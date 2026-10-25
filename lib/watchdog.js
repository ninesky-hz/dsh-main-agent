/**
 * dsh-main-agent — server-side loop watchdog.
 *
 * 这一层的存在理由：循环的连续性此前完全押在「模型记得在每轮末尾再排一条
 * 提醒」上。漏一次，`schedule_create` 没被调用，就没有下一次唤醒 —— 监督者
 * 静默停机，且没有任何东西会报告这件事。提示词再密也堵不住这个洞，因为
 * 「模型这次忘了」正是它的失效模式本身。
 *
 * 所以把兜底搬到服务端：每轮 pre-step（也就是每次唤醒真正开始时）核对三件事
 * ——
 *   1. 还有没有进行中的目标（`ctx.goals`）；
 *   2. 这一轮有没有留下 active 提醒（fold session 事件）；
 *   3. 有没有 worker 还在跑（子代理存活表）。
 *
 * 然后把「下一条提醒归谁」交给 {@link watchdogPlan}：模型自己排了就撤掉我们
 * 这条（yield），没排就由服务端补一条（arm），目标结束了就撤掉（clear）。
 *
 * 两条硬约束，都是踩过的：
 *   - 写提醒必须走宿主 `schedule` 服务。`schedule/change` 的 session 事件只是
 *     日志投影，权威存储是宿主 domain 表（`tasks`），append 事件不会真的排一条。
 *   - 任何失败都 fail-open：兜底是为了让循环活着，绝不能因为它自己出错而把
 *     这一轮打断。
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { foldScheduleEvents } from '@deepseek-ai/dsh-schedule'

import { sessionAgentPreset } from './full-stop.js'
import {
  appendLoopEvent,
  progressMtime,
  readLoopState,
  renderBrief,
  writeBrief,
  writeLoopState,
} from './loop-journal.js'
import {
  adaptiveWake,
  describeWake,
  idleStreakOf,
  idleVerdict,
  REVIEW_EVERY_ROUNDS,
  reviewDue,
  staleWake,
  WATCHDOG_TITLE,
  watchdogPlan,
  workerDeadlineExceeded,
} from './loop-policy.js'
import { sessionEvents, sessionInheritedEventCount } from './session-events.js'
import { continuableChildIds, runningChildIds } from './subagent-compat.js'

/** Supervised preset id; the watchdog only ever acts for root supervisors. */
const PRESET_ID = 'main-agent'

/** Wall-clock unit of the model-facing reminder text. */
const REMINDER_PROMPT = [
  '[watchdog] 服务端兜底唤醒：这一轮结束时没有留下任何提醒，循环会在这里停住。',
  '按监督循环继续：先读 .agi/ 现状（GOAL.md / progress.jsonl / questions.jsonl），',
  '再决定是派活、纠偏、汇报还是收尾。目标已不可能推进就写 mission report 并结束。',
].join('')

/**
 * 定期复核用的提醒文案。
 *
 * 每 {@link REVIEW_EVERY_ROUNDS} 轮问一次「目标本身还成立吗」：循环最贵的
 * 失败不是做错事，而是把三十几轮花在一个已经不成立的目标上。刻意要求先读
 * GOAL.md 再答，避免模型凭上下文里的记忆复述。
 */
const REVIEW_PROMPT = [
  '[watchdog] 到了目标复核轮次：先读一遍 .agi/GOAL.md 与 .agi/progress.jsonl，',
  '然后只回答三个问题 —— 目标还成立吗？剩下的里程碑还值得做吗？预算还够吗？',
  '不成立就写 mission report 并用 update_goal 结束；成立就在 progress.jsonl 记一行「复核通过」再继续。',
].join('')

const isNum = value => typeof value === 'number' && Number.isFinite(value)

/**
 * 判断「这一轮有没有写出新东西」。
 *
 * 用 mtime 的前后关系而不是「有没有 progress 记录」：空转的定义就是**没有
 * 新产出**，而 `progress.jsonl` 只要被 append 就会更新 mtime。所以比 mtime
 * 比内容更接近意图 —— 内容里写「继续观察」也算一次写入，但那是模型骗自己。
 *
 * 缺失值（文件还没建）不参与比较：第一次看到文件就算一次进展。
 *
 * @param {{ lastProgressAt?: number }} [previous]
 * @param {number | undefined} current
 * @returns {{ advanced: boolean, lastProgressAt?: number }}
 */
function advanceProgress(previous, current) {
  const last = previous?.lastProgressAt
  if (!isNum(current)) return { advanced: false, lastProgressAt: isNum(last) ? last : undefined }
  if (!isNum(last)) return { advanced: true, lastProgressAt: current }
  return current > last
    ? { advanced: true, lastProgressAt: current }
    : { advanced: false, lastProgressAt: last }
}

/** `progress.jsonl` records carry `{ ts, text }`; `questions.jsonl` `{ status }`. */
function readAgiFacts(cwd) {  const agi = join(resolve(cwd), '.agi')
  const facts = { lastProgressAt: undefined, pendingQuestions: 0 }
  try {
    const lines = readFileSync(join(agi, 'progress.jsonl'), 'utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const trimmed = lines[index]?.trim()
      if (trimmed === undefined || trimmed === '') continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      const at = Date.parse(record?.ts)
      if (Number.isFinite(at)) {
        facts.lastProgressAt = at
        break
      }
    }
  } catch {
    // An absent log simply means "no evidence yet".
  }
  try {
    for (const line of readFileSync(join(agi, 'questions.jsonl'), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (record?.status === 'pending') facts.pendingQuestions += 1
    }
  } catch {
    // Same: no questions file, nothing pending.
  }
  return facts
}

/** Active reminders as the fold sees them (id + title). */
export function activeReminders(session) {
  const folded = foldScheduleEvents(sessionEvents(session), sessionInheritedEventCount(session))
  return folded.active.map(record => ({
    id: record?.id,
    title: typeof record?.title === 'string' ? record.title : '',
    scheduledAt: typeof record?.scheduledAt === 'string' ? Date.parse(record.scheduledAt) : Number.NaN,
  }))
}

/**
 * Active reminders for one session, read from the AUTHORITATIVE store.
 *
 * `activeReminders` folds the session log, and the log is only a projection:
 * reminders created through the `schedule` service (which is what this watchdog
 * does, and what a durable full-stop needs) never appear there. Reading the
 * fold alone made the watchdog believe it had never armed, so it re-armed every
 * dedupe window and stacked a new reminder each time — observed in the wild as
 * four `watchdog · 监督循环兜底` rows 20 seconds apart.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} session
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ id: string, title: string, scheduledAt: number }>>}
 */
export async function listReminders(ctx, session, { signal } = {}) {
  const schedule = ctx.get('schedule')
  if (schedule !== undefined && typeof schedule.list === 'function') {
    const active = await schedule.list({ sessionId: session?.id }, signal)
    if (Array.isArray(active)) {
      return active.map(record => ({
        id: record?.id,
        title: typeof record?.title === 'string' ? record.title : '',
        scheduledAt: typeof record?.scheduledAt === 'string'
          ? Date.parse(record.scheduledAt)
          : Number.NaN,
      }))
    }
  }
  return activeReminders(session)
}

/** Newest `schedule/change` dispatch time — the approximation of "last real wake". */
export function lastDispatchAt(session) {
  let at
  try {
    for (const event of sessionEvents(session)) {
      if (event?.type !== 'schedule/change') continue
      if (event.data?.operation !== 'dispatch') continue
      if (typeof event.time !== 'number') continue
      at = at === undefined ? event.time : Math.max(at, event.time)
    }
  } catch {
    // An unreadable log simply has no dispatch history.
  }
  return at
}

/** Newest event time of a live agent, used as its last-activity signal. */
function lastActivityAt(agent) {
  if (agent === undefined || agent.session === undefined) return undefined
  const events = sessionEvents(agent.session)
  const newest = events[events.length - 1]
  return typeof newest?.time === 'number' ? newest.time : undefined
}

/**
 * Reconcile the wake-up guarantee for one supervisor session.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} agent live supervisor agent (pre-step payload)
 * @param {{ warn: Function }} log
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ action: string, wake?: object, reason: string }>}
 */
export async function reconcileLoop(ctx, agent, log, { signal } = {}) {
  const meta = ctx.get('supervisorSettings')?.current() ?? {}
  if (meta.watchdogEnabled === false) return { action: 'none', reason: '兜底已关闭' }

  const schedule = ctx.get('schedule')
  if (schedule === undefined || typeof schedule.create !== 'function') {
    return { action: 'none', reason: '宿主没有可用的 schedule 服务' }
  }

  const session = agent.session
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { action: 'none', reason: 'session 没有工作区' }
  }

  const facts = readAgiFacts(cwd)
  const now = Date.now()

  // 产出的判据是 `progress.jsonl` 的 mtime，不是它的内容：模型完全可以在
  // 里面反复写「还在查」，那不算推进；只有真的动了文件，mtime 才会走。
  const previous = readLoopState(cwd)
  const producedAt = advanceProgress(previous, progressMtime(cwd) ?? facts.lastProgressAt)
  const loopState = {
    ...previous,
    idleTicks: producedAt.advanced ? 0 : previous.idleTicks + 1,
    lastProgressAt: producedAt.lastProgressAt,
  }
  writeLoopState(cwd, loopState)
  const verdict = idleVerdict({ idleTicks: loopState.idleTicks })

  const wake = adaptiveWake({
    runningWorkers: 0,
    pendingQuestions: facts.pendingQuestions,
    idleStreak: idleStreakOf({
      lastProgressAt: loopState.lastProgressAt,
      now,
      seconds: (meta.wakeMinutes ?? 5) * 60,
    }),
    wakeMinutes: meta.wakeMinutes,
    questionWaitMinutes: meta.questionWaitMinutes,
  })

  let reminders
  try {
    // Authoritative read: the log projection misses service-created reminders,
    // and missing our own row is exactly what makes the watchdog stack them.
    reminders = await listReminders(ctx, session, { signal })
  } catch (error) {
    log.warn(`dsh-main-agent: 无法读取提醒列表，跳过兜底：${error?.message ?? error}`)
    return { action: 'none', reason: '读取提醒失败' }
  }

  let running = []
  try {
    const children = await ctx.get('subagents')?.listChildren(agent.id, signal)
    running = runningChildIds(ctx, Array.isArray(children) ? children : [])
  } catch {
    // A missing/angry catalog must not block the wake guarantee.
    running = []
  }

  // Worker count wins over the question band: a running worker is the only
  // thing that can produce news without a human.
  const decided = running.length > 0
    ? adaptiveWake({ runningWorkers: running.length, wakeMinutes: meta.wakeMinutes })
    : wake

  const goals = ctx.get('goals')
  const goal = goals?.get(agent)
  // 驱动器的前提是 `phase === 'active' && activation === 'armed'`，这里用同一
  // 判据。原先只排除 `complete`，于是人类刚按下的 pause 会被兜底提醒重新拉
  // 起来 —— 兜底的本意是「别让循环意外停住」，不是「按住了也停不下来」。
  // `activation` 缺失（旧宿主）按 armed 处理，宁可多叫醒一次也别误停。
  const armed = goal === undefined || goal.activation === undefined || goal.activation === 'armed'
  const goalActive = goals === undefined
    ? true
    : goal !== undefined && goal.phase === 'active' && armed

  // 新目标（或人类 resume）开工时清掉上次的暂停标记，否则下一轮真正停下来
  // 时 `goal-stopped` 会被去重逻辑吞掉。
  if (goalActive && loopState.pausedBy !== undefined) {
    writeLoopState(cwd, { pausedBy: undefined, pausedAt: undefined, pausedReason: undefined })
  }

  // 每轮把「现在这几件事」写成 `.agi/BRIEF.md`：提示词里「以持久状态为准」
  // 只是原则，模型真正缺的是「不用翻 40 轮历史就能开始干活」。写失败不影响
  // 兜底（`writeBrief` 内部吞掉异常）。
  writeBrief({
    cwd,
    objective: goal?.objective,
    state: loopState,
    roundsStarted: goal?.roundsStarted,
    maxGoalRounds: goal?.maxGoalRounds,
    phase: goal?.phase,
  })

  // 连续空转到达阈值：与其继续每 N 分钟叫醒一次、每轮都空转，不如停下来把
  // 「为什么停」写进时间线。用 block 而不是 pause —— block 带原因码，重启后
  // 仍能从 goal 状态读到「是被空转停的」，pause 则只留一个 phase。
  if (verdict.action === 'pause' && goals !== undefined && goal !== undefined) {
    appendLoopEvent(cwd, 'loop-paused', {
      reason: verdict.reason,
      idleTicks: loopState.idleTicks,
    })
    writeLoopState(cwd, {
      ...loopState,
      pausedBy: 'idle',
      pausedAt: new Date().toISOString(),
      pausedReason: verdict.reason,
    })
    try {
      await goals.block(
        agent,
        { id: goal.id, revision: goal.revision },
        { code: 'idle', message: verdict.reason },
      )
      return { action: 'block', wake: decided, reason: verdict.reason }
    } catch (error) {
      // 停不下来就退回正常兜底：叫醒一次总比彻底静默强。
      log.warn(`dsh-main-agent: 空转达到阈值但无法结束目标：${error?.message ?? error}`)
    }
  }

  const own = reminders.filter(reminder => reminder.title === WATCHDOG_TITLE)
  // "Already armed" means one of ours lands within 1.5× the recommended wake.
  // An exact-instant match was too brittle (clock, rounding, a band change of a
  // few seconds all read as "never armed" and stacked another reminder).
  const ownHorizon = now + Math.max(decided.seconds * 1.5, 90) * 1000
  const ownDue = own.some(reminder => Number.isFinite(reminder.scheduledAt)
    && reminder.scheduledAt <= ownHorizon)

  const plan = watchdogPlan({
    goalActive,
    reminderTitles: reminders.map(reminder => reminder.title),
    seconds: decided.seconds,
    serviceAvailable: true,
    ownReminderDue: ownDue,
  })

  if (plan.action === 'none') {
    // Our own reminder is already sitting on the right instant — keep it.
    // Deleting here would make `none` and `arm` alternate forever.
    return { action: plan.action, wake: decided, reason: plan.reason }
  }

  if (plan.action === 'yield' || plan.action === 'clear') {
    for (const reminder of own) {
      try {
        await schedule.delete({ sessionId: agent.id, id: reminder.id }, signal)
      } catch (error) {
        log.warn(`dsh-main-agent: 撤掉兜底提醒失败：${error?.message ?? error}`)
      }
    }
    // `clear` = 目标不在 active/armed 上。这正是「循环停下来」的那一刻，值得
    // 记一条带原因的时间线；用 `pausedBy` 去重，否则每轮 pre-step 都会重记。
    if (plan.action === 'clear' && goal !== undefined && loopState.pausedBy === undefined) {
      appendLoopEvent(cwd, 'goal-stopped', {
        reason: `目标已 ${goal.phase}`,
        phase: goal.phase,
        activation: goal.activation,
        roundsStarted: goal.roundsStarted,
      })
      writeLoopState(cwd, { pausedBy: `goal-${goal.phase}` })
    }
    return { action: plan.action, wake: decided, reason: plan.reason }
  }

  // arm: replace our own row (a stale one may fire too early) with a fresh one.
  for (const reminder of own) {
    try {
      await schedule.delete({ sessionId: agent.id, id: reminder.id }, signal)
    } catch {
      // Deleting is best effort; create below still arms the guarantee.
    }
  }

  // 复核窗口到了就把这次的提醒换成「先确认目标还成立」。判定用窗口键而不是
  // 轮次号：同一个窗口里重试多少次都只问一次，重启后也不会重复问。
  const reviewing = goal !== undefined
    && reviewDue({
      roundsStarted: goal.roundsStarted,
      lastReviewRound: loopState.lastReviewRound,
    })
  if (reviewing) {
    appendLoopEvent(cwd, 'round-review', {
      round: goal.roundsStarted,
      objective: goal.objective,
    })
    writeLoopState(cwd, {
      lastReviewRound: Math.floor(goal.roundsStarted / REVIEW_EVERY_ROUNDS),
    })
  }

  try {
    await schedule.create(agent.id, {
      title: WATCHDOG_TITLE,
      prompt: reviewing ? REVIEW_PROMPT : REMINDER_PROMPT,
      after_seconds: decided.seconds,
    }, signal)
  } catch (error) {
    log.warn(`dsh-main-agent: 补兜底提醒失败：${error?.message ?? error}`)
    return { action: 'none', reason: `create 失败：${error?.message ?? error}` }
  }
  return { action: 'arm', wake: decided, reason: describeWake(decided) }
}

/**
 * Interrupt workers that have produced nothing for longer than the deadline.
 *
 * A running worker with a dead provider connection looks exactly like a busy one
 * from the parent's side; the only difference is that its log stops growing.
 *
 * @returns {Promise<Array<{ id: string, stalledMinutes: number }>>} stopped ids
 */
export async function reapStalledWorkers(ctx, agent, log, { signal } = {}) {
  const meta = ctx.get('supervisorSettings')?.current() ?? {}
  const deadline = meta.workerDeadlineMinutes ?? 0
  if (!(deadline > 0)) return []

  let children
  try {
    children = await ctx.get('subagents')?.listChildren(agent.id, signal)
  } catch {
    return []
  }
  const stalled = []
  for (const childId of runningChildIds(ctx, Array.isArray(children) ? children : [])) {
    const verdict = workerDeadlineExceeded({
      lastActivityAt: lastActivityAt(ctx.get('agents')?.get(childId)),
      deadlineMinutes: deadline,
    })
    if (!verdict.exceeded) continue
    try {
      // The host requires the exact live ancestor as authority, not a session id.
      ctx.get('subagents')?.interrupt?.(childId, { kind: 'ancestor', agent })
      stalled.push({ id: childId, stalledMinutes: verdict.stalledMinutes })
      // 中断要留痕：worker 卡死本身不会报错，只会让父代理一直在等，事后
      // 翻时间线时「这一轮为什么没进展」才有答案。
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) {
        appendLoopEvent(cwd, 'worker-reaped', {
          worker: childId,
          stalledMinutes: verdict.stalledMinutes,
        })
      }
      log.warn(`dsh-main-agent: worker ${childId} 已 ${verdict.stalledMinutes} 分钟无动静，已中断`)
    } catch (error) {
      log.warn(`dsh-main-agent: 中断停滞 worker ${childId} 失败：${error?.message ?? error}`)
    }
  }
  return stalled
}

/**
 * Install the watchdog on the supervisor scope.
 *
 * The hook is cooperative and NEVER rejects: a failing reconcile is logged and
 * the turn proceeds, because losing the wake guarantee is bad but blocking the
 * supervisor's only path forward is worse.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn?: Function }} [log]
 */
export function installLoopWatchdog(ctx, log = console) {
  /** One reconcile per session per window: pre-step can run more than once. */
  const lastRun = new Map()
  const WINDOW_MS = 20_000
  let disposed = false
  ctx.effect?.(() => () => { disposed = true })

  ctx.effect?.(() => ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (disposed || decision?.kind === 'reject' || signal?.aborted) return decision
    const session = agent?.session
    if (session === undefined) return decision
    if (session.header?.origin === 'subagent') return decision
    if (sessionAgentPreset(session) !== PRESET_ID) return decision

    const now = Date.now()
    const seen = lastRun.get(agent.id)
    if (seen !== undefined && now - seen < WINDOW_MS) return decision
    lastRun.set(agent.id, now)

    // Intentionally not awaited: the guarantee is about the NEXT wake, so the
    // current turn must not wait on a table write.
    void (async () => {
      try {
        const outcome = await reconcileLoop(ctx, agent, log, { signal })
        if (outcome.action !== 'none') {
          log.info?.(`dsh-main-agent: watchdog ${outcome.action}（${outcome.reason}）`)
        }
        await reapStalledWorkers(ctx, agent, log, { signal })
      } catch (error) {
        log.warn?.(`dsh-main-agent: watchdog 执行失败（不影响本回合）：${error?.message ?? error}`)
      }
    })()
    return decision
  }))
}

/**
 * Planned-interval / staleness snapshot for the Feed and for `/supervisor/loop`.
 * Pure read: no writes, safe to call from a GET handler.
 */
export function loopSnapshot(ctx, agent, { lastDeliveryAt, runningWorkers = 0 } = {}) {
  const meta = ctx.get('supervisorSettings')?.current() ?? {}
  const cwd = agent?.session?.header?.cwd
  const facts = typeof cwd === 'string' && cwd.length > 0
    ? readAgiFacts(cwd)
    : { lastProgressAt: undefined, pendingQuestions: 0 }
  const now = Date.now()
  const wake = adaptiveWake({
    runningWorkers,
    pendingQuestions: facts.pendingQuestions,
    idleStreak: idleStreakOf({
      lastProgressAt: facts.lastProgressAt,
      now,
      seconds: (meta.wakeMinutes ?? 5) * 60,
    }),
    wakeMinutes: meta.wakeMinutes,
    questionWaitMinutes: meta.questionWaitMinutes,
  })
  return {
    wake,
    description: describeWake(wake),
    pendingQuestions: facts.pendingQuestions,
    lastProgressAt: facts.lastProgressAt,
    stale: staleWake({ lastWakeAt: lastDeliveryAt, now, seconds: wake.seconds }),
  }
}
