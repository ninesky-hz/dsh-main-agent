/**
 * dsh-main-agent — wake-up policy for the supervisor loop.
 *
 * 纯函数，不碰 ctx：服务端 watchdog（lib/watchdog.js）、`/supervisor/loop`
 * 投影与测试共用同一份判定。
 *
 * 为什么需要这一层：宿主的 schedule 服务（`@deepseek-ai/dsh-schedule`）本身
 * 只是「到点投一条消息」的持久定时器，它不知道监督者现在在等什么。此前本插件
 * 让模型自己 `schedule_create` 一个固定 `every` 间隔 —— 间隔是死的，无法随
 * 「有 worker 在跑 / 在等用户回答 / 连续几轮没进展」变化，于是要么唤醒太密
 * （烧钱），要么太疏（停滞很久才发现）。
 *
 * 这里把「当前状态 → 下一次该隔多久」收敛成一个可测的决定，并把
 * 「谁负责兜底这条提醒」也收敛成 {@link watchdogPlan} 的输出：
 *
 *   arm       服务端补一条自己的兜底提醒（模型这一轮没排）
 *   yield     模型自己排了提醒 —— 服务端让位，撤掉自己的那条
 *   clear     目标已经不活跃 —— 撤掉兜底，别再把人叫醒
 *   none      无事可做（例如宿主没有 schedule 服务）
 *
 * 宿主的下限是 60 秒（`MIN_EVERY_INTERVAL_SECONDS`），本插件的 `wakeMinutes`
 * 只作为「空闲档」的基准，不再是最小间隔的硬约束。
 */

/** Title of the reminder this plugin owns, so it can tell its own row apart. */
export const WATCHDOG_TITLE = 'watchdog · 监督循环兜底'

/** Harness floor for any scheduled wake (`MIN_EVERY_INTERVAL_SECONDS`). */
export const MIN_WAKE_SECONDS = 60

/** Hard ceiling: beyond this a stalled mission is better served by a human. */
export const MAX_IDLE_SECONDS = 1800

/** Per-band bounds: `[floor, ceiling]` in seconds, with a model-facing label. */
export const WAKE_BANDS = {
  worker: { min: 60, max: 120, label: 'worker 还在跑' },
  question: { min: 300, max: 900, label: '在等用户回答' },
  active: { min: 120, max: 900, label: '刚推进完、还没派活' },
  idle: { min: 300, max: 1800, label: '连续几轮没有新证据' },
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value)

/**
 * How long to sleep before the next inspection, given the supervisor's state.
 *
 * Band precedence is deliberate: a running worker is the only thing that can
 * produce news on its own, so it gets the tightest interval; a pending question
 * blocks the mission on the user (long), and a goal that has produced nothing
 * for several rounds backs off exponentially instead of hammering.
 *
 * @param {object} [state]
 * @param {number} [state.runningWorkers] live worker count
 * @param {number} [state.pendingQuestions] questions still awaiting an answer
 * @param {number} [state.idleStreak] consecutive inspections without new evidence
 * @param {number} [state.wakeMinutes] configured idle baseline (minutes)
 * @param {number} [state.questionWaitMinutes] configured question wait (minutes)
 * @returns {{ seconds: number, band: keyof typeof WAKE_BANDS, label: string, reason: string }}
 */
export function adaptiveWake({
  runningWorkers = 0,
  pendingQuestions = 0,
  idleStreak = 0,
  wakeMinutes = 5,
  questionWaitMinutes = 2,
} = {}) {
  const base = clamp(isFiniteNumber(wakeMinutes) ? wakeMinutes * 60 : 300, 60, MAX_IDLE_SECONDS)
  if (isFiniteNumber(runningWorkers) && runningWorkers > 0) {
    const band = WAKE_BANDS.worker
    return {
      seconds: clamp(base, band.min, band.max),
      band: 'worker',
      label: band.label,
      reason: `${runningWorkers} 个 worker 在跑，等它的收敛通知，到点再看一眼`,
    }
  }
  if (isFiniteNumber(pendingQuestions) && pendingQuestions > 0) {
    const band = WAKE_BANDS.question
    const want = isFiniteNumber(questionWaitMinutes) ? questionWaitMinutes * 60 : 120
    return {
      seconds: clamp(want, band.min, band.max),
      band: 'question',
      label: band.label,
      reason: `${pendingQuestions} 个提问在等用户，按问题等待时长复查一次`,
    }
  }
  const streak = isFiniteNumber(idleStreak) ? Math.max(0, Math.floor(idleStreak)) : 0
  if (streak === 0) {
    const band = WAKE_BANDS.active
    return {
      seconds: clamp(base, band.min, band.max),
      band: 'active',
      label: band.label,
      reason: '目标还在推进，按唤醒间隔复查',
    }
  }
  const band = WAKE_BANDS.idle
  const backoff = base * 2 ** Math.min(streak, 4)
  return {
    seconds: clamp(backoff, band.min, band.max),
    band: 'idle',
    label: band.label,
    reason: `连续 ${streak} 轮没有新证据，退避到 ${clamp(backoff, band.min, band.max)} 秒`,
  }
}

/**
 * Decide which side owns the next wake.
 *
 * @param {object} state
 * @param {boolean} state.goalActive an unfinished goal still owns this session
 * @param {string[]} [state.reminderTitles] titles of currently armed reminders
 * @param {number} [state.seconds] interval this plugin would otherwise use
 * @param {boolean} [state.serviceAvailable] host schedule service is reachable
 * @param {boolean} [state.ownReminderDue] our own row already fires about right
 * @returns {{ action: 'arm' | 'yield' | 'clear' | 'none', seconds?: number, reason: string }}
 */
export function watchdogPlan({
  goalActive,
  reminderTitles = [],
  seconds,
  serviceAvailable = true,
  ownReminderDue = false,
}) {
  if (!serviceAvailable) return { action: 'none', reason: '宿主 schedule 服务不可用' }
  if (!goalActive) return { action: 'clear', reason: '没有进行中的目标，不该再自动唤醒' }
  const titles = Array.isArray(reminderTitles) ? reminderTitles : []
  const foreign = titles.filter(title => title !== WATCHDOG_TITLE)
  if (foreign.length > 0) {
    return { action: 'yield', reason: `这一轮已有 ${foreign.length} 条提醒，交回模型自己排` }
  }
  if (ownReminderDue) {
    return { action: 'none', reason: '兜底提醒已在正确的时间点上' }
  }
  if (!isFiniteNumber(seconds) || seconds <= 0) {
    return { action: 'none', reason: '没有可用的间隔建议' }
  }
  return { action: 'arm', seconds, reason: '这一轮没有留下任何提醒，服务端补一条兜底' }
}

/**
 * Did the supervisor sleep far longer than the interval it planned?
 *
 * The host collapses missed occurrences into one delivery, so a long gap means
 * the world may have moved on: the supervisor should re-ground before it walks
 * the plan forward.
 *
 * @param {object} state
 * @param {number} [state.lastWakeAt] epoch ms of the previous real delivery
 * @param {number} [state.now] epoch ms
 * @param {number} [state.seconds] the interval that was planned
 * @returns {{ stale: boolean, gapSeconds: number, thresholdSeconds: number }}
 */
export function staleWake({ lastWakeAt, now = Date.now(), seconds } = {}) {
  const planned = isFiniteNumber(seconds) && seconds > 0 ? seconds : 300
  const threshold = Math.max(planned * 2, 600)
  if (!isFiniteNumber(lastWakeAt)) return { stale: false, gapSeconds: 0, thresholdSeconds: threshold }
  const gapSeconds = Math.max(0, Math.round((now - lastWakeAt) / 1000))
  return { stale: gapSeconds > threshold, gapSeconds, thresholdSeconds: threshold }
}

/**
 * Consecutive inspections without new evidence.
 *
 * Progress is the workspace's own signal (`progress.jsonl` mtime), so this stays
 * true across process restarts and needs no in-memory counter.
 *
 * @param {object} state
 * @param {number} [state.lastProgressAt] epoch ms, `undefined` when no progress yet
 * @param {number} [state.now]
 * @param {number} [state.seconds] current planned interval
 * @returns {number} 0 while fresh, then 1..4 (capped)
 */
export function idleStreakOf({ lastProgressAt, now = Date.now(), seconds } = {}) {
  // No progress file at all is "unknown", not "abandoned": a workspace whose
  // goal was just locked would otherwise start one step up the backoff ladder
  // and make the first check late.
  if (!isFiniteNumber(lastProgressAt)) return 0
  const interval = (isFiniteNumber(seconds) && seconds > 0 ? seconds : 300) * 1000
  const gap = now - lastProgressAt
  if (gap <= interval) return 0
  return Math.min(4, Math.max(1, Math.floor(gap / interval) - 1))
}

/**
 * Is a running worker past its deadline?
 *
 * @param {object} state
 * @param {number} [state.lastActivityAt] epoch ms of the worker's newest event
 * @param {number} [state.now]
 * @param {number} [state.deadlineMinutes] 0 disables the check
 * @returns {{ exceeded: boolean, stalledMinutes: number }}
 */
export function workerDeadlineExceeded({ lastActivityAt, now = Date.now(), deadlineMinutes = 0 } = {}) {
  if (!isFiniteNumber(deadlineMinutes) || deadlineMinutes <= 0) {
    return { exceeded: false, stalledMinutes: 0 }
  }
  if (!isFiniteNumber(lastActivityAt)) return { exceeded: false, stalledMinutes: 0 }
  const stalledMs = now - lastActivityAt
  const limitMs = deadlineMinutes * 60 * 1000
  return {
    exceeded: stalledMs > limitMs,
    stalledMinutes: Math.round(stalledMs / 60000),
  }
}

/**
 * Human-readable one-liner for the Feed's loop card and the model-facing wake
 * note: what the next interval is and why.
 */
export function describeWake(wake) {
  if (wake === undefined || wake === null) return '—'
  const seconds = wake.seconds
  const human = typeof seconds === 'number'
    ? (seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`)
    : '—'
  return `${human}（${wake.label ?? wake.band ?? '未知'}：${wake.reason ?? ''}）`
}
