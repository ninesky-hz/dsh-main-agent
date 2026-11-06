/**
 * dsh-main-agent — settings-guarded worker `subagent` tool.
 *
 * A preset-row plugin (mounted from agent-presets/main-agent/agent.cordis.yml
 * as `name: dsh-main-agent/spawn`) that replaces the pinned
 * `@deepseek-ai/dsh-tool-subagent` dev row with a MODEL-GENERIC one: a
 * required `model` argument selects the worker's model from the USER-owned
 * settings allowlist. Each allowed route has a settings-owned reasoning effort;
 * the main agent can choose a permitted route but cannot choose or inherit its
 * effort. Fixed routes are annotated with native input modalities
 * (`[text]` / `[text,image]`); the explicit `runtime/current` choice resolves
 * the calling turn's captured route and capabilities at execution time.
 *
 * META-CONFIG (live): when the host half's `supervisorSettings` service is
 * present (bundle install), the allowlist, per-route worker efforts, and
 * `maxParallelWorkers` come from the user's settings — the Settings → Plugins
 * card, i.e. the `- id: agi-supervisor-setup` row of the profile's own patch
 * layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`; the namespace is the
 * entry id, never the package name) — and are read at EVERY tool call, so
 * edits apply mid-session with no restart. A live system-prompt section
 * renders the current values into each request. There is deliberately no
 * preset fallback or implicit parent-model inheritance: an empty allowlist
 * exposes no tool.
 *
 * Everything else mirrors the shipped tool: continuable background children
 * through the 0.2.x `ctx.subagents.startActivation({…, delivery: 'parent'})`
 * seam (lib/subagent-compat.js — the 0.1 `start`/`startContinuable` pair was
 * removed from the host), per-row worker persona, foreground fallback via
 * `run_in_background: false` (the same activation with `delivery: 'caller'`,
 * awaited and disposed by this turn).
 * The child model rides `SubagentRequest.agentOptions` — a per-request field
 * the service always supported; only the shipped tool's config hid it.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hasDirectHumanMessage } from './goal.js'
import { appendLoopEvent } from './loop-journal.js'
import { installSettlementDiagnostics } from './settlement.js'
import { installLoopWatchdog } from './watchdog.js'
import {
  openWorkerCount as countOpenWorkers,
  startWorker,
  subagentIncompatibilityMessage,
} from './subagent-compat.js'
import {
  currentRuntimeModel,
  hostUsesModelSelection,
  pinWorkerEffort,
  resolveWorkerEffort,
  RUNTIME_MODEL_KEY,
  selectWorkerModel,
  WORKER_EFFORT_PROVIDER_DEFAULT,
  workerDeniedTools,
  workerToolFilter,
  workerModelKey,
  workerModelLabel,
  workerReasoningInfo,
} from './worker-model-policy.js'

export const name = 'dsh-main-agent-spawn'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

/** Prompt order near the shipped delegation guidance. */
const META_SECTION_ORDER = 116.7

export const Config = z.object({
  /** The `ctx.subagents` provider to start children on. */
  provider: z.string().default('spawn'),
  /** Model-facing tool name. */
  toolName: z.string().default('subagent'),
  /** Per-child persona (the invariant worker protocol). */
  persona: z.string(),
  /** Child recursion cap, forwarded per request. */
  maxDepth: z.natural().default(3),
  /**
   * Extra tool names this preset's workers must not see, on top of the fixed
   * worker-protocol denials.
   *
   * This is the native home for a restriction some presets used to express as
   * `toolFilter.deny` — the retired `@deepseek-ai/dsh-tool-subagent` spelling,
   * which the official tool now rejects outright. The supervisor layer copies
   * that list here; `workerDeniedTools` also reads the old field directly, so a
   * preset keeps its restriction whether or not the copy happened.
   */
  deny: z.array(z.string()).default([]),
  /**
   * 为「人的消息」预留的额外槽位（0 = 关闭该特性）。
   *
   * 参考实现的原话是：为人的消息或状态请求多留一个槽位，正常槽满时可用，取
   * 空闲槽优先。动机是真实的：并行上限是为了防住无限的自动扇出，但人类的一句
   * 话不该被自己设的上限挡住 —— 那会让人以为监督者卡死了。所以槽满时，如果
   * 本回合确实有直接人类消息，允许用到 `cap + reservedHumanSlots`，并在
   * `progress.jsonl` 里留一条 `reserved-slot-used` 事件，让「这次为什么多开
   * 了一个」事后可查。
   */
  reservedHumanSlots: z.natural().default(1),
})

/**
 * Resolve the user's allowlist against the native catalog. Fixed entries keep
 * their `provider/model-id` spelling and gain native input modalities;
 * `runtime/current` stays synthetic until execution has a calling turn.
 * A malformed or unresolvable entry is skipped with a warning. The tool stays
 * available when at least one route resolves; if none resolve, spawning is
 * disabled rather than falling through to an unapproved route.
 */
async function resolveAllowlist(ctx, models) {
  const entries = []
  const seen = new Set()
  for (const value of models) {
    if (seen.has(value)) continue
    seen.add(value)
    if (value === RUNTIME_MODEL_KEY) {
      entries.push({
        provider: 'runtime',
        id: 'current',
        modalities: [],
        runtime: true,
      })
      continue
    }
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) {
      ctx.logger.warn(`dsh-main-agent-spawn: models 条目 "${value}" 不是 provider/model-id —— 已跳过`)
      continue
    }
    const provider = value.slice(0, slash)
    const id = value.slice(slash + 1)
    try {
      const info = await ctx.llm.resolveModelInfo(provider, id)
      entries.push({
        provider,
        id,
        modalities: info.inputModalities ?? ['text'],
        ...info.reasoning === undefined ? {} : { reasoning: workerReasoningInfo(info.reasoning) },
      })
    } catch (error) {
      ctx.logger.warn(`dsh-main-agent-spawn: models 条目 "${value}" 无法解析（${error?.message ?? error}）—— 已跳过`)
    }
  }
  return entries
}

export async function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'subagent'

  // Capability probe: a host that renamed the delegation API must say so at
  // boot, not at the first spawn. The same diagnosis feeds
  // `GET /supervisor/health` and the Feed banner (lib/index.js).
  const incompatibility = subagentIncompatibilityMessage(ctx)
  if (incompatibility !== undefined) {
    ctx.logger.error(`dsh-main-agent-spawn: ${incompatibility} —— "${toolName}" 会在执行时报错`)
  }

  // Exact, one-use bridge from spawn policy to the fresh child's first model
  // request. Continuable starts accept a caller-reserved UUID. Foreground
  // starts allocate internally, so their agent/created edge captures only the
  // newly published direct child before it can make a request. Root listeners
  // are required because ordinary agent-scoped listeners intentionally receive
  // events for that exact agent only; both listeners fail closed on an exact id
  // and unregister with this plugin fiber. Once applied, request/header is the
  // durable authority and neither warm steps nor cold resumes need the bridge.
  //
  // Two host seams, one policy:
  //   0.2.2+  `agent/created` → `agent.model.select()` records a durable
  //           `model/selection` before the first preStep reads it.
  //   ≤0.2.1  no `agent.model`; the `agent/request` listener is the only way to
  //           set the effort, and rewriting the request there is legal.
  // The request listener therefore stands down as soon as the host exposes the
  // selection seam: from 0.2.2 on, returning a different reasoningEffort after
  // step preparation makes the loop throw and kills that worker's first step.
  // The two seams record the value in different places, so a support report
  // that reads "effort was ignored" needs to know which one ran. Log it once.
  let reportedSeam
  const reportSeam = seam => {
    if (reportedSeam === seam) return
    reportedSeam = seam
    ctx.logger.info(`dsh-main-agent-spawn: worker 推理强度经 ${seam} 落定`)
  }
  const pendingEfforts = new Map()
  let pendingForeground
  ctx.effect(() => ctx.root.on('agent/created', ({ agent }) => {
    const pending = pendingForeground
    if (pending !== undefined && agent.session.header.parentSession === pending.parentId) {
      pending.childId = agent.id
      pendingEfforts.set(agent.id, pending.effort)
    }
    const effort = pendingEfforts.get(agent.id)
    if (effort === undefined) return
    // New hosts: pin it now and stop carrying the value anywhere else.
    if (pinWorkerEffort(agent, effort)) {
      pendingEfforts.delete(agent.id)
      reportSeam('agent.model.select()（宿主 0.2.2+）')
    }
  }))
  ctx.effect(() => ctx.root.on('agent/request', async ({ agent }, next) => {
    // Legacy hosts only. Returning a request whose reasoningEffort differs from
    // the step's prepared selection is a hard error from 0.2.2 on, so nothing
    // is rewritten once the selection seam exists.
    if (hostUsesModelSelection(agent)) return next()
    const effort = pendingEfforts.get(agent.id)
    const request = await next()
    if (effort === undefined) return request
    reportSeam('agent/request（宿主 ≤0.2.1）')
    return { ...request, reasoningEffort: effort }
  }))
  ctx.effect(() => ctx.root.on('session/event', (session, event) => {
    if (event.type === 'request/header') pendingEfforts.delete(session.id)
  }))

  installSettlementDiagnostics(ctx)
  // Server-side wake guarantee + stalled-worker reaper. The supervisor loop is
  // prompt-driven, so nothing used to notice a forgotten `schedule_create`;
  // this hook runs on every supervisor turn and re-arms the fallback reminder.
  installLoopWatchdog(ctx)

  // The settings namespace is the sole routing authority. There is no preset
  // fallback or implicit parent-model inheritance. runtime/current is an
  // explicit allowed value; an empty/missing list means no worker may start.
  const meta = () => ctx.get('supervisorSettings')?.current()
  const configuredModels = () => {
    const configured = meta()?.workerModels
    return Array.isArray(configured) ? configured : []
  }
  const configuredEfforts = () => {
    const configured = meta()?.workerEfforts
    return configured !== null && typeof configured === 'object' && !Array.isArray(configured)
      ? configured
      : {}
  }
  const configuredEffortFor = route => {
    const effort = configuredEfforts()[route]
    return typeof effort === 'string' && effort.length > 0
      ? effort
      : WORKER_EFFORT_PROVIDER_DEFAULT
  }

  /**
   * 自动派生档位（参考实现里的 accept mode：off / observe / auto）。
   *
   * 缺省或写了不认识的值一律按 `auto`：这是「现状不变」的那一档，回落到它
   * 不会让用户以为自己的设置生效了、实际却被降级成更严的档位。
   */
  const configuredProactive = () => {
    const mode = meta()?.proactive
    return mode === 'off' || mode === 'observe' ? mode : 'auto'
  }

  /** 调用方工作区（绝对路径）；拿不到时 `undefined`。 */
  const cwdOf = agent => {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : undefined
  }

  /**
   * `observe` 档：把「本会派生的完整内容」落到 `.agi/proposals.jsonl`，不真派。
   *
   * 用 jsonl 而不是读一遍就算了：`observe` 的全部价值是「先看几条再切 auto」，
   * 那就必须能在事后（甚至重启后）读到当时到底会派什么。
   *
   * @returns {{ path?: string, error?: string }}
   */
  const recordProposal = (agent, entry) => {
    const cwd = cwdOf(agent)
    if (cwd === undefined) return { error: '拿不到工作区路径' }
    const dir = join(cwd, '.agi')
    const path = join(dir, 'proposals.jsonl')
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
      return { path }
    } catch (error) {
      return { path, error: `写 proposals.jsonl 失败：${error?.message ?? error}` }
    }
  }

  // Cap ledger: children this fiber started that have not yet been SEEN
  // running. See openWorkerCount() in ./subagent-compat.js for why the ledger
  // exists and how stale entries expire.
  const startingLedger = new Map()

  const openWorkerCount = children => countOpenWorkers(ctx, children, startingLedger)

  let allowlistCache = []
  let cachedKey
  let disposeTool
  let providerAvailable = typeof ctx.subagents?.getProvider === 'function'
    && ctx.subagents.getProvider(provider) !== undefined

  /** Register one schema snapshot containing only the currently allowed routes. */
  const mount = () => {
    const allowed = allowlistCache.map(entry => ({
      provider: entry.provider,
      id: entry.id,
      modalities: [...entry.modalities],
      ...entry.reasoning === undefined ? {} : { reasoning: workerReasoningInfo(entry.reasoning) },
      ...entry.runtime === true ? { runtime: true } : {},
    }))
    const allowedRows = allowed
      .map(entry => workerModelLabel(entry, configuredEffortFor(workerModelKey(entry))))
      .join('\n')
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        '在一个全新上下文中启动一个 worker agent（它看不到本对话；prompt 必须是完整的、'
        + '独立的任务）。默认在后台运行并立即返回一个持久的 '
        + 'subagent id；当该次运行收敛时你会收到一条带其结论的通知，而 `send_message` '
        + '会继续同一个子会话，并在某个正在运行的回合的下一步汇入。'
        + '必填的 `model` 参数必须是用户所有的 worker 白名单中的恰好一个选项；'
        + '不存在隐式默认值，也不会继承父模型。`runtime/current` 启用时显式跟随'
        + '本次调用回合所捕获的路由。固定路由旁会标注原生输入模态'
        + '（仅当 worker 必须查看图片时才选择 [text,image] 模型）。'
        + '每份 worker prompt 都必须要求它把报告写进 `.agi/subagents/<你的 session id>/outcome.md`，'
        + '并在第一行写 `<!-- worker: <你的 session id> -->`，Feed 才能把结果挂回它自己那一行。'
        + '同一份 outcome.md 里还要有一行 `<!-- report: <state> -->`（progress/waiting/ready/blocked/failed/dropped）；'
        + 'blocked/failed 时再加一行 `<!-- question: <一句话的具体问题> -->` —— 监督者的 BRIEF 按它推出 stage，'
        + '而不是从自述文本里猜「它是不是在等我」。'
        + '同时要求它在同一目录写 `checks.json`（数组，每条是 `{id, cmd}` / `{id, file, contains}` / `{id, note}`），'
        + '这样你能用 `check_outcome` 一次跑完它的验收清单，而不是只读到它自称的「已完成」。'
        + `允许的 worker 模型：\n${allowedRows}`,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: '被委派任务的简短描述（3-5 个词），用于展示。',
        },
        prompt: {
          type: 'string',
          required: true,
          description: '完整、独立的任务（Role / Objective / Scope / Context pointers / Protocol / Constraints）。',
        },
        model: {
          type: 'string',
          required: true,
          enum: allowed.map(workerModelKey),
          description: `必填的 worker 选择。只接受经设置批准的条目：\n${allowedRows}`,
        },
        run_in_background: {
          type: 'boolean',
          description: '默认为 true（持久的后台子 agent）。当你的下一步动作依赖其结果时设为 false 以等待结果。',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
                model: { type: 'string', required: true },
                modalities: { type: 'array', required: true, items: { type: 'string' } },
                effort: { type: 'string', required: true },
                // 只在越过并行上限、用掉人类预留槽时出现，说明这次为什么能派。
                notice: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                output: { type: 'array', required: true, items: { type: 'json' } },
                model: { type: 'string', required: true },
                modalities: { type: 'array', required: true, items: { type: 'string' } },
                effort: { type: 'string', required: true },
                notice: { type: 'string' },
              },
            },
            {
              // `proactive=observe`：没有派生任何东西，只把「本会派什么」记下来。
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'proposal' },
                model: { type: 'string', required: true },
                description: { type: 'string', required: true },
                recorded: { type: 'boolean', required: true },
                note: { type: 'string', required: true },
              },
            },
          ],
        },
        render: (_args, value) => {
          if (value.kind === 'proposal') return [{ type: 'text', text: value.note }]
          const notice = value.notice === undefined ? '' : `\n${value.notice}`
          const head = value.kind === 'continuable'
            ? `已启动 subagent ${value.subagentId}，模型 ${value.model} [${value.modalities.join(',')}]，推理强度 ${value.effort}`
            : `subagent 已完成，模型 ${value.model} [${value.modalities.join(',')}]，推理强度 ${value.effort}\n\n${value.output
                .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
                .map(block => block.text)
                .join('')}`
          return [{ type: 'text', text: `${head}${notice}` }]
        },
      },
      // Deliberately NOT concurrency-safe: spawn bodies serialize so the cap
      // check of a second same-step call observes the first call's ledger entry.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error(`${toolName} 需要一个调用方 agent`)

        // Re-read settings at execution time. A schema captured one step ago
        // cannot authorize a model the user removed before this call executes.
        await refreshAllowlist()
        const policySelection = selectWorkerModel(args.model, allowlistCache)
        let selected = policySelection
        if (policySelection.runtime === true) {
          const currentRoute = currentRuntimeModel(parent)
          const info = await ctx.llm.resolveModelInfo(currentRoute.provider, currentRoute.model, exec.signal)
          selected = {
            key: `${currentRoute.provider}/${currentRoute.model}`,
            provider: currentRoute.provider,
            model: currentRoute.model,
            modalities: info.inputModalities ?? ['text'],
            ...info.reasoning === undefined ? {} : { reasoning: workerReasoningInfo(info.reasoning) },
          }
        }
        // The route key in the tool call selects both the allowed model and its
        // settings-owned effort. There is intentionally no tool argument and no
        // read from the parent request's reasoning effort.
        const effort = resolveWorkerEffort(configuredEffortFor(args.model), selected)

        // 自动派生档位必须在任何 cap 检查之前判：被拒掉的派生不该先消耗一次
        // 上限，也不该在 observe 档留下「已打开」的错觉。
        const proactive = configuredProactive()
        if (proactive === 'off') {
          throw new Error(
            'proactive=off（SUPERVISOR META-CONFIG）：用户要求先关闭自动派生，本次调用没有派生任何 worker。'
            + '请在总结里如实报告剩余工作与阻塞点，等用户把档位切回 observe 或 auto；'
            + '不要用别的委派工具绕过这个开关。',
          )
        }
        if (proactive === 'observe') {
          const recorded = recordProposal(parent, {
            ts: new Date().toISOString(),
            description: args.description,
            model: args.model,
            prompt: args.prompt,
          })
          return {
            kind: 'proposal',
            model: selected.key,
            description: args.description,
            recorded: recorded.path !== undefined && recorded.error === undefined,
            note: recorded.error === undefined
              ? `proactive=observe：已记录到 ${recorded.path}，未实际派生。`
                + '把这条提案当成「本会派出什么」的记录；需要真派时请用户把档位切到 auto。'
              : `proactive=observe：未能写入提案文件（${recorded.error}），也未实际派生。`,
          }
        }

        // Enforce the LIVE parallel cap (0 = unlimited): active children plus
        // our own still-starting spawns, read at call time so a settings edit
        // applies to the very next spawn.
        const cap = meta()?.maxParallelWorkers ?? 0
        // 人优先的预留槽：槽满时若本回合确有直接人类消息，允许用到 cap + 预留，
        // 并把理由带回工具结果 —— 主 Agent 需要知道这次为什么越过了自己的上限。
        let reservedNotice
        if (cap > 0) {
          const children = await ctx.subagents.listChildren(parent.id, exec.signal)
          const open = openWorkerCount(children)
          if (open >= cap) {
            const reserved = Number.isInteger(config.reservedHumanSlots) && config.reservedHumanSlots > 0
              ? config.reservedHumanSlots
              : 0
            const allowed = reserved > 0 && open < cap + reserved && hasDirectHumanMessage(ctx, parent)
            if (!allowed) {
              throw new Error(
                `已达到并行 worker 上限：已打开 ${open} 个 worker，用户设定的上限是 ${cap}（SUPERVISOR META-CONFIG）。`
                + (reserved > 0
                  ? `另为「人的消息」预留了 ${reserved} 个槽位，但它只在存在直接人类消息的回合可用 —— 本回合没有。`
                  : '')
                + '请等待一条收敛通知，或 interrupt_agent 一个你不再需要的 worker，'
                + '然后重新派生。',
              )
            }
            const cwd = cwdOf(parent)
            if (cwd !== undefined) {
              appendLoopEvent(cwd, 'reserved-slot-used', { open, cap, reserved })
            }
            reservedNotice = `本次占用了为人类消息预留的槽位：调用前已打开 ${open} 个 worker，`
              + `上限是 ${cap} + 预留 ${reserved}，并在 .agi/progress.jsonl 记了一条 reserved-slot-used。`
          }
        }

        // Lifetime budget (0 = unlimited): the parallel cap only bounds what is
        // alive at one instant, so a long mission could spawn forever while
        // staying under it. This counts every continuable child the session
        // ever created — the durable children roster, not the live set.
        const totalCap = meta()?.maxSpawnTotal ?? 0
        if (totalCap > 0) {
          const children = await ctx.subagents.listChildren(parent.id, exec.signal)
          const used = continuableChildIds(children).length
          if (used >= totalCap) {
            throw new Error(
              `已达到 worker 总量预算：本会话累计派生 ${used} 个 worker，用户设定的上限是 ${totalCap}（SUPERVISOR META-CONFIG）。`
              + '请在总结里如实报告剩余工作，让用户决定是否提高上限，不要用别的路径绕过。',
            )
          }
        }

        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          maxDepth: config.maxDepth ?? 3,
          // A question opened through ask_user_question belongs to the child
          // session and does not wake its supervisor. Hide that dead-end from
          // both the worker's schema and execution path. The continuable
          // child-scoped `report` tool survives this global restriction and
          // remains the sole escalation channel to the parent. A preset that
          // used to narrow its worker catalog through `toolFilter.deny` keeps
          // that narrowing here, without depending on the retired spelling.
          toolFilter: workerToolFilter(workerDeniedTools(config)),
          agentOptions: {
            provider: selected.provider,
            model: selected.model,
          },
          ...config.persona !== undefined ? { persona: config.persona } : {},
        }
        if (args.run_in_background !== false) {
          const childId = randomUUID()
          if (effort.reasoningEffort !== undefined) {
            pendingEfforts.set(childId, effort.reasoningEffort)
          }
          let started
          try {
            started = await startWorker(ctx, {
              provider,
              label: args.description,
              childId,
              request,
              signal: exec.signal,
              mode: 'background',
            })
          } catch (error) {
            pendingEfforts.delete(childId)
            throw error
          }
          startingLedger.set(started.childId, { wasActive: false, startedAt: Date.now() })
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: selected.key,
            modalities: selected.modalities,
            effort: effort.label,
            ...reservedNotice === undefined ? {} : { notice: reservedNotice },
          }
        }
        if (effort.reasoningEffort !== undefined) {
          pendingForeground = { parentId: parent.id, effort: effort.reasoningEffort }
        }
        let run
        try {
          // Foreground = one activation the CALLER awaits and disposes; it
          // announces no settlement message, so the tool result stays the only
          // channel back to this agent.
          run = await startWorker(ctx, {
            provider,
            label: args.description,
            request,
            signal: exec.signal,
            mode: 'foreground',
          })
          const result = await run.result
          if (result.stopReason !== 'completed') {
            const partial = result.output
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('')
            throw new Error(`subagent 运行异常结束（${String(result.stopReason)}）`
              + (partial === '' ? '' : `\n运行结束前的部分输出：\n${partial}`))
          }
          return {
            kind: 'foreground',
            output: result.output,
            model: selected.key,
            modalities: selected.modalities,
            effort: effort.label,
            ...reservedNotice === undefined ? {} : { notice: reservedNotice },
          }
        } finally {
          const childId = pendingForeground?.childId
          pendingForeground = undefined
          if (childId !== undefined) pendingEfforts.delete(childId)
          if (run !== undefined) await run.dispose()
        }
      },
    }))
  }

  /** Keep registration aligned with both provider and settings availability. */
  const reconcileTool = () => {
    if (disposeTool !== undefined) {
      disposeTool()
      disposeTool = undefined
    }
    if (providerAvailable && allowlistCache.length > 0) mount()
  }

  // Serialize async catalog resolution. A settings edit remounts the tool so
  // the very next request's JSON schema contains the current enum and modality
  // labels, while execute() still performs authoritative current-state checks.
  let refreshChain = Promise.resolve()
  const refreshAllowlist = () => {
    refreshChain = refreshChain.then(async () => {
      const models = configuredModels()
      const key = JSON.stringify([models, configuredEfforts()])
      if (key === cachedKey) return
      const resolved = await resolveAllowlist(ctx, models)
      cachedKey = key
      allowlistCache = resolved
      reconcileTool()
    })
    return refreshChain
  }

  // Live meta-config section: re-rendered on every request. It states the hard
  // policy even when the empty allowlist intentionally leaves no spawn tool.
  ctx.systemPrompt.section({
    name: `meta:${toolName}`,
    order: META_SECTION_ORDER,
    text: () => {
      const current = meta()
      const cap = current?.maxParallelWorkers ?? 0
      const lines = [
        'SUPERVISOR META-CONFIG（监督者元配置；用户所有：Settings -> Plugins -> dsh-main-agent，即本插件在当前 profile 里的入口 id `agi-supervisor-setup`；你运行期间它可能变化 —— 本节始终显示当前值）：',
        allowlistCache.length > 0
          ? `- ${toolName} 必须从这份完整的 worker 白名单中选择恰好一个 \`model\` 选项；不存在隐式默认继承。\`${RUNTIME_MODEL_KEY}\` 若在列，只解析为本次调用回合所捕获的模型路由：\n${allowlistCache.map(entry => `    ${workerModelLabel(entry, configuredEffortFor(workerModelKey(entry)))}`).join('\n')}`
          : `- worker 派生已禁用：不允许任何模型。用户必须在 Settings -> Plugins -> dsh-main-agent 中添加 ${RUNTIME_MODEL_KEY} 或一个固定路由；绝不要用其他委派工具绕过此策略。`,
        ...providerAvailable ? [] : [`- worker 派生不可用：subagent provider "${provider}" 未注册。`],
        '- 每个允许路由的 worker 推理强度由用户在 Plugin Settings 中固定。本工具不暴露任何推理强度参数，Main Agent（监督者）也不能选择或继承推理强度。每个配置值都会在 provider I/O 之前针对实际解析出的 worker 模型校验；provider/default 不发送显式推理强度。',
        cap > 0
          ? `- 并行 worker 上限：${cap}（强制生效 —— 超出即拒绝；等一次收敛，或终止一个 worker）。${config.reservedHumanSlots > 0 ? `另为「人的消息」预留 ${config.reservedHumanSlots} 个槽位，只在存在直接人类消息的回合可用。` : ''}`
          : '- 并行 worker 上限：无限制。',
        `- 自动派生档位 \`proactive=${configuredProactive()}\`：off = 直接拒绝新的派生（用户要求先关掉自动扇出）；observe = 不真派生，只把「本会派出什么」追加到 \`.agi/proposals.jsonl\` 并返回一条说明；auto = 正常派生。改档位在 Settings -> Plugins -> dsh-main-agent。`,
        '- 对正在运行的 worker 调用 `send_message`，消息会在其当前回合的下一步汇入（不会等该回合结束）。空闲 worker 会在之后的某一回合启动。仅当必须立刻停止当前回合时，才先用 `interrupt_agent`。',
        '- worker 存活规则：`list_agents` 的 `running` 状态只能证明驱动还开着，不能证明有实际进展在发生。每次定时巡检都要把具体的新证据（一份报告、变更过的产物/日志、或已完成的步骤）与 NOTES.md 里的上一个检查点对比。绝不重复一句空洞的「仍在运行 / 继续监控」结论。若没有新证据，立即 `send_message` 要求一份简短进展/阻塞报告。若探针之后的下一次巡检仍然毫无变化，就 `interrupt_agent`，记录这次停滞，然后用修订过的任务恢复或重新派生。',
        ...current === undefined ? [] : [
          `- 计时默认值：wakeMinutes=${current.wakeMinutes}（你多久醒来巡检一次 worker；重复计划，单位分钟），questionWaitMinutes=${current.questionWaitMinutes}（等待一个提问多久之后记录假设并继续）。工作区的 .agi/config.json 携带该键时会覆盖它们。`,
        ],
      ]
      return lines.join('\n')
    },
  })

  // Mirror provider lifecycle (sibling load order can register `spawn` later).
  ctx.on('subagent/provider-added', (added) => {
    if (added.name !== provider) return
    providerAvailable = true
    reconcileTool()
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== provider) return
    providerAvailable = false
    reconcileTool()
  })
  if (!providerAvailable) {
    ctx.logger.info(`dsh-main-agent-spawn: provider "${provider}" 尚未注册；"${toolName}" 会在它出现时完成注册`)
  }

  await refreshAllowlist()
  const unsubscribe = ctx.get('supervisorSettings')?.subscribe(() => {
    void refreshAllowlist().catch(error => {
      ctx.logger.warn(`dsh-main-agent-spawn: 刷新 worker 模型失败（${error?.message ?? error}）`)
    })
  })
  if (unsubscribe !== undefined) ctx.effect(() => unsubscribe)
}
