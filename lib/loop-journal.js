/**
 * dsh-main-agent — 循环记账。
 *
 * 监督者循环有一套外部驱动（宿主的 goal round driver）和一套内部兜底
 * （lib/watchdog.js）。两者都能让循环继续，但谁都不记录「这一轮到底有没有
 * 产出」和「为什么停下来了」—— 于是 40 轮预算可以被空转吃掉，停下来的时候
 * 也没人知道原因。
 *
 * 这里把这两件事落成工作区里的文件，好处是跨进程重启仍然有效：
 *
 *   .agi/loop-state.json   小状态（连续空转计数、上次复核轮次、暂停原因）
 *   .agi/progress.jsonl    追加式事件流（已有格式，`{ts, event, detail}`）
 *   .agi/BRIEF.md          每轮开头该知道的事实摘要（给模型读，也给 Feed 看）
 *
 * 全部操作都对缺失目录/坏 JSON 宽容：记账失败绝不能让循环本身失败。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { EXPECT_FILE } from './checks.js'
import { markDelivered, markFailed, renderOutboxNotice } from './outbox.js'
import { hasPendingQuestion, REPORT_STATES, shortWorkerId } from './report.js'
import { renderStageLabel, workerStage } from './stage.js'

/** 循环状态文件名（相对 `.agi/`）。 */
export const LOOP_STATE_FILE = 'loop-state.json'

/** 状态摘要文件名（相对 `.agi/`）。 */
export const LOOP_BRIEF_FILE = 'BRIEF.md'

/**
 * 工作区里可能同时有多个监督者会话。`.agi/` 是 per-workspace 的，但
 * 「连续空转了几轮」「谁按下的暂停」是 per-session 的事实 —— 共用一份状态会让
 * 两个会话互相把对方的推进判成空转，或者替对方清掉暂停原因。
 *
 * 文件名取 session id 的最后 8 位字母数字：够短、够区分，而且同一会话重启后
 * 仍然是同一个文件。
 *
 * @param {{ id?: unknown } | undefined} session
 * @returns {string | undefined} 无可用 id 时返回 undefined（退回单文件模式）
 */
export function sessionKeyOf(session) {
  const raw = session?.id
  const text = typeof raw === 'string' ? raw : (raw === undefined ? '' : String(raw))
  const cleaned = text.replace(/[^a-zA-Z0-9]/g, '')
  return cleaned.length === 0 ? undefined : cleaned.slice(-8)
}

/** 我们自己写进 `.agi/` 的派生文件，不该进版本库。 */
const IGNORE_ENTRIES = ['.agi/loop-state*.json', '.agi/BRIEF.md']

/** 已经覆盖了上面两条的既有写法（整个 `.agi/` 都被忽略时无需再写）。 */
const IGNORE_COVERING = new Set(['.agi', '.agi/', '/.agi', '/.agi/', '**/.agi', '**/.agi/'])

/** 一次进度记录的形态；与既有 `progress.jsonl` 兼容。 */
const EMPTY_STATE = Object.freeze({
  idleTicks: 0,
  lastProgressAt: undefined,
  lastReviewRound: 0,
  pausedBy: undefined,
  pausedAt: undefined,
  pausedReason: undefined,
  renewals: 0,
  lastGapMs: undefined,
  lastArmAt: undefined,
  // lease（档1）：上一次巡检**承诺过**的下一次唤醒时刻。`lastArmAt` 只说明「我
  // 排过一条」，说明不了「那条该在什么时候响」—— 进程在两次唤醒之间死掉时，
  // 唯一能判断「这条循环已经被放弃了」的就是这个值。
  leaseExpiresAt: undefined,
  // 上一次「补齐错过唤醒」的时刻（档2）：一次崩溃重启可能连续扫好几轮，靠它去重，
  // 否则每多扫一轮就多唤一次。
  recoveredAt: undefined,
  // 上一次巡检时的「进程启动时刻」与「当时正在跑的 worker」。
  // 两个字段一起用来判断「这是重启后的第一次巡检，有谁的话我们没送到」。
  hostStartedAt: undefined,
  runningSnapshot: undefined,
  // 策略指纹（A2）：用户改了设置之后，这一轮必须按新设置重新校验，而不是沿用
  // 上一轮读到的值。`digest` 相同就是没变；`values` 只用来渲染「哪个键变了」。
  policyDigest: undefined,
  policyValues: undefined,
  // GOAL.md 的版本与正文指纹（B7）：磁盘上的目标文件被人改过时，循环必须知道
  // 自己正在按哪一版执行。`goalDigest` 只覆盖 front-matter 之后的正文。
  goalRevision: undefined,
  goalDigest: undefined,
  // BRIEF 的读回执（B8）：摘要写盘成功只证明文件系统收到了，不证明有人读过它。
  // `seq` 是「第几份摘要」，跨重启单调递增；`seenSeq` 是「最后一份被证明读过的」，
  // `unreadStreak` 是「连着几份没人读」。三个数只用来观测，不触发任何动作。
  brief: undefined,
})

/** 跨目标积累的经验，agent 自己在收尾时追加。 */
export const LOOP_LESSONS_FILE = 'LESSONS.md'

const agiDir = cwd => join(resolve(cwd), '.agi')

const loopStatePath = (cwd, key) =>
  join(agiDir(cwd), key === undefined
    ? LOOP_STATE_FILE
    : LOOP_STATE_FILE.replace(/\.json$/, `.${key}.json`))
const briefPath = cwd => join(agiDir(cwd), LOOP_BRIEF_FILE)
const progressPath = cwd => join(agiDir(cwd), 'progress.jsonl')

const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value)

/** 普通对象判据：数组与 null 都不算 —— 策略快照只能是键值对。 */
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 解析 `runningSnapshot`：只保留 `{ id, at }` 都合法的项。
 *
 * 坏数据一律当「没有快照」：恢复 note 宁可少写一条，也不能凭一个坏 id 去猜
 * 「它之前在跑」—— 猜错的代价是让主 Agent 去查一个根本没在工作的 worker。
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, at: number }> | undefined}
 */
function readSnapshot(value) {
  if (!Array.isArray(value)) return undefined
  const rows = []
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue
    if (!isNonEmptyString(row.id) || !isFiniteNumber(row.at)) continue
    rows.push({ id: row.id, at: row.at })
  }
  return rows
}

/**
 * 解析 BRIEF 读回执（B8）：只保留形状对得上的那份，坏数据当「还没有回执」。
 *
 * 宁可丢掉一份读回执、从下一份重新开始数，也不要凭一个坏 `seq` 去报警说
 * 「摘要没人读」—— 误报的代价是让主 Agent 去查一个本来正常的循环。
 *
 * @param {unknown} value
 * @returns {{ seq: number, writtenAt: number, seenSeq: number, unreadStreak: number } | undefined}
 */
function readBrief(value) {
  if (!isPlainObject(value)) return undefined
  if (!Number.isSafeInteger(value.seq) || value.seq <= 0) return undefined
  const count = raw => (Number.isSafeInteger(raw) && raw >= 0 ? raw : 0)
  return {
    seq: value.seq,
    writtenAt: isFiniteNumber(value.writtenAt) ? value.writtenAt : 0,
    seenSeq: Math.min(count(value.seenSeq), value.seq),
    unreadStreak: count(value.unreadStreak),
  }
}

/**
 * 读循环状态。缺失、损坏、或工作区没有 `.agi/` 时返回空状态 ——「不知道」与
 * 「没空转过」在这里是同一件事，因为第一次记账就会写下真实值。
 *
 * @param {string} cwd 会话工作区
 * @param {string} [key] `sessionKeyOf(session)` 的结果；缺省读旧的单文件
 * @returns {typeof EMPTY_STATE}
 */
export function readLoopState(cwd, key) {
  if (!isNonEmptyString(cwd)) return { ...EMPTY_STATE }
  try {
    const parsed = JSON.parse(readFileSync(loopStatePath(cwd, key), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { ...EMPTY_STATE }
    return {
      idleTicks: isFiniteNumber(parsed.idleTicks) ? Math.max(0, Math.floor(parsed.idleTicks)) : 0,
      lastProgressAt: isFiniteNumber(parsed.lastProgressAt) ? parsed.lastProgressAt : undefined,
      lastReviewRound: isFiniteNumber(parsed.lastReviewRound) ? parsed.lastReviewRound : 0,
      pausedBy: isNonEmptyString(parsed.pausedBy) ? parsed.pausedBy : undefined,
      pausedAt: isNonEmptyString(parsed.pausedAt) ? parsed.pausedAt : undefined,
      pausedReason: isNonEmptyString(parsed.pausedReason) ? parsed.pausedReason : undefined,
      renewals: isFiniteNumber(parsed.renewals) ? Math.max(0, Math.floor(parsed.renewals)) : 0,
      lastGapMs: isFiniteNumber(parsed.lastGapMs) ? parsed.lastGapMs : undefined,
      lastArmAt: isFiniteNumber(parsed.lastArmAt) ? parsed.lastArmAt : undefined,
      leaseExpiresAt: isFiniteNumber(parsed.leaseExpiresAt) ? parsed.leaseExpiresAt : undefined,
      recoveredAt: isFiniteNumber(parsed.recoveredAt) ? parsed.recoveredAt : undefined,
      hostStartedAt: isFiniteNumber(parsed.hostStartedAt) ? parsed.hostStartedAt : undefined,
      runningSnapshot: readSnapshot(parsed.runningSnapshot),
      policyDigest: isNonEmptyString(parsed.policyDigest) ? parsed.policyDigest : undefined,
      policyValues: isPlainObject(parsed.policyValues) ? parsed.policyValues : undefined,
      goalRevision: Number.isSafeInteger(parsed.goalRevision) && parsed.goalRevision > 0
        ? parsed.goalRevision
        : undefined,
      goalDigest: isNonEmptyString(parsed.goalDigest) ? parsed.goalDigest : undefined,
      brief: readBrief(parsed.brief),
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

/**
 * 写循环状态。失败只返回 `false`，不抛：记账是旁路，不能成为循环的新故障点。
 *
 * `patch` 里显式传 `undefined` 表示**删掉该键**（而不是「保留旧值」）——
 * 「新目标开工了，把上次的暂停原因清掉」需要这个语义，靠写入空串表达会让
 * 读回来的值既不是空也不是缺失。
 *
 * @param {string} cwd
 * @param {Partial<typeof EMPTY_STATE>} patch 与既有状态合并
 * @param {string} [key] `sessionKeyOf(session)` 的结果；缺省写旧的单文件
 * @returns {boolean} 是否写成功
 */
export function writeLoopState(cwd, patch, key) {
  if (!isNonEmptyString(cwd)) return false
  try {
    mkdirSync(agiDir(cwd), { recursive: true })
    ensureIgnored(cwd)
    const next = { ...readLoopState(cwd, key) }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    writeFileSync(loopStatePath(cwd, key), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 按会话分开的循环状态文件名（`loop-state.<8 位小写字母数字>.json`）。
 *
 * 刻意只认这一个形状：`loop-state.json`（无 key 的旧单文件）以及任何别人放进来
 * 的东西都不在清理范围里。清理宁可少删，也不能误删。
 */
const KEYED_STATE_NAME = /^loop-state\.[0-9a-z]{8}\.json$/

/** 默认保留份数：够覆盖最近开过的几个会话，再多就只是磁盘上的旧噪声。 */
const KEEP_LOOP_STATES = 5

/**
 * 清理按会话分开的 `loop-state.<key>.json`。
 *
 * 为什么需要它：这些状态文件是 per-session 的（见 `sessionKeyOf`），每个新监督
 * 者会话都会开一份新的，谁也不回收旧的。它们被 `.gitignore` 盖住了，版本库里看
 * 不见 —— 磁盘上却一直长。实测一个跑了十来天的工作区里积了 7 份。
 *
 * 三条硬约束：
 *  - 只处理匹配 `loop-state.<8 位字母数字>.json` 的文件，别的一律不碰；
 *  - 按 mtime 降序保留最近 `keep` 个（mtime 才代表「最近还在用」；文件名里的
 *    session 片段没有时间顺序含义）；
 *  - `keep_key` 指定的那一份**无条件保留** —— 删掉正在被这个进程读写的状态，
 *    会把「连续空转计数 / 暂停原因」清成 0，等于让循环健忘。
 *
 * 绝不抛：清理是磁盘卫生，任何单文件失败（被占用、权限不足、刚好消失）都跳过
 * 并继续处理下一个。
 *
 * @param {string} cwd 会话工作区
 * @param {{ keep?: number, keep_key?: string }} [options]
 * @returns {{ removed: string[], kept: string[] }} 绝对路径；`kept` 含 `keep_key` 那一份
 */
export function pruneLoopStates(cwd, { keep = KEEP_LOOP_STATES, keep_key } = {}) {
  if (!isNonEmptyString(cwd)) return { removed: [], kept: [] }
  const dir = agiDir(cwd)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    // 还没有 `.agi/`，也就没有任何东西可清。
    return { removed: [], kept: [] }
  }

  const limit = Number.isInteger(keep) && keep >= 0 ? keep : KEEP_LOOP_STATES
  const pinned = isNonEmptyString(keep_key) ? `loop-state.${keep_key}.json` : undefined

  const candidates = []
  for (const name of names) {
    if (!KEYED_STATE_NAME.test(name)) continue
    const abs = join(dir, name)
    let mtimeMs
    try {
      const stat = statSync(abs)
      if (!stat.isFile()) continue
      mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
    } catch {
      // 单个 stat 失败（刚好被删）不该让整轮清理放弃。
      continue
    }
    candidates.push({ name, abs, mtimeMs })
  }
  // 新的在前；mtime 相同时按名字倒序，保证每次跑出来的是同一组（否则同样输入
  // 可能清掉不同的两份，测试也会飘）。
  candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  )

  const kept = []
  const doomed = []
  candidates.forEach((entry, index) => {
    if (entry.name === pinned || index < limit) kept.push(entry.abs)
    else doomed.push(entry.abs)
  })

  const removed = []
  for (const abs of doomed) {
    try {
      unlinkSync(abs)
      removed.push(abs)
    } catch {
      // 删不掉的留到下次，但绝不因此中断。
    }
  }
  return { removed, kept }
}

/**
 * 追加一条循环事件到 `progress.jsonl`。
 *
 * 刻意复用既有格式而不是新开文件：`.agi/progress.jsonl` 已经是 Feed、watchdog、
 * 人工复盘共用的时间线，多一条事件类型比多一个文件更容易被现有读取方看见。
 *
 * @param {string} cwd
 * @param {string} event 事件名（`goal-stopped` 等）
 * @param {object} [detail] 结构化补充信息
 * @returns {boolean} 是否写成功
 */
export function appendLoopEvent(cwd, event, detail = {}) {
  if (!isNonEmptyString(cwd) || !isNonEmptyString(event)) return false
  try {
    mkdirSync(agiDir(cwd), { recursive: true })
    const record = {
      ts: new Date().toISOString(),
      event,
      ...(detail !== null && typeof detail === 'object' ? { detail } : {}),
    }
    appendFileSync(progressPath(cwd), `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读回最近的事件（最多 `limit` 条，按文件顺序）。 */
export function readLoopEvents(cwd, limit = 200) {
  if (!isNonEmptyString(cwd)) return []
  try {
    const text = readFileSync(progressPath(cwd), 'utf8')
    const events = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') events.push(parsed)
      } catch {
        // 单行坏掉不该让整条时间线不可读。
      }
    }
    return events.slice(-Math.max(1, limit))
  } catch {
    return []
  }
}

/** `progress.jsonl` 的 mtime（epoch ms）；文件不存在时 `undefined`。 */
export function progressMtime(cwd) {
  if (!isNonEmptyString(cwd)) return undefined
  try {
    // 用 `statSync` 而不是读文件：这里只需要「上次写是什么时候」，别为它把
    // 整条时间线读进内存。文件不存在时 statSync 抛 ENOENT，落到下面的 catch。
    const { mtimeMs } = statSync(progressPath(cwd))
    return isFiniteNumber(mtimeMs) ? mtimeMs : undefined
  } catch {
    return undefined
  }
}

/**
 * 读上一个目标留下的教训（`.agi/LESSONS.md` 的最后几条）。
 *
 * 这份文件不由我们生成 —— 它是 agent 在收尾时自己写的散文，这里只负责把最后
 * 几条捞出来放进摘要，让下一个目标不必从零学起同一个坑。
 *
 * @param {string} cwd
 * @param {number} [limit]
 * @returns {string[]} 条目文本（已去掉列表符号），最新在后
 */
export function readLessons(cwd, limit = 5) {
  if (!isNonEmptyString(cwd)) return []
  let raw
  try {
    raw = readFileSync(join(agiDir(cwd), LOOP_LESSONS_FILE), 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const body = trimmed.slice(2).trim()
    if (body.length > 0) entries.push(body)
  }
  return entries.slice(-Math.max(1, limit))
}

/** 已确认过的 `.gitignore`，避免每轮重复读盘。 */
const ignoredOnce = new Set()

/**
 * 确保 `.gitignore` 里盖住了我们写的派生文件。
 *
 * `loop-state*.json` 与 `BRIEF.md` 每轮都被重写，它们是运行时缓存而不是源码；
 * 不忽略的话，任何用 git 的项目每跑一轮就会多出几条未跟踪改动，把人真正的
 * 改动淹掉。整个 `.agi/` 已经被忽略时什么都不做。
 *
 * @param {string} cwd
 * @returns {boolean} 是否已覆盖（或已成功追加）
 */
export function ensureIgnored(cwd) {
  if (!isNonEmptyString(cwd)) return false
  let root
  try {
    root = resolve(cwd)
  } catch {
    return false
  }
  if (ignoredOnce.has(root)) return true
  const path = join(root, '.gitignore')
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 没有 .gitignore（或读不了）—— 下面按空文件处理，只写我们这两条。
  }
  const lines = text.split('\n').map(line => line.trim())
  if (lines.some(line => IGNORE_COVERING.has(line))) {
    ignoredOnce.add(root)
    return true
  }
  const missing = IGNORE_ENTRIES.filter(entry => !lines.includes(entry))
  if (missing.length === 0) {
    ignoredOnce.add(root)
    return true
  }
  try {
    const prefix = text.length === 0
      ? '# dsh-main-agent 的循环记账（每轮重写，不是源码）\n'
      : `${text.endsWith('\n') ? '' : '\n'}\n# dsh-main-agent 的循环记账（每轮重写，不是源码）\n`
    appendFileSync(path, `${prefix}${missing.join('\n')}\n`, 'utf8')
    ignoredOnce.add(root)
    return true
  } catch {
    return false
  }
}

/**
 * 一条进度记录的事件名。
 *
 * `.agi/progress.jsonl` 里混着两代格式：老记录是 `{ts, text}`（人写的进展），
 * 新记录是 `{ts, event, detail}`（`appendLoopEvent` 写的）。直接读 `event.event`
 * 会在老记录上得到 `undefined`，BRIEF 里就出现 `- 2026-10-30T...Z `undefined``
 * —— 一行既没信息又像坏了的数据。所以统一在这里归一。
 *
 * @param {object} event
 * @returns {string}
 */
const eventName = event => {
  const raw = event?.event ?? event?.kind
  return isNonEmptyString(raw) ? raw : 'progress'
}

/** 取第一个非空字符串；全空时返回 `''`（绝不返回字面量 `undefined`）。 */
const firstText = (...values) => {
  for (const value of values) {
    if (isNonEmptyString(value)) return value
  }
  return ''
}

/**
 * 渲染「## Worker 状态」段的行。
 *
 * 每条说三件事：这个 worker 是谁、它现在在等谁/等什么（`renderStageLabel`）、
 * 以及它自己报的 report 六态与问题。stage 分类走 `lib/stage.js` 的纯函数，
 * 所以面板、BRIEF、测试看到的是同一套判断。
 *
 * `worker.known === false` 表示调用方查过子会话 catalog、里面没有这个 id —— 那
 * 是历史残留目录，永远不可能再跑，所以传 `ended`（`stage.js` 的第一条分支）。
 * **只在明确的 `false` 时传**：`known` 为 `undefined` 意味着调用方没查（诊断
 * 脚本、单元测试的旧调用点），此时必须保持旧行为 —— 没在跑的仍判 `queued`。
 *
 * @param {Array<object>} workers
 * @param {Set<string>} [expectIds] 目录里带 `expect.json` 的 worker 名（见 `expectDirIds`）
 * @returns {string[]} Markdown 行（空数组表示这一轮没有 worker 可写）
 */
function renderWorkerLines(workers, expectIds) {
  const lines = []
  for (const worker of workers) {
    if (worker === null || typeof worker !== 'object') continue
    const id = isNonEmptyString(worker.id) ? worker.id : '（未知 id）'
    const tag = isNonEmptyString(worker.tag) ? `（${worker.tag}）` : ''
    const report = worker.report !== null && typeof worker.report === 'object' ? worker.report : undefined
    const pendingQuestion = hasPendingQuestion(report)
    // Lead 侧的归档事实（`.agi/subagents/<id>/archived.json`）。必须透传，
    // 否则一个已验收的 worker 会一直自述 `ready`，被永久判成 `person/review`。
    const archived = worker.archived === true
    // worker 自己说的「没活了」。也是**事实**，不是推断。
    const selfReportedDropped = report?.state === 'dropped'
    // `known === false` 只是**推断**：「这个 id 不在子会话 catalog 里，所以这目录
    // 不会再跑」。推断不该盖掉上面两个更具体的事实标签 —— 盖掉的后果是已验收的
    // worker 从「已验收归档」退化成只说「已收尾」，读的人看不出「Lead 验过它」。
    // 事实优先于推断，所以 archived / dropped 在场时让 ended 让位。
    const inferredEnded = archived || selfReportedDropped
      ? false
      : worker.known === false
        ? true
        : worker.ended
    const stage = workerStage({
      report,
      running: worker.running === true,
      pendingQuestion,
      ended: inferredEnded,
      archived,
      // 「这个 worker 的话压根没送到」是事实，不是推断：outbox 里有它连续失败的
      // entry。必须透传，否则一个消息全丢的 worker 会一直显示成 working/idle。
      deliveryFailed: worker.deliveryFailed === true,
    })
    const state = REPORT_STATES.includes(report?.state) ? report.state : undefined
    const question = isNonEmptyString(report?.question) ? report.question : ''
    const note = state === undefined
      ? ''
      : ` — ${state}${question.length > 0 ? `：${question}` : ''}`
    lines.push(`- \`${id}\`${tag} ${renderStageLabel(stage)}${note}${expectSuffix(worker, id, expectIds)}`)
  }
  return lines
}

/**
 * 没有验收契约的 worker，行尾必须自己说出来。
 *
 * 这一行是 BRIEF 里唯一会被人快速扫过的地方：`ready` 只代表「它说自己做完了」，
 * 而派发时写死的 `expect.json` 才是「什么叫做完」。两者都在时不必加噪音 ——
 * 契约已经由 `check_outcome` 输出；只有缺了它，读者才需要立刻知道这一条没被
 * 机器判过。
 *
 * @param {object} worker
 * @param {string} id 已在行内使用的显示 id
 * @param {Set<string>} [expectIds] 带 `expect.json` 的目录名集合
 * @returns {string} `（无验收契约）` 或空串
 */
function expectSuffix(worker, id, expectIds) {
  // 调用方已经明确告知时不猜。
  if (typeof worker.expect === 'boolean') return worker.expect ? '' : '（无验收契约）'
  if (!(expectIds instanceof Set) || expectIds.size === 0) return '（无验收契约）'
  for (const name of expectIds) {
    if (shortWorkerId(name) === id) return ''
  }
  return '（无验收契约）'
}

/**
 * 哪些 `.agi/subagents/<name>/` 目录里有 `expect.json`。
 *
 * 一次 `readdirSync` 建集合，而不是每个 worker 一次 `existsSync`：BRIEF 每轮都
 * 渲染，worker 数量多的时候那点系统调用也会摊在每次唤醒上。目录不存在时返回
 * 空集合 —— 摘要不能因为一个不存在的目录就渲染失败。
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
function expectDirIds(cwd) {
  if (!isNonEmptyString(cwd)) return new Set()
  const root = join(resolve(cwd), '.agi', 'subagents')
  let names
  try {
    names = readdirSync(root, { withFileTypes: true })
  } catch {
    return new Set()
  }
  const found = new Set()
  for (const entry of names) {
    if (entry === null || typeof entry !== 'object' || entry.isDirectory?.() !== true) continue
    try {
      if (existsSync(join(root, entry.name, EXPECT_FILE))) found.add(entry.name)
    } catch {
      // 单个目录读不了只说明这一条未知，不影响其它 worker。
    }
  }
  return found
}

/**
 * 算出下一份 BRIEF 读回执（B8）。纯函数：只依赖传进来的上一份回执与「有没有活动」。
 *
 * 判据只有一条：`writtenAt` 之后有没有出过回合/消息事件。有，说明上一份摘要真的
 * 被某个醒来的模型看到了；没有，说明它写完就躺在那儿 —— 那才是要报的事。
 *
 * 首次写（`prev` 缺失或形状不对）一律记成「已读」：新工作区刚开张时还没有任何
 * 读取机会，从 0 开始累加等于第一轮就误报。
 *
 * `sawActivity` 只有**显式为 `false`** 才算「没活动」：调用方读不到事件时
 * 应该 fail-open 地传 `true`，这里的兜底也按同样的方向倒。
 *
 * @param {{ seq: number, writtenAt: number, seenSeq: number, unreadStreak: number } | undefined} prev
 * @param {{ seq: number, writtenAt: number, sawActivity?: boolean }} input
 * @returns {{ seq: number, writtenAt: number, seenSeq: number, unreadStreak: number }}
 */
export function deriveBriefReceipt(prev, { seq, writtenAt, sawActivity } = {}) {
  const nextSeq = Number.isSafeInteger(seq) && seq > 0 ? seq : 1
  const at = isFiniteNumber(writtenAt) ? writtenAt : 0
  const before = readBrief(prev)
  if (before === undefined || sawActivity !== false) {
    return { seq: nextSeq, writtenAt: at, seenSeq: nextSeq, unreadStreak: 0 }
  }
  return { seq: nextSeq, writtenAt: at, seenSeq: before.seenSeq, unreadStreak: before.unreadStreak + 1 }
}

/**
 * 渲染读回执那一行；不值得报的时候返回 `null`。
 *
 * 门槛是「连着两份都没人读」：一份没被读可能只是刚好写在某个回合中途，连着
 * 两份就基本能断定「supervisor 没在被唤醒」。quiet by default —— 正常循环
 * 往 BRIEF 里加的任何一行都在偷模型的注意力。
 *
 * @param {{ seq: number, unreadStreak: number } | undefined} receipt
 * @returns {string | null} 自带 `- ` 前缀的单行
 */
export function renderBriefReceipt(receipt) {
  if (!isPlainObject(receipt)) return null
  const streak = Number.isSafeInteger(receipt.unreadStreak) ? receipt.unreadStreak : 0
  const previous = Number.isSafeInteger(receipt.seq) ? receipt.seq - 1 : 0
  if (streak < 2 || previous < 1) return null
  return `- 读回执：上一份 BRIEF（seq=${previous}）已 ${streak} 轮未被读取 —— ` +
    '检查 supervisor 是否还在被唤醒'
}

/**
 * 渲染给模型看的每轮摘要。
 *
 * prompt 里那句「treat durable session state as authoritative」只是原则；
 * 模型真正需要的是「现在就这五件事，别再翻 40 轮历史」。所以摘要刻意压到
 * 一屏能读完：目标、最近进展、未答问题、已落地的排除项、当前循环状态。
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {string} [input.objective] 当前 goal 的目标陈述
 * @param {object} [input.state] `readLoopState` 的结果
 * @param {number} [input.roundsStarted]
 * @param {number} [input.maxGoalRounds]
 * @param {string} [input.phase]
 * @param {string} [input.session] 会话标识，用于声明这份摘要属于谁
 * @param {Array<{ id: string, tag?: string, report?: object, running?: boolean, known?: boolean, ended?: object, archived?: boolean, expect?: boolean }>} [input.workers]
 *   当前在管的 worker 及其结构化 report；缺省（或空数组）时不渲染该段 ——
 *   旧调用方（`lib/watchdog.js`）没有这些事实，硬渲染只会多出一段空标题。
 *   `known === false` 表示这个 id 不在子会话 catalog 里（历史残留目录），渲染成
 *   `ended`；`known` 为 `undefined` 表示调用方没查，按旧行为处理。
 *   可选的 `expect: boolean` 让调用方直接给出「有没有派发时写死的验收契约」；
 *   不传时按 `.agi/subagents/<id>/expect.json` 是否存在自行判定。没有契约的
 *   worker 行尾会带 `（无验收契约）` —— `ready` 只代表它说自己做完了。
 * @param {object[]} [input.outbox] `dueEntries(cwd)` 的结果：本轮该投递的事实。
 *   非空时在「## Worker 状态」之后渲染「## 待投递」。这一参数让「某一件必须
 *   告知的事」不再依赖「上一轮有没有走完」—— 只要它还在队列里，摘要就会
 *   一直说下去，直到真的被看见。缺省或空数组时整段省略。
 * @param {string} [input.policyChange] 策略变更行（`renderPolicyChange` 的结果，
 *   自带 `- ` 前缀）。渲染在标题之后、正文之前：这是「这一轮的规则已经换了」，
 *   比任何进展都更该先被看到。缺省或空串时不渲染。
 * @param {string} [input.goalChange] GOAL.md 变更行（同样自带 `- ` 前缀），
 *   渲染在 `policyChange` 之后 —— 先规则、再目标，剩下的才是进展。
 * @param {string} [input.briefReceipt] BRIEF 读回执行（`renderBriefReceipt` 的结果，
 *   同样自带 `- ` 前缀）。与 `policyChange` / `goalChange` 同层：它说的是「这套
 *   机制本身可能没在转」，比任何一条进展都更该先被看到。缺省或空串时不渲染。
 * @returns {string} Markdown 文本
 */
export function renderBrief({
  cwd,
  objective,
  state,
  roundsStarted,
  maxGoalRounds,
  phase,
  session,
  workers,
  outbox,
  policyChange,
  goalChange,
  briefReceipt,
} = {}) {
  const events = readLoopEvents(cwd, 200)
  const progress = events
    .filter(event => eventName(event) !== 'idle-tick' && eventName(event) !== 'loop-paused')
    .slice(-6)
  const questions = events.filter(event => eventName(event) === 'question').slice(-3)
  const stopped = events.filter(event => eventName(event) === 'goal-stopped').slice(-1)
  const workerLines = Array.isArray(workers) ? renderWorkerLines(workers, expectDirIds(cwd)) : []
  const outboxNotice = renderOutboxNotice(Array.isArray(outbox) ? outbox : [])
  const outboxLines = outboxNotice.length > 0 ? outboxNotice.split('\n') : []
  const lines = ['# 循环摘要', '']
  // 规则与目标的变更排在一切正文之前：读到摘要的人必须先知道「这一轮按什么
  // 规则、按哪一版目标在跑」，否则他会拿旧规则去理解新进展。
  if (isNonEmptyString(policyChange)) lines.push(policyChange, '')
  if (isNonEmptyString(goalChange)) lines.push(goalChange, '')
  if (isNonEmptyString(briefReceipt)) lines.push(briefReceipt, '')
  if (isNonEmptyString(session)) {
    lines.push(
      `> 会话 \`${session}\` 的循环状态。同一工作区里可能还有别的监督者会话，` +
      '它们的轮次与暂停原因不在这里。',
      '',
    )
  }

  if (isNonEmptyString(objective)) {
    lines.push('## 目标', '', objective, '')
  }

  const roundLine = isFiniteNumber(roundsStarted)
    ? `第 ${roundsStarted}/${isFiniteNumber(maxGoalRounds) ? maxGoalRounds : '?'} 轮`
    : '未开始'
  const idle = isFiniteNumber(state?.idleTicks) ? state.idleTicks : 0
  lines.push(
    '## 循环状态',
    '',
    `- ${roundLine}${isNonEmptyString(phase) ? `，phase=${phase}` : ''}`,
    `- 连续空转计数：${idle}`,
    `- 上次复核：第 ${isFiniteNumber(state?.lastReviewRound) ? state.lastReviewRound : 0} 轮`,
  )
  // 成本默认是要紧的信息：只写「第 12 轮」而不写「一轮多久」，读者没法判断
  // 这个目标是在推进还是在慢慢烧预算。
  if (isFiniteNumber(state?.lastProgressAt)) {
    const idleMinutes = Math.max(0, Math.round((Date.now() - state.lastProgressAt) / 60_000))
    lines.push(`- 上次推进：${idleMinutes} 分钟前`)
  }
  if (isFiniteNumber(state?.lastGapMs) && state.lastGapMs > 0) {
    const gapMinutes = Math.max(0, Math.round(state.lastGapMs / 60_000))
    lines.push(`- 上一轮用了：${gapMinutes} 分钟`)
  }
  if (isFiniteNumber(state?.renewals) && state.renewals > 0) {
    lines.push(`- 预算已续期：${state.renewals} 次`)
  }
  lines.push('')

  // 「谁在等我做决定」必须排在「世界发生了什么」前面：模型醒来第一件事是分派
  // 动作，而阶段分类就是分派依据。老调用方不传 workers 时整段省略。
  if (workerLines.length > 0) {
    lines.push(
      '## Worker 状态',
      '',
      ...workerLines,
      '',
      '> stage 是结构化分类，不是从自述里猜的：`person/*` 在等人（要么问用户，' +
      '要么记录假设），`working` 别打扰，`idle` 可以给新单元。',
      '',
    )
  }

  // 「待投递」= 已经发生、必须让模型知道、但还没有被任何一轮真正处理掉的事实
  // （收敛通知 / worker 报告 / 验收失败）。它排在「最近进展」前面：进展是历史，
  // 待投递是欠账，欠账优先。这里只渲染、不改状态 —— 真正算「已投递」是在
  // `writeBrief` 把摘要落盘成功之后，写失败就让它们下一轮继续出现。
  if (outboxLines.length > 0) {
    lines.push('## 待投递', '', ...outboxLines, '')
  }

  lines.push('## 最近进展', '')
  if (progress.length === 0) {
    lines.push('_还没有任何进展记录。_')
  } else {
    for (const event of progress) {
      // 正文三处都试：`{event,detail:{text}}`、`{event,detail:{detail}}`、
      // 以及历史 `{ts,text}` 记录。全空时只输出时间与事件名 —— 输出字面量
      // `undefined` 会让整份 BRIEF 看起来像坏掉的数据流。
      const note = firstText(event.detail?.text, event.detail?.detail, event.text)
      lines.push(`- ${event.ts ?? '?'} \`${eventName(event)}\`${note.length > 0 ? ` — ${note}` : ''}`)
    }
  }
  lines.push('')

  if (questions.length > 0) {
    lines.push('## 待用户回答', '')
    for (const event of questions) {
      const text = firstText(event.detail?.text, event.detail?.detail, event.text)
      lines.push(`- ${text.length > 0 ? text : (event.ts ?? '?')}`)
    }
    lines.push('')
  }

  if (stopped.length > 0) {
    const last = stopped[0]
    const reason = firstText(last.detail?.reason, last.detail?.text, last.text)
    lines.push('## 上次停止原因', '', `- ${reason.length > 0 ? reason : (last.ts ?? '?')}`, '')
  }

  const lessons = readLessons(cwd, 5)
  if (lessons.length > 0) {
    lines.push('## 之前的目标留下的教训', '')
    for (const lesson of lessons) lines.push(`- ${lesson}`)
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 把摘要写进 `.agi/BRIEF.md`，并推进这份摘要的读回执（B8）。
 *
 * 写入是「尽力而为」：工作区只读时不抛，仍然返回渲染好的文本。
 *
 * 这里也是「待投递」真正算投递的地方：摘要写盘成功之后，才把本次渲染进摘要的
 * 那些 entry 标记为已投递。判据刻意绑在「写成功」上而不是「渲染过」上 ——
 * 摘要写不进去，主 Agent 下一轮读到的还是旧文件，那这些事实就等于没送达，
 * 必须留在队列里继续出现。
 *
 * 返回值里的 `seq` 是这份摘要的编号。编号存在 `loop-state` 里而不是内存里，
 * 所以进程重启之后继续往上加；`at` 是写盘时刻，下一轮拿它当「从这一刻起有没有
 * 人动过」的基线。`receipt` 是这一份的回执本身 —— 调用方（watchdog 的空转
 * 暂停分支）要把它原样写回状态，否则那一次整份覆盖会把新回执打回旧值。
 *
 * 摘要没写进去时编号**不前进**：否则下一份的 `seq` 会跳过一份从来没存在过的
 * 摘要，而「连着几份没人读」也跟着算错。
 *
 * @param {Parameters<typeof renderBrief>[0] & { key?: string, sawActivity?: boolean }} input
 *   `key` 是 `sessionKeyOf(session)` 的结果（回执要按会话分文件存）；
 *   `sawActivity` 是「上一份摘要写完之后有没有出过回合/消息事件」，读不到事件
 *   时调用方应传 `true`（宁可不报警，也不要误报「没人读」）。
 * @returns {{ seq: number, at: number, text: string, receipt: object | undefined }}
 */
export function writeBrief(input) {
  const key = isNonEmptyString(input?.key) ? input.key : undefined
  const cwd = input?.cwd
  const previous = isNonEmptyString(cwd) ? readBrief(readLoopState(cwd, key).brief) : undefined
  const at = Date.now()
  const seq = (previous?.seq ?? 0) + 1
  const receipt = deriveBriefReceipt(previous, { seq, writtenAt: at, sawActivity: input?.sawActivity })
  const text = renderBrief({ ...input, briefReceipt: renderBriefReceipt(receipt) })
  if (isNonEmptyString(cwd)) {
    try {
      mkdirSync(agiDir(cwd), { recursive: true })
      ensureIgnored(cwd)
      writeFileSync(briefPath(cwd), text, 'utf8')
    } catch {
      // 摘要写不进去不影响调用方拿到的文本；此时**不**标记已投递，
      // 让这些事实下一次继续出现在摘要里。
      //
      // 同时记一次投递失败：`attempts` 递增、`nextAt` 按退避推后。这里不用
      // `markDelivered` 也不用「什么都不做」—— 什么都不做的话，工作区只读时
      // 同一条会带着「已重试 0 次」永远重复出现，看上去和第一次一样，读的人
      // 无从判断「是不是一直没送出去」。累加 attempts 之后 BRIEF 会写成
      // 「已重试 3 次」，`outboxProblems` 也才有东西可报警。
      for (const entry of Array.isArray(input?.outbox) ? input.outbox : []) {
        if (isNonEmptyString(entry?.id)) markFailed(input.cwd, entry.id, 'BRIEF 写盘失败')
      }
      return { seq: previous?.seq ?? 0, at, text, receipt: previous }
    }
    for (const entry of Array.isArray(input?.outbox) ? input.outbox : []) {
      if (isNonEmptyString(entry?.id)) markDelivered(input.cwd, entry.id)
    }
    writeLoopState(cwd, { brief: receipt }, key)
  }
  return { seq, at, text, receipt }
}

/** 摘要文件的绝对路径，供 UI/诊断引用。 */
export function briefPathFor(cwd) {
  return isNonEmptyString(cwd) ? briefPath(cwd) : undefined
}
