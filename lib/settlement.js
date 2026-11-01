/**
 * Final continuable-worker failure diagnostics for the supervisor.
 *
 * The native settlement notice is the authoritative wake: it is delivered
 * only after the child Activation is quiescent, including any request retries.
 * This plugin enriches that one claimed message from the child's durable final
 * `turn/end`; it never observes or reports intermediate request failures.
 */

import { enqueue } from './outbox.js'
import { readReport } from './report.js'
import { sessionEvents } from './session-events.js'

const FAILURE_DETAIL_MAX_CHARS = 2048

/**
 * 收到收敛通知时先把「这件事发生过」写进 `.agi/outbox.jsonl`，再谈富化。
 *
 * 为什么要先存：`agent/pre-step` 的富化结果要经过 `next()` 的决策才可能进入
 * 这一轮。用户插话打断、决策被 reject、模型提前收尾、上下文溢出 —— 任何一种
 * 都会让这次收敛连同它的富化一起消失，而原生通知是**一次性**的，不会重放。
 * 写进 outbox 之后，即使这一轮整轮没走完，下一次 BRIEF 仍然会写出「某个
 * worker 交了活」，主 Agent 也就不会把停摆读成「没事发生」。
 *
 * 三个生产点都在这个模块里，因为读取点只有一个就是这里：
 *   - `settlement`：worker 收敛了（附带它的六态与问题）；
 *   - `worker-report`：六态是 blocked / failed / ready —— 这三种都是「有 worker
 *     在等人」，最不该被某一轮弄丢的那一类。
 *
 * 全部 fail-open：`enqueue` 自己已经绝不抛，这里再包一层 try/catch 兜住
 * 「读 report 本身出意外」的情况，最多 warn 一句。
 *
 * @param {object} agent 主 Agent（取 `session.header.cwd`）
 * @param {object[]} messages pre-step 收到的消息
 * @param {{ warn: Function }} logger
 * @returns {number} 实际看到的 worker 数（诊断用）
 */
function recordSettledWorkers(agent, messages, logger) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    // 拿不到工作区就跳过入队：路径靠猜会把 entry 写到别的工作区里去。
    logger?.warn?.('dsh-main-agent: 收敛消息没有可用的会话工作区，跳过 outbox 入队')
    return 0
  }
  const seen = new Set()
  for (const message of messages) {
    const source = message?.source
    if (source?.kind !== 'subagent-settled') continue
    const workerId = source.senderSessionId
    if (typeof workerId !== 'string' || workerId.length === 0 || seen.has(workerId)) continue
    seen.add(workerId)
    try {
      const report = readReport(cwd, workerId)
      const detail = report.question === undefined
        ? { state: report.state }
        : { state: report.state, question: report.question }
      const queued = enqueue(cwd, { kind: 'settlement', dedupeKey: workerId, detail })
      if (queued.ok !== true) {
        logger?.warn?.(`dsh-main-agent: 收敛通知入队失败（不影响本轮）：${queued.error}`)
      }
      if (report.state === 'blocked' || report.state === 'failed' || report.state === 'ready') {
        enqueue(cwd, {
          kind: 'worker-report',
          dedupeKey: `${workerId}:${report.state}`,
          detail,
        })
      }
    } catch (error) {
      logger?.warn?.(
        `dsh-main-agent: 无法为已收敛的 subagent "${workerId}" 记 outbox：${error?.message ?? error}`,
      )
    }
  }
  return seen.size
}
const FAILURE_PREFIX = 'Terminal failure ['

/** Find when the native settlement message entered the parent's durable inbox. */
function settlementNoticeTime(events, messageId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent/inbox/spliced') continue
    if (event.data?.inserted?.some(message => message.id === messageId)) return event.time
  }
  return undefined
}

/**
 * Return the final durable failure for the Activation that produced a notice.
 * A later successful turn wins earlier retry attempts, and the last
 * `session/end-seed` prevents a resumed child from inheriting an older error.
 */
export function terminalFailureAt(events, notAfter) {
  let terminal
  for (const event of events) {
    if (event.time > notAfter) continue
    if (event.type === 'session/end-seed') {
      terminal = undefined
      continue
    }
    if (event.type === 'turn/end') terminal = event.data.reason
  }
  return terminal?.kind === 'error' ? terminal.error : undefined
}

/** Render bounded model-facing failure detail from the logged provider facts. */
export function renderTerminalFailure(failure) {
  const status = failure.status === undefined ? '' : `; HTTP ${failure.status}`
  const prefix = `${FAILURE_PREFIX}${failure.code}${status}]: `
  const available = Math.max(0, FAILURE_DETAIL_MAX_CHARS - prefix.length)
  const message = failure.message.length <= available
    ? failure.message
    : `${failure.message.slice(0, Math.max(0, available - 1))}…`
  return `${prefix}${message}`
}

function alreadyEnriched(message) {
  return message.content.some(block => block.type === 'text' && block.text.startsWith(FAILURE_PREFIX))
}

function withDiagnostic(message, text) {
  const diagnostic = Object.freeze({ type: 'text', text })
  const [summary, ...rest] = message.content
  const content = Object.freeze(summary === undefined
    ? [diagnostic]
    : [summary, diagnostic, ...rest])
  return Object.freeze({ ...message, content })
}

/**
 * Enrich accepted settlement messages without changing their identity or wake.
 * Inspection is fail-open: the generic native notice remains useful when its
 * child log is unavailable.
 */
export async function enrichSettlementMessages(persistence, parent, messages, signal, logger) {
  const rewritten = await Promise.all(messages.map(async (message) => {
    const source = message.source
    if (source?.kind !== 'subagent-settled' || alreadyEnriched(message)) return message
    const noticeTime = settlementNoticeTime(sessionEvents(parent?.session), message.id)
    if (noticeTime === undefined) return message
    try {
      const child = await persistence.inspect(source.senderSessionId, signal)
      signal.throwIfAborted()
      const failure = terminalFailureAt(child.events, noticeTime)
      return failure === undefined ? message : withDiagnostic(message, renderTerminalFailure(failure))
    } catch (error) {
      if (signal.aborted) throw error
      logger.warn(
        `dsh-main-agent: 无法检查已收敛的 subagent "${source.senderSessionId}"；`
        + `按原样投递原生通知：${error?.message ?? error}`,
      )
      return message
    }
  }))
  return rewritten.every((message, index) => message === messages[index]) ? messages : rewritten
}

/** Register the cooperative pre-step enrichment on this supervisor scope. */
export function installSettlementDiagnostics(ctx) {
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (!messages.some(message => message.source?.kind === 'subagent-settled')) return next()
    // 先存后做：入队必须排在 `next()` 之前。`next()` 之后的富化路径有多个
    // 提前返回（reject、abort、没有 persistence），任何一条走过都会把这次
    // 收敛从这一轮里抹掉 —— 而「抹掉」正是我们要防的那个失败。
    recordSettledWorkers(agent, messages, ctx.logger)
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return decision
    return {
      ...decision,
      messages: await enrichSettlementMessages(
        persistence,
        agent,
        decision.messages,
        signal,
        ctx.logger,
      ),
    }
  })
}
