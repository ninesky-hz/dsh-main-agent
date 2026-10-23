/**
 * Coverage for the adaptive wake policy and the server-side watchdog.
 *
 * 为什么这些测试值得写：这一层的每一条规则都是「出事后才被发现」的类型。
 * 漏排提醒会让循环静默停在一轮（看不到错误）；死循环的固定间隔会让成本线性
 * 烧钱（看不到错误）；Full stop 只写日志不删任务会让提醒继续 armed（也看不到
 * 错误）。三者都只能靠断言把契约钉住。
 *
 * loop-policy 是纯函数，直接断言；fullStopAgent 用 fake agent 断言调用顺序与
 * 结果形状；loopHandler 用 fake ctx/req/res 断言响应契约（不启动宿主）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_IDLE_SECONDS,
  MIN_WAKE_SECONDS,
  WATCHDOG_TITLE,
  adaptiveWake,
  describeWake,
  idleStreakOf,
  staleWake,
  watchdogPlan,
  workerDeadlineExceeded,
} from '../lib/loop-policy.js'
import { fullStopAgent } from '../lib/full-stop.js'

register('./harness-stub-loader.js', import.meta.url)

const { loopHandler } = await import('../lib/index.js')

// ---------------------------------------------------------------- policy

test('a running worker wakes the supervisor inside two minutes, never sooner than the host floor', () => {
  const fast = adaptiveWake({ runningWorkers: 1, wakeMinutes: 5, questionWaitMinutes: 2 })
  assert.equal(fast.band, 'worker')
  assert.ok(fast.seconds >= MIN_WAKE_SECONDS)
  assert.ok(fast.seconds <= 120)

  // A user who configured 1 minute still cannot go below the 60s host floor.
  const floor = adaptiveWake({ runningWorkers: 2, wakeMinutes: 1, questionWaitMinutes: 2 })
  assert.equal(floor.seconds, MIN_WAKE_SECONDS)
})

test('waiting on the user stretches the wake to the question window', () => {
  const waiting = adaptiveWake({ pendingQuestions: 1, wakeMinutes: 5, questionWaitMinutes: 2 })
  assert.equal(waiting.band, 'question')
  assert.equal(waiting.seconds, 300)

  const long = adaptiveWake({ pendingQuestions: 1, wakeMinutes: 5, questionWaitMinutes: 20 })
  assert.ok(long.seconds <= 900, 'a 20 minute wait still caps at 15 minutes of idle')
})

test('no evidence backoff doubles per idle round and stops at half an hour', () => {
  const one = adaptiveWake({ idleStreak: 1, wakeMinutes: 5, questionWaitMinutes: 2 })
  const three = adaptiveWake({ idleStreak: 3, wakeMinutes: 5, questionWaitMinutes: 2 })
  const many = adaptiveWake({ idleStreak: 9, wakeMinutes: 5, questionWaitMinutes: 2 })
  assert.ok(three.seconds > one.seconds)
  assert.equal(many.seconds, MAX_IDLE_SECONDS)
  assert.ok(one.seconds <= MAX_IDLE_SECONDS)
})

test('idle streak is derived from the last progress timestamp', () => {
  const now = 1_000_000
  assert.equal(idleStreakOf({ lastProgressAt: now - 10_000, now, seconds: 60 }), 0)
  assert.equal(idleStreakOf({ lastProgressAt: now - 10 * 60_000, now, seconds: 60 }), 4)
  // No progress file at all is "fresh": a brand-new workspace must not be
  // treated as abandoned.
  assert.equal(idleStreakOf({ lastProgressAt: undefined, now, seconds: 60 }), 0)
})

test('the watchdog arms only when nobody else did, and clears when the goal ends', () => {
  const base = { seconds: 300, serviceAvailable: true }
  assert.equal(watchdogPlan({ ...base, goalActive: false, reminderTitles: [] }).action, 'clear')
  assert.equal(watchdogPlan({ ...base, goalActive: true, reminderTitles: [] }).action, 'arm')
  assert.equal(
    watchdogPlan({ ...base, goalActive: true, reminderTitles: ['巡检'] }).action,
    'yield',
    'the model scheduled its own reminder — the fallback must stand down',
  )
  assert.equal(
    watchdogPlan({ ...base, goalActive: true, reminderTitles: [WATCHDOG_TITLE], ownReminderDue: true }).action,
    'none',
    'our own reminder is still pending — re-creating it would double the wake rate',
  )
  assert.equal(
    watchdogPlan({ ...base, goalActive: true, serviceAvailable: false, reminderTitles: [] }).action,
    'none',
  )
})

test('a wake that arrives far past its window is reported as stale before anything else happens', () => {
  const now = 10_000_000
  const fresh = staleWake({ lastWakeAt: now - 60_000, now, seconds: 300 })
  assert.equal(fresh.stale, false)
  const late = staleWake({ lastWakeAt: now - 30 * 60_000, now, seconds: 300 })
  assert.equal(late.stale, true)
  assert.ok(late.gapSeconds >= 30 * 60)
  // First ever wake has nothing to compare against.
  assert.equal(staleWake({ lastWakeAt: undefined, now, seconds: 300 }).stale, false)
})

test('the worker deadline only fires once the configured window has elapsed', () => {
  const now = 5_000_000
  assert.equal(workerDeadlineExceeded({ lastActivityAt: now - 60_000, now, deadlineMinutes: 0 }).exceeded, false)
  assert.equal(workerDeadlineExceeded({ lastActivityAt: now - 60_000, now, deadlineMinutes: 10 }).exceeded, false)
  const dead = workerDeadlineExceeded({ lastActivityAt: now - 20 * 60_000, now, deadlineMinutes: 10 })
  assert.equal(dead.exceeded, true)
  assert.equal(dead.stalledMinutes, 20)
})

test('the human-readable line names the band, not just a number', () => {
  const text = describeWake(adaptiveWake({ runningWorkers: 1, wakeMinutes: 5, questionWaitMinutes: 2 }))
  assert.match(text, /秒|分钟/)
  assert.ok(text.length > 0)
})

// ------------------------------------------------------- durable deletion

function fakeStopAgent(order, activeIds) {
  return {
    session: {
      id: 'session-1',
      header: { version: 4, agentPreset: 'main-agent' },
      append(type, data) { order.push(`append:${data.id}`) },
    },
    sessionEvents: () => [],
    cancel(cause) { order.push(`cancel:${cause.kind}`) },
    whenIdle() { order.push('idle'); return Promise.resolve() },
    runMaintenance(task) { order.push('maintenance'); return task() },
    fold() { order.push('fold'); return { active: activeIds.map(id => ({ id })) } },
  }
}

test('full stop deletes through the schedule service before it appends the log record', async () => {
  const order = []
  const agent = fakeStopAgent(order, ['schedule-2', 'schedule-7'])
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    () => agent.fold(),
    {
      // The authoritative store is the host `tasks` table — appending a
      // `schedule/change` delete never reaches it.
      deleteReminder: async (sessionId, id) => {
        order.push(`delete:${sessionId}:${id}`)
        return { id, deleted: true }
      },
    },
  )

  assert.deepEqual(outcome, { kind: 'stopped', ids: ['schedule-2', 'schedule-7'], durableDeleted: 2 })
  assert.deepEqual(order, [
    'cancel:user', 'idle', 'maintenance', 'flush', 'fold',
    'delete:session-1:schedule-2', 'delete:session-1:schedule-7',
    'append:schedule-2', 'append:schedule-7', 'flush',
  ])
})

test('full stop reports a reminder that survived the service delete instead of claiming success', async () => {
  const order = []
  const agent = fakeStopAgent(order, ['schedule-2'])
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    () => agent.fold(),
    {
      deleteReminder: async (sessionId, id) => {
        order.push(`delete:${id}`)
        return { id, deleted: false, code: 'schedule_not_found' }
      },
    },
  )
  assert.equal(outcome.kind, 'reminder-delete-failed')
  assert.deepEqual(outcome.stillArmed, ['schedule-2'])
})

// ------------------------------------------------------------- the route

function fakeCtx({ goal, reminders = [], children = [], settings = {} } = {}) {
  // A workspace WITHOUT .agi/: the test process's own cwd carries this repo's
  // running state, and reading it here would make the assertions depend on
  // whatever the supervisor is doing right now.
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-loop-'))
  const agent = {
    id: 'session-1',
    session: {
      id: 'session-1',
      header: { version: 4, cwd, agentPreset: 'main-agent' },
      append() {},
    },
  }
  return {
    agents: {
      get: id => {
        if (id === 'session-1') return agent
        // Any other id is a live worker: `childIsRunning` reads `status`.
        return children.some(child => child.id === id) ? { id, status: 'running' } : undefined
      },
    },
    get: name => {
      if (name === 'supervisorSettings') {
        return { current: () => ({ wakeMinutes: 5, questionWaitMinutes: 2, watchdogEnabled: true, ...settings }) }
      }
      if (name === 'goals') return { get: () => goal }
      if (name === 'schedule') return { delete: async () => ({ deleted: true }) }
      return undefined
    },
    subagents: { listChildren: async () => children },
  }
}

function recorder(url = '/supervisor/loop?sessionId=session-1') {
  const res = {
    status: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    end(body) { this.body = body; return this },
  }
  return {
    req: { method: 'GET', url, headers: {} },
    res,
    read() {
      return { status: res.status, body: res.body === undefined ? undefined : JSON.parse(res.body) }
    },
  }
}

test('the loop route explains the recommendation instead of only returning a number', async () => {
  const { req, res, read } = recorder()
  await loopHandler(fakeCtx({ children: [{ id: 'child-1', mode: 'continuable' }] }), req, res)
  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.live, true)
  assert.equal(body.recommend.band, 'worker')
  assert.ok(body.recommend.seconds > 0)
  assert.ok(typeof body.recommend.reason === 'string')
  assert.ok(typeof body.recommend.description === 'string')
  assert.deepEqual(body.watchdog, { enabled: true, armed: false, ownedElsewhere: false })
})

test('the loop route requires a session and refuses a non-supervisor session', async () => {
  const missing = recorder('/supervisor/loop')
  await loopHandler(fakeCtx(), missing.req, missing.res)
  assert.equal(missing.read().status, 400)

  const foreign = recorder()
  await loopHandler(fakeCtx({ settings: {} }), { ...foreign.req }, foreign.res)
  // Unknown session → honest "not live", never a fabricated recommendation.
  const unknown = recorder('/supervisor/loop?sessionId=other')
  await loopHandler(fakeCtx(), unknown.req, unknown.res)
  const { status, body } = unknown.read()
  assert.equal(status, 200)
  assert.equal(body.live, false)
})

// ----------------------------------------------------- reconcileLoop 的读写口
//
// 真机上暴露过的问题：`activeReminders` 只 fold session 日志，而通过 schedule
// 服务创建的提醒从不写日志。于是「我自己已经排过」这件事永远读不出来，watchdog
// 每 20 秒的窗口就再补一条 —— 实测 schedule 表里 4 条 watchdog 提醒间隔 20 秒。
// 下面这几条把「读权威表」这个前提钉住。

function loopCtx({ goal, reminders = [], settings = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-loop-'))
  const calls = []
  const schedule = {
    list: async ({ sessionId }) => {
      calls.push(`list:${sessionId}`)
      return reminders.map(record => ({
        ...record,
        scheduledAt: new Date(record.scheduledAt).toISOString(),
      }))
    },
    create: async (sessionId, request) => {
      calls.push(`create:${request.title}:${request.after_seconds}`)
      return { id: 'created', ...request }
    },
    delete: async ({ id }) => {
      calls.push(`delete:${id}`)
      return { id, deleted: true }
    },
  }
  return {
    calls,
    agent: { id: 'session-1', session: { id: 'session-1', header: { version: 4, cwd, agentPreset: 'main-agent' } } },
    ctx: {
      get: name => {
        if (name === 'supervisorSettings') {
          return { current: () => ({ wakeMinutes: 5, questionWaitMinutes: 2, watchdogEnabled: true, ...settings }) }
        }
        if (name === 'goals') return { get: () => goal }
        if (name === 'schedule') return schedule
        if (name === 'agents') return { get: () => undefined }
        if (name === 'subagents') return { listChildren: async () => [] }
        return undefined
      },
    },
    log: { warn() {}, info() {} },
  }
}

test('an existing watchdog row read from the authoritative table stops the watchdog from arming again', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { ctx, agent, calls, log } = loopCtx({
    goal: { phase: 'active' },
    reminders: [{ id: 'watch-1', title: WATCHDOG_TITLE, scheduledAt: Date.now() + 300_000 }],
  })
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.equal(outcome.action, 'none')
  assert.deepEqual(calls, ['list:session-1'], 'neither创建 nor 删除：那条提醒本来就在正确时间上')
})

test('a watchdog row scheduled too far out is replaced with a nearer one', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { ctx, agent, calls, log } = loopCtx({
    goal: { phase: 'active' },
    reminders: [{ id: 'watch-old', title: WATCHDOG_TITLE, scheduledAt: Date.now() + 6 * 3600_000 }],
  })
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.equal(outcome.action, 'arm')
  assert.equal(calls[1], 'delete:watch-old')
  assert.ok(calls[2].startsWith(`create:${WATCHDOG_TITLE}:`))
})

test('a reminder the model scheduled itself makes the watchdog yield', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { ctx, agent, calls, log } = loopCtx({
    goal: { phase: 'active' },
    reminders: [{ id: 'mine', title: '巡检：看 worker', scheduledAt: Date.now() + 120_000 }],
  })
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.equal(outcome.action, 'yield')
  assert.ok(!calls.some(call => call.startsWith('create:')), 'yield 不能再补一条')
})

test('a finished goal clears every watchdog row through the service', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { ctx, agent, calls, log } = loopCtx({
    goal: { phase: 'complete' },
    reminders: [
      { id: 'watch-a', title: WATCHDOG_TITLE, scheduledAt: Date.now() + 60_000 },
      { id: 'watch-b', title: WATCHDOG_TITLE, scheduledAt: Date.now() + 90_000 },
    ],
  })
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.equal(outcome.action, 'clear')
  assert.deepEqual(calls.filter(call => call.startsWith('delete:')), ['delete:watch-a', 'delete:watch-b'])
  assert.ok(!calls.some(call => call.startsWith('create:')))
})

test('full stop also reaches reminders that never appended a log event', async () => {
  const order = []
  const agent = fakeStopAgent(order, [])
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    () => agent.fold(),
    {
      deleteReminder: async (sessionId, id) => { order.push(`delete:${id}`); return { id, deleted: true } },
      listReminderIds: async () => ['service-only'],
    },
  )
  assert.deepEqual(outcome.ids, ['service-only'])
  assert.ok(order.includes('delete:service-only'))
  assert.equal(outcome.durableDeleted, 1)
})
