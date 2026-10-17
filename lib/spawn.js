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
 * through `ctx.subagents.startContinuable` (the native provider `spawn`),
 * per-row worker persona, foreground fallback via `run_in_background: false`.
 * The child model rides `SubagentRequest.agentOptions` — a per-request field
 * the service always supported; only the shipped tool's config hid it.
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettlementDiagnostics } from './settlement.js'
import {
  currentRuntimeModel,
  resolveWorkerEffort,
  RUNTIME_MODEL_KEY,
  selectWorkerModel,
  WORKER_EFFORT_PROVIDER_DEFAULT,
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

  // Exact, one-use bridge from spawn policy to the fresh child's first model
  // request. Continuable starts accept a caller-reserved UUID. Foreground
  // starts allocate internally, so their agent/created edge captures only the
  // newly published direct child before it can make a request. Root listeners
  // are required because ordinary agent-scoped listeners intentionally receive
  // events for that exact agent only; both listeners fail closed on an exact id
  // and unregister with this plugin fiber. Once applied, request/header is the
  // durable authority and neither warm steps nor cold resumes need the bridge.
  const pendingEfforts = new Map()
  let pendingForeground
  ctx.effect(() => ctx.root.on('agent/created', ({ agent }) => {
    const pending = pendingForeground
    if (pending === undefined || agent.session.header.parentSession !== pending.parentId) return
    pending.childId = agent.id
    pendingEfforts.set(agent.id, pending.effort)
  }))
  ctx.effect(() => ctx.root.on('agent/request', async ({ agent }, next) => {
    const effort = pendingEfforts.get(agent.id)
    const request = await next()
    if (effort === undefined) return request
    return { ...request, reasoningEffort: effort }
  }))
  ctx.effect(() => ctx.root.on('session/event', (session, event) => {
    if (event.type === 'request/header') pendingEfforts.delete(session.id)
  }))

  installSettlementDiagnostics(ctx)

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

  // Cap ledger: children this fiber started that have not yet been SEEN
  // active. `listChildren` reports `activity: 'inactive'` both before a child's
  // first turn and after its last, so a freshly spawned worker is invisible to
  // a plain active-count — two same-turn spawns would both see zero. The
  // ledger bridges that gap: an entry counts as an open worker until the child
  // has been observed active and gone inactive again (ran and settled), or
  // never activates within a generous window (startup failure).
  const startingLedger = new Map()
  const LEDGER_STALE_MS = 15 * 60 * 1000

  const openWorkerCount = (children) => {
    const byId = new Map(children.filter(entry => entry.kind === 'child').map(entry => [entry.id, entry]))
    const now = Date.now()
    for (const [childId, state] of startingLedger) {
      const entry = byId.get(childId)
      const active = entry?.activity === 'running'
      if (active) state.wasActive = true
      else if (state.wasActive || now - state.startedAt > LEDGER_STALE_MS) startingLedger.delete(childId)
    }
    const activeCount = children.filter(entry => entry.kind === 'child' && entry.activity === 'running').length
    const startingCount = [...startingLedger.keys()]
      .filter(childId => byId.get(childId)?.activity !== 'running').length
    return activeCount + startingCount
  }

  let allowlistCache = []
  let cachedKey
  let disposeTool
  let providerAvailable = ctx.subagents.getProvider(provider) !== undefined

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
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'continuable'
            ? `已启动 subagent ${value.subagentId}，模型 ${value.model} [${value.modalities.join(',')}]，推理强度 ${value.effort}`
            : `subagent 已完成，模型 ${value.model} [${value.modalities.join(',')}]，推理强度 ${value.effort}\n\n${value.output
                .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
                .map(block => block.text)
                .join('')}`,
        }],
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

        // Enforce the LIVE parallel cap (0 = unlimited): active children plus
        // our own still-starting spawns, read at call time so a settings edit
        // applies to the very next spawn.
        const cap = meta()?.maxParallelWorkers ?? 0
        if (cap > 0) {
          const children = await ctx.subagents.listChildren(parent.id, exec.signal)
          const open = openWorkerCount(children)
          if (open >= cap) {
            throw new Error(
              `已达到并行 worker 上限：已打开 ${open} 个 worker，用户设定的上限是 ${cap}（SUPERVISOR META-CONFIG）。`
              + '请等待一条收敛通知，或 interrupt_agent 一个你不再需要的 worker，'
              + '然后重新派生。',
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
          // remains the sole escalation channel to the parent.
          toolFilter: workerToolFilter(),
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
            started = await ctx.subagents.startContinuable({
              provider,
              label: args.description,
              childId,
              request,
              signal: exec.signal,
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
          }
        }
        if (effort.reasoningEffort !== undefined) {
          pendingForeground = { parentId: parent.id, effort: effort.reasoningEffort }
        }
        let run
        try {
          run = await ctx.subagents.start(provider, { ...request, signal: exec.signal })
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
          ? `- 并行 worker 上限：${cap}（强制生效 —— 超出即拒绝；等一次收敛，或终止一个 worker）。`
          : '- 并行 worker 上限：无限制。',
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
