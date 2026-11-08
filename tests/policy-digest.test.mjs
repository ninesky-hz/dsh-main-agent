/**
 * A2：策略变更重校验。
 *
 * 真机症状：用户在设置里把并行上限从 6 调到 1，监督者照旧按 6 派活，直到重启才
 * 生效。这一层要保证「每一轮都能发现自己跑的是一份旧策略」，并且把变更说清楚。
 *
 * 用例分三层：纯函数（snapshot / diff / render）、loop-state 的落盘形状、BRIEF 的
 * 渲染位置 —— 最后一层是「用户真能看到」的那一层。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readLoopState, renderBrief, writeLoopState } from '../lib/loop-journal.js'
import { POLICY_KEYS, policyDiff, policySnapshot, renderPolicyChange } from '../lib/loop-policy.js'

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-policy-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('POLICY_KEYS：只覆盖真正影响本轮行为的五项', () => {
  assert.deepEqual(POLICY_KEYS, [
    'maxParallelWorkers',
    'reservedHumanSlots',
    'proactive',
    'wakeMinutes',
    'questionWaitMinutes',
  ])
})

test('policySnapshot：只取 POLICY_KEYS，缺失键落成 null', () => {
  const { digest, values } = policySnapshot({ maxParallelWorkers: 6, proactive: 'auto', unrelated: 'x' })
  assert.deepEqual(Object.keys(values), POLICY_KEYS)
  assert.equal(values.maxParallelWorkers, 6)
  assert.equal(values.proactive, 'auto')
  assert.equal(values.reservedHumanSlots, null)
  assert.equal(values.wakeMinutes, null)
  assert.equal(values.questionWaitMinutes, null)
  // 白名单之外的键不进指纹，否则改个无关设置也会报「策略已变更」。
  assert.equal('unrelated' in values, false)
  assert.match(digest, /^[0-9a-f]{12}$/)
})

test('policySnapshot：只有键顺序无关，值无关才是真的无关', () => {
  const a = policySnapshot({ proactive: 'auto', maxParallelWorkers: 6 })
  const b = policySnapshot({ maxParallelWorkers: 6, proactive: 'auto' })
  assert.equal(a.digest, b.digest)

  assert.notEqual(a.digest, policySnapshot({ maxParallelWorkers: 1, proactive: 'auto' }).digest)
  // 缺键与显式 null 是同一份策略：都是「没设」。
  assert.equal(
    policySnapshot({ maxParallelWorkers: 6, proactive: 'auto', wakeMinutes: null }).digest,
    a.digest,
  )
  // 坏输入不抛，退化成「全空」。
  assert.match(policySnapshot(undefined).digest, /^[0-9a-f]{12}$/)
  assert.equal(policySnapshot(undefined).digest, policySnapshot({}).digest)
  assert.equal(policySnapshot('nope').digest, policySnapshot({}).digest)
})

test('policyDiff：按 POLICY_KEYS 顺序只列真正变化的键', () => {
  const before = { maxParallelWorkers: 6, proactive: 'auto', wakeMinutes: 5 }
  const after = { maxParallelWorkers: 1, proactive: 'auto', wakeMinutes: 5 }
  assert.deepEqual(policyDiff(before, after), [{ key: 'maxParallelWorkers', from: 6, to: 1 }])

  // 顺序固定：即使入参对象里 questionWaitMinutes 写在前面，也按 POLICY_KEYS 排。
  const many = policyDiff(
    { questionWaitMinutes: 2, maxParallelWorkers: 6, proactive: 'auto' },
    { questionWaitMinutes: 9, maxParallelWorkers: 1, proactive: 'observe' },
  )
  assert.deepEqual(many, [
    { key: 'maxParallelWorkers', from: 6, to: 1 },
    { key: 'proactive', from: 'auto', to: 'observe' },
    { key: 'questionWaitMinutes', from: 2, to: 9 },
  ])

  assert.deepEqual(policyDiff(before, { ...before }), [])
  // 缺键与 null 等价：从「没设」到「设成 3」是真的变化。
  assert.deepEqual(policyDiff({}, { wakeMinutes: 3 }), [{ key: 'wakeMinutes', from: null, to: 3 }])
})

test('policyDiff：任一入参不是对象就返回空数组', () => {
  for (const bad of [undefined, null, 'x', 3, [], true]) {
    assert.deepEqual(policyDiff(bad, { maxParallelWorkers: 1 }), [])
    assert.deepEqual(policyDiff({ maxParallelWorkers: 1 }, bad), [])
  }
})

test('renderPolicyChange：一行说清「改了什么 + 在跑的不回收」', () => {
  const line = renderPolicyChange([{ key: 'maxParallelWorkers', from: 6, to: 1 }], { running: 3 })
  assert.equal(line, '- 策略已变更：maxParallelWorkers 6→1，本轮起生效；已有 3 个在跑不回收')

  // 没有在跑的 worker 时只留前半句 —— 不写一句没有信息量的「已有 0 个」。
  assert.equal(
    renderPolicyChange([{ key: 'maxParallelWorkers', from: 6, to: 1 }]),
    '- 策略已变更：maxParallelWorkers 6→1，本轮起生效',
  )
  assert.equal(
    renderPolicyChange([{ key: 'wakeMinutes', from: 5, to: 10 }], { running: 0 }),
    '- 策略已变更：wakeMinutes 5→10，本轮起生效',
  )

  const multi = renderPolicyChange(
    [
      { key: 'maxParallelWorkers', from: 6, to: 1 },
      { key: 'proactive', from: 'auto', to: 'observe' },
    ],
    { running: 2 },
  )
  assert.equal(
    multi,
    '- 策略已变更：maxParallelWorkers 6→1、proactive auto→observe，本轮起生效；已有 2 个在跑不回收',
  )

  // 空 diff 没有可说的 —— 返回空串，让调用方按「没变」处理。
  assert.equal(renderPolicyChange([]), '')
  assert.equal(renderPolicyChange(undefined), '')
  // 缺值渲染成 null 而不是 undefined，读的人知道「原来没设」。
  assert.equal(
    renderPolicyChange([{ key: 'wakeMinutes', from: null, to: 5 }]),
    '- 策略已变更：wakeMinutes null→5，本轮起生效',
  )
})

test('readLoopState：策略指纹与逐项值都能落盘读回', () => {
  const { dir, cleanup } = workspace()
  try {
    const { digest, values } = policySnapshot({ maxParallelWorkers: 1, proactive: 'observe' })
    assert.equal(writeLoopState(dir, { policyDigest: digest, policyValues: values }), true)

    const state = readLoopState(dir)
    assert.equal(state.policyDigest, digest)
    assert.deepEqual(state.policyValues, values)
  } finally {
    cleanup()
  }
})

test('readLoopState：指纹与逐项值坏了就当没记录（不抛）', () => {
  const { dir, cleanup } = workspace()
  try {
    writeLoopState(dir, { policyDigest: 42, policyValues: 'oops' })
    assert.equal(readLoopState(dir).policyDigest, undefined)
    assert.equal(readLoopState(dir).policyValues, undefined)

    writeLoopState(dir, { policyDigest: '', policyValues: [] })
    assert.equal(readLoopState(dir).policyDigest, undefined)
    assert.equal(readLoopState(dir).policyValues, undefined)
  } finally {
    cleanup()
  }
})

test('renderBrief：策略变更行紧跟在标题之后、正文之前', () => {
  const { dir, cleanup } = workspace()
  try {
    const policyChange = renderPolicyChange(
      [{ key: 'maxParallelWorkers', from: 6, to: 1 }],
      { running: 2 },
    )
    const text = renderBrief({ cwd: dir, objective: '让循环停在正确的地方', state: {}, policyChange })
    const lines = text.split('\n')
    assert.equal(lines[0], '# 循环摘要')
    assert.equal(lines[1], '')
    assert.equal(lines[2], policyChange)
    assert.equal(lines[3], '')
    // 变更行必须出现在目标段之前：先规则、再目标、最后才是进展。
    assert.ok(text.indexOf(policyChange) < text.indexOf('## 目标'))

    // 没变时不插空行：去掉这一行就是旧版的逐字输出。
    const plain = renderBrief({ cwd: dir, objective: '让循环停在正确的地方', state: {} })
    assert.equal(plain.includes('策略已变更'), false)
    assert.equal(text.replace(`${policyChange}\n\n`, ''), plain)
  } finally {
    cleanup()
  }
})
