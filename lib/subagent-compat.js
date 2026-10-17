/**
 * dsh-main-agent — the single seam the plugin uses to talk to `ctx.subagents`.
 *
 * WHY THIS FILE EXISTS: the plugin was written against the 0.1 series of
 * `@deepseek-ai/dsh-subagent`, whose service exposed `start()`,
 * `startContinuable()`, and `drainContinuableChildren()` and whose child
 * catalog carried `kind`/`activity` fields. dsh-subagent 0.2.1-rc.2 (the
 * version the current host ships) removed all three methods and the catalog
 * fields; it offers `startActivation()`, `drainChildren()`, and a catalog
 * projection of `{ id, createdAt, mode, label? }` instead. Calling the old
 * names threw "is not a function" at the first delegation, long after the
 * plugin had loaded cleanly — so every host-side caller now goes through this
 * module, which also publishes the capability probe the settings card and
 * `GET /supervisor/health` use to REPORT the drift instead of failing silently.
 *
 * Contract notes for the 0.2.1 API (verified in the host bundle):
 * - `startActivation({ provider, label, childId?, request, signal, delivery })`
 *   returns `{ childId, result, dispose }`. `delivery: 'parent'` is the
 *   background path (requires session persistence, child settlement is
 *   announced to the parent inbox); `delivery: 'caller'` is the foreground path
 *   (persistence optional, no settlement announcement — the caller awaits
 *   `result` and disposes).
 * - `drainChildren(parent, childIds)` releases resident child activations;
 *   ids that are not resident are skipped, never an error.
 * - The catalog never reports liveness. A child is "running" only while a live
 *   agent with that session id reports `status === 'running'`.
 */

/** Methods this plugin needs. Order matters only for the message. */
export const REQUIRED_METHODS = [
  'startActivation',
  'drainChildren',
  'listChildren',
  'sendMessage',
  'interrupt',
  'getProvider',
]

/** Diagnostics for a host that would silently break delegation. */
export function missingSubagentMethods(ctx) {
  const service = ctx?.subagents
  if (service === undefined || service === null) return [...REQUIRED_METHODS]
  return REQUIRED_METHODS.filter(method => typeof service[method] !== 'function')
}

/** True when every method this plugin calls exists on the live service. */
export function subagentCompatible(ctx) {
  return missingSubagentMethods(ctx).length === 0
}

/** The human-readable half of the capability probe (shared by log + health). */
export function subagentIncompatibilityMessage(ctx) {
  const missing = missingSubagentMethods(ctx)
  if (missing.length === 0) return undefined
  return '宿主 ctx.subagents 缺少本插件需要的方法：'
    + `${missing.join('、')}（插件面向 dsh-subagent 0.2.x 的 startActivation/drainChildren API）`
}

/** Fail loud and early with an actionable message instead of a bare TypeError. */
function assertMethod(ctx, method) {
  const service = ctx?.subagents
  if (typeof service?.[method] !== 'function') {
    throw new Error(`宿主 subagent 服务不兼容：缺少 ctx.subagents.${method}()。`
      + '本插件要求 dsh-subagent 0.2.x（startActivation/drainChildren）。'
      + `当前缺少：${missingSubagentMethods(ctx).join('、') || '无（服务未安装）'}`)
  }
}

/** Is this child id backed by a live, running agent right now? */
export function childIsRunning(ctx, childId) {
  try {
    return ctx?.agents?.get?.(childId)?.status === 'running'
  } catch {
    return false
  }
}

/**
 * Continuable child ids from the 0.2.1 catalog projection. The catalog is
 * durable, so this is "every child ever", not "every child now" — callers that
 * need liveness must pair it with `childIsRunning()`.
 */
export function continuableChildIds(children) {
  return (Array.isArray(children) ? children : [])
    .filter(entry => entry !== null && typeof entry === 'object' && entry.mode === 'continuable')
    .map(entry => entry.id)
}

/** Ids among `children` that are running right now. */
export function runningChildIds(ctx, children) {
  return continuableChildIds(children).filter(childId => childIsRunning(ctx, childId))
}

/**
 * Start one child. `mode: 'background'` announces settlement to the parent;
 * `mode: 'foreground'` keeps the result with the caller.
 * @returns {Promise<{ childId: string, result: Promise<any>, dispose: () => Promise<void> }>}
 */
export async function startWorker(ctx, { provider, label, childId, request, signal, mode = 'background' }) {
  assertMethod(ctx, 'startActivation')
  const started = await ctx.subagents.startActivation({
    provider,
    label,
    ...childId === undefined ? {} : { childId },
    request,
    signal,
    delivery: mode === 'foreground' ? 'caller' : 'parent',
  })
  return {
    childId: started.childId,
    result: started.result,
    dispose: started.dispose,
  }
}

/** Release resident child activations (Full stop). Non-resident ids are skipped. */
export async function drainWorkers(ctx, parent, childIds) {
  if (childIds.length === 0) return undefined
  assertMethod(ctx, 'drainChildren')
  return ctx.subagents.drainChildren(parent, childIds)
}

/**
 * How long a just-started child may stay invisible before its ledger entry is
 * discarded (a spawn that never materialized an agent).
 */
export const LEDGER_STALE_MS = 15 * 60 * 1000

/**
 * The hard parallel-worker count: running children plus children this fiber
 * started that are not observable as running yet.
 *
 * WHY THE LEDGER: the 0.2.x catalog carries no activity field and
 * `agents.get()` reports nothing until the child agent is materialized, so a
 * freshly spawned worker is invisible to a plain running-count — two spawns in
 * the same step would both read zero. A ledger entry therefore counts as open
 * until that child has been OBSERVED running and is gone again (spawned, ran,
 * settled), or until it never runs within LEDGER_STALE_MS.
 *
 * Mutates `ledger` (prunes settled/stale entries) — it is fiber-local state.
 */
export function openWorkerCount(ctx, children, ledger, now = Date.now()) {
  const byId = new Set(continuableChildIds(children))
  for (const [childId, state] of ledger) {
    const running = byId.has(childId) && childIsRunning(ctx, childId)
    if (running) state.wasActive = true
    else if (state.wasActive || now - state.startedAt > LEDGER_STALE_MS) ledger.delete(childId)
  }
  const runningCount = runningChildIds(ctx, children).length
  // A ledger entry that is already running must not be counted twice.
  const startingCount = [...ledger.keys()].filter(childId => !childIsRunning(ctx, childId)).length
  return runningCount + startingCount
}
