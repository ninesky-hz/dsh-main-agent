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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderGoalMarkdown } from '../lib/goal-policy.js'
import {
  MAX_IDLE_SECONDS,
  MIN_WAKE_SECONDS,
  WATCHDOG_TITLE,
  adaptiveWake,
  describeWake,
  idleStreakOf,
  deriveLeaseOverdue,
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
  // lease-first：先建新的，再撤旧的。反过来的顺序在两次调用之间崩溃会留下
  // 「零提醒」—— 重启后就没有任何东西能把这条循环拉起来了。
  assert.ok(calls[1].startsWith(`create:${WATCHDOG_TITLE}:`), 'create 必须先于 delete')
  assert.equal(calls[2], 'delete:watch-old')
})

test('a failed create keeps the old row: the loop is never left with zero reminders', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { ctx, agent, calls, log } = loopCtx({
    goal: { phase: 'active' },
    reminders: [{ id: 'watch-old', title: WATCHDOG_TITLE, scheduledAt: Date.now() + 6 * 3600_000 }],
  })
  // 建新提醒这一步失败（表被锁、写盘满、宿主换版本）。
  const schedule = ctx.get('schedule')
  schedule.create = async () => {
    calls.push('create:failed')
    throw new Error('table busy')
  }
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.equal(outcome.action, 'none')
  assert.ok(!calls.some(call => call.startsWith('delete:')), '建失败时一条都不能删')
})

test('arming records a lease so a restart can tell the loop was abandoned', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { readLoopState, sessionKeyOf } = await import('../lib/loop-journal.js')
  const { ctx, agent, log } = loopCtx({ goal: { phase: 'active' }, reminders: [] })
  const before = Date.now()
  await reconcileLoop(ctx, agent, log)
  const state = readLoopState(agent.session.header.cwd, sessionKeyOf(agent.session))
  assert.ok(state.leaseExpiresAt > before, 'lease 到期时刻必须落在未来')
  assert.ok(state.leaseExpiresAt > state.lastArmAt, 'lease 至少比建的时刻晚一个间隔')
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

// ------------------------------------- 每轮重校验：策略与 GOAL.md 的变更可见
//
// 真机症状：用户在设置面板把并行上限从 6 调到 1，监督者直到重启都还按 6 派活；
// GOAL.md 被人改过之后，也没有任何一处告诉读者「你在按旧版执行」。这两条用例走
// 完整的 `reconcileLoop`：第一轮只记指纹，第二轮改设置/改文件才报警。

/** 读 `.agi/BRIEF.md`（reconcileLoop 每轮都会重写）。 */
function briefText(agent) {
  return readFileSync(join(agent.session.header.cwd, '.agi', 'BRIEF.md'), 'utf8')
}

/** 读 progress.jsonl 里的事件名序列（还没有任何事件时是空数组）。 */
function eventNames(agent) {
  const path = join(agent.session.header.cwd, '.agi', 'progress.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .map(record => record.event)
}

test('a settings change between rounds lands in the timeline and the brief', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const settings = { maxParallelWorkers: 6, proactive: 'auto' }
  const { ctx, agent, log } = loopCtx({ goal: { phase: 'active' }, reminders: [], settings })

  await reconcileLoop(ctx, agent, log)
  // 首轮只是记下指纹，不能凭空报「策略已变更」。
  assert.equal(briefText(agent).includes('策略已变更'), false)

  settings.maxParallelWorkers = 1
  await reconcileLoop(ctx, agent, log)

  assert.ok(eventNames(agent).includes('policy-changed'))
  const brief = briefText(agent)
  assert.match(brief, /- 策略已变更：maxParallelWorkers 6→1，本轮起生效/)
  // 渲染在正文之前：先规则、再状态。
  assert.ok(brief.indexOf('策略已变更') < brief.indexOf('## 循环状态'))

  // 第三轮设置没再动 —— 不该重复报警。
  const before = eventNames(agent).filter(name => name === 'policy-changed').length
  await reconcileLoop(ctx, agent, log)
  assert.equal(eventNames(agent).filter(name => name === 'policy-changed').length, before)
  assert.equal(briefText(agent).includes('策略已变更'), false)
})

test('an edited GOAL.md is reported with its revision and body change', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { ctx, agent, log } = loopCtx({ goal: { phase: 'active' }, reminders: [] })
  const goalPath = join(agent.session.header.cwd, '.agi', 'GOAL.md')
  mkdirSync(join(agent.session.header.cwd, '.agi'), { recursive: true })

  writeFileSync(goalPath, renderGoalMarkdown({
    objective: 'Keep the loop honest.',
    constraints: [],
    milestones: ['Read.'],
    outOfScope: [],
    maxGoalRounds: 12,
    revision: 1,
    updated: '2026-11-08T00:00:00.000Z',
  }), 'utf8')
  await reconcileLoop(ctx, agent, log)
  assert.equal(briefText(agent).includes('GOAL.md 已被修改'), false)

  // 只改正文、不改 revision：也要报，但说清「版本号没动」。
  writeFileSync(goalPath, renderGoalMarkdown({
    objective: 'Keep the loop honest.',
    constraints: [],
    milestones: ['Read.', 'Verify.'],
    outOfScope: [],
    maxGoalRounds: 12,
    revision: 1,
    updated: '2026-11-08T00:00:00.000Z',
  }), 'utf8')
  await reconcileLoop(ctx, agent, log)
  assert.match(briefText(agent), /- GOAL\.md 已被修改：revision 1 未变但正文有改动/)

  // 再改 revision 且改正文：两个事实都要出现。
  writeFileSync(goalPath, renderGoalMarkdown({
    objective: 'Keep the loop honest, even after edits.',
    constraints: [],
    milestones: ['Read.', 'Verify.'],
    outOfScope: [],
    maxGoalRounds: 12,
    revision: 2,
    updated: '2026-11-08T01:00:00.000Z',
  }), 'utf8')
  await reconcileLoop(ctx, agent, log)
  const brief = briefText(agent)
  assert.match(brief, /- GOAL\.md 已被修改：revision 1→2，本轮起按新版本执行（正文亦有改动）/)
  assert.ok(eventNames(agent).filter(name => name === 'goal-revised').length >= 2)

  // 没有 GOAL.md 的工作区沉默，不报错。
  const bare = loopCtx({ goal: { phase: 'active' }, reminders: [] })
  await reconcileLoop(bare.ctx, bare.agent, bare.log)
  assert.equal(readdirSync(join(bare.agent.session.header.cwd, '.agi')).includes('GOAL.md'), false)
  assert.equal(eventNames(bare.agent).includes('goal-revised'), false)
})

// ------------------------------- lease 与冷启动扫描（崩溃后的续命路径）
//
// 真机症状：DSH 崩溃或被杀之后重开，那条会话永远停在「任务已停止」—— 没有
// 任何回合会再触发 pre-step，而旧的冷启动扫描读的是内存里的 `agents.roots()`，
// 重启后必然是空的。下面几条把「lease 过期能被看见」与「数据源必须是磁盘」
// 这两个前提钉住。

test('a lease is only overdue once the planned interval plus grace has passed', () => {
  const now = 1_000_000_000
  // 没有 lease、也没有 lastArmAt：未知，不算过期 —— 误判会让每次启动都多唤一次。
  assert.equal(deriveLeaseOverdue({ now, seconds: 300 }).overdue, false)
  // 还在未来：正常。
  assert.equal(deriveLeaseOverdue({ leaseExpiresAt: now + 60_000, now, seconds: 300 }).overdue, false)
  // 刚过期几秒：宽限内，不算。
  assert.equal(deriveLeaseOverdue({ leaseExpiresAt: now - 1_000, now, seconds: 300 }).overdue, false)
  // 过期超过宽限：算，并给出迟到秒数。
  const late = deriveLeaseOverdue({ leaseExpiresAt: now - 900_000, now, seconds: 300 })
  assert.equal(late.overdue, true)
  assert.equal(late.overdueSeconds, 600)
  // 升级前写下的循环状态只记了 lastArmAt：按当时的间隔推算，同样能判出来。
  assert.equal(deriveLeaseOverdue({ lastArmAt: now - 3_600_000, now, seconds: 300 }).overdue, true)
})

test('the sweep picks supervisor sessions out of raw headers, never child or archived ones', async () => {
  const { filterSupervisorSessionIds } = await import('../lib/watchdog.js')
  const ids = filterSupervisorSessionIds([
    { id: 'session-a', agentPreset: 'main-agent' },
    { id: 'session-a', agentPreset: 'main-agent' },
    { id: 'session-child', agentPreset: 'main-agent', origin: 'subagent' },
    { id: 'session-plain', agentPreset: 'default' },
    { id: 'session-archived', agentPreset: 'main-agent' },
    null,
    { agentPreset: 'main-agent' },
  ], { archivedIds: ['session-archived'] })
  assert.deepEqual(ids, ['session-a'])
})

/** ensureBootSweep 的最小 ctx：磁盘上有会话，内存里一条 agent 都没有（重启后的样子）。 */
function bootCtx({ headers = [], live = [], archivedIds = [], cwd, goal = { phase: 'active' } } = {}) {
  const calls = []
  const agents = new Map()
  const agentOf = id => {
    const agent = { id, session: { id, header: { version: 4, cwd, agentPreset: 'main-agent' } } }
    agents.set(id, agent)
    return agent
  }
  const schedule = {
    list: async ({ sessionId }) => {
      calls.push(`list:${sessionId}`)
      return []
    },
    create: async (sessionId, request) => {
      calls.push(`create:${sessionId}:${request.after_seconds}`)
      return { id: `created-${sessionId}`, ...request }
    },
    delete: async ({ id }) => {
      calls.push(`delete:${id}`)
      return { id, deleted: true }
    },
  }
  const ctx = {
    get: name => {
      if (name === 'supervisorSettings') {
        return { current: () => ({ wakeMinutes: 5, questionWaitMinutes: 2, watchdogEnabled: true }) }
      }
      if (name === 'goals') return { get: () => goal }
      if (name === 'schedule') return schedule
      if (name === 'agents') return { get: id => agents.get(id) }
      if (name === 'sessions') return { list: () => live.map(header => ({ header })) }
      if (name === 'sessionPersistence') return { list: async () => headers.map(header => ({ header })) }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archivedIds }
      if (name === 'subagents') return { listChildren: async () => [] }
      return undefined
    },
    waterfall: async (name, sessionId) => {
      calls.push(`resolve:${sessionId}`)
      return agentOf(sessionId)
    },
  }
  return { ctx, calls }
}

const quietLog = { warn() {}, info() {} }

test('a crashed loop with an expired lease wakes within a second on startup', async () => {
  const { ensureBootSweep } = await import('../lib/watchdog.js')
  const { writeLoopState, sessionKeyOf } = await import('../lib/loop-journal.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-boot-'))
  const header = { id: 'session-crashed', agentPreset: 'main-agent' }
  // 上一次巡检承诺的唤醒时刻是两小时前：这条循环本来早该被叫醒了。
  const now = Date.now()
  writeLoopState(cwd, { lastArmAt: now - 7_300_000, leaseExpiresAt: now - 7_200_000 }, sessionKeyOf(header))

  // 同一会话同时出现在 live 与磁盘快照里：只该扫一次。
  const { ctx, calls } = bootCtx({ headers: [header], live: [header], cwd })
  const outcome = await ensureBootSweep(ctx, quietLog)

  assert.equal(outcome.scanned, 1)
  assert.deepEqual(outcome.recovered, ['session-crashed'])
  assert.ok(calls.includes('create:session-crashed:1'), '过期就直接唤醒，不再等一个完整间隔')
  assert.match(
    readFileSync(join(cwd, '.agi', 'progress.jsonl'), 'utf8'),
    /wake-recovered/,
    '补齐唤醒这件事必须进时间线',
  )
})

test('a session whose lease is still valid is left on its normal cadence', async () => {
  const { ensureBootSweep } = await import('../lib/watchdog.js')
  const { writeLoopState, sessionKeyOf } = await import('../lib/loop-journal.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-boot-'))
  const header = { id: 'session-fresh', agentPreset: 'main-agent' }
  writeLoopState(cwd, { leaseExpiresAt: Date.now() + 600_000 }, sessionKeyOf(header))

  const { ctx, calls } = bootCtx({ headers: [header], cwd })
  const outcome = await ensureBootSweep(ctx, quietLog)

  assert.deepEqual(outcome.recovered, [])
  const created = calls.filter(call => call.startsWith('create:'))
  assert.equal(created.length, 1)
  assert.ok(!created[0].endsWith(':1'), '没过期就不该立刻唤醒')
})

test('a session the host cannot mount is reported instead of silently dropped', async () => {
  const { ensureBootSweep } = await import('../lib/watchdog.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-boot-'))
  const { ctx } = bootCtx({ headers: [{ id: 'session-lost', agentPreset: 'main-agent' }], cwd })
  ctx.waterfall = async () => undefined

  const outcome = await ensureBootSweep(ctx, quietLog)
  assert.equal(outcome.scanned, 1)
  assert.deepEqual(outcome.unresolved, ['session-lost'])
})

test('recovering a crashed loop is idempotent across a burst of startup sweeps', async () => {
  const { ensureLoopRecovered } = await import('../lib/watchdog.js')
  const { writeLoopState, sessionKeyOf } = await import('../lib/loop-journal.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-boot-'))
  const agent = {
    id: 'session-twice',
    session: { id: 'session-twice', header: { version: 4, cwd, agentPreset: 'main-agent' } },
  }
  const now = Date.now()
  writeLoopState(
    cwd,
    { lastArmAt: now - 7_300_000, leaseExpiresAt: now - 7_200_000 },
    sessionKeyOf(agent.session),
  )
  const { ctx, calls } = bootCtx({ cwd })

  const first = await ensureLoopRecovered(ctx, agent, quietLog)
  assert.equal(first.action, 'recover')

  // 同一次启动里扫描会排好几轮（3s/20s/60s…）：刚补齐过的那条不能再补，
  // 否则一次崩溃换来的是一串重复唤醒。
  const mark = calls.length
  const second = await ensureLoopRecovered(ctx, agent, quietLog)
  assert.notEqual(second.action, 'recover')
  assert.ok(!calls.slice(mark).includes('create:session-twice:1'), '第二轮不该再立刻唤醒')
})

test('监督者 preset 由设置决定：打开的那个也进扫描范围', async () => {
  const { deriveSupervisorPresets, filterSupervisorSessionIds } = await import('../lib/watchdog.js')
  const headers = [
    { id: 'session-cordis', agentPreset: 'cordis' },
    { id: 'session-main', agentPreset: 'main-agent' },
  ]
  // 默认（没打开任何额外 preset）只认内置那档。
  assert.deepEqual(filterSupervisorSessionIds(headers), ['session-main'])
  // 设置里勾了 cordis：扫描与 pre-step 守卫都按同一份集合走，否则「设置说开了、
  // watchdog 不干活」—— 线上就是这个形态：会话跑 cordis，一块状态都不写。
  const presets = deriveSupervisorPresets({ supervisedPresets: ['cordis'] })
  assert.ok(presets.has('main-agent'), '内置那档永远在集合里')
  assert.deepEqual(filterSupervisorSessionIds(headers, { presets }), ['session-cordis', 'session-main'])
})

test('pre-step 不再硬编码 main-agent：设置里打开的那档照样开始对账', async () => {
  const { installLoopWatchdog, WATCHDOG_TITLE } = await import('../lib/watchdog.js')
  const { readLoopState, sessionKeyOf } = await import('../lib/loop-journal.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-preset-'))
  const calls = []
  const schedule = {
    list: async () => [],
    create: async (sessionId, request) => {
      calls.push(`create:${sessionId}:${request.after_seconds}`)
      return { id: 'created', ...request }
    },
    delete: async ({ id }) => ({ id, deleted: true }),
  }
  let listener
  const ctx = {
    effect: fn => { fn() },
    on: (name, fn) => { if (name === 'agent/pre-step') listener = fn; return () => {} },
    get: name => {
      if (name === 'supervisorSettings') {
        return { current: () => ({ wakeMinutes: 5, questionWaitMinutes: 2, supervisedPresets: ['cordis'] }) }
      }
      if (name === 'goals') return { get: () => ({ phase: 'active' }) }
      if (name === 'schedule') return schedule
      if (name === 'subagents') return { listChildren: async () => [] }
      return undefined
    },
  }
  installLoopWatchdog(ctx, { warn() {}, info() {} })
  assert.ok(typeof listener === 'function', 'pre-step 监听必须装上')

  const agent = { id: 'session-cordis', session: { id: 'session-cordis', header: { version: 4, cwd, agentPreset: 'cordis' } } }
  const decision = await listener({ agent }, async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'continue')

  // 对账是不 await 的：给它一拍再读盘上的事实。
  await new Promise(resolve => setTimeout(resolve, 200))
  const state = readLoopState(cwd, sessionKeyOf(agent.session))
  assert.ok(state.leaseExpiresAt > 0, 'cordis 会话也必须留下 lease')
})

/** 心跳用例的落盘准备：一个已经过期、还没被扫描救回来的 lease。 */
async function seededLease(cwd, sessionId, patch = {}) {
  const { writeLoopState } = await import('../lib/loop-journal.js')
  const now = Date.now()
  const key = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)
  writeLoopState(cwd, {
    lastArmAt: now - 7_300_000,
    leaseExpiresAt: now - 7_200_000,
    ...patch,
  }, key)
  return key
}

test('心跳发现运行中漏投：lease 过期就补一条 1 秒后的提醒', async () => {
  const { ensureLeaseHeartbeat } = await import('../lib/watchdog.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-heartbeat-'))
  const header = { id: 'session-crash', version: 4, cwd, agentPreset: 'main-agent' }
  const { ctx, calls } = bootCtx({ headers: [header], cwd })
  const key = await seededLease(cwd, 'session-crash')

  const stop = ensureLeaseHeartbeat(ctx, quietLog, { intervalMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 80))
  stop()

  assert.ok(
    calls.includes('create:session-crash:1'),
    `过期 lease 必须补一条立刻到期的提醒，实际调用：${calls.join(',')}`,
  )
  const { readLoopState } = await import('../lib/loop-journal.js')
  const state = readLoopState(cwd, key)
  assert.ok(state.recoveredAt > 0, '补过之后要记下 recoveredAt，避免连环唤醒')
  const events = readFileSync(join(cwd, '.agi', 'progress.jsonl'), 'utf8')
  assert.ok(events.includes('wake-heartbeat'), '补唤醒必须留痕，不能只写 stderr')
  assert.ok(readFileSync(join(cwd, '.agi', 'progress.jsonl'), 'utf8').includes('wake-heartbeat'))
})

test('心跳不重复补：已经有排着的兜底提醒就闭嘴', async () => {
  const { ensureLeaseHeartbeat } = await import('../lib/watchdog.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-heartbeat-pending-'))
  const header = { id: 'session-waiting', version: 4, cwd, agentPreset: 'main-agent' }
  const { ctx, calls } = bootCtx({ headers: [header], cwd })
  ctx.get('schedule').list = async () => [
    {
      id: 'kept',
      title: WATCHDOG_TITLE,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      involvedSessionIds: ['session-waiting'],
    },
  ]
  await seededLease(cwd, 'session-waiting')

  const stop = ensureLeaseHeartbeat(ctx, quietLog, { intervalMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 80))
  stop()

  assert.equal(calls.filter(call => call.startsWith('create:')).length, 0, '排着的提醒不是漏投')
})

test('心跳尊重 paused：空转停下的循环不该被它偷偷拉起来', async () => {
  const { ensureLeaseHeartbeat } = await import('../lib/watchdog.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-heartbeat-paused-'))
  const header = { id: 'session-paused', version: 4, cwd, agentPreset: 'main-agent' }
  const { ctx, calls } = bootCtx({ headers: [header], cwd })
  await seededLease(cwd, 'session-paused', { pausedBy: 'idle' })

  const stop = ensureLeaseHeartbeat(ctx, quietLog, { intervalMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 80))
  stop()

  assert.equal(calls.filter(call => call.startsWith('create:')).length, 0)
})

test('目标被空转判停后退到待机巡检：降频但不撤岗', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const { readLoopState } = await import('../lib/loop-journal.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-standby-'))
  writeFileSync(join(cwd, 'GOAL.md'), '# 目标\n')
  mkdirSync(join(cwd, '.agi'), { recursive: true })
  const { ctx, calls, agent, log } = loopCtx({ goal: { id: 'g1', phase: 'blocked', revision: 1 } })
  agent.session.header.cwd = cwd
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.equal(outcome.action, 'arm')
  assert.equal(outcome.wake.reason, 'idle-standby')
  assert.ok(
    calls.some(call => String(call).endsWith(`:${MAX_IDLE_SECONDS}`)),
    `待机巡检必须排在 MAX_IDLE_SECONDS 之后，实际：${calls.join(',')}`,
  )
  const state = readLoopState(cwd, agent.session.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8))
  assert.ok(state.leaseExpiresAt >= Date.now() + MAX_IDLE_SECONDS * 1000 - 5_000)
})

test('写了 NOTES 就算有产出：不该被当成空转判停', async () => {
  const { reconcileLoop } = await import('../lib/watchdog.js')
  const cwd = mkdtempSync(join(tmpdir(), 'dsma-activity-'))
  writeFileSync(join(cwd, 'GOAL.md'), '# 目标\n')
  mkdirSync(join(cwd, '.agi'), { recursive: true })
  // 只有进度日志是很久以前的；NOTES 是刚写的。
  writeFileSync(join(cwd, '.agi', 'progress.jsonl'), `${JSON.stringify({ ts: new Date(Date.now() - 3 * 3600_000).toISOString() })}\n`)
  writeFileSync(join(cwd, '.agi', 'NOTES.md'), '# 笔记\n')
  const { ctx, calls, agent, log } = loopCtx({ goal: { id: 'g1', phase: 'active', revision: 1 } })
  agent.session.header.cwd = cwd
  const outcome = await reconcileLoop(ctx, agent, log)
  assert.ok(!calls.includes('block'), `有产出时不该判停，实际：${calls.join(',')}`)
  assert.notEqual(outcome.action, 'block')
})
