/**
 * End-to-end regression coverage for the supervisor goal frontend.
 *
 * The 0.2 Session surface exposes its log only through `snapshotEvents()`.
 * `lib/goal.js` still read the removed plain `session.events` field, so the
 * very first `get_goal` / `start_goal` call threw
 * `TypeError: Cannot read properties of undefined (reading 'length')` before
 * any policy check ran. The mocks here therefore declare the same Session
 * surface the live Harness declares, exercise the registered tools through a
 * fake plugin context, and pin the failure mode to a typed policy rejection
 * instead of a TypeError.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/goal.js')

const TURN = 1
const CWD = mkdtempSync(join(tmpdir(), 'dsh-goal-tools-'))

/** One logged Session event, carrying only the fields the plugin reads. */
function event(type, seq, data = {}) {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

function userMessage(seq, text) {
  return event('user/message', seq, {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * A Session that exposes exactly the declared 0.2 surface: `header` plus a
 * `snapshotEvents()` log. There is deliberately no `events` field.
 */
function sessionWith(events) {
  return {
    header: { id: 'session-under-test', cwd: CWD, version: 4, agentPreset: 'main-agent' },
    inheritedEventCount: 0,
    snapshotEvents: () => events,
  }
}

/** The log a running root agent has at the moment a goal tool executes. */
function openTurnLog() {
  return [
    event('session/start', 0, {}),
    event('turn/start', 1, { turn: TURN }),
    userMessage(2, 'continue the mission'),
  ]
}

function goalRecord(overrides = {}) {
  return {
    id: 'goal-2f1c',
    revision: 1,
    objective: 'Ship a verified report.',
    phase: 'active',
    roundsStarted: 0,
    maxGoalRounds: 12,
    activation: 'armed',
    ...overrides,
  }
}

/** One fake plugin context carrying only what `apply()` registers against. */
function harness(events) {
  const session = sessionWith(events)
  const agent = { id: 'agent-under-test', session, status: 'running' }
  const tools = new Map()
  const sections = []
  const listeners = new Map()
  const fake = {
    session,
    agent,
    tools,
    sections,
    listeners,
    goals: { value: undefined },
    ctx: {
      agents: {
        get: id => (id === agent.id ? agent : undefined),
        roots: () => [agent],
        currentInitiator: () => agent,
      },
      goals: {
        get: () => fake.goals.value,
        create: (_agent, request) => (fake.goals.value = goalRecord({ objective: request.objective, maxGoalRounds: request.maxGoalRounds })),
        pause: () => (fake.goals.value = goalRecord({ phase: 'paused' })),
        resume: () => (fake.goals.value = goalRecord()),
        complete: () => (fake.goals.value = goalRecord({ phase: 'complete' })),
        block: () => (fake.goals.value = goalRecord({ phase: 'blocked' })),
      },
      systemPrompt: { section: section => sections.push(section) },
      tools: { register: tool => tools.set(tool.name, tool) },
      on: (name, listener) => listeners.set(name, listener),
    },
  }
  fake.tool = name => {
    const tool = tools.get(name)
    assert.ok(tool, `${name} must be registered`)
    return tool
  }
  fake.exec = (name, args) => tool => tool.execute(args, {
    agent,
    name,
    arguments: args,
    deferContext: () => {},
  })
  apply(fake.ctx)
  return fake
}

function runGoalTool(context, name, args = {}) {
  const tool = context.tool(name)
  return tool.execute(args, { agent: context.agent, name, arguments: args, deferContext: () => {} })
}

/**
 * `assert.rejects` treats a throwing validator as a failure, so these helpers
 * return booleans. The crash under test is a raw TypeError on the removed
 * `session.events` field, never a typed policy rejection.
 */
function policyCode(code) {
  return error => error?.name !== 'TypeError' && error?.code === code
}

function policyMessage(pattern) {
  return error => error?.name !== 'TypeError' && pattern.test(error?.message ?? '')
}

test('get_goal reads the declared snapshotEvents Session surface', async () => {
  const context = harness(openTurnLog())
  context.goals.value = goalRecord()

  assert.deepEqual(await runGoalTool(context, 'get_goal'), {
    goal: {
      id: 'goal-2f1c',
      revision: 1,
      objective: 'Ship a verified report.',
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds: 12,
    },
    activation: 'armed',
  })
})

test('get_goal reports the no-active-goal state without throwing', async () => {
  const context = harness(openTurnLog())
  assert.deepEqual(await runGoalTool(context, 'get_goal'), { goal: null })
})

test('start_goal writes GOAL.md and arms the native goal in the same turn', async () => {
  const context = harness(openTurnLog())
  const args = {
    objective: 'Ship a verified report.',
    constraints: ['No Harness edits.'],
    milestones: ['Inspect.', 'Verify.'],
    out_of_scope: ['Rewrites.'],
    max_goal_rounds: 12,
  }
  const result = await runGoalTool(context, 'start_goal', args)

  assert.equal(result.activation, 'armed')
  assert.equal(result.goal.objective, 'Ship a verified report.')
  assert.equal(result.goal.maxGoalRounds, 12)
  assert.equal(result.goalFile, join(CWD, '.agi', 'GOAL.md'), 'the goal file must live in the session cwd')
  assert.match(readFileSync(result.goalFile, 'utf8'), /## 目标陈述\n\nShip a verified report\./)
  assert.equal(context.goals.value.phase, 'active')
  assert.equal(context.tool('get_goal').name, 'get_goal')
  assert.equal(context.tool('update_goal').name, 'update_goal')
})

test('goal tools reject an unreadable or legacy Session log without a TypeError', async () => {
  // A Session whose log cannot be read at all: no snapshotEvents(), no events.
  const unreadable = harness([{ type: 'session/start', seq: 0, data: {} }])
  unreadable.session.snapshotEvents = undefined
  await assert.rejects(
    async () => runGoalTool(unreadable, 'get_goal'),
    policyCode('SUPERVISOR_GOAL_DRIVER_REQUIRED'),
  )

  // A legacy Session that only carries the removed plain `events` field. The
  // pre-fix code read `session.events.length` unconditionally; the read is now
  // revision-tolerant and fails as a typed policy rejection.
  const legacy = harness([])
  legacy.session.snapshotEvents = undefined
  legacy.session.events = []
  await assert.rejects(
    async () => runGoalTool(legacy, 'get_goal'),
    policyCode('SUPERVISOR_GOAL_DRIVER_REQUIRED'),
  )
})

test('update_goal keeps the direct-human boundary for pause and resume', async () => {
  const context = harness(openTurnLog())
  context.goals.value = goalRecord()

  const paused = await runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'pause' })
  assert.equal(paused.goal.phase, 'paused')
  const resumed = await runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'resume' })
  assert.equal(resumed.goal.phase, 'active')
  const completed = await runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'complete' })
  assert.equal(completed.goal.phase, 'complete')

  // The exact id/revision pair returned by get_goal stays required.
  await assert.rejects(
    async () => runGoalTool(context, 'update_goal', { goal_id: '   ', revision: 1, action: 'complete' }),
    policyCode('SUPERVISOR_GOAL_INVALID_UPDATE'),
  )
})

test('update_goal admits a goal round but never a pause, and still enforces the blocked floor', async () => {
  const context = harness([
    event('session/start', 0, {}),
    event('turn/start', 1, { turn: TURN }),
    event('user/message', 2, {
      content: [{ type: 'text', text: 'continue the mission' }],
      source: { kind: 'goal', goalId: 'goal-2f1c', revision: 1, round: 0 },
    }),
  ])
  context.goals.value = goalRecord()

  await assert.rejects(
    async () => runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'pause' }),
    policyMessage(/需要一个直接人类回合/),
  )
  await assert.rejects(
    async () => runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'blocked', blocked_reason: 'stuck' }),
    policyMessage(/至少需要 3 个连续的 goal 回合/),
  )
  const completed = await runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'complete' })
  assert.equal(completed.goal.phase, 'complete')
})


/** 一个不是人开口的回合：定时唤醒投递的消息 source.kind 固定是 'schedule'。 */
function scheduledTurnLog() {
  return [
    event('session/start', 0, {}),
    event('turn/start', 1, { turn: TURN }),
    event('user/message', 2, {
      content: [{ type: 'text', text: '巡检一次' }],
      source: { kind: 'schedule' },
    }),
  ]
}

/** `tools/pre-execute` 守卫：跑一次，返回它给出的结果与 next 被调用的次数。 */
async function runGuard(context, name, args) {
  const guard = context.listeners.get('tools/pre-execute')
  assert.equal(typeof guard, 'function', 'tools/pre-execute 守卫必须注册')
  let forwarded = 0
  const result = await guard({ agent: context.agent, name, arguments: args }, () => {
    forwarded += 1
    return 'next'
  })
  return { result, forwarded }
}

test('定时唤醒里 start_goal 在执行前就被拒，且理由说的是现场不是权限', async () => {
  const context = harness(scheduledTurnLog())

  const { result, forwarded } = await runGuard(context, 'start_goal', { objective: 'x' })
  assert.equal(forwarded, 0, '被拒的 goal 写入动作不该继续往下走')
  assert.equal(result?.kind, 'deny')
  assert.match(result.reason, /start_goal 需要一个直接人类回合/)
  assert.match(result.reason, /定时唤醒/)

  // 守卫只接管 goal 写入动作：同一条定时回合里的普通工具照旧放行，
  // 这样 watchdog 真正需要派活儿的回合不会被掐死。
  const plain = await runGuard(context, 'bash', { command: 'ls' })
  assert.equal(plain.result, 'next')
  assert.equal(plain.forwarded, 1)

  // 守卫若被绕过，工具本体是最后一道闸：同样是「需要直接人类回合」，不是 TypeError。
  await assert.rejects(
    async () => runGoalTool(context, 'start_goal', {
      objective: 'Ship a verified report.',
      constraints: [],
      milestones: [],
      out_of_scope: [],
    }),
    policyMessage(/start_goal 需要一个直接人类回合/),
  )
  assert.equal(context.goals.value, undefined, '被拒的 start_goal 不该武装任何目标')
})

test('看门狗判停的 goal 可以在定时唤醒里自己恢复，并留下系统持有的凭证', async () => {
  const context = harness(scheduledTurnLog())
  const idle = { code: 'idle', message: '连续 5 个回合没有推进' }
  context.goals.value = goalRecord({ phase: 'blocked', blockedReason: idle })

  const guard = await runGuard(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'resume' })
  assert.equal(guard.result, 'next', '系统自己停的目标必须能在定时回合里自己回来')

  const changelog = join(CWD, '.agi', 'CHANGELOG.jsonl')
  const before = existsSync(changelog)
    ? readFileSync(changelog, 'utf8').trim().split('\n').filter(Boolean).length
    : 0

  const resumed = await runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'resume' })
  assert.equal(resumed.goal.phase, 'active')

  const lines = readFileSync(changelog, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(lines.length, before + 1, '一次自动恢复必须留一条带凭证的记录')
  const entry = JSON.parse(lines.at(-1))
  assert.deepEqual(entry.authority, { kind: 'rule', id: 'goal-system-hold' })
  assert.equal(entry.actor, 'main-agent')
  assert.equal(entry.action, 'goal-resume')
  assert.equal(entry.goalId, 'goal-2f1c')
  assert.deepEqual(entry.blockedReason, idle)
  assert.equal(entry.turnSource, 'schedule')
  assert.match(entry.summary, /idle/)
})

test('非人类回合里 pause 与「不是空转」的 resume 执行前就被拒，complete 不被接管', async () => {
  const context = harness(scheduledTurnLog())

  // 模型自报阻塞：需要一个成年人拍板，理由里要把原因码原文报出来。
  context.goals.value = goalRecord({ phase: 'blocked', blockedReason: { code: 'model-reported', message: 'stuck' } })
  const blocked = await runGuard(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'resume' })
  assert.equal(blocked.result?.kind, 'deny')
  assert.match(blocked.result.reason, /model-reported/)

  // 人暂停的目标：解除同样要人。
  context.goals.value = goalRecord({ phase: 'paused' })
  const paused = await runGuard(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'resume' })
  assert.equal(paused.result?.kind, 'deny')
  assert.match(paused.result.reason, /被人暂停/)

  // 按住正在跑的循环只有人能决定。
  context.goals.value = goalRecord()
  const hold = await runGuard(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'pause' })
  assert.equal(hold.result?.kind, 'deny')
  assert.match(hold.result.reason, /只有人能把正在跑的循环按住/)

  // complete / blocked 有自己那条 goal-round 通道，刻意不在这条守卫里接管。
  const finish = await runGuard(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'complete' })
  assert.equal(finish.result, 'next')

  // 工具本体给出的仍是同一句「现场」，两处判据没有漂移。
  await assert.rejects(
    async () => runGoalTool(context, 'update_goal', { goal_id: 'goal-2f1c', revision: 1, action: 'pause' }),
    policyMessage(/只有人能把正在跑的循环按住/),
  )
})
