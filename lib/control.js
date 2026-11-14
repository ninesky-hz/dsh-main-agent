/**
 * dsh-main-agent — `send_message` + `interrupt_agent` + `wait_agent`.
 *
 * Replaces the shipped `@deepseek-ai/dsh-tool-subagent-control` row in the
 * main-agent preset. Same parent-authority surface, two differences:
 *
 * 1. A message to a RUNNING direct child is steered at its next step
 *    (`Agent.steer()`, the same built-in primitive the web UI's queue-steer
 *    action uses), so a correction can redirect work already underway instead
 *    of waiting for the whole turn to finish. Every other case — idle, waiting,
 *    cold-resume, or any authority mismatch — goes through the native
 *    `ctx.subagents.sendMessage()` unchanged.
 * 2. Addressing takes an agent NAME as well as a subagent id. dsh 0.2.2-rc.2
 *    made names the canonical handle: team tasks resolve their `owner` through
 *    `ctx.subagents.resolveName()`, and `list_agents` reports a slash path
 *    (`reviewer/checker`). `resolveName()` also passes an unknown bare token
 *    through unchanged, so one call serves names AND ids — and on a 0.2.1 host,
 *    which has no `resolveName()`, the handle is the session id as before.
 *
 * `wait_agent` is registered only on the rc.2 generation: 0.2.1 hosts still get
 * that tool from the agent-team plugin, and registering a second tool of the
 * same name is a load-time failure, not a shadow.
 *
 * The native service itself is never modified, so the shipped `subagent`/fork
 * tools and report flows keep stock behavior.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSubagentGeneration } from './subagent-compat.js'

export const name = 'dsh-main-agent-control'
export const inject = ['tools', 'subagents', 'agents']

const DEFAULT_WAIT_MS = 30_000
const MIN_WAIT_MS = 10_000
const MAX_WAIT_MS = 3_600_000

/**
 * Resolve the model's target handle to a child session id.
 *
 * The new spelling is `agent` (a name or a slash path from `list_agents`, or a
 * plain session id); the legacy id fields stay accepted so prompts, tests, and
 * recorded transcripts written against the pre-name contract keep working.
 *
 * @param {any} ctx
 * @param {any} caller exact live calling agent
 * @param {{ agent?: string, legacy?: string, legacyField: string }} handle
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import('@deepseek-ai/dsh-session').SessionId>}
 */
async function resolveTarget(ctx, caller, handle, signal) {
  if (handle.agent !== undefined && handle.legacy !== undefined) {
    throw new Error(`agent 与 ${handle.legacyField} 只能给一个：新写法用 agent（list_agents 的 name 或 id），旧写法用 ${handle.legacyField}。`)
  }
  const raw = handle.agent ?? handle.legacy
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`缺少目标：给出 agent（list_agents 返回的 name，可带 / 的路径名，也可以是 id）或 ${handle.legacyField}。`)
  }
  const service = ctx.subagents
  // rc.2 owns the tree-wide name index; it returns the caller for `lead`, and an
  // unknown bare token is handed back as an id, so this is also the id path.
  if (handle.agent !== undefined && typeof service?.resolveName === 'function') {
    const resolved = await service.resolveName(caller, raw, signal)
    return SessionId(String(resolved))
  }
  return SessionId(raw)
}

/**
 * Register the control surface.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      '按 agent 名字（list_agents 的 name，可带 / 的路径名）或 subagent id 向一个后台 subagent 发送消息，继续同一个对话。'
      + '若它仍在工作，消息会在其当前回合的下一步汇入，因此可以改变已经开展的工作的走向 —— '
      + '不要等子级结束，也不要中断，除非当前回合必须立刻停止。若它空闲，消息会启动它的下一轮。'
      + '本次调用不返回 subagent 的任何回答 —— 只返回消息已投递的确认。失败意味着消息没有被投递。',
    parameters: {
      agent: {
        type: 'string',
        description: '目标 agent 的名字（list_agents 返回的 name，多层用 / 连接）或它的 subagent id。',
      },
      subagent_id: {
        type: 'string',
        description: '[旧写法] 目标 subagent 的 session id；新代码请用 agent。',
      },
      message: {
        type: 'string',
        required: true,
        description: '要投递给该 subagent 的消息。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `消息已投递给 ${String(args.agent ?? args.subagent_id)}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('send_message 需要一个调用方 agent（exec.agent 为 undefined）')
      }
      const childId = await resolveTarget(
        ctx,
        parent,
        { agent: args.agent, legacy: args.subagent_id, legacyField: 'subagent_id' },
        exec.signal,
      )
      const content = [{ type: 'text', text: args.message }]
      const source = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }

      // Fast path: the child is live and mid-turn, and this caller is its
      // exact live direct parent — steer into the current turn's next step.
      // The authority predicate mirrors the service's own lineage check
      // (`parentSession === parent.id` + exact live parent); any mismatch or
      // idle/absent child falls through to the native delivery, which owns
      // wake, cold resume, and the authoritative rejection.
      const child = ctx.agents.get(childId)
      if (
        child !== undefined
        && child.status === 'running'
        && ctx.agents.get(parent.id) === parent
        && child.session.header.parentSession === parent.id
      ) {
        exec.signal?.throwIfAborted?.()
        const message = createUserMessage({ content, source })
        child.steer(message)
        // If the child left the registry in the same tick (settlement raced
        // the steer, dispose clears the inbox), re-deliver through the native
        // path so the message is not silently lost.
        if (ctx.agents.get(childId) === child) return { messageId: message.id }
      }

      // `sendMessage` steers a running target at its nearest step, starts a
      // turn for an idle one, and cold-resumes an absent continuable child;
      // attribution is derived from the exact live sender. It requires the
      // signal, so pass the tool's.
      const messageId = await ctx.subagents.sendMessage(parent, childId, content, {
        signal: exec.signal,
      })
      return { messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      '按 agent 名字（list_agents 的 name，可带 / 的路径名）或 agent id 请求取消一个后台 agent 的当前回合。'
      + '目标可以是你的直接子级，也可以是挂在你下面更深层的 agent。只有当前回合会停止：'
      + '已经排队给该 agent 的消息会一直停泊，直到之后再发一次 send_message；'
      + '它启动的 agent 会继续运行，而该 agent 本身仍然可以接受后续消息。'
      + '本次调用在停止请求被接受后立即返回，所以目标可能还会短暂运行；'
      + '去中断一个已经结束的 agent 属于被接受的无操作。',
    parameters: {
      agent: {
        type: 'string',
        description: '要中断的那个正在运行的 agent 的名字（list_agents 的 name，多层用 / 连接）或它的 id。',
      },
      agent_id: {
        type: 'string',
        description: '[旧写法] 要中断的 agent 的 session id；新代码请用 agent。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `已请求中断 ${String(args.agent ?? args.agent_id)}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        throw new Error('interrupt_agent 需要一个调用方 agent（exec.agent 为 undefined）')
      }
      const targetId = await resolveTarget(
        ctx,
        caller,
        { agent: args.agent, legacy: args.agent_id, legacyField: 'agent_id' },
        exec.signal,
      )
      ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: caller })
      return { accepted: true }
    },
  }))

  if (shouldRegisterWait(ctx)) registerWaitAgent(ctx)
}

/**
 * rc.2 only.
 *
 * 0.2.1 hosts (dsh 0.2.2-rc.1) get `wait_agent` from the agent-team plugin, and
 * two registrations of one tool name fail the load. On rc.2 that plugin only
 * keeps the `team_task_*` board, while this preset replaced the row that used to
 * register the wait — so the wait has to live here or disappear from the surface
 * that the team policy still tells the model to call.
 *
 * @param {any} ctx
 */
function shouldRegisterWait(ctx) {
  if (resolveSubagentGeneration(ctx) !== '0.2.2') return false
  try {
    return typeof ctx.tools?.get !== 'function' || ctx.tools.get('wait_agent') === undefined
  } catch {
    return true
  }
}

/**
 * Wait for input at the calling agent's next step.
 *
 * Semantics (mirrors the shipped rc.2 implementation, which this preset's row
 * replacement took off the surface):
 *   - resolves `{ timedOut: false }` as soon as NEW input is pending in the
 *     caller's inbox — agent messages, completion notifications, user steering;
 *   - resolves `{ timedOut: true }` on the timeout;
 *   - pending input that an EARLIER wait of the same model tool call already
 *     reported does not end this wait. That input only reaches the model after
 *     the call finishes, so without the guard a `run_code` loop spins on it.
 *     The dedupe needs `exec.rootCallId`, which 0.2.1 lacks; there it degrades
 *     to "any pending input ends the wait", the pre-fix behavior.
 *
 * @param {any} ctx
 */
function registerWaitAgent(ctx) {
  /** Pending input ids the latest successful wait of one model tool call reported. */
  const reported = new WeakMap()
  const lifetime = new AbortController()
  ctx.effect?.(() => () => {
    lifetime.abort(new Error('wait_agent 随插件卸载结束'))
  }, 'dsh-main-agent.waits()')

  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description:
      '等待你自己下一步的输入（agent 消息、收敛通知、用户插话），有新的输入时立即返回。'
      + '`timedOut: false` 表示有新输入待处理；`timedOut: true` 表示等到超时都没有新输入。'
      + '待处理输入要等本次工具调用结束才会交给模型 —— 这正是「同一次调用里重复等待」不会自旋的原因。'
      + '等待本身不会唤醒任何 agent：要唤醒空闲的 worker，先 send_message。',
    parameters: {
      timeout_ms: {
        type: 'integer',
        description: '等待毫秒数，10000 到 3600000，默认 30000。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { timedOut: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeoutMs = args.timeout_ms ?? DEFAULT_WAIT_MS
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_WAIT_MS || timeoutMs > MAX_WAIT_MS) {
        throw new Error(`timeout_ms 必须是 ${MIN_WAIT_MS} 到 ${MAX_WAIT_MS} 之间的整数`)
      }
      if (exec.agent === undefined) {
        throw new Error('wait_agent 需要一个调用方 agent（exec.agent 为 undefined）')
      }
      return await waitForInput(ctx, exec.agent, timeoutMs, exec.signal, lifetime.signal, reported, exec.rootCallId)
    },
  }))
}

/**
 * @param {any} ctx
 * @param {any} agent exact live calling agent
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal caller cancellation
 * @param {AbortSignal} lifetime plugin lifetime
 * @param {WeakMap<any, { rootCallId: string, ids: Set<string> }>} reported
 * @param {string | undefined} rootCallId
 * @returns {Promise<{ timedOut: boolean }>}
 */
function waitForInput(ctx, agent, timeoutMs, signal, lifetime, reported, rootCallId) {
  lifetime.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent) {
    throw new Error('wait_agent 需要仍然存活的调用方 agent')
  }
  const tracked = typeof rootCallId === 'string' && rootCallId !== ''
  const previous = reported.get(agent)
  const seen = tracked && previous?.rootCallId === rootCallId ? previous.ids : undefined

  return new Promise((resolve, reject) => {
    let timer
    let offInserted
    let offDisposed
    const finish = settle => {
      clearTimeout(timer)
      offInserted?.()
      offDisposed?.()
      signal?.removeEventListener?.('abort', onAbort)
      lifetime.removeEventListener('abort', onUnload)
      settle()
    }
    const pendingInput = () => {
      const rows = agent.inbox?.nextStep
      return Array.isArray(rows) ? rows : []
    }
    const onInput = () => {
      const rows = pendingInput()
      if (!rows.some(message => seen?.has(message.id) !== true)) return
      if (tracked) reported.set(agent, { rootCallId, ids: new Set(rows.map(message => message.id)) })
      finish(() => { resolve({ timedOut: false }) })
    }
    const onAbort = () => { finish(() => { reject(signal.reason) }) }
    const onUnload = () => { finish(() => { reject(lifetime.reason) }) }
    // Subscribe before reading pending input so an arrival cannot fall between.
    offInserted = ctx.on('agent/inbox/inserted', payload => {
      const recipient = payload?.agent
      // 0.2.1 emits the bare `{ message }` at the loop boundary; when the
      // recipient is not in the payload, re-reading OUR inbox is still exact.
      if (recipient === undefined || recipient === agent) onInput()
    })
    offDisposed = ctx.on('agent/disposed', payload => {
      if (payload?.agent !== agent) return
      finish(() => { reject(new Error('wait_agent 结束：调用方 agent 已被释放')) })
    })
    signal?.addEventListener?.('abort', onAbort, { once: true })
    lifetime.addEventListener('abort', onUnload, { once: true })
    timer = setTimeout(() => { finish(() => { resolve({ timedOut: true }) }) }, timeoutMs)
    if (signal?.aborted) onAbort()
    else onInput()
  })
}
