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

import { createHash } from 'node:crypto'

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
/** 轮次预算最多续几次。续期是给「真的在推进」的目标留余地，不是给空转续命。 */
export const MAX_RENEWALS = 2

/** 用到这个比例才谈续期 —— 太早续等于把预算判定架空。 */
export const RENEW_AT_RATIO = 0.8

/** 每次至少加这么多轮，小幅预算也能看出区别。 */
export const RENEW_MIN_ROUNDS = 20

/**
 * 该不该给这个目标续轮次预算。
 *
 * 只回答「现在续不续」，不关心怎么写入 —— 调用方拿 `nextRounds` 去
 * `goals.edit`。三个门槛缺一不可：用到了 80%、最近确实在产出、还没续过太多次。
 *
 * 最后一条是防呆：一个永远不产出、但每轮都在写文件的目标，`idleTicks` 会被
 * 一直清零，于是续期可以无限进行。上限让它最多再多跑两轮预算就该结束。
 *
 * @param {object} input
 * @param {number} [input.roundsStarted]
 * @param {number} [input.maxGoalRounds]
 * @param {number} [input.idleTicks]
 * @param {number} [input.renewals] 已经续过几次
 * @returns {{ renew: boolean, nextRounds?: number, step?: number, reason: string }}
 */
export function budgetVerdict({
  roundsStarted,
  maxGoalRounds,
  idleTicks = 0,
  renewals = 0,
  maxRenewals = MAX_RENEWALS,
  renewAtRatio = RENEW_AT_RATIO,
  minRounds = RENEW_MIN_ROUNDS,
} = {}) {
  if (!Number.isFinite(maxGoalRounds) || maxGoalRounds <= 0) {
    return { renew: false, reason: '没有轮次上限' }
  }
  // 小预算通常是刻意设的（试水、一次性调查），替用户加码没有道理。
  if (maxGoalRounds < 5) return { renew: false, reason: '预算太小，续期没有意义' }
  if (!Number.isFinite(roundsStarted) || roundsStarted < 0) {
    return { renew: false, reason: '轮次未知' }
  }
  if (renewals >= maxRenewals) {
    return { renew: false, reason: `已经续过 ${renewals} 次` }
  }
  if (idleTicks > 0) {
    return { renew: false, reason: `最近 ${idleTicks} 轮没有产出` }
  }
  const trigger = Math.max(1, Math.floor(maxGoalRounds * renewAtRatio))
  if (roundsStarted < trigger) {
    return { renew: false, reason: `还没到 ${trigger} 轮` }
  }
  const step = Math.max(minRounds, Math.floor(maxGoalRounds / 2))
  const nextRounds = maxGoalRounds + step
  return {
    renew: true,
    nextRounds,
    step,
    reason: `第 ${roundsStarted}/${maxGoalRounds} 轮且有产出，续到 ${nextRounds}`,
  }
}

export function describeWake(wake) {
  if (wake === undefined || wake === null) return '—'
  const seconds = wake.seconds
  const human = typeof seconds === 'number'
    ? (seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`)
    : '—'
  return `${human}（${wake.label ?? wake.band ?? '未知'}：${wake.reason ?? ''}）`
}

/**
 * 连续多少轮「没有任何产出」就该停下来。
 *
 * 取 5 是因为一次派活 + 等 worker + 收尾通常跨 2~3 轮，四轮以内不动手仍然
 * 可能是在读代码；到第五轮还没写任何东西，多半是卡在等一个不会来的条件。
 */
export const IDLE_PAUSE_TICKS = 5

/** 每隔多少轮重新读一次 GOAL.md，确认目标本身还成立。 */
export const REVIEW_EVERY_ROUNDS = 5

/** 按里程碑数估轮次预算时的每项倍数。 */
export const ROUNDS_PER_MILESTONE = 6
export const MIN_SUGGESTED_ROUNDS = 20
export const MAX_SUGGESTED_ROUNDS = 120

/**
 * 把「连续空转计数」翻译成该做什么。
 *
 * 三级而不是两级：`throttle` 只是把唤醒间隔拉到 idle 档，代价是慢一点；
 * `pause` 才真正停下循环。中间这一级让「一轮没动」不至于直接判死。
 *
 * @param {object} state
 * @param {number} [state.idleTicks] 连续无产出的次数
 * @param {number} [state.pauseTicks] 触发暂停的阈值
 * @returns {{ action: 'continue'|'throttle'|'pause', idleTicks: number, pauseTicks: number, reason: string }}
 */
export function idleVerdict({ idleTicks = 0, pauseTicks = IDLE_PAUSE_TICKS } = {}) {
  const ticks = isFiniteNumber(idleTicks) ? Math.max(0, Math.floor(idleTicks)) : 0
  const limit = isFiniteNumber(pauseTicks) && pauseTicks > 0
    ? Math.max(1, Math.floor(pauseTicks))
    : IDLE_PAUSE_TICKS
  if (ticks >= limit) {
    return {
      action: 'pause',
      idleTicks: ticks,
      pauseTicks: limit,
      reason: `连续 ${ticks} 轮没有任何产出，先停在这里等人工确认`,
    }
  }
  if (ticks > 0) {
    return {
      action: 'throttle',
      idleTicks: ticks,
      pauseTicks: limit,
      reason: `已连续 ${ticks} 轮没有新证据，拉长唤醒间隔`,
    }
  }
  return { action: 'continue', idleTicks: 0, pauseTicks: limit, reason: '' }
}

/**
 * 这一轮是否该重新读一遍目标。
 *
 * 用 `floor(rounds / every)` 当键而不是直接比轮次号：这样每跨过一个窗口只
 * 触发一次，`lastReviewRound` 存的就是上次触发时的键，重启后也不会重复问。
 *
 * @param {object} state
 * @param {number} [state.roundsStarted] 已开始的轮次数（从 1 数起）
 * @param {number} [state.lastReviewRound] 上次触发时的窗口键
 * @param {number} [state.every] 窗口大小
 * @returns {boolean}
 */
export function reviewDue({ roundsStarted = 0, lastReviewRound = 0, every = REVIEW_EVERY_ROUNDS } = {}) {
  const rounds = isFiniteNumber(roundsStarted) ? Math.max(0, Math.floor(roundsStarted)) : 0
  const step = isFiniteNumber(every) && every > 0 ? Math.max(1, Math.floor(every)) : REVIEW_EVERY_ROUNDS
  if (rounds < 1) return false
  const window = Math.floor(rounds / step)
  if (window < 1) return false
  return window > (isFiniteNumber(lastReviewRound) ? lastReviewRound : 0)
}

/**
 * 没显式给 `max_goal_rounds` 时，按里程碑数估一个预算。
 *
 * 宿主的默认值是 256，对「六个里程碑」这种规模等于没有上限 —— 预算不起作用
 * 时它就不是约束，只是把「该不该停」这个判断永久推迟。这里按每个里程碑 6
 * 轮给初值，并夹在 20~120 之间：低于 20 连一次「读代码 → 改 → 验」都不够，
 * 高于 120 又回到了「等于没有」。
 *
 * @param {object} state
 * @param {number} [state.milestones] 里程碑条数
 * @param {number} [state.perMilestone]
 * @param {number} [state.min]
 * @param {number} [state.max]
 * @returns {number}
 */
export function suggestedRounds({
  milestones = 0,
  perMilestone = ROUNDS_PER_MILESTONE,
  min = MIN_SUGGESTED_ROUNDS,
  max = MAX_SUGGESTED_ROUNDS,
} = {}) {
  const count = isFiniteNumber(milestones) ? Math.max(0, Math.floor(milestones)) : 0
  const per = isFiniteNumber(perMilestone) && perMilestone > 0
    ? Math.max(1, Math.floor(perMilestone))
    : ROUNDS_PER_MILESTONE
  const floor = isFiniteNumber(min) && min > 0 ? Math.floor(min) : MIN_SUGGESTED_ROUNDS
  const ceil = isFiniteNumber(max) && max > 0 ? Math.floor(max) : MAX_SUGGESTED_ROUNDS
  const upper = Math.max(floor, ceil)
  const raw = count === 0 ? floor : count * per
  return Math.min(upper, Math.max(floor, raw))
}

// ── 策略指纹（A2：策略变更后重新校验）────────────────────────────────────────
//
// 为什么要指纹而不是直接比配置对象：`supervisorSettings.current()` 每次返回的
// 都是一个新对象，逐字段比较会在键顺序、默认值补齐这些无关差异上抖动 —— 于是
// 「策略变了吗」要么天天报警，要么永远报不出来。这里把**只有这五个键**的规范化
// JSON 取哈希，指纹一变就是真的变了。

/**
 * 参与指纹与变更报告的配置键。
 *
 * 刻意只列这五个：它们是「监督者这一轮该怎么做」的全部输入。像
 * `workerModels` 这种列表已经由各自的刷新链处理，放进来说不清楚谁负责重校验。
 */
export const POLICY_KEYS = [
  'maxParallelWorkers',
  'reservedHumanSlots',
  'proactive',
  'wakeMinutes',
  'questionWaitMinutes',
]

/** 缺失的键统一写成 `null`：`undefined` 会让 `JSON.stringify` 把它整个吞掉。 */
const valueOf = (config, key) => {
  const value = config?.[key]
  return value === undefined ? null : value
}

/**
 * 一份策略快照：`{ digest, values }`。
 *
 * `values` 只含 {@link POLICY_KEYS}，顺序与之一致；`digest` 是对规范化 JSON 取
 * 的 sha256 前 12 位十六进制 —— 12 位足够区分同一个人几天里改的几次设置，又短到
 * 可以直接贴在 BRIEF 里。
 *
 * @param {object | undefined} config `supervisorSettings.current()` 的结果
 * @returns {{ digest: string, values: Record<string, unknown> }}
 */
export function policySnapshot(config) {
  const values = {}
  for (const key of POLICY_KEYS) values[key] = valueOf(config, key)
  const digest = createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex').slice(0, 12)
  return { digest, values }
}

/**
 * 两份快照之间真正不同的键。
 *
 * 只按 `POLICY_KEYS` 的顺序输出，`from`/`to` 都是**归一后**的值（缺失即 `null`），
 * 这样渲染出来的 `null→auto` 与真实配置语义一致，而不是少一半。
 *
 * 任一入参不是对象（含数组、null）时返回空数组：拿不到上一份快照就是「不知道」，
 * 「不知道」不能渲染成「一切都变了」。
 *
 * @param {object | undefined} prev 上一轮写入 loop-state 的 `policyValues`
 * @param {object | undefined} next 本轮 `policySnapshot().values`
 * @returns {Array<{ key: string, from: unknown, to: unknown }>}
 */
export function policyDiff(prev, next) {
  const usable = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!usable(prev) || !usable(next)) return []
  const rows = []
  for (const key of POLICY_KEYS) {
    const from = prev[key] === undefined ? null : prev[key]
    const to = next[key] === undefined ? null : next[key]
    if (JSON.stringify(from) !== JSON.stringify(to)) rows.push({ key, from, to })
  }
  return rows
}

/** 变更行里的键必须是非空字符串；否则这行只会渲染出 `null 1→2` 这种噪声。 */
const isNonEmptyKey = value => typeof value === 'string' && value.length > 0

/** 渲染用的值文本：`null` 明确写成 `null`，不让读者以为是空字符串。 */
const renderValue = value => (value === null || value === undefined ? 'null'
  : typeof value === 'object'
    ? JSON.stringify(value)
    : String(value))

/**
 * 把一次策略变更渲染成 BRIEF 里的一行。
 *
 * 只讲两件事：哪个键从什么变成了什么，以及**已经在跑的 worker 不会被回收**。
 * 后半句必须写：否则读到「上限 6→1」的人会以为监督者接下来要杀掉五个 worker。
 *
 * @param {Array<{ key: string, from: unknown, to: unknown }>} diff `policyDiff` 的结果
 * @param {{ running?: number }} [options] 当前仍在跑的 worker 数
 * @returns {string} 以 `- ` 开头的单行；`diff` 为空时返回空串（调用方据此跳过）
 */
export function renderPolicyChange(diff, { running = 0 } = {}) {
  const rows = Array.isArray(diff)
    ? diff.filter(row => row !== null && typeof row === 'object' && isNonEmptyKey(row.key))
    : []
  if (rows.length === 0) return ''
  const body = rows
    .map(row => `${row.key} ${renderValue(row.from)}→${renderValue(row.to)}`)
    .join('、')
  const held = isFiniteNumber(running) && running > 0 ? `；已有 ${running} 个在跑不回收` : ''
  return `- 策略已变更：${body}，本轮起生效${held}`
}
