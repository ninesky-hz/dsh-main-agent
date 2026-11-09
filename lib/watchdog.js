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
 *     旧版本 dsh 才有的投影（0.2.2 起宿主不再往 Session 日志里写；折叠逻辑
 *     因此收在 `./schedule-fold.js`，不再 import 宿主的命名导出）。
 *     日志投影，权威存储是宿主 domain 表（`tasks`），append 事件不会真的排一条。
 *   - 任何失败都 fail-open：兜底是为了让循环活着，绝不能因为它自己出错而把
 *     这一轮打断。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { foldScheduleEvents } from './schedule-fold.js'
import { ensureReminder, ensureReminderRemoved, listSessionReminders } from './schedule-compat.js'

import { sessionAgentPreset } from './full-stop.js'
import { goalDocDigest, parseGoalFrontMatter } from './goal-policy.js'
import {
  appendLoopEvent,
  progressMtime,
  pruneLoopStates,
  readLoopState,
  sessionKeyOf,
  renderBrief,
  writeBrief,
  writeLoopState,
} from './loop-journal.js'
import {
  adaptiveWake,
  budgetVerdict,
  describeWake,
  idleStreakOf,
  idleVerdict,
  deriveLeaseOverdue,
  MAX_IDLE_SECONDS,
  MIN_WAKE_SECONDS,
  policyDiff,
  policySnapshot,
  REVIEW_EVERY_ROUNDS,
  reviewDue,
  renderPolicyChange,
  staleWake,
  WATCHDOG_TITLE,
  watchdogPlan,
  workerDeadlineExceeded,
} from './loop-policy.js'
import { dueEntries, enqueue, readOutbox } from './outbox.js'
import { collectReports } from './report.js'
import { sessionEvents, sessionInheritedEventCount } from './session-events.js'
import { continuableChildIds, runningChildIds } from './subagent-compat.js'

/** Supervised preset id; the watchdog only ever acts for root supervisors. */
const PRESET_ID = 'main-agent'

/**
 * 本进程的启动时刻。
 *
 * 用它判断「这是重启后的第一次巡检」：`loop-state` 里记着上次巡检时看到的启动
 * 时刻，两者不相等说明中间换过进程 —— 上一次巡检之后发生的事没有话事人，
 * 那些「上次在跑、这次不在跑」的 worker 需要一条恢复 note。
 *
 * 在模块顶层求值（而不是每次巡检取 `Date.now()`）：同一进程里每一轮都必须读到
 * 同一个值，否则每轮都会被判成「刚重启」，恢复 note 会反复入队。
 */
const PROCESS_STARTED_AT = Date.now()

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
 * 冷启动扫描的退避序列（毫秒）。
 *
 * 原来只有 3 秒和 20 秒两次，之后彻底放弃。宿主恢复慢的时候（会话索引重建、
 * profile 迁移、远端工作区挂载），20 秒后 `sessionPersistence` 仍然读不出东西，
 * 扫描就永久失效了 —— 「慢」于是变成了「永远不」。改成逐次拉长但不放弃：
 * 前几次快，后面慢，五次之后仍没恢复的部署由用户下一次交互触发 pre-step。
 */
const SWEEP_DELAYS_MS = [3_000, 20_000, 60_000, 180_000, 600_000]

/**
 * 取 id 的末 8 位（与 `lib/report.js` 的 `shortWorkerId` 同一个口径）。
 *
 * 必须归一：outbox 里的 `dedupeKey` 是完整 UUID（`settlement.js` 直接拿
 * `senderSessionId`），worker 报告里的 `id` 是短号。不归一的话「投递失败」与
 * 「重启恢复」这两件事在生产里永远匹配不上，测试却因为两边都手写同一个 id 而绿。
 *
 * @param {unknown} value
 * @returns {string} 归一后的 id；无法归一返回 `''`
 */
const shortId = value => (typeof value === 'string' && value.length > 0
  ? value.slice(-8)
  : '')

/**
 * 一条 outbox entry 属于哪个 worker。
 *
 * `settlement` 的键就是完整 worker id；`worker-report` 的是 `${id}:${state}`，
 * 所以先按 `:` 切第一段再取短号。
 *
 * @param {unknown} dedupeKey
 * @returns {string}
 */
const keyWorkerId = dedupeKey => (typeof dedupeKey === 'string' ? shortId(dedupeKey.split(':')[0]) : '')

/**
 * 哪些 worker 的消息连续投递失败。
 *
 * 判据只有事实：outbox 里存在一条 `pending`、`attempts >= 3`、且键归一后等于
 * 该 worker id 的 entry。只看 `pending` 是因为 `delivered` 已经是终态；`failed`
 * 状态与「重试到 3 次」在 `lib/outbox.js` 里是同一件事的两种写法，这里都收。
 *
 * 返回 `Set` 而不是数组：调用方是按 worker 逐个查。
 *
 * @param {object[]} entries outbox 全量 entry
 * @param {string[]} ids worker 的短 id
 * @returns {Set<string>} 投递失败的 worker 短 id
 */
export function deliveryFailureIds(entries, ids) {
  const failed = new Set()
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(shortId).filter(id => id.length > 0))
  if (wanted.size === 0) return failed
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.status === 'delivered') continue
    const attempts = Number.isFinite(entry.attempts) ? entry.attempts : 0
    if (entry.status !== 'failed' && attempts < 3) continue
    const id = keyWorkerId(entry.dedupeKey)
    if (wanted.has(id)) failed.add(id)
  }
  return failed
}

/**
 * 重启后该给哪些 worker 补一条「你之前做到哪」的恢复 note。
 *
 * 输入是「上次巡检看见在跑的快照」与「这次巡检的事实」，输出是**按 `at` 升序**
 * 的短 id 列表。规则很短，但每条都是为了让 note 不撒谎：
 *   - 上次在跑、这次不在跑：它的话可能压在一次崩溃里没送到；
 *   - 已经 archived / ended 的跳过：收尾了就不需要「接着做」；
 *   - 快照里同一个 id 出现多次只算一条，取最早的 `at`（重启可能落在任意两次
 *     巡检之间，重复入队没有意义）。
 *
 * 升序而不是随便排：最老的那条最可能已经被人忘了，先让主 Agent 看见它。
 *
 * @param {{ snapshot?: Array<{ id: string, at: number }>, runningIds?: string[], archivedIds?: string[], endedIds?: string[] }} [input]
 * @returns {string[]} 需要恢复的短 id（`at` 升序）
 */
export function recoveryTargets({ snapshot, runningIds, archivedIds, endedIds } = {}) {
  const rows = Array.isArray(snapshot) ? snapshot : []
  const stillRunning = new Set((Array.isArray(runningIds) ? runningIds : []).map(shortId))
  const skip = new Set([
    ...(Array.isArray(archivedIds) ? archivedIds : []).map(shortId),
    ...(Array.isArray(endedIds) ? endedIds : []).map(shortId),
  ])
  const oldest = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = shortId(row.id)
    if (id.length === 0) continue
    if (stillRunning.has(id) || skip.has(id)) continue
    const at = Number.isFinite(row.at) ? row.at : 0
    const seen = oldest.get(id)
    if (seen === undefined || at < seen) oldest.set(id, at)
  }
  return [...oldest.entries()]
    .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)))
    .map(([id]) => id)
}

/**
 * `.agi/loop-state.<key>.json` 的清理是否已经跑过。
 *
 * 每个进程只扫一次：清理是磁盘卫生，不是每轮都该付的 I/O 成本；而会话 id 每轮
 * 不变，重复扫也不会多删一个文件。
 */
let prunedOnce = false

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
  // 空转判定的口径必须包含「写了东西但没记进度」这种情形。旧实现只看
  // `progress.jsonl` 最后一行的 `ts`，于是「改代码、跑测试、写报告」全部算
  // 空转 —— 连续 5 轮就把一个正在干活的循环判停，而且判停之后紧接着的
  // `clear` 会把它刚排好的兜底提醒一起撤掉，循环从此静默。这里把工作区里
  // 其它会被写到的文件也算成活跃信号；`BRIEF.md` 不算 —— 那是本插件自己
  // 每轮重写的，算进去等于永不空转。
  try {
    let newest = facts.lastProgressAt
    const touched = [
      join(agi, 'NOTES.md'),
      join(agi, 'LESSONS.md'),
      join(agi, 'changelog.md'),
    ]
    try {
      for (const name of readdirSync(join(agi, 'subagents'))) {
        touched.push(join(agi, 'subagents', name, 'outcome.md'))
      }
    } catch {
      // 没有 subagents 目录就是没派过活，不是错误。
    }
    for (const file of touched) {
      try {
        const at = statSync(file).mtimeMs
        if (Number.isFinite(at) && (newest === undefined || at > newest)) newest = at
      } catch {
        // 文件不存在等于没有这条信号。
      }
    }
    if (newest !== undefined) facts.lastProgressAt = newest
  } catch {
    // 活跃信号是旁路：读不到就退回只看 progress.jsonl。
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

/**
 * 磁盘上 GOAL.md 的版本事实。
 *
 * 没有文件、读不出来、或 front-matter 解析失败一律返回 `undefined` —— 这三种
 * 都不是「出错了」，而是「这份工作区还没有可比的版本」。汇报它们是噪声，会让人
 * 每轮都去看一个根本不存在的问题。
 *
 * @param {string} cwd
 * @returns {{ revision: number, digest?: string } | undefined}
 */
function readGoalFacts(cwd) {
  let text
  try {
    text = readFileSync(join(resolve(cwd), '.agi', 'GOAL.md'), 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseGoalFrontMatter(text)
  if (parsed === null) return undefined
  return { revision: parsed.revision, digest: goalDocDigest(text) ?? undefined }
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
  const sessionId = session?.id
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    try {
      const rows = await listSessionReminders(schedule, sessionId, signal)
      if (rows.length > 0) return rows
    } catch {
      // 表读不到时退回日志折叠：少一条「我刚排过」，比整轮对账失败轻。
      // 这里刻意不写日志 —— 折叠结果是空的会让上层重新 arm，而 recreate 失败
      // 自己会 warn，重复记一遍只会让同一次故障看起来像两次。
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
 * 哪些事件算「有人读过了上一份 BRIEF」（B8）。
 *
 * 刻意**不含** `turn/start` / `step/start`：摘要是在 pre-step 里写的，那两个事件
 * 往往在同一时刻先落盘，把它们算成「读过」会让这个判据永远为真，功能等于没有。
 * 真正能证明「有个醒着的模型看到了这份摘要」的是它随后做的事：发消息、调工具。
 */
const BRIEF_READ_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/**
 * 上一份 BRIEF（`writtenAt` 那一刻写的）之后，这条会话里有没有出过回合/消息事件。
 *
 * 三个 fail-open：没有基线时刻、日志读不到、日志里没有任何带时间的事件 —— 一律
 * 当成「有活动」。这个判据的用途是报警，误报「没人读」比漏报更贵：它会让主
 * Agent 去查一个其实正常的循环。
 *
 * @param {object} session
 * @param {number | undefined} writtenAt 上一份摘要的写盘时刻
 * @returns {boolean}
 */
function briefSawActivity(session, writtenAt) {
  if (!isNum(writtenAt)) return true
  let events
  try {
    events = sessionEvents(session)
  } catch {
    return true
  }
  if (!Array.isArray(events) || events.length === 0) return true
  let dated = false
  for (const event of events) {
    if (!isNum(event?.time)) continue
    dated = true
    if (event.time > writtenAt && BRIEF_READ_TYPES.has(event.type)) return true
  }
  return !dated
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

  // 同一工作区可能有多个监督者会话，状态按 session 分文件存。缺 id 时退回
  // 单文件（旧行为），至少不会比之前更糟。
  const key = sessionKeyOf(session)

  const facts = readAgiFacts(cwd)
  const now = Date.now()

  // 产出的判据是 `progress.jsonl` 的 mtime，不是它的内容：模型完全可以在
  // 里面反复写「还在查」，那不算推进；只有真的动了文件，mtime 才会走。
  const previous = readLoopState(cwd, key)

  // ── 策略变更重校验（A2）────────────────────────────────────────────────
  // 设置可以在会话中途被改（Settings → Plugins，每次工具调用都重读）。改完之后
  // 上一轮基于旧设置做的判断（上限、档位、唤醒间隔）就不成立了，所以要让模型在
  // 下一轮开头就看见「策略变了」，并按新值重新校验已经在跑的那批 worker。
  //
  // 首轮 `previous.policyDigest` 是 undefined：那不是「变了」，是「还没有基线」，
  // 只记录不报警。
  const policy = policySnapshot(meta)
  const policyMoved = typeof previous.policyDigest === 'string'
    && previous.policyDigest.length > 0
    && previous.policyDigest !== policy.digest

  // ── GOAL.md 版本事实（B7）──────────────────────────────────────────────
  // 人可以直接改 GOAL.md（编辑器、git checkout、另一个 agent）。循环要是还按
  // 上下文里那份旧目标推进，就会去做一件人已经取消的事。这里只比对磁盘事实。
  const goalFacts = readGoalFacts(cwd)
  const goalKnown = Number.isSafeInteger(previous.goalRevision) && goalFacts !== undefined
  const goalRevisionMoved = goalKnown && previous.goalRevision !== goalFacts.revision
  const goalDigestMoved = goalKnown
    && typeof previous.goalDigest === 'string'
    && previous.goalDigest !== goalFacts.digest

  const producedAt = advanceProgress(previous, progressMtime(cwd) ?? facts.lastProgressAt)
  // 上一轮花了多久：两次推进之间的间隔就是一轮的近似时长。没有推进时保留上次
  // 的值 —— 「这一轮还没结束」不该被写成「这一轮用了 0 分钟」。
  const gapMs = producedAt.advanced
    && isNum(previous.lastProgressAt)
    && isNum(producedAt.lastProgressAt)
    ? Math.max(0, producedAt.lastProgressAt - previous.lastProgressAt)
    : previous.lastGapMs
  const loopState = {
    ...previous,
    idleTicks: producedAt.advanced ? 0 : previous.idleTicks + 1,
    lastProgressAt: producedAt.lastProgressAt,
    lastGapMs: gapMs,
  }
  writeLoopState(cwd, loopState, key)
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

  // `children` 要活到下面的 `writeBrief`：摘要里「这个 worker 还可能在跑吗」
  // 靠的是 catalog（`continuableChildIds`），而不是 liveness —— 一个收敛但没归档
  // 的真 worker 与一个根本不是 session 的历史目录，两者都不在跑，但只有后者
  // 是「已结束」。
  //
  // 读不到 catalog（服务缺失 / 调用抛错）时 `children` 保持 `undefined`，而不是
  // 退化成空数组：空数组会让 `collectReports` 把每个目录都判成 `known: false`
  // （= 已结束），而「我不知道」绝不能写成「它已经没了」。
  let children
  let running = []
  try {
    const listed = await ctx.get('subagents')?.listChildren(agent.id, signal)
    children = Array.isArray(listed) ? listed : undefined
    running = children === undefined ? [] : runningChildIds(ctx, children)
  } catch {
    // A missing/angry catalog must not block the wake guarantee.
    running = []
    children = undefined
  }

  // 这一轮 worker 的静态事实：报告、是否在跑、是否已验收、是否还在 catalog 里。
  // 只算一次，恢复 note 与 BRIEF 共用同一份判断 —— 两处各算一遍迟早会分叉，
  // 而分叉的结果是「摘要说它没了、恢复 note 却在叫它接着做」。
  const reports = collectReports(
    cwd,
    running,
    children === undefined ? undefined : new Set(continuableChildIds(children)),
  )
  const runningReports = reports.filter(report => report.running === true)

  // 变更必须先落时间线、再进摘要：`policy-changed` / `goal-revised` 是「这一轮
  // 为什么换了做法」的唯一持久解释，BRIEF 只是当轮的投影。只在这里算一次，
  // 事件与摘要共用同一份判断 —— 两处各算一遍会让它们说的是两件事。
  let policyChange
  if (policyMoved) {
    const changed = policyDiff(previous.policyValues, policy.values)
    appendLoopEvent(cwd, 'policy-changed', {
      session: key,
      from: previous.policyDigest,
      to: policy.digest,
      changed,
    })
    policyChange = renderPolicyChange(changed, { running: runningReports.length })
      // 旧状态里没有逐个值可对比时（本特性上线前写下的 loop-state），逐项差异
      // 是空的 —— 但「变了」这件事仍然成立，必须说出来，否则这一轮看起来什么
      // 也没发生，而模型正需要按新设置重新校验。
      || '- 策略已变更：上一版没有逐项记录，本轮起按当前设置重新校验'
  }
  let goalChange
  if (goalRevisionMoved || goalDigestMoved) {
    appendLoopEvent(cwd, 'goal-revised', {
      session: key,
      from: previous.goalRevision,
      to: goalFacts.revision,
      digestChanged: goalDigestMoved,
    })
    goalChange = goalRevisionMoved
      ? `- GOAL.md 已被修改：revision ${previous.goalRevision}→${goalFacts.revision}，本轮起按新版本执行${goalDigestMoved ? '（正文亦有改动）' : ''}`
      // revision 没动、正文却变了：有人在原地改内容而没走 start_goal。同样是
      // 「目标已经不是原来那份」，同样必须读。
      : `- GOAL.md 已被修改：revision ${goalFacts.revision} 未变但正文有改动，本轮起按新版本执行`
  }

  // 重启后的第一次巡检：`loop-state` 里记的启动时刻与本次进程不同，说明上一次
  // 巡检之后换过进程。那些「上次在跑、这次不在跑」的 worker，它们的话很可能
  // 压在崩溃前的某一轮里没送到 —— 按最老优先补一条恢复 note。
  //
  // 走 outbox 而不是直接 `send_message`：这是原型 effect 队列的原则 —— 只有
  // 落盘的消息才值得用来告诉人「你该接着做什么」，重启一次就丢的消息不行。
  const previousSnapshot = Array.isArray(previous.runningSnapshot) ? previous.runningSnapshot : []
  const seenAt = new Map(previousSnapshot.map(row => [shortId(row.id), row.at]))
  if (previous.hostStartedAt !== PROCESS_STARTED_AT) {
    const targets = recoveryTargets({
      snapshot: previousSnapshot,
      runningIds: runningReports.map(report => report.id),
      archivedIds: reports.filter(report => report.archived === true).map(report => report.id),
      endedIds: reports.filter(report => report.known === false).map(report => report.id),
    })
    for (const id of targets) {
      enqueue(cwd, {
        kind: 'recovery',
        dedupeKey: `recovery:${id}`,
        detail: { worker: id, note: '先查工作区产物与 git 历史确认做到哪，再重做外部动作' },
      })
    }
    if (targets.length > 0) {
      appendLoopEvent(cwd, 'recovery-note', { session: key, workers: targets })
    }
  }

  // 每轮巡检都把「现在在跑的」写成新快照。同一段连续 running 里 `at` 保持不变：
  // 这样「最老优先」排的是真的跑了最久的那个，而不是所有人都等于这一轮的时间戳。
  writeLoopState(cwd, {
    hostStartedAt: PROCESS_STARTED_AT,
    runningSnapshot: runningReports.map(report => ({
      id: report.id,
      at: isNum(seenAt.get(report.id)) ? seenAt.get(report.id) : now,
    })),
    // 这一轮的策略基线与 GOAL.md 版本：下一轮靠它们判断「有没有人改过」。
    // `goalFacts` 为 undefined（没有 GOAL.md / 解析失败）时写 undefined，
    // 按 `writeLoopState` 的语义就是删掉旧值 —— 让「文件没了」不再拿旧版本比对。
    policyDigest: policy.digest,
    policyValues: policy.values,
    goalRevision: goalFacts?.revision,
    goalDigest: goalFacts?.digest,
  }, key)

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
    writeLoopState(cwd, { pausedBy: undefined, pausedAt: undefined, pausedReason: undefined }, key)
  }

  // 唤醒丢失：兜底每一轮都该按上一轮算出的间隔被叫醒。这次发现距上次排提醒
  // 的时间远超那个间隔，说明中间有提醒没兑现（进程重启、服务重启、表被清）。
  // 不算失败、只是慢，但必须留痕 —— 否则「循环比预期慢很多」永远没有解释。
  if (isNum(previous.lastArmAt)) {
    const stale = staleWake({ lastWakeAt: previous.lastArmAt, now, seconds: decided.seconds })
    if (stale.stale) {
      appendLoopEvent(cwd, 'wake-stale', {
        session: key,
        gapSeconds: Math.round(stale.gapSeconds),
        thresholdSeconds: Math.round(stale.thresholdSeconds),
      })
      log.warn?.(`dsh-main-agent: 上次兜底唤醒比预期晚了 ${Math.round(stale.gapSeconds / 60)} 分钟`)
    }
  }

  // 轮次预算续期：只在「快用完了」且「最近确实在产出」时加码，最多两次。
  // 续期写在 BRIEF 之前，这样这一轮的摘要里显示的已经是新上限。
  let budgetGoal = goal
  if (goalActive && goals !== undefined && goal !== undefined) {
    const budget = budgetVerdict({
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      idleTicks: loopState.idleTicks,
      renewals: loopState.renewals,
    })
    if (budget.renew) {
      try {
        await goals.edit(
          agent,
          { id: goal.id, revision: goal.revision },
          { maxGoalRounds: budget.nextRounds },
        )
        writeLoopState(cwd, { renewals: (loopState.renewals ?? 0) + 1 }, key)
        appendLoopEvent(cwd, 'budget-renewed', {
          session: key,
          from: goal.maxGoalRounds,
          to: budget.nextRounds,
          roundsStarted: goal.roundsStarted,
        })
        budgetGoal = { ...goal, maxGoalRounds: budget.nextRounds }
        log.info?.(`dsh-main-agent: ${budget.reason}`)
      } catch (error) {
        log.warn?.(`dsh-main-agent: 续期失败（不影响本轮）：${error?.message ?? error}`)
      }
    }
  }

  // 每轮把「现在这几件事」写成 `.agi/BRIEF.md`：提示词里「以持久状态为准」
  // 只是原则，模型真正缺的是「不用翻 40 轮历史就能开始干活」。写失败不影响
  // 兜底（`writeBrief` 内部吞掉异常）。
  //
  // `outbox` 是这一轮真正该送达的事实（到期的收敛通知 / worker 报告 / 验收失败）。
  // 只在这里传、只在写盘成功后由 `writeBrief` 标记已投递：没送出去的事实会在
  // 下一次摘要里继续出现，而不是随某一轮的失败一起消失。

  // 「消息压根没送到」是这一轮最硬的事实之一：worker 自述什么都以「能收到」为
  // 前提。判据取 outbox 全量而不是 `dueEntries` —— 正在退避重试的 entry 还没
  // 到期，正好是最该被看见的那一条。
  const deliveryFailed = deliveryFailureIds(
    readOutbox(cwd).entries,
    reports.map(report => report.id),
  )

  // ── BRIEF 读回执（B8）──────────────────────────────────────────────────
  // 写盘成功只证明文件系统收到了。真正该问的是：上一份摘要写完之后，这条会话
  // 里有没有出过回合/消息 —— 没有就说明 supervisor 可能没在被唤醒，而那正是
  // 这份摘要永远帮不上忙的原因。判据只取事件，不新增任何 config 键。
  const sawBriefActivity = briefSawActivity(session, previous.brief?.writtenAt)

  const briefOut = writeBrief({
    session: key,
    cwd,
    key,
    sawActivity: sawBriefActivity,
    objective: goal?.objective,
    state: loopState,
    roundsStarted: goal?.roundsStarted,
    maxGoalRounds: budgetGoal?.maxGoalRounds,
    phase: goal?.phase,
    // 这两行在摘要里紧跟在标题后面：先知道「规则/目标变了」，再读进展。
    ...policyChange === undefined ? {} : { policyChange },
    ...goalChange === undefined ? {} : { goalChange },
    outbox: dueEntries(cwd),
    // 第三个入参是 catalog：`known: false` 的目录是历史残留，不是「还在排队」。
    // 不传（catalog 读不到）时 `known` 为 undefined，下游按旧行为处理。
    workers: reports.map(report => (deliveryFailed.has(report.id)
      ? { ...report, deliveryFailed: true }
      : report)),
  })

  // `.agi/loop-state.<key>.json` 每个监督者会话一份、永不自清。清理放在 BRIEF
  // 写盘之后、且每个进程只扫一次（`prunedOnce`）：它是磁盘卫生，不是每轮都该付
  // 的 I/O 成本；`keep_key` 保证当前会话这份无条件留下。
  if (!prunedOnce) {
    prunedOnce = true
    try {
      pruneLoopStates(cwd, { keep: 5, keep_key: key })
    } catch {
      // 清理是旁路，绝不能成为兜底的新故障点。
    }
  }

  // 连续空转到达阈值：与其继续每 N 分钟叫醒一次、每轮都空转，不如停下来把
  // 「为什么停」写进时间线。用 block 而不是 pause —— block 带原因码，重启后
  // 仍能从 goal 状态读到「是被空转停的」，pause 则只留一个 phase。
  if (verdict.action === 'pause' && goals !== undefined && goal !== undefined) {
    appendLoopEvent(cwd, 'loop-paused', {
      session: key,
      reason: verdict.reason,
      idleTicks: loopState.idleTicks,
    })
    writeLoopState(cwd, {
      ...loopState,
      // `loopState` 是这一轮开头读到的旧状态，里面的 `brief` 是上一份回执；
      // 这一份刚由 `writeBrief` 推进过。整份覆盖时带上旧回执会把它打回去。
      brief: briefOut.receipt,
      pausedBy: 'idle',
      pausedAt: new Date().toISOString(),
      pausedReason: verdict.reason,
    }, key)
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

  // 「目标停下来了」和「没有目标」不是一回事，撤提醒要区别对待。
  //
  // 空转判停之后，goal 变成 `blocked`，下一轮 `watchdogPlan` 自然给出
  // `clear` —— 而 `clear` 会把刚排好的兜底提醒删掉。于是整个循环从「每 5 分钟
  // 叫醒一次」直接掉到「零提醒」：进程还活着，但再也没有任何东西会来敲门，
  // 用户看到的就是那句「任务已停止」。待机巡检把这条断链补上：判停只降频，
  // 不撤岗。
  const standby = plan.action === 'clear'
    && goal !== undefined
    && (goal.phase === 'blocked' || loopState.pausedBy === 'idle')
  if (standby) {
    try {
      const created = await ensureReminder(schedule, agent.id, {
        title: WATCHDOG_TITLE,
        prompt: REMINDER_PROMPT,
        afterSeconds: MAX_IDLE_SECONDS,
      }, signal)
      for (const reminder of own) {
        if (created?.id !== undefined && reminder.id === created.id) continue
        try {
          await ensureReminderRemoved(schedule, agent.id, reminder.id, signal)
        } catch (error) {
          log.warn(`dsh-main-agent: 撤掉旧兜底提醒失败：${error?.message ?? error}`)
        }
      }
      writeLoopState(cwd, {
        lastArmAt: now,
        leaseExpiresAt: now + MAX_IDLE_SECONDS * 1000,
      }, key)
      return {
        action: 'arm',
        wake: { seconds: MAX_IDLE_SECONDS, reason: 'idle-standby' },
        reason: `目标已停下（${goal.phase}），改成待机巡检：${Math.round(MAX_IDLE_SECONDS / 60)} 分钟后再看一次`,
      }
    } catch (error) {
      log.warn(`dsh-main-agent: 待机提醒排不上，退回普通收尾：${error?.message ?? error}`)
    }
  }

  if (plan.action === 'yield' || plan.action === 'clear') {
    for (const reminder of own) {
      try {
        await ensureReminderRemoved(schedule, agent.id, reminder.id, signal)
      } catch (error) {
        log.warn(`dsh-main-agent: 撤掉兜底提醒失败：${error?.message ?? error}`)
      }
    }
    // `clear` = 目标不在 active/armed 上。这正是「循环停下来」的那一刻，值得
    // 记一条带原因的时间线；用 `pausedBy` 去重，否则每轮 pre-step 都会重记。
    if (plan.action === 'clear' && goal !== undefined && loopState.pausedBy === undefined) {
      appendLoopEvent(cwd, 'goal-stopped', {
        session: key,
        reason: `目标已 ${goal.phase}`,
        phase: goal.phase,
        activation: goal.activation,
        roundsStarted: goal.roundsStarted,
      })
      writeLoopState(cwd, { pausedBy: `goal-${goal.phase}` }, key)
    }
    return { action: plan.action, wake: decided, reason: plan.reason }
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
      session: key,
      round: goal.roundsStarted,
      objective: goal.objective,
    })
    writeLoopState(cwd, {
      lastReviewRound: Math.floor(goal.roundsStarted / REVIEW_EVERY_ROUNDS),
    }, key)
  }

  // ── lease-first：先建新的，再撤旧的 ─────────────────────────────────────
  //
  // 顺序反过来的写法（先 delete 再 create）在两次调用之间崩溃、被强杀、或
  // 关闭超时，会留下「零提醒」状态：旧的那条已经没了，新的还没建。重启后的
  // 兜底扫描又要靠提醒存在才能把循环拉起来 —— 于是任务永远停在
  // 「任务已停止，等待重新开始」那一行，日志里不留任何痕迹。
  //
  // 改成先建：任意时刻 schedule 表里至少有一条属于本会话的兜底提醒。建的
  // 动作失败就直接返回，把旧的那条**留在原地** —— 它可能早一点响，但不会
  // 不响。这是这里唯一不能省的一条不变式。
  let created
  try {
    created = await ensureReminder(schedule, agent.id, {
      title: WATCHDOG_TITLE,
      prompt: reviewing ? REVIEW_PROMPT : REMINDER_PROMPT,
      afterSeconds: decided.seconds,
    }, signal)
  } catch (error) {
    // 这一行 warn 曾经是唯一线索，而它落在 DSH 进程的 stderr 上，翻不到就等于
    // 没有。两次真实事故（0.22.3 之前是签名错配，0.22.4 是缺 kind）都是靠人
    // 肉怀疑才发现的，所以失败必须留一条**可 grep** 的进度事件。
    log.warn(`dsh-main-agent: 补兜底提醒失败（旧提醒保留）：${error?.message ?? error}`)
    appendLoopEvent(cwd, 'wake-arm-failed', {
      session: key,
      seconds: decided.seconds,
      error: String(error?.message ?? error),
    })
    return { action: 'none', reason: `create 失败：${error?.message ?? error}` }
  }

  // 新的已经落地，才轮到收拾旧的。撤失败只会多出一条（下一轮还会再撤），
  // 不会变成零条。
  const createdId = typeof created?.id === 'string' ? created.id : undefined
  for (const reminder of own) {
    if (createdId !== undefined && reminder.id === createdId) continue
    try {
      await ensureReminderRemoved(schedule, agent.id, reminder.id, signal)
    } catch (error) {
      log.warn(`dsh-main-agent: 撤掉旧兜底提醒失败：${error?.message ?? error}`)
    }
  }

  // `leaseExpiresAt` 是这一轮对「下一次唤醒」的持久承诺。进程在下一轮之前
  // 死掉时，重启扫描只能靠它判断「这条循环本来该醒了却没有」，从而立刻补一次
  // 唤醒，而不是再等一个完整间隔。
  writeLoopState(cwd, {
    lastArmAt: now,
    leaseExpiresAt: now + decided.seconds * 1000,
  }, key)
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
 * 哪些 preset 算「监督者」。
 *
 * `main-agent` 是内置的那一档；其余是用户在设置里打开的。路由层早就按这个
 * 口径判断（`lib/index.js` 的 `countsAsSupervisor`），但 watchdog 这边一直是
 * 硬编码 `=== 'main-agent'` —— 于是「设置里说这个 preset 开了监督循环」和
 * 「watchdog 真的在替它兜底」成了两件事：会话跑在 `cordis` 这类被打开的
 * preset 上时，`pre-step` 每次都被这道守卫挡回去，一块状态都不写，重启后
 * 看起来就是「循环静默停住」。
 *
 * 设置是活的（用户在设置面板里勾选立即生效），所以每次都重新算，不缓存。
 *
 * @param {{ supervisedPresets?: unknown }} [meta] `supervisorSettings.current()`
 * @returns {Set<string>} 允许当作监督者的 preset id
 */
export function deriveSupervisorPresets(meta) {
  const extra = Array.isArray(meta?.supervisedPresets) ? meta.supervisedPresets : []
  const ids = [PRESET_ID]
  for (const id of extra) {
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return new Set(ids)
}

/**
 * 一组会话 header 里，哪些是需要对账的监督者会话。
 *
 * 判据全部来自 header：`origin` 排除子代理、`agentPreset` 只认监督者。
 * header 上没有事件可读时 `sessionAgentPreset` 会回退到 `header.agentPreset`，
 * 正好是这个场景需要的口径 —— 冷启动时能拿到的只有 header，没有事件流。
 *
 * 归档会话不复活：人主动收起的循环，不该因为一次重启又跑起来。
 *
 * @param {Array<object | undefined | null>} headers 候选 header（live 与磁盘快照皆可）
 * @param {{ archivedIds?: string[], presets?: Set<string> }} [options] 已归档会话 id 与监督者 preset 集合
 * @returns {string[]} 去重后的会话 id，按出现顺序
 */
export function filterSupervisorSessionIds(headers, { archivedIds, presets } = {}) {
  const allowed = presets instanceof Set ? presets : deriveSupervisorPresets()
  const archived = new Set(Array.isArray(archivedIds) ? archivedIds : [])
  const ids = []
  for (const header of Array.isArray(headers) ? headers : []) {
    if (header === null || typeof header !== 'object') continue
    if (typeof header.id !== 'string' || header.id.length === 0) continue
    if (ids.includes(header.id) || archived.has(header.id)) continue
    if (header.origin === 'subagent') continue
    if (!allowed.has(sessionAgentPreset({ header }))) continue
    ids.push(header.id)
  }
  return ids
}

/**
 * 候选 header 的两个来源。
 *
 * 为什么两个都要：`sessions.list()` 只有**已经激活**的会话，重启后通常是空的；
 * `sessionPersistence.list()` 是磁盘快照，冷启动时唯一可用的全量视图。反过来
 * 只用持久化的会话又拿不到「这一秒刚开、还没落盘」的那条。两个来源合并去重，
 * 才覆盖「刚崩溃重启」与「重启后过了一会儿」两种时刻。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<object[]>} header 列表（可能含 undefined，由调用方过滤）
 */
async function collectSessionHeaders(ctx) {
  const headers = []
  try {
    const live = ctx.get('sessions')
    if (typeof live?.list === 'function') for (const session of live.list()) headers.push(session?.header)
  } catch {
    // live 读失败不是终点：持久化快照还在下面。
  }
  try {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.list === 'function') {
      for (const snapshot of await persistence.list()) headers.push(snapshot?.header)
    }
  } catch {
    // 持久化也读不到时只扫 live —— 至少不比旧行为更差。
  }
  return headers
}

/**
 * 拿到一个可用的 agent：内存里有就用内存里的，没有就按 id 挂载。
 *
 * 挂载走宿主的 `schedule/resolve-agent` waterfall —— 这正是定时器投递用的
 * 同一个原语，因此不会造出宿主不认的会话。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @returns {Promise<object | undefined>}
 */
async function agentForSession(ctx, sessionId) {
  const live = ctx.get('agents')?.get?.(sessionId)
  if (live !== undefined && live !== null) return live
  if (typeof ctx.waterfall !== 'function') return undefined
  try {
    const resolved = await ctx.waterfall('schedule/resolve-agent', sessionId, () => undefined)
    return resolved === null ? undefined : resolved
  } catch {
    // 宿主不认这个会话（已删除、工作区不在），下一轮扫描还会再试。
    return undefined
  }
}

/**
 * 冷启动时对一个监督者会话的对账：lease 早就过期就直接把唤醒排到 1 秒后，
 * 否则退回普通的 {@link reconcileLoop}。
 *
 * 为什么要分叉：`reconcileLoop` 只会**排一条未来的**提醒。如果循环是因为
 * 崩溃停掉的，那条提醒本来该在半小时前响 —— 再排一条等于让人白等一个完整
 * 间隔。已经过期就直接唤醒，这才是「重新进入 DSH 之后接着干」。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} agent
 * @param {{ warn?: Function, info?: Function }} log
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ action: string, reason: string } | undefined>}
 */
export async function ensureLoopRecovered(ctx, agent, log, { signal } = {}) {
  const session = agent?.session
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const meta = ctx.get('supervisorSettings')?.current() ?? {}
  if (meta.watchdogEnabled === false) return undefined
  const key = sessionKeyOf(session)
  const previous = readLoopState(cwd, key)
  const planned = Math.max(MIN_WAKE_SECONDS, (meta.wakeMinutes ?? 5) * 60)
  const lease = deriveLeaseOverdue({
    leaseExpiresAt: previous.leaseExpiresAt,
    lastArmAt: previous.lastArmAt,
    now: Date.now(),
    seconds: planned,
  })
  if (!lease.overdue) return reconcileLoop(ctx, agent, log, { signal })

  // 同一次过期只补一次：否则每次启动、每轮扫描都会立刻唤醒一遍，把一次崩溃
  // 变成一连串重叠的回合。
  const now = Date.now()
  if (isNum(previous.recoveredAt) && now - previous.recoveredAt < planned * 2000) {
    return reconcileLoop(ctx, agent, log, { signal })
  }

  const schedule = ctx.get('schedule')
  if (typeof schedule?.create !== 'function') return undefined
  try {
    await ensureReminder(schedule, agent.id, {
      title: WATCHDOG_TITLE,
      prompt: REMINDER_PROMPT,
      afterSeconds: 1,
    }, signal)
  } catch (error) {
    log.warn?.(`dsh-main-agent: 补齐错过的唤醒失败：${error?.message ?? error}`)
    return reconcileLoop(ctx, agent, log, { signal })
  }
  writeLoopState(cwd, {
    recoveredAt: now,
    lastArmAt: now,
    leaseExpiresAt: now + planned * 1000,
  }, key)
  appendLoopEvent(cwd, 'wake-recovered', {
    session: key,
    overdueSeconds: lease.overdueSeconds,
  })
  return {
    action: 'recover',
    reason: `补齐错过的唤醒（迟到 ${Math.round(lease.overdueSeconds / 60)} 分钟）`,
  }
}

/**
 * 扫一遍磁盘上所有监督者会话（冷启动兜底的一次完整扫描）。
 *
 * 与旧实现的区别只有一处，但那一处是根因：数据源从
 * `ctx.get('agents').roots()`（内存里已激活的根 agent）换成
 * 「live + 持久化快照」，再按 id 逐个挂载。重启之后 roots() 是空的，
 * 旧扫描扫了个寂寞，循环就永远停在那里。
 *
 * 任何会话失败都不影响其它会话；整个函数不抛。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn?: Function, info?: Function }} log
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ scanned: number, recovered: string[], unresolved: string[] }>}
 */
export async function ensureBootSweep(ctx, log, { signal } = {}) {
  const archivedIds = (() => {
    try {
      const list = ctx.get('workspaceRegistry')?.archivedSessionIds
      return Array.isArray(list) ? list : []
    } catch {
      // 归档集合读不到时按「未归档」处理，宁可多对账一次。
      return []
    }
  })()

  // 扫描的候选集合必须与 `pre-step` 守卫用同一个口径：只认 `main-agent` 会把
  // 「设置里已打开监督循环的 preset」漏掉，那正是重启后循环不再被拉起的一种情形。
  const presets = deriveSupervisorPresets(ctx.get('supervisorSettings')?.current())
  const ids = filterSupervisorSessionIds(await collectSessionHeaders(ctx), { archivedIds, presets })
  const recovered = []
  const unresolved = []

  for (const sessionId of ids) {
    if (signal?.aborted) break
    const agent = await agentForSession(ctx, sessionId)
    if (agent === undefined) {
      unresolved.push(sessionId)
      continue
    }
    try {
      const outcome = await ensureLoopRecovered(ctx, agent, log, { signal })
      if (outcome !== undefined && outcome.action === 'recover') recovered.push(sessionId)
      if (outcome !== undefined && outcome.action !== 'none') {
        log.info?.(`dsh-main-agent: 启动扫描 watchdog ${outcome.action}（${outcome.reason}）`)
      }
      await reapStalledWorkers(ctx, agent, log, { signal })
    } catch (error) {
      log.warn?.(`dsh-main-agent: 启动扫描失败（不影响循环）：${error?.message ?? error}`)
    }
  }

  if (unresolved.length > 0) {
    log.warn?.(`dsh-main-agent: ${unresolved.length} 个监督者会话暂时无法挂载，交给下一次扫描`)
  }
  return { scanned: ids.length, recovered, unresolved }
}

/**
 * 进程内心跳：宿主漏投一次提醒，不该变成「循环永久停住」。
 *
 * 冷启动扫描已经能救「重启后继续干」，但它只在启动时跑；如果提醒是**在运行中**
 * 没被投递（真实发生过：任务落库、`scheduledAt` 正确，但会话日志里没有任何
 * 投递消息），进程还活着，没人会再去看一眼 lease —— 循环就停在那里，直到有人
 * 手动发消息。这个心跳只补这一种情况：读 `leaseExpiresAt`，真过期了才补一条
 * 1 秒后到期的提醒。
 *
 * 三条自我约束：
 * - 只读 `.agi/loop-state.*.json`，**不**跑 `reconcileLoop`（那会每 60 秒重写
 *   一次 BRIEF，把摘要刷成噪音）。
 * - 已经有本会话的兜底提醒就不补（那是排着的，不是丢了的）。
 * - 同一次过期只补一次（`recoveredAt` 去重），否则一次漏投会变成连环唤醒。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn?: Function, info?: Function }} log
 * @param {{ intervalMs?: number }} [options]
 * @returns {() => void} 停止心跳
 */
export function ensureLeaseHeartbeat(ctx, log = console, { intervalMs = 60_000 } = {}) {
  let stopped = false
  const timer = setInterval(() => { void beat() }, intervalMs)
  // 短命进程（测试、CLI 一次调用）不该被这个心跳拖住不退。
  timer.unref?.()

  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }

  async function beat() {
    if (stopped) return
    let ids = []
    try {
      const archivedIds = (() => {
        try {
          const list = ctx.get('workspaceRegistry')?.archivedSessionIds
          return Array.isArray(list) ? list : []
        } catch {
          return []
        }
      })()
      const presets = deriveSupervisorPresets(ctx.get('supervisorSettings')?.current())
      ids = filterSupervisorSessionIds(await collectSessionHeaders(ctx), { archivedIds, presets })
    } catch (error) {
      log.warn?.(`dsh-main-agent: 心跳读不到会话列表：${error?.message ?? error}`)
      return
    }
    for (const sessionId of ids) {
      if (stopped) return
      try {
        await beatOne(sessionId)
      } catch (error) {
        log.warn?.(`dsh-main-agent: 心跳跳过 ${shortId(sessionId)}：${error?.message ?? error}`)
      }
    }
  }

  async function beatOne(sessionId) {
    const meta = ctx.get('supervisorSettings')?.current() ?? {}
    if (meta.watchdogEnabled === false) return
    const agent = await agentForSession(ctx, sessionId)
    if (agent === undefined) return
    const session = agent.session
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const key = sessionKeyOf(session)
    const previous = readLoopState(cwd, key)
    // 从没 arm 过（或已 clear）就没有 lease 可守 —— 那不是「漏投」，是「没排」。
    if (!isNum(previous.lastArmAt) && !isNum(previous.leaseExpiresAt)) return
    const planned = Math.max(MIN_WAKE_SECONDS, (meta.wakeMinutes ?? 5) * 60)
    const now = Date.now()
    const lease = deriveLeaseOverdue({
      leaseExpiresAt: previous.leaseExpiresAt,
      lastArmAt: previous.lastArmAt,
      now,
      seconds: planned,
    })
    if (!lease.overdue) return
    if (isNum(previous.recoveredAt) && now - previous.recoveredAt < planned * 2000) return
    if (previous.pausedBy !== undefined) return

    const schedule = ctx.get('schedule')
    if (typeof schedule?.create !== 'function') return
    // 排着的提醒不算丢：它只是还没到点（或者正在被投递）。
    const pending = await listSessionReminders(schedule, agent.id)
    if (pending.some(reminder => reminder.title === WATCHDOG_TITLE)) return

    await ensureReminder(schedule, agent.id, {
      title: WATCHDOG_TITLE,
      prompt: REMINDER_PROMPT,
      afterSeconds: 1,
    })
    writeLoopState(cwd, {
      recoveredAt: now,
      lastArmAt: now,
      leaseExpiresAt: now + planned * 1000,
    }, key)
    appendLoopEvent(cwd, 'wake-heartbeat', {
      session: key,
      overdueSeconds: lease.overdueSeconds,
    })
    log.info?.(`dsh-main-agent: 心跳发现唤醒漏投，已补一条（迟到 ${Math.round(lease.overdueSeconds / 60)} 分钟）`)
  }

  return stop
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
    if (sessionAgentPreset(session) !== PRESET_ID) {
      // 用户在设置里打开的 preset 也算监督者 —— 这里读的是活的设置，不是启动快照。
      const allowed = deriveSupervisorPresets(ctx.get('supervisorSettings')?.current())
      if (!allowed.has(sessionAgentPreset(session))) return decision
    }

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

  // ── 冷启动兜底 ────────────────────────────────────────────────────────
  //
  // pre-step 只在有回合时才触发，而重启之后最常见的情形恰恰是「会话空闲、
  // 提醒表空了、也没有新消息」—— 那种状态下 pre-step 永远不会来，reconcile
  // 也就永远不会跑，循环静默停在这里，日志里一个字都不留。
  //
  // 扫描本身按 {@link SWEEP_DELAYS_MS} 逐次拉长重试：宿主恢复慢的时候
  // （会话索引重建、profile 迁移、远端工作区挂载），前几次读不出东西是正常的，
  // 而旧实现 20 秒后就永久放弃，于是「慢」变成了「永远不」。
  // 枚举与挂载的逻辑在 {@link ensureBootSweep} 里，独立可测。
  let sweepAttempt = 0
  const sweepTimers = []
  // `unref()` 是必须的：这条链最长拖到 10 分钟，而宿主进程不该为了等一次
  // 兜底扫描而活着（测试进程尤其明显 —— 不 unref 就一直跑到计时器到期）。
  const scheduleSweep = delay => {
    const timer = setTimeout(() => { void runSweep() }, delay)
    timer.unref?.()
    sweepTimers.push(timer)
  }
  const runSweep = async () => {
    if (disposed) return
    try {
      await ensureBootSweep(ctx, log)
    } catch (error) {
      log.warn?.(`dsh-main-agent: 启动扫描异常（不影响循环）：${error?.message ?? error}`)
    }
    sweepAttempt += 1
    if (disposed || sweepAttempt >= SWEEP_DELAYS_MS.length) return
    scheduleSweep(SWEEP_DELAYS_MS[sweepAttempt])
  }
  scheduleSweep(SWEEP_DELAYS_MS[0])

  // 扫描只覆盖「启动那一刻」。运行中漏投（任务落库、`scheduledAt` 正确、但
  // 会话日志里没有任何投递消息）时进程还活着，没人会再回头看 lease —— 心跳
  // 就是这最后一道：过期了才补，没过期一句话都不说。
  const stopHeartbeat = ensureLeaseHeartbeat(ctx, log)

  ctx.effect?.(() => () => {
    for (const timer of sweepTimers) clearTimeout(timer)
    stopHeartbeat()
  })
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
