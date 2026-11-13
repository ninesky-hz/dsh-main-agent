/**
 * dsh-main-agent — the single seam the plugin uses to talk to `ctx.subagents`.
 *
 * WHY THIS FILE EXISTS: the plugin was written against the 0.1 series of
 * `@deepseek-ai/dsh-subagent`, whose service exposed `start()`,
 * `startContinuable()`, and `drainContinuableChildren()` and whose child
 * catalog carried `kind`/`activity` fields. dsh-subagent 0.2.1-rc.2 removed all
 * three methods and the catalog fields; 0.2.2-rc.2 then reshaped the start
 * request again. Calling a retired name throws "is not a function" at the first
 * delegation, long after the plugin loaded cleanly — so every host-side caller
 * goes through this module, which also publishes the capability probe the
 * settings card and `GET /supervisor/health` use to REPORT drift instead of
 * failing silently.
 *
 * TWO LIVE GENERATIONS, BOTH SUPPORTED HERE (this is the point of the file):
 *
 *   0.2.1 — dsh 0.2.2-rc.1
 *     startActivation({ provider, label, childId?, request, signal, delivery })
 *       `request` is one nested `SubagentStartRequest` object.
 *     listChildren(parentSessionId, signal)      direct children
 *     drainChildren(parent, childIds)            releases the listed activations
 *
 *   0.2.2 — dsh 0.2.2-rc.2
 *     startActivation({ provider, label, name?, childId?, ...startRequest, signal, delivery })
 *       the nested `request` is FLATTENED into the spec, and `name` is new:
 *       1–32 lower-case letters/digits/hyphens starting with a letter, not
 *       `lead`; omitted means the host allocates `agent-N`.
 *     listDescendants(rootSessionId, signal)     the whole subtree; direct
 *       children are the rows with `depth === 1`
 *     drainDescendants(parents)                  releases a WHOLE TREE
 *
 * `sendMessage` and `interrupt` are identical in both generations, so the
 * control half (`lib/control.js`) needs no switching. Generation is detected
 * from service shape, never from a version string: rc.2 is the only generation
 * that can list or drain descendants.
 *
 * Result shape: `startActivation` returns `{ childId, name?, messageId?, result,
 * dispose }`. `delivery: 'parent'` is the background path (requires session
 * persistence, settlement is announced to the parent inbox); `delivery:
 * 'caller'` is the foreground path (persistence optional, no settlement
 * announcement — the caller awaits `result` and disposes). rc.2 also reports the
 * model-facing `name`; the 0.2.1 host does not, so callers must tolerate
 * `undefined`.
 *
 * The catalog never reports liveness. A child is "running" only while a live
 * agent with that session id reports `status === 'running'`.
 */

/** Methods every supported generation has. */
export const CORE_METHODS = ['startActivation', 'sendMessage', 'interrupt', 'getProvider']

/** Catalog readers; a host must offer one of them. rc.2 first. */
export const CATALOG_METHODS = ['listDescendants', 'listChildren']

/** Release entry points; a host must offer one of them. rc.2 first. */
export const DRAIN_METHODS = ['drainDescendants', 'drainChildren']

/**
 * Every method a host may expose. NOT an all-required list — the catalog and
 * drain groups are alternatives — so use {@link missingSubagentMethods} for
 * the verdict and this only for documentation and messages.
 */
export const REQUIRED_METHODS = [...CORE_METHODS, ...CATALOG_METHODS, ...DRAIN_METHODS]

const CATALOG_HINT = 'listChildren 或 listDescendants'
const DRAIN_HINT = 'drainChildren 或 drainDescendants'

/**
 * The live service, whether the caller holds it directly or has to ask the
 * context (the watchdog only ever has `ctx.get('subagents')`).
 */
function serviceOf(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  const direct = ctx.subagents
  if (direct !== undefined && direct !== null) return direct
  try {
    return ctx.get?.('subagents') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Which host generation this service speaks, from shape alone.
 * @returns {'0.2.2' | '0.2.1' | undefined} undefined when there is no service.
 */
export function resolveSubagentGeneration(ctx) {
  const service = serviceOf(ctx)
  if (service === undefined) return undefined
  if (typeof service.drainDescendants === 'function'
    || typeof service.listDescendants === 'function'
    || typeof service.namesOf === 'function') return '0.2.2'
  if (typeof service.drainChildren === 'function' || typeof service.listChildren === 'function') return '0.2.1'
  return undefined
}

/** Can this host list children at all? */
export function hasCatalog(ctx) {
  const service = serviceOf(ctx)
  return service !== undefined && CATALOG_METHODS.some(method => typeof service[method] === 'function')
}

/** Diagnostics for a host that would silently break delegation. */
export function missingSubagentMethods(ctx) {
  const service = serviceOf(ctx)
  if (service === undefined) return [...CORE_METHODS, CATALOG_HINT, DRAIN_HINT]
  const missing = CORE_METHODS.filter(method => typeof service[method] !== 'function')
  if (!CATALOG_METHODS.some(method => typeof service[method] === 'function')) missing.push(CATALOG_HINT)
  if (!DRAIN_METHODS.some(method => typeof service[method] === 'function')) missing.push(DRAIN_HINT)
  return missing
}

/** True when every capability this plugin calls exists on the live service. */
export function subagentCompatible(ctx) {
  return missingSubagentMethods(ctx).length === 0
}

/** The human-readable half of the capability probe (shared by log + health). */
export function subagentIncompatibilityMessage(ctx) {
  const missing = missingSubagentMethods(ctx)
  if (missing.length === 0) return undefined
  return '宿主 ctx.subagents 缺少本插件需要的方法：'
    + `${missing.join('、')}（插件面向 dsh-subagent 0.2.x：rc.1 的 request 形态与 rc.2 的扁平形态都支持）`
}

/** How to name the service in a diagnostic: generation, unknown, or absent. */
function describeService(service) {
  if (service === undefined) return '无（服务未安装）'
  return resolveSubagentGeneration({ subagents: service }) ?? '未知（两代的目录/释放方法都不在）'
}

/** Fail loud and early with an actionable message instead of a bare TypeError. */
function assertCallable(service, method, what) {
  if (typeof service?.[method] !== 'function') {
    throw new Error(`宿主 subagent 服务不兼容：${what}需要 ctx.subagents.${method}()。`
      + '本插件兼容 dsh-subagent 0.2.1（request 形态）与 0.2.2（扁平形态）。'
      + `当前服务代数：${describeService(service)}。`)
  }
}

/** Same, for a capability that either generation may satisfy. */
function assertAnyCallable(service, methods, hint, what) {
  if (!methods.some(method => typeof service?.[method] === 'function')) {
    throw new Error(`宿主 subagent 服务不兼容：${what}需要 ctx.subagents.${hint}()。`
      + '本插件兼容 dsh-subagent 0.2.1 与 0.2.2。'
      + `当前服务代数：${describeService(service)}。`)
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
 * Continuable child ids from the 0.2.x catalog projection. The catalog is
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
 * Direct children of one session, normalized to the 0.2.1 catalog shape
 * `{ id, createdAt, mode, label? }`.
 *
 * rc.2 has no direct-child reader: `listDescendants()` returns the whole
 * subtree and the direct children are exactly the rows with `depth === 1`.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listChildrenOf(ctx, sessionId, signal) {
  const service = serviceOf(ctx)
  assertAnyCallable(service, CATALOG_METHODS, CATALOG_HINT, '读取 worker 目录')
  if (typeof service.listDescendants === 'function') {
    const rows = await service.listDescendants(sessionId, signal)
    return (Array.isArray(rows) ? rows : [])
      .filter(entry => entry !== null && typeof entry === 'object' && entry.depth === 1)
  }
  const rows = await service.listChildren(sessionId, signal)
  return Array.isArray(rows) ? rows : []
}

/** Hard ceiling on a client-side subtree walk (rc.1 has no descendant reader). */
const DESCENDANT_WALK_LIMIT = 500

/**
 * Whole subtree below one session, each row carrying `parentId` and `depth`.
 *
 * rc.2 answers this natively. 0.2.1 has no descendant reader, so the walk is
 * rebuilt breadth-first from the direct-child catalog — only continuable
 * children can own descendants, so one-shot children are leaves.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listDescendantsOf(ctx, sessionId, signal) {
  const service = serviceOf(ctx)
  assertAnyCallable(service, CATALOG_METHODS, CATALOG_HINT, '读取 worker 子树')
  if (typeof service.listDescendants === 'function') {
    const rows = await service.listDescendants(sessionId, signal)
    return Array.isArray(rows) ? rows : []
  }
  const out = []
  const seen = new Set([sessionId])
  let frontier = [{ id: sessionId, depth: 0 }]
  while (frontier.length > 0 && out.length < DESCENDANT_WALK_LIMIT) {
    const next = []
    for (const node of frontier) {
      const rows = await service.listChildren(node.id, signal)
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || seen.has(row.id)) continue
        seen.add(row.id)
        out.push({ ...row, parentId: node.id, depth: node.depth + 1 })
        if (row.mode === 'continuable') next.push({ id: row.id, depth: node.depth + 1 })
      }
    }
    frontier = next
  }
  return out
}

/** Flatten a 0.2.1 `SubagentStartRequest` into the rc.2 spec surface. */
function flattenRequest(request) {
  if (request === null || typeof request !== 'object') return {}
  // `label` moved to the spec's own top level; everything else is passed
  // through untouched, including the provider-consumed extras this plugin adds
  // (`toolFilter`, `persona`), which neither generation declares but both
  // hand to the provider.
  const { label: _retired, ...rest } = request
  return rest
}

/**
 * Start one child on either host generation.
 * `mode: 'background'` announces settlement to the parent; `mode: 'foreground'`
 * keeps the result with the caller.
 * @returns {Promise<{ childId: string, name?: string, result: Promise<any>, dispose: () => Promise<void> }>}
 */
export async function startWorker(ctx, { provider, label, name, childId, request, signal, mode = 'background' }) {
  const service = serviceOf(ctx)
  assertCallable(service, 'startActivation', '派生 worker')
  const delivery = mode === 'foreground' ? 'caller' : 'parent'
  const spec = resolveSubagentGeneration(ctx) === '0.2.2'
    ? {
        provider,
        label,
        ...name === undefined ? {} : { name },
        ...childId === undefined ? {} : { childId },
        ...flattenRequest(request),
        signal,
        delivery,
      }
    : {
        provider,
        label,
        ...childId === undefined ? {} : { childId },
        request,
        signal,
        delivery,
      }
  const started = await service.startActivation(spec)
  return {
    childId: started.childId,
    ...typeof started.name === 'string' && started.name !== '' ? { name: started.name } : {},
    result: started.result,
    dispose: started.dispose,
  }
}

/**
 * Release resident child activations (Full stop).
 *
 * rc.1 releases exactly the listed ids and skips non-resident ones. rc.2 has no
 * id-addressed release: `drainDescendants([parent])` stops the whole tree, which
 * is what a Full stop wants — callers reach here only for a session that is
 * being stopped.
 */
export async function drainWorkers(ctx, parent, childIds) {
  if (childIds.length === 0) return undefined
  const service = serviceOf(ctx)
  if (typeof service?.drainDescendants === 'function') return service.drainDescendants([parent])
  assertAnyCallable(service, DRAIN_METHODS, DRAIN_HINT, '释放 worker')
  return service.drainChildren(parent, childIds)
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
