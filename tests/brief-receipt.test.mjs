/**
 * BRIEF 读回执（B8）。
 *
 * 这一层要证明的不是「摘要写成功了」——写盘成功早就有测试；要证明的是
 * 「写成功 ≠ 被读过」这件事现在可观测：连着几份没人读，摘要里才会出现一行提醒。
 *
 * 纯函数（`deriveBriefReceipt` / `renderBriefReceipt`）在这里逐态钉死；`writeBrief`
 * 只验编号单调与状态落盘，因为渲染细节属于 `loop-journal.test.mjs` 的范围。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  briefPathFor,
  deriveBriefReceipt,
  readLoopState,
  renderBrief,
  renderBriefReceipt,
  sessionKeyOf,
  writeBrief,
} from '../lib/loop-journal.js'

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'brief-receipt-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 文案只在这里写一次：改了措辞就该同时改实现与这条断言，而不是只改一半。 */
const receiptLine = (seq, streak) =>
  `- 读回执：上一份 BRIEF（seq=${seq}）已 ${streak} 轮未被读取 —— 检查 supervisor 是否还在被唤醒`

test('deriveBriefReceipt: 首次写一律记成已读（还没有读取机会，不能一上来就报警）', () => {
  const first = deriveBriefReceipt(undefined, { seq: 1, writtenAt: 1000, sawActivity: false })
  assert.deepEqual(first, { seq: 1, writtenAt: 1000, seenSeq: 1, unreadStreak: 0 })

  // 缺省 sawActivity 与显式 false 都不能让第一份算「没被读」。
  assert.equal(deriveBriefReceipt(undefined, { seq: 1, writtenAt: 1000 }).unreadStreak, 0)
})

test('deriveBriefReceipt: 有活动 → seenSeq 跟上新编号，连续未读归零', () => {
  const prev = { seq: 3, writtenAt: 900, seenSeq: 1, unreadStreak: 5 }
  const next = deriveBriefReceipt(prev, { seq: 4, writtenAt: 1000, sawActivity: true })
  assert.deepEqual(next, { seq: 4, writtenAt: 1000, seenSeq: 4, unreadStreak: 0 })
})

test('deriveBriefReceipt: 没活动 → 连续未读累加，seenSeq 原地不动', () => {
  const prev = { seq: 3, writtenAt: 900, seenSeq: 2, unreadStreak: 1 }
  const next = deriveBriefReceipt(prev, { seq: 4, writtenAt: 1000, sawActivity: false })
  assert.deepEqual(next, { seq: 4, writtenAt: 1000, seenSeq: 2, unreadStreak: 2 })
  // 再一份还是没人读：继续加，不因为「已经报过」就停。
  assert.equal(deriveBriefReceipt(next, { seq: 5, writtenAt: 1100, sawActivity: false }).unreadStreak, 3)
})

test('deriveBriefReceipt: 坏回执当「还没有回执」处理，不让脏数据造出误报', () => {
  for (const broken of [null, {}, { seq: 0 }, { seq: '3' }, [1, 2]]) {
    const next = deriveBriefReceipt(broken, { seq: 2, writtenAt: 1000, sawActivity: false })
    assert.equal(next.unreadStreak, 0)
    assert.equal(next.seenSeq, 2)
  }
  // 非数字 writtenAt 落成 0（下次判活动时它不会假装成一条可信基线）。
  assert.equal(deriveBriefReceipt(undefined, { seq: 1, writtenAt: Number.NaN }).writtenAt, 0)
})

test('renderBriefReceipt: 一份没被读不够格报警，从第二份起才渲染', () => {
  assert.equal(renderBriefReceipt(undefined), null)
  assert.equal(renderBriefReceipt({ seq: 1, unreadStreak: 0 }), null)
  assert.equal(renderBriefReceipt({ seq: 1, unreadStreak: 1 }), null)
  assert.equal(renderBriefReceipt({ seq: 2, unreadStreak: 1 }), null)
  // 形状不对（比如把渲染出来的行又喂回去）也只回 null，不抛。
  assert.equal(renderBriefReceipt(receiptLine(2, 2)), null)
})

test('renderBriefReceipt: 报警那一行的文案与位置都是固定的', () => {
  assert.equal(renderBriefReceipt({ seq: 3, unreadStreak: 2 }), receiptLine(2, 2))
  assert.equal(renderBriefReceipt({ seq: 9, unreadStreak: 7 }), receiptLine(8, 7))
  // 自带 `- ` 前缀，且只有一行 —— 摘要里多出来的每一行都在偷模型的注意力。
  const line = renderBriefReceipt({ seq: 3, unreadStreak: 4 })
  assert.ok(line.startsWith('- '))
  assert.equal(line.split('\n').length, 1)
})

test('renderBrief: 读回执行渲染在标题之后、目标之前；不传时一个字都不多', () => {
  const plain = renderBrief({ cwd: '', objective: '把活干完', state: {} })
  assert.doesNotMatch(plain, /读回执/)

  const warned = renderBrief({
    cwd: '',
    objective: '把活干完',
    state: {},
    briefReceipt: receiptLine(2, 2),
  })
  assert.match(warned, /读回执/)
  assert.ok(warned.indexOf('读回执') < warned.indexOf('## 目标'))
  // 空串与 null 一样当作「不渲染」，免得写出一条空的 `- `。
  assert.doesNotMatch(renderBrief({ cwd: '', objective: 'x', briefReceipt: '' }), /读回执/)
})

test('writeBrief: 返回单调编号，并把回执写进 loop-state', () => {
  const { dir, cleanup } = workspace()
  try {
    const key = 'abcd1234'
    const first = writeBrief({ cwd: dir, key, objective: '甲', state: {}, sawActivity: false })
    assert.equal(first.seq, 1)
    assert.equal(first.receipt.unreadStreak, 0)
    assert.equal(readLoopState(dir, key).brief.seq, 1)

    const second = writeBrief({ cwd: dir, key, objective: '甲', state: {}, sawActivity: false })
    assert.equal(second.seq, 2)
    assert.equal(second.receipt.unreadStreak, 1)
    // 没人读的那一份不推进 `seenSeq` —— 它记的是「最后一份被证明确实被读过的」。
    assert.equal(second.receipt.seenSeq, 1)
    // 编号落在磁盘上 —— 进程重启后接着往上加，而不是从 1 重来。
    assert.equal(readLoopState(dir, key).brief.seq, 2)

    const third = writeBrief({ cwd: dir, key, objective: '甲', state: {}, sawActivity: false })
    assert.equal(third.seq, 3)
    assert.deepEqual(third.receipt, { seq: 3, writtenAt: third.at, seenSeq: 1, unreadStreak: 2 })

    // 第三份才够格报警：此时落盘的摘要里那行必须真的在。
    const onDisk = readFileSync(briefPathFor(dir), 'utf8')
    assert.match(onDisk, new RegExp(`^${receiptLine(2, 2)}$`, 'm'))

    // 有人读过了：连续未读归零，下一份摘要里那行消失。
    const fourth = writeBrief({ cwd: dir, key, objective: '甲', state: {}, sawActivity: true })
    assert.equal(fourth.seq, 4)
    assert.equal(fourth.receipt.unreadStreak, 0)
    assert.equal(fourth.receipt.seenSeq, 4)
    assert.doesNotMatch(readFileSync(briefPathFor(dir), 'utf8'), /读回执/)
  } finally {
    cleanup()
  }
})

/** reconcileLoop 的最小 ctx：够它跑完一轮，不碰日程以外的任何服务。 */
function loopFixture({ snapshotEvents }) {
  const dir = mkdtempSync(join(tmpdir(), 'brief-receipt-loop-'))
  const session = {
    id: 'session-1',
    header: { version: 4, cwd: dir, agentPreset: 'main-agent' },
    snapshotEvents,
  }
  const schedule = {
    list: async () => [],
    create: async (sessionId, request) => ({ id: 'created', ...request }),
    delete: async ({ id }) => ({ id, deleted: true }),
  }
  const ctx = {
    get: name => {
      if (name === 'supervisorSettings') {
        return { current: () => ({ wakeMinutes: 5, questionWaitMinutes: 2, watchdogEnabled: true }) }
      }
      if (name === 'goals') return { get: () => ({ phase: 'active', objective: '把活干完' }) }
      if (name === 'schedule') return schedule
      if (name === 'agents') return { get: () => undefined }
      if (name === 'subagents') return { listChildren: async () => [] }
      return undefined
    },
  }
  return {
    agent: { id: 'session-1', session },
    ctx,
    log: { warn() {}, info() {} },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('reconcile: 连续几轮没有任何回合事件才把读回执写进 BRIEF', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  // 一条早于任何一次 writeBrief 的旧事件：它证明「这段时间里没有人动过」，
  // 而不是「读不到事件」（后者必须 fail-open，见下一条）。
  const events = [{ type: 'user/message', time: Date.now() - 60_000 }]
  const { ctx, agent, log, cleanup } = loopFixture({ snapshotEvents: () => events })
  try {
    await reconcileLoop(ctx, agent, log)
    assert.doesNotMatch(readFileSync(briefPathFor(agent.session.header.cwd), 'utf8'), /读回执/)

    // 第二份：上一份没人读，但一份不够格报警（quiet by default）。
    await reconcileLoop(ctx, agent, log)
    assert.doesNotMatch(readFileSync(briefPathFor(agent.session.header.cwd), 'utf8'), /读回执/)

    // 第三份：连着两份没人读，摘要里该出现那一行，且说的是上一份的编号。
    await reconcileLoop(ctx, agent, log)
    const warned = readFileSync(briefPathFor(agent.session.header.cwd), 'utf8')
    assert.match(warned, new RegExp(`^${receiptLine(2, 2)}$`, 'm'))
    assert.ok(warned.indexOf('读回执') < warned.indexOf('## 目标'))

    // 有人接着干活：新事件晚于上一份的写入时间 → 连续未读归零，那行消失。
    events.push({ type: 'assistant/message', time: Date.now() + 1000 })
    await reconcileLoop(ctx, agent, log)
    assert.doesNotMatch(readFileSync(briefPathFor(agent.session.header.cwd), 'utf8'), /读回执/)
  } finally {
    cleanup()
  }
})

test('reconcile: 读不到事件时不报警（宁可不报，也不诬告 supervisor 没人读）', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  // 旧版 Session 没有 snapshotEvents，也没有 events 字段。
  const { ctx, agent, log, cleanup } = loopFixture({ snapshotEvents: undefined })
  try {
    for (let round = 0; round < 3; round += 1) await reconcileLoop(ctx, agent, log)
    assert.doesNotMatch(readFileSync(briefPathFor(agent.session.header.cwd), 'utf8'), /读回执/)
    // 编号照常前进：判据 fail-open 只影响「算不算没被读」，不影响序号。
    const state = readLoopState(agent.session.header.cwd, sessionKeyOf(agent.session))
    assert.equal(state.brief.seq, 3)
    assert.equal(state.brief.unreadStreak, 0)
  } finally {
    cleanup()
  }
})

test('writeBrief: 回执按会话分文件，两个 key 各数各的', () => {
  const { dir, cleanup } = workspace()
  try {
    writeBrief({ cwd: dir, key: 'aaaaaaaa', objective: '甲', state: {}, sawActivity: false })
    writeBrief({ cwd: dir, key: 'aaaaaaaa', objective: '甲', state: {}, sawActivity: false })
    const other = writeBrief({ cwd: dir, key: 'bbbbbbbb', objective: '乙', state: {}, sawActivity: false })
    assert.equal(other.seq, 1)
    assert.equal(readLoopState(dir, 'aaaaaaaa').brief.seq, 2)
    assert.equal(readLoopState(dir, 'bbbbbbbb').brief.seq, 1)
  } finally {
    cleanup()
  }
})
