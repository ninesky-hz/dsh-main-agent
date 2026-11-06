/**
 * Local fold for the Session-owned `schedule/change` log.
 *
 * 为什么需要这一层：`foldScheduleEvents` 曾经由宿主包
 * `@deepseek-ai/dsh-schedule` 导出，插件直接从它 import。dsh-schedule 0.2.2
 * 之后这个导出被移除了（新版本只保留 durable `tasks` 领域表，`schedule/changed`
 * 是宿主事件而不是 Session 日志事件）。静态 import 一个已经不存在的命名导出
 * 会让整个 bundle 在 activate 阶段直接 SyntaxError，监督循环连一行代码都跑
 * 不起来 —— 所以折叠逻辑留在这里，宿主包只当可选的增强。
 *
 * 语义保持旧实现的两个外部约定：
 *   - 严格的 `inheritedEventCount`：必须是 `0..events.length` 的安全整数，
 *     否则抛错（fork 出来的 Session 只能 fold 自己的事件）。
 *   - 返回 `{ active, seenIds }`：`active` 是仍然排着的记录，`seenIds` 是历史
 *     用过的 id，调用方只读 `active`。
 *
 * 转义策略与旧实现不同：旧包对「delete 一个不存在的 id」这类不一致日志直接
 * 抛错，而这里的调用点全是 pre-step / stop 事务，抛错等于把这一轮打断。日志
 * 只当投影看 —— 不一致就跳过这一条，权威状态由 `schedule.list()` 提供。
 *
 * Kept free of Harness imports so the fold can be exercised directly.
 */

const SCHEDULE_EVENT = 'schedule/change'

/** Events that retire a record. */
const RETIRE_OPS = new Set(['delete', 'remove', 'cancel', 'end', 'ended', 'complete', 'completed'])

/** Events that add or replace a record. */
const UPSERT_OPS = new Set(['create', 'add', 'update', 'reschedule', 'arm', 'snooze'])

/** A malformed schedule log; only the fork offset currently raises it. */
export class ScheduleLogError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScheduleLogError'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isoFrom(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/**
 * Next fixed-rate target after one accepted dispatch.
 *
 * 旧实现按记录自己的锚点算下一次；这里没有宿主解析器可用，就用
 * `acceptedAt + everySeconds`，与固定间隔的语义一致，也足够让 watchdog 判断
 * 「还排着一条」。
 */
function nextEveryTarget(record, acceptedAt) {
  const everySeconds = record.everySeconds
  const accepted = typeof acceptedAt === 'string' ? Date.parse(acceptedAt) : Number.NaN
  if (!Number.isSafeInteger(everySeconds) || everySeconds <= 0) return undefined
  if (!Number.isFinite(accepted)) return undefined
  return isoFrom(accepted + everySeconds * 1000)
}

function recordOf(change) {
  const candidate = isRecord(change.schedule) ? change.schedule : isRecord(change.record) ? change.record : undefined
  if (candidate !== undefined) return candidate
  return typeof change.id === 'string' && change.id.length > 0 ? { id: change.id } : undefined
}

/**
 * Fold the package-owned stream after the durable fork seed boundary.
 *
 * @param {ReadonlyArray<object>} events complete ordered Session log
 * @param {number} [inheritedEventCount] inherited prefix length excluded from ownership
 * @returns {{ active: ReadonlyArray<object>, seenIds: ReadonlyArray<string> }}
 */
export function foldScheduleEvents(events, inheritedEventCount = 0) {
  if (!Array.isArray(events)) throw new ScheduleLogError('schedule events must be an array')
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) {
    throw new ScheduleLogError('schedule inheritedEventCount must be within the supplied event log')
  }

  const active = new Map()
  const seenIds = new Set()

  for (const event of events.slice(inheritedEventCount)) {
    if (!isRecord(event) || event.type !== SCHEDULE_EVENT) continue
    const change = isRecord(event.data) ? event.data : undefined
    if (change === undefined) continue
    const operation = typeof change.operation === 'string' ? change.operation : ''

    if (UPSERT_OPS.has(operation)) {
      const record = recordOf(change)
      if (record === undefined || typeof record.id !== 'string' || record.id.length === 0) continue
      seenIds.add(record.id)
      // A re-created/re-armed id replaces the record wholesale; an update merges
      // so a partial change keeps the fields it did not mention.
      const previous = operation === 'update' || operation === 'snooze' ? active.get(record.id) : undefined
      active.set(record.id, previous === undefined ? record : { ...previous, ...record })
      continue
    }

    if (RETIRE_OPS.has(operation)) {
      if (typeof change.id === 'string') active.delete(change.id)
      continue
    }

    if (operation === 'dispatch') {
      const id = typeof change.id === 'string' ? change.id : undefined
      if (id === undefined) continue
      const record = active.get(id)
      // A dispatch for a record this fold never saw (inherited prefix) is not a
      // reason to resurrect or drop anything.
      if (record === undefined) continue
      if (record.kind === 'every') {
        const scheduledAt = nextEveryTarget(record, change.acceptedAt)
        if (scheduledAt === undefined) active.delete(id)
        else active.set(id, { ...record, scheduledAt })
        continue
      }
      // One-shot reminders are consumed by their dispatch.
      active.delete(id)
    }
  }

  return Object.freeze({
    active: Object.freeze([...active.values()]),
    seenIds: Object.freeze([...seenIds]),
  })
}
