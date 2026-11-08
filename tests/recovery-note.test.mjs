/**
 * B3：重启恢复 note 的选取逻辑。
 *
 * 整条链路（`reconcileLoop` 里「读快照 → 比对 → 入队」）依赖宿主的 schedule /
 * subagents 服务，单测里搭不出来；所以真正需要钉住的那部分抽成了纯函数
 * `recoveryTargets`：**谁**该收到恢复 note、按什么顺序。
 *
 * 这里测的就是它，外加两件容易写错的事实：
 *   - outbox 的 `dedupeKey` 是完整 UUID、报告里的 id 是短号，归一错了生产里
 *     永远匹配不上（测试却可能因为两边手写同一个 id 而绿）；
 *   - 同一条恢复 note 重复入队不能变成两条。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readLoopState, sessionKeyOf, writeLoopState } from '../lib/loop-journal.js'
import { enqueue, readOutbox } from '../lib/outbox.js'
import { deliveryFailureIds, recoveryTargets, reconcileLoop } from '../lib/watchdog.js'

const shortId = uuid => uuid.slice(-8)

/** 与 tests/outbox.test.mjs 同一套兜底：系统临时目录可能被沙箱挡掉。 */
function workspace(prefix = 'recovery-') {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    const base = join(process.cwd(), '.test-tmp')
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, prefix))
  }
}

const withWorkspace = body => {
  const cwd = workspace()
  try {
    return body(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

test('recoveryTargets: 按 at 升序 —— 跑得最久的先恢复', () => {
  const targets = recoveryTargets({
    snapshot: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000003', at: 300 },
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', at: 100 },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', at: 200 },
    ],
    runningIds: [],
  })
  assert.deepEqual(targets, ['00000001', '00000002', '00000003'])
})

test('recoveryTargets: 这次仍在跑的跳过（它没丢过话）', () => {
  const targets = recoveryTargets({
    snapshot: [
      { id: 'b0000000-0000-0000-0000-00000000aaaa', at: 100 },
      { id: 'b0000000-0000-0000-0000-00000000bbbb', at: 200 },
    ],
    // 一个用完整 id、一个用短号（末 8 位）：两种形状都得认。
    runningIds: ['b0000000-0000-0000-0000-00000000aaaa', '0000bbbb'],
  })
  assert.deepEqual(targets, [])
})

test('recoveryTargets: 已 archived / 已 ended 的不该被叫回来接着做', () => {
  const targets = recoveryTargets({
    snapshot: [
      { id: 'c0000000-0000-0000-0000-00000000000a', at: 100 },
      { id: 'c0000000-0000-0000-0000-00000000000b', at: 200 },
      { id: 'c0000000-0000-0000-0000-00000000000c', at: 300 },
    ],
    runningIds: [],
    archivedIds: ['0000000a'],
    endedIds: ['0000000b'],
  })
  assert.deepEqual(targets, ['0000000c'])
})

test('recoveryTargets: 同一 id 出现多次只算一条，取最早的 at', () => {
  const targets = recoveryTargets({
    snapshot: [
      { id: 'd0000000-0000-0000-0000-00000000000a', at: 500 },
      { id: 'd0000000-0000-0000-0000-00000000000a', at: 100 },
      { id: 'd0000000-0000-0000-0000-00000000000b', at: 200 },
    ],
    runningIds: [],
  })
  // a 的最早 at=100 比 b 的 200 早，所以 a 在前。
  assert.deepEqual(targets, ['0000000a', '0000000b'])
})

test('recoveryTargets: 空快照 / 坏数据都不炸', () => {
  assert.deepEqual(recoveryTargets({}), [])
  assert.deepEqual(recoveryTargets({ snapshot: [] }), [])
  assert.deepEqual(recoveryTargets({ snapshot: [null, 42, { id: '' }, { id: 'x', at: 'nope' }] }), ['x'])
})

test('recovery note: 同 dedupeKey 重复入队只有一条', () => withWorkspace(cwd => {
  const id = shortId('e0000000-0000-0000-0000-00000000000a')
  const note = { worker: id, note: '先查工作区产物与 git 历史确认做到哪，再重做外部动作' }
  const first = enqueue(cwd, { kind: 'recovery', dedupeKey: `recovery:${id}`, detail: note })
  const second = enqueue(cwd, { kind: 'recovery', dedupeKey: `recovery:${id}`, detail: note })
  assert.equal(first.ok, true)
  assert.equal(second.replaced, true)
  assert.equal(second.id, first.id)

  const entries = readOutbox(cwd).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'recovery')
  assert.deepEqual(entries[0].detail, note)
}))

test('deliveryFailureIds: 完整 UUID 与短 id 都能匹配', () => {
  const uuid = 'f0000000-1111-2222-3333-444455556666'
  const failed = deliveryFailureIds([
    // settlement 的键是完整 UUID。
    { kind: 'settlement', dedupeKey: uuid, attempts: 3, status: 'pending' },
    // worker-report 的键是 `${id}:${state}`。
    { kind: 'worker-report', dedupeKey: `${uuid}:blocked`, attempts: 4, status: 'pending' },
    // 只失败两次：还没到「连续失败」的口径。
    { kind: 'settlement', dedupeKey: uuid, attempts: 2, status: 'pending' },
    // 已投递的不算 —— 它已经不是问题了。
    { kind: 'settlement', dedupeKey: uuid, attempts: 9, status: 'delivered' },
    // 别的 worker 的。
    { kind: 'settlement', dedupeKey: '99999999-9999-9999-9999-999999999999', attempts: 5, status: 'pending' },
  ], [shortId(uuid)])
  assert.deepEqual([...failed], [shortId(uuid)])
})

test('deliveryFailureIds: attempts 不足或队列为空时没有结论', () => {
  assert.equal(deliveryFailureIds([], ['abcdefgh']).size, 0)
  assert.equal(deliveryFailureIds(undefined, undefined).size, 0)
  assert.equal(deliveryFailureIds([
    { kind: 'settlement', dedupeKey: 'abcdefgh', attempts: 1, status: 'pending' },
  ], ['abcdefgh']).size, 0)
})

/**
 * 一个只够 `reconcileLoop` 跑完的 ctx：宿主服务全是最小假实现。
 *
 * 这里不测「提醒排得对不对」（那是 `loop-watchdog.test.mjs` 的事），只测一件：
 * 重启后的第一轮巡检有没有把恢复 note 真的落进 outbox、第二轮会不会重复。
 */
function loopCtx({ cwd, children }) {
  const agent = {
    id: 'session-1',
    session: { id: 'session-1', header: { version: 4, cwd, agentPreset: 'main-agent' } },
  }
  const ctx = {
    get: name => {
      if (name === 'supervisorSettings') {
        return { current: () => ({ wakeMinutes: 5, questionWaitMinutes: 2, watchdogEnabled: true }) }
      }
      if (name === 'schedule') {
        return {
          list: async () => [],
          create: async () => ({ id: 'created' }),
          delete: async () => ({ deleted: true }),
        }
      }
      if (name === 'subagents') return { listChildren: async () => children }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
  }
  return { ctx, agent, log: { warn() {}, info() {} } }
}

test('reconcileLoop: 重启后的第一轮补恢复 note，第二轮不重复', async () => {
  const cwd = workspace()
  try {
    const uuidA = '11111111-1111-1111-1111-0000aaa1'
    const uuidB = '22222222-2222-2222-2222-0000bbb2'
    const children = [{ id: uuidA, mode: 'continuable' }, { id: uuidB, mode: 'continuable' }]
    for (const id of [uuidA, uuidB]) {
      mkdirSync(join(cwd, '.agi', 'subagents', id), { recursive: true })
    }

    const { ctx, agent, log } = loopCtx({ cwd, children })
    const key = sessionKeyOf(agent.session)
    // 上一次巡检：两个都在跑，A 跑得更久（at 更小）。hostStartedAt 是别的进程。
    writeLoopState(cwd, {
      hostStartedAt: 1,
      runningSnapshot: [{ id: shortId(uuidA), at: 100 }, { id: shortId(uuidB), at: 500 }],
    }, key)

    await reconcileLoop(ctx, agent, log)

    const entries = readOutbox(cwd).entries.filter(entry => entry.kind === 'recovery')
    assert.deepEqual(entries.map(entry => entry.dedupeKey), [
      `recovery:${shortId(uuidA)}`,
      `recovery:${shortId(uuidB)}`,
    ])
    // 正文必须能指导下一步：只有「重启恢复」四个字等于没说。
    assert.match(entries[0].detail.note, /git 历史/)

    const state = readLoopState(cwd, key)
    assert.equal(typeof state.hostStartedAt, 'number')
    assert.notEqual(state.hostStartedAt, 1)
    assert.deepEqual(state.runningSnapshot, [], '这次没人在跑，快照必须是空的')

    // 第二轮的 hostStartedAt 已经等于本进程，不该再补一遍。
    await reconcileLoop(ctx, agent, log)
    assert.equal(readOutbox(cwd).entries.filter(entry => entry.kind === 'recovery').length, 2)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
