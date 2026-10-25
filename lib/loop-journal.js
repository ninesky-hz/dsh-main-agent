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

const loopStatePath = cwd => join(agiDir(cwd), LOOP_STATE_FILE)
const briefPath = cwd => join(agiDir(cwd), LOOP_BRIEF_FILE)
const progressPath = cwd => join(agiDir(cwd), 'progress.jsonl')

const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value)

/**
 * 读循环状态。缺失、损坏、或工作区没有 `.agi/` 时返回空状态 ——「不知道」与
 * 「没空转过」在这里是同一件事，因为第一次记账就会写下真实值。
 *
 * @param {string} cwd 会话工作区
 * @returns {typeof EMPTY_STATE}
 */
export function readLoopState(cwd) {
  if (!isNonEmptyString(cwd)) return { ...EMPTY_STATE }
  try {
    const parsed = JSON.parse(readFileSync(loopStatePath(cwd), 'utf8'))
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
 * @returns {boolean} 是否写成功
 */
export function writeLoopState(cwd, patch) {
  if (!isNonEmptyString(cwd)) return false
  try {
    mkdirSync(agiDir(cwd), { recursive: true })
    const next = { ...readLoopState(cwd) }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    writeFileSync(loopStatePath(cwd), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
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
 * @returns {string} Markdown 文本
 */
export function renderBrief({
  cwd,
  objective,
  state,
  roundsStarted,
  maxGoalRounds,
  phase,
} = {}) {
  const events = readLoopEvents(cwd, 200)
  const progress = events
    .filter(event => event.event !== 'idle-tick' && event.event !== 'loop-paused')
    .slice(-6)
  const questions = events.filter(event => event.event === 'question').slice(-3)
  const stopped = events.filter(event => event.event === 'goal-stopped').slice(-1)
  const lines = ['# 循环摘要', '']

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
