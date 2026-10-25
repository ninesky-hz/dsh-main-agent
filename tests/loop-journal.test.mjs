import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendLoopEvent,
  briefPathFor,
  LOOP_BRIEF_FILE,
  LOOP_STATE_FILE,
  progressMtime,
  readLoopEvents,
  readLoopState,
  renderBrief,
  writeBrief,
  writeLoopState,
} from '../lib/loop-journal.js'
import { idleVerdict, reviewDue, suggestedRounds } from '../lib/loop-policy.js'

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
