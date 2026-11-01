/**
 * `lib/stage.js` 的直测：stage 分类的 first-match-wins 顺序。
 *
 * 顺序就是这套逻辑的全部内容 —— 同一组输入换个判断次序就会得出不同的 stage，
 * 而 stage 决定监督者是「去问用户」还是「别打扰它」。所以每一条规则都单独钉
 * 一次，并且专门钉住几条互相竞争的组合（ready + 有问题、waiting + 没在跑）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { canRetry, renderStageLabel, workerStage } from '../lib/stage.js'

test('1. ended 压过一切', () => {
  assert.deepEqual(
    workerStage({ ended: { at: 1 }, report: { state: 'blocked', question: '?' }, running: true, pendingQuestion: true }),
    { stage: 'ended' },
  )
})

test('dropped → ended/dropped：干完了、没活可干，不算失败也不占等人的位置', () => {
  assert.deepEqual(
    workerStage({ report: { state: 'dropped' }, running: true }),
    { stage: 'ended', action: 'dropped' },
  )
  // 即使还挂着 running，dropped 也已经收尾。
  assert.deepEqual(workerStage({ report: { state: 'dropped' }, running: false }), { stage: 'ended', action: 'dropped' })
})

test('2. pendingQuestion 压过 ready / blocked 的通用分支', () => {
  assert.deepEqual(
    workerStage({ report: { state: 'blocked', question: 'A 还是 B' }, running: true, pendingQuestion: true }),
    { stage: 'person', action: 'answer' },
  )
  // ready 但带着问题：问问题优先于「等我验收」。
  assert.deepEqual(
    workerStage({ report: { state: 'ready', question: '要不要顺带改 X' }, running: true, pendingQuestion: true }),
    { stage: 'person', action: 'answer' },
  )
})

test('2. archived 压过 ready / dropped / pendingQuestion：已验收的单元不该再占等人的位置', () => {
  // 就是这次要修的缺口：三个 Lead 已经亲自核验过的 worker 头行一直是
  // `<!-- report: ready -->`，worker 无从知道验收了没有，于是 BRIEF 永久挂着
  // 三条「等用户验收」去误导主 Agent。归档事实由验收方写下，必须赢过 ready。
  assert.deepEqual(
    workerStage({ report: { state: 'ready' }, running: false, archived: true }),
    { stage: 'ended', action: 'archived' },
  )
  // 还挂着 running 也一样退场。
  assert.deepEqual(
    workerStage({ report: { state: 'ready' }, running: true, archived: true }),
    { stage: 'ended', action: 'archived' },
  )
  // 压过 pendingQuestion：验收完还挂着一个旧问题，那不是「等人回答」。
  assert.deepEqual(
    workerStage({ report: { state: 'blocked', question: 'A 还是 B' }, running: true, pendingQuestion: true, archived: true }),
    { stage: 'ended', action: 'archived' },
  )
  // 压过 dropped 与 queued。
  assert.deepEqual(
    workerStage({ report: { state: 'dropped' }, running: false, archived: true }),
    { stage: 'ended', action: 'archived' },
  )
  // 但压不过 ended：已经结束的单元连归档都不需要。
  assert.deepEqual(
    workerStage({ ended: { at: 1 }, archived: true }),
    { stage: 'ended' },
  )
  // archived 显式 false 时行为与不传完全一致（旧调用方不受影响）。
  assert.deepEqual(
    workerStage({ report: { state: 'ready' }, running: true, archived: false }),
    { stage: 'person', action: 'review' },
  )
})

test('3. ready → person/review', () => {
  assert.deepEqual(
    workerStage({ report: { state: 'ready' }, running: true }),
    { stage: 'person', action: 'review' },
  )
})

test('4. blocked / failed → person/<state>', () => {
  assert.deepEqual(workerStage({ report: { state: 'blocked' }, running: true }), { stage: 'person', action: 'blocked' })
  assert.deepEqual(workerStage({ report: { state: 'failed' }, running: true }), { stage: 'person', action: 'failed' })
})

test('5. running !== true → working/queued（排队压过 waiting/idle）', () => {
  assert.deepEqual(
    workerStage({ report: { state: 'waiting' }, running: false }),
    { stage: 'working', action: 'queued' },
  )
  assert.deepEqual(workerStage({ report: { state: 'progress' } }), { stage: 'working', action: 'queued' })
})

test('6. waiting 且驱动开着 → idle', () => {
  assert.deepEqual(workerStage({ report: { state: 'waiting' }, running: true }), { stage: 'idle' })
})

test('7. 其余 → working', () => {
  assert.deepEqual(workerStage({ report: { state: 'progress' }, running: true }), { stage: 'working' })
  assert.deepEqual(workerStage({ running: true }), { stage: 'working' })
})

test('first-match-wins：同一次调用里前面的规则赢', () => {
  // ready + 未运行：review 排在 queued 之前。
  assert.deepEqual(
    workerStage({ report: { state: 'ready' }, running: false }),
    { stage: 'person', action: 'review' },
  )
  // blocked + 未运行：person/blocked 排在 queued 之前。
  assert.deepEqual(
    workerStage({ report: { state: 'blocked' }, running: false }),
    { stage: 'person', action: 'blocked' },
  )
})

test('renderStageLabel：每条都说清在等谁/等什么，不输出裸状态码', () => {
  const cases = [
    { stage: 'ended' },
    { stage: 'ended', action: 'archived' },
    { stage: 'ended', action: 'dropped' },
    { stage: 'person', action: 'answer' },
    { stage: 'person', action: 'review' },
    { stage: 'person', action: 'blocked' },
    { stage: 'person', action: 'failed' },
    { stage: 'working' },
    { stage: 'working', action: 'queued' },
    { stage: 'idle' },
    { stage: 'unknown-stage', action: 'weird' },
    {},
  ]
  for (const stage of cases) {
    const label = renderStageLabel(stage)
    assert.ok(label.includes('→'), `缺少「→ 人话」：${label}`)
    const prose = label.split('→')[1].trim()
    assert.ok(prose.length >= 3, `→ 后面没有说清在等什么：${label}`)
    assert.match(prose, /[\u4e00-\u9fa5]/, `→ 后面不是中文说明：${label}`)
  }
  // 三档关键标签保持与 BRIEF/面板约定一致。
  assert.equal(renderStageLabel({ stage: 'person', action: 'answer' }), 'person/answer → 等用户回答')
  assert.equal(renderStageLabel({ stage: 'idle' }), 'idle → 等触发')
  assert.match(renderStageLabel({ stage: 'working', action: 'queued' }), /排队中/)
  // 归档档的措辞必须让人一眼看出「不用再处理」，而不是又一个待办。
  assert.match(renderStageLabel({ stage: 'ended', action: 'archived' }), /已验收归档/)
})

test('canRetry：只有「受阻/失败 + 没有更新的问题」才值得重试', () => {
  assert.equal(canRetry({ report: { state: 'blocked' } }), true)
  assert.equal(canRetry({ report: { state: 'failed' } }), true)
  // 还在等人回答：重试只会重复同一个失败。
  assert.equal(canRetry({ report: { state: 'blocked' }, pendingQuestion: true }), false)
  // 已结束、或压根没受阻：不重试。
  assert.equal(canRetry({ ended: { at: 1 }, report: { state: 'blocked' } }), false)
  assert.equal(canRetry({ report: { state: 'progress' } }), false)
  assert.equal(canRetry({ report: { state: 'dropped' } }), false)
  // 已归档 = Lead 验收过这个单元，重派它等于否定那次验收。
  assert.equal(canRetry({ report: { state: 'blocked' }, archived: true }), false)
  assert.equal(canRetry(), false)
})
