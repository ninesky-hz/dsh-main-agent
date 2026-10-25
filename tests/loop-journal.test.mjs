import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendLoopEvent,
  briefPathFor,
  ensureIgnored,
  readLessons,
  LOOP_BRIEF_FILE,
  LOOP_STATE_FILE,
  progressMtime,
  readLoopEvents,
  readLoopState,
  renderBrief,
  sessionKeyOf,
  writeBrief,
  writeLoopState,
} from '../lib/loop-journal.js'
import { budgetVerdict, idleVerdict, reviewDue, suggestedRounds } from '../lib/loop-policy.js'

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-journal-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('idleVerdict: 0 继续，正数降频，到阈值停', () => {
  assert.equal(idleVerdict({ idleTicks: 0 }).action, 'continue')
  const throttled = idleVerdict({ idleTicks: 2, pauseTicks: 5 })
  assert.equal(throttled.action, 'throttle')
  assert.match(throttled.reason, /2 轮/)
  const paused = idleVerdict({ idleTicks: 5, pauseTicks: 5 })
  assert.equal(paused.action, 'pause')
  assert.match(paused.reason, /5 轮/)
})

test('idleVerdict: 非法输入退化成「继续」而不是「停」', () => {
  assert.equal(idleVerdict({ idleTicks: Number.NaN }).action, 'continue')
  assert.equal(idleVerdict({}).action, 'continue')
  // 阈值传 0/负数时退回默认值，不能因此把一切判成 pause。
  assert.equal(idleVerdict({ idleTicks: 1, pauseTicks: 0 }).action, 'throttle')
})

test('reviewDue: 每个窗口只触发一次', () => {
  assert.equal(reviewDue({ roundsStarted: 4, lastReviewRound: 0, every: 5 }), false)
  assert.equal(reviewDue({ roundsStarted: 5, lastReviewRound: 0, every: 5 }), true)
  // 同一窗口里重复调用不再问。
  assert.equal(reviewDue({ roundsStarted: 9, lastReviewRound: 1, every: 5 }), false)
  assert.equal(reviewDue({ roundsStarted: 10, lastReviewRound: 1, every: 5 }), true)
  assert.equal(reviewDue({ roundsStarted: 0, lastReviewRound: 0, every: 5 }), false)
})

test('suggestedRounds: 按里程碑估并在区间内夹取', () => {
  assert.equal(suggestedRounds({ milestones: 0 }), 20)
  assert.equal(suggestedRounds({ milestones: 3 }), 20)
  assert.equal(suggestedRounds({ milestones: 5 }), 30)
  assert.equal(suggestedRounds({ milestones: 40 }), 120)
})

test('readLoopState: 缺失与损坏都退化成空状态', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(readLoopState(dir).idleTicks, 0)
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(join(dir, '.agi', 'loop-state.json'), '{ not json', 'utf8')
    assert.equal(readLoopState(dir).idleTicks, 0)
  } finally {
    cleanup()
  }
})

test('writeLoopState: 合并写入，undefined 删除键', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(writeLoopState(dir, { idleTicks: 3, pausedBy: 'idle' }), true)
    assert.equal(readLoopState(dir).idleTicks, 3)
    assert.equal(readLoopState(dir).pausedBy, 'idle')

    writeLoopState(dir, { idleTicks: 0, pausedBy: undefined })
    const after = readLoopState(dir)
    assert.equal(after.idleTicks, 0)
    assert.equal(after.pausedBy, undefined)
    // 真正落盘的 JSON 里不该留着 `"pausedBy": null`。
    const raw = readFileSync(join(dir, '.agi', LOOP_STATE_FILE), 'utf8')
    assert.equal(raw.includes('pausedBy'), false)
  } finally {
    cleanup()
  }
})

test('appendLoopEvent / readLoopEvents: 追加可读，坏行不拖垮整条时间线', () => {
  const { dir, cleanup } = workspace()
  try {
    appendLoopEvent(dir, 'goal-started', { objective: '反编译' })
    appendLoopEvent(dir, 'worker-reaped', { worker: 'w1', stalledMinutes: 42 })
    writeFileSync(join(dir, '.agi', 'progress.jsonl'), '{ broken\n', { encoding: 'utf8', flag: 'a' })

    const events = readLoopEvents(dir)
    assert.deepEqual(events.map(event => event.event), ['goal-started', 'worker-reaped'])
    assert.equal(events[1].detail.stalledMinutes, 42)
    assert.equal(typeof events[0].ts, 'string')
    // limit 取尾部。
    assert.deepEqual(readLoopEvents(dir, 1).map(event => event.event), ['worker-reaped'])
  } finally {
    cleanup()
  }
})

test('progressMtime: 真读文件 mtime，不存在时 undefined', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(progressMtime(dir), undefined)
    appendLoopEvent(dir, 'goal-started', {})
    const before = progressMtime(dir)
    assert.equal(typeof before, 'number')
    assert.ok(before > Date.now() - 60_000)
    assert.ok(before <= Date.now() + 1000)
  } finally {
    cleanup()
  }
})

test('renderBrief: 汇总目标、状态、进展与停止原因', () => {
  const { dir, cleanup } = workspace()
  try {
    appendLoopEvent(dir, 'goal-started', { text: '开始' })
    appendLoopEvent(dir, 'goal-stopped', { reason: '目标已 complete' })
    const text = renderBrief({
      cwd: dir,
      objective: '让循环停在正确的地方',
      state: { idleTicks: 2, lastReviewRound: 1 },
      roundsStarted: 7,
      maxGoalRounds: 40,
      phase: 'active',
    })
    assert.match(text, /# 循环摘要/)
    assert.match(text, /让循环停在正确的地方/)
    assert.match(text, /第 7\/40 轮/)
    assert.match(text, /连续空转计数：2/)
    assert.match(text, /goal-started/)
    assert.match(text, /目标已 complete/)
  } finally {
    cleanup()
  }
})

test('writeBrief: 落到 .agi/BRIEF.md 且返回同样的文本', () => {
  const { dir, cleanup } = workspace()
  try {
    const text = writeBrief({ cwd: dir, objective: 'x', state: { idleTicks: 0 } })
    const onDisk = readFileSync(join(dir, '.agi', LOOP_BRIEF_FILE), 'utf8')
    assert.equal(onDisk, text)
    assert.equal(briefPathFor(dir), join(dir, '.agi', LOOP_BRIEF_FILE))
    assert.equal(briefPathFor(''), undefined)
  } finally {
    cleanup()
  }
})

test('sessionKeyOf: 取 session id 的后 8 位字母数字', () => {
  // 'session-01JABCDEF' 去掉连字符后是 session01JABCDEF，取后 8 位。
  assert.equal(sessionKeyOf({ id: 'session-01JABCDEF' }), '1JABCDEF')
  assert.equal(sessionKeyOf({ id: 'abc' }), 'abc')
  assert.equal(sessionKeyOf({ id: '' }), undefined)
  assert.equal(sessionKeyOf({}), undefined)
  assert.equal(sessionKeyOf(undefined), undefined)
})

test('多会话：两个 key 的状态各自独立，不会互相覆盖', () => {
  const { dir, cleanup } = workspace()
  try {
    writeLoopState(dir, { idleTicks: 4, pausedBy: 'idle' }, 'aaaa1111')
    writeLoopState(dir, { idleTicks: 0 }, 'bbbb2222')

    assert.equal(readLoopState(dir, 'aaaa1111').idleTicks, 4)
    assert.equal(readLoopState(dir, 'aaaa1111').pausedBy, 'idle')
    assert.equal(readLoopState(dir, 'bbbb2222').idleTicks, 0)
    assert.equal(readLoopState(dir, 'bbbb2222').pausedBy, undefined)

    // 写的是按 key 分开的文件，不是同一份。
    const a = JSON.parse(readFileSync(join(dir, '.agi', 'loop-state.aaaa1111.json'), 'utf8'))
    const b = JSON.parse(readFileSync(join(dir, '.agi', 'loop-state.bbbb2222.json'), 'utf8'))
    assert.equal(a.idleTicks, 4)
    assert.equal(b.idleTicks, 0)
  } finally {
    cleanup()
  }
})

test('多会话：没有 key 时仍读写旧的单文件（向后兼容）', () => {
  const { dir, cleanup } = workspace()
  try {
    writeLoopState(dir, { idleTicks: 2 })
    assert.equal(readLoopState(dir).idleTicks, 2)
    assert.ok(readFileSync(join(dir, '.agi', LOOP_STATE_FILE), 'utf8').includes('"idleTicks": 2'))
    // 带 key 的读不会看到单文件里的值。
    assert.equal(readLoopState(dir, 'zzzz9999').idleTicks, 0)
  } finally {
    cleanup()
  }
})

test('ensureIgnored: 追加两条规则，且只会追加一次', () => {
  const { dir, cleanup } = workspace()
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    assert.equal(ensureIgnored(dir), true)
    const once = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.match(once, /\.agi\/loop-state\*\.json/)
    assert.match(once, /\.agi\/BRIEF\.md/)
    assert.match(once, /^node_modules\/$/m)

    ensureIgnored(dir)
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), once)
  } finally {
    cleanup()
  }
})

test('ensureIgnored: 整个 .agi/ 已被忽略时不再追加', () => {
  const { dir, cleanup } = workspace()
  try {
    writeFileSync(join(dir, '.gitignore'), '.agi/re/\n.agi/\n')
    assert.equal(ensureIgnored(dir), true)
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.agi/re/\n.agi/\n')
  } finally {
    cleanup()
  }
})

test('renderBrief: 带 session 时声明这份摘要属于谁', () => {
  const { dir, cleanup } = workspace()
  try {
    const text = renderBrief({ cwd: dir, session: 'aaaa1111', state: { idleTicks: 1 } })
    assert.match(text, /> 会话 `aaaa1111` 的循环状态/)
    assert.match(text, /不在这里/)
    // 不带时不多这一行（旧的调用点行为不变）。
    assert.doesNotMatch(renderBrief({ cwd: dir, state: { idleTicks: 1 } }), /的循环状态。/)
  } finally {
    cleanup()
  }
})

test('budgetVerdict: 只有「快用完 + 在产出 + 没续太多次」才续', () => {
  const base = { roundsStarted: 80, maxGoalRounds: 100, idleTicks: 0, renewals: 0 }
  const renew = budgetVerdict(base)
  assert.equal(renew.renew, true)
  assert.equal(renew.nextRounds, 150)
  assert.match(renew.reason, /80\/100/)

  // 还没到 80%
  assert.equal(budgetVerdict({ ...base, roundsStarted: 79 }).renew, false)
  // 最近没有产出
  assert.equal(budgetVerdict({ ...base, idleTicks: 1 }).renew, false)
  // 已经续满两次
  assert.equal(budgetVerdict({ ...base, renewals: 2 }).renew, false)
  // 小预算通常是刻意设的
  assert.equal(budgetVerdict({ roundsStarted: 3, maxGoalRounds: 4 }).renew, false)
  // 没有上限 / 轮次未知都退化成不续，而不是抛错
  assert.equal(budgetVerdict({ roundsStarted: 5, maxGoalRounds: 0 }).renew, false)
  assert.equal(budgetVerdict({}).renew, false)
})

test('budgetVerdict: 小预算也至少加 20 轮', () => {
  const verdict = budgetVerdict({ roundsStarted: 8, maxGoalRounds: 10, idleTicks: 0, renewals: 0 })
  assert.equal(verdict.renew, true)
  assert.equal(verdict.step, 20)
  assert.equal(verdict.nextRounds, 30)
})

test('readLessons: 只取以「- 」开头的行，最新在后', () => {
  const { dir, cleanup } = workspace()
  try {
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(join(dir, '.agi', 'LESSONS.md'), [
      '# 教训',
      '',
      '这段说明不是条目。',
      '- 第一条',
      '  - 缩进的也算',
      '- 第二条',
      '',
    ].join('\n'))
    const lessons = readLessons(dir, 5)
    assert.deepEqual(lessons, ['第一条', '缩进的也算', '第二条'])
    assert.deepEqual(readLessons(dir, 1), ['第二条'])
    // 没有文件时是空数组，不抛。
    const other = workspace()
    assert.deepEqual(readLessons(other.dir), [])
    other.cleanup()
  } finally {
    cleanup()
  }
})

test('renderBrief: 有成本数据时给出「上次推进 / 上一轮用时 / 续期次数」', () => {
  const { dir, cleanup } = workspace()
  try {
    const text = renderBrief({
      cwd: dir,
      state: { idleTicks: 0, renewals: 1, lastGapMs: 4 * 60_000, lastProgressAt: Date.now() - 3 * 60_000 },
      roundsStarted: 12,
      maxGoalRounds: 150,
    })
    assert.match(text, /上次推进：\d+ 分钟前/)
    assert.match(text, /上一轮用了：4 分钟/)
    assert.match(text, /预算已续期：1 次/)
    // 没有数据时不写这几行，避免给读者「0 分钟」的错觉。
    const bare = renderBrief({ cwd: dir, state: { idleTicks: 0 } })
    assert.doesNotMatch(bare, /上一轮用了/)
    assert.doesNotMatch(bare, /预算已续期/)
  } finally {
    cleanup()
  }
})

test('renderBrief: 有 LESSONS.md 时附上「之前的目标留下的教训」', () => {
  const { dir, cleanup } = workspace()
  try {
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(join(dir, '.agi', 'LESSONS.md'), '- 先跑 go build 再看 diff\n- 别信静态扫描的路径\n')
    const text = renderBrief({ cwd: dir, state: { idleTicks: 0 } })
    assert.match(text, /之前的目标留下的教训/)
    assert.match(text, /先跑 go build 再看 diff/)
    assert.match(text, /别信静态扫描的路径/)
  } finally {
    cleanup()
  }
})
