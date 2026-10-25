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
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

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
})

const agiDir = cwd => join(resolve(cwd), '.agi')

const loopStatePath = (cwd, key) =>
  join(agiDir(cwd), key === undefined
    ? LOOP_STATE_FILE
    : LOOP_STATE_FILE.replace(/\.json$/, `.${key}.json`))
const briefPath = cwd => join(agiDir(cwd), LOOP_BRIEF_FILE)
const progressPath = cwd => join(agiDir(cwd), 'progress.jsonl')

const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value)

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
} = {}) {
  const events = readLoopEvents(cwd, 200)
  const progress = events
    .filter(event => event.event !== 'idle-tick' && event.event !== 'loop-paused')
    .slice(-6)
  const questions = events.filter(event => event.event === 'question').slice(-3)
  const stopped = events.filter(event => event.event === 'goal-stopped').slice(-1)
  const lines = ['# 循环摘要', '']
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
    '',
  )

  lines.push('## 最近进展', '')
  if (progress.length === 0) {
    lines.push('_还没有任何进展记录。_')
  } else {
    for (const event of progress) {
      const detail = event.detail
      const note = typeof detail?.text === 'string'
        ? detail.text
        : (typeof detail?.detail === 'string' ? detail.detail : '')
      lines.push(`- ${event.ts ?? '?'} \`${event.event}\`${note.length > 0 ? ` — ${note}` : ''}`)
    }
  }
  lines.push('')

  if (questions.length > 0) {
    lines.push('## 待用户回答', '')
    for (const event of questions) {
      lines.push(`- ${event.detail?.text ?? event.ts ?? '?'}`)
    }
    lines.push('')
  }

  if (stopped.length > 0) {
    const last = stopped[0]
    lines.push('## 上次停止原因', '', `- ${last.detail?.reason ?? last.ts ?? '?'}`, '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 把摘要写进 `.agi/BRIEF.md` 并返回文本。
 *
 * 写入是「尽力而为」：工作区只读时返回文本但仍然可用。
 *
 * @param {Parameters<typeof renderBrief>[0]} input
 * @returns {string} 渲染出的文本
 */
export function writeBrief(input) {
  const text = renderBrief(input)
  if (isNonEmptyString(input?.cwd)) {
    try {
      mkdirSync(agiDir(input.cwd), { recursive: true })
      ensureIgnored(input.cwd)
      writeFileSync(briefPath(input.cwd), text, 'utf8')
    } catch {
      // 摘要写不进去不影响调用方拿到的文本。
    }
  }
  return text
}

/** 摘要文件的绝对路径，供 UI/诊断引用。 */
export function briefPathFor(cwd) {
  return isNonEmptyString(cwd) ? briefPath(cwd) : undefined
}
