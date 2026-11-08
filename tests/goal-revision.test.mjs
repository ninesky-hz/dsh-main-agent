/**
 * B7：GOAL.md 的 revision / 正文指纹。
 *
 * 真机症状：监督者每轮都「按 GOAL.md 执行」，但 GOAL.md 被人改过之后没有任何人
 * 知道 —— 磁盘上的目标与运行时认的目标悄悄分叉。front-matter 就是这条裂缝的
 * 补丁：谁改的、改到第几版、正文还是不是原来那段，都能被机器读出来。
 *
 * 这些用例同时钉住三件事：渲染的形状、解析的严格（坏数据一律 null 而不是猜）、
 * 以及 start_goal 连续写两次时 revision 会不会递增。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import test from 'node:test'

import { goalDocDigest, parseGoalFrontMatter, renderGoalMarkdown } from '../lib/goal-policy.js'
import { renderBrief } from '../lib/loop-journal.js'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/goal.js')

const sha12 = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

const setup = () => ({
  objective: 'Ship a verified report.',
  constraints: ['No Harness edits.'],
  milestones: ['Inspect.', 'Verify.'],
  outOfScope: [],
  maxGoalRounds: 12,
})

// ── 渲染 ──────────────────────────────────────────────────────────────────────

test('renderGoalMarkdown：front-matter 在最前面，三件套齐全', () => {
  const markdown = renderGoalMarkdown({ ...setup(), updated: '2026-11-08T05:58:40.154Z' })
  assert.equal(markdown.startsWith('---\n'), true)
  const head = markdown.slice(0, markdown.indexOf('---\n\n') + '---\n\n'.length)
  assert.equal(head, [
    '---',
    'revision: 1',
    'updated: 2026-11-08T05:58:40.154Z',
    `objective_sha256: ${sha12('Ship a verified report.')}`,
    '---',
    '',
    '',
  ].join('\n'))
  // 正文一字未动。
  assert.match(markdown.slice(head.length), /^# 目标\n/)
})

test('renderGoalMarkdown：revision 可传入，非法值回落 1 而不是写出奇怪的版本号', () => {
  assert.match(renderGoalMarkdown({ ...setup(), revision: 7 }), /^---\nrevision: 7\n/)
  for (const bad of [0, -3, 1.5, '4', null, undefined, Number.NaN]) {
    assert.match(renderGoalMarkdown({ ...setup(), revision: bad }), /^---\nrevision: 1\n/)
  }
})

test('renderGoalMarkdown：updated 缺省用当前时刻，且是合法 ISO 串', () => {
  const markdown = renderGoalMarkdown(setup())
  const match = /^---\nrevision: 1\nupdated: (\S+)\n/.exec(markdown)
  assert.ok(match, 'front-matter 必须带 updated')
  assert.match(match[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  assert.equal(Number.isNaN(Date.parse(match[1])), false)
})

test('renderGoalMarkdown：objective 变了，objective_sha256 就变', () => {
  const a = renderGoalMarkdown({ ...setup(), updated: '2026-11-08T00:00:00.000Z' })
  const b = renderGoalMarkdown({ ...setup(), objective: 'Ship something else.', updated: '2026-11-08T00:00:00.000Z' })
  assert.notEqual(parseGoalFrontMatter(a).objectiveDigest, parseGoalFrontMatter(b).objectiveDigest)
})

// ── 解析 ──────────────────────────────────────────────────────────────────────

test('parseGoalFrontMatter：与渲染互为逆运算', () => {
  const markdown = renderGoalMarkdown({ ...setup(), revision: 3, updated: '2026-11-08T05:58:40.154Z' })
  assert.deepEqual(parseGoalFrontMatter(markdown), {
    revision: 3,
    updated: '2026-11-08T05:58:40.154Z',
    objectiveDigest: sha12('Ship a verified report.'),
  })
})

test('parseGoalFrontMatter：不是 front-matter 或字段缺失一律 null', () => {
  const good = '---\nrevision: 2\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789ab\n---\n\n# 目标\n'
  assert.equal(parseGoalFrontMatter(good).revision, 2)

  for (const bad of [
    undefined,
    null,
    42,
    '',
    '# 目标\n\n没有 front-matter。\n',
    // 正文里的水平线不是 front-matter。
    '\n---\nrevision: 1\n---\n',
    // 缺 updated
    '---\nrevision: 2\nobjective_sha256: 0123456789ab\n---\n',
    // 缺 objective_sha256
    '---\nrevision: 2\nupdated: 2026-11-08T00:00:00.000Z\n---\n',
    // revision 非正整数
    '---\nrevision: 0\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789ab\n---\n',
    '---\nrevision: -1\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789ab\n---\n',
    '---\nrevision: 1.5\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789ab\n---\n',
    '---\nrevision: abc\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789ab\n---\n',
    // 指纹不是 12 位小写十六进制
    '---\nrevision: 2\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123\n---\n',
    '---\nrevision: 2\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789AB\n---\n',
    '---\nrevision: 2\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: zzzzzzzzzzzz\n---\n',
    // 没有闭合
    '---\nrevision: 2\nupdated: 2026-11-08T00:00:00.000Z\nobjective_sha256: 0123456789ab\n',
  ]) {
    assert.equal(parseGoalFrontMatter(bad), null, `必须判成 null：${JSON.stringify(bad)}`)
  }
})

// ── 正文指纹 ──────────────────────────────────────────────────────────────────

test('goalDocDigest：只认正文，updated 变了也不算改过正文', () => {
  const a = renderGoalMarkdown({ ...setup(), updated: '2026-11-08T00:00:00.000Z' })
  const b = renderGoalMarkdown({ ...setup(), updated: '2026-12-01T12:00:00.000Z' })
  assert.equal(goalDocDigest(a), goalDocDigest(b))
  assert.equal(goalDocDigest(a), sha12(a.slice(a.indexOf('---\n\n') + '---\n\n'.length).trim()))

  // 正文真改了才变。
  const edited = a.replace('- Inspect.', '- Inspect carefully.')
  assert.notEqual(goalDocDigest(edited), goalDocDigest(a))
})

test('goalDocDigest：非字符串返回 null，不猜', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(goalDocDigest(bad), null)
  }
})

// ── start_goal：磁盘上的 revision 递增 ─────────────────────────────────────────

function event(type, seq, data = {}) {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

function userMessage(seq, text) {
  return event('user/message', seq, { content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function openTurnLog() {
  return [
    event('session/start', 0, {}),
    event('turn/start', 1, { turn: 1 }),
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

/** 自带一个空工作区的 goal 工具 harness（与 go-tools 测试同形，但 CWD 可注入）。 */
function harness(cwd) {
  const agent = {
    id: 'agent-under-test',
    session: {
      header: { id: 'session-under-test', cwd, version: 4, agentPreset: 'main-agent' },
      inheritedEventCount: 0,
      snapshotEvents: openTurnLog,
    },
    status: 'running',
  }
  const tools = new Map()
  const fake = { agent, tools, goals: { value: undefined } }
  apply({
    agents: {
      get: id => (id === agent.id ? agent : undefined),
      roots: () => [agent],
      currentInitiator: () => agent,
    },
    goals: {
      get: () => fake.goals.value,
      create: (_agent, request) => (fake.goals.value = goalRecord({
        objective: request.objective,
        maxGoalRounds: request.maxGoalRounds,
      })),
      pause: () => (fake.goals.value = goalRecord({ phase: 'paused' })),
      resume: () => (fake.goals.value = goalRecord()),
      complete: () => (fake.goals.value = goalRecord({ phase: 'complete' })),
      block: () => (fake.goals.value = goalRecord({ phase: 'blocked' })),
    },
    systemPrompt: { section: () => {} },
    tools: { register: tool => tools.set(tool.name, tool) },
    on: () => {},
  })
  return fake
}

const goalArgs = {
  objective: 'Keep the loop honest.',
  constraints: ['No Harness edits.'],
  milestones: ['Read.', 'Write.', 'Verify.'],
  out_of_scope: ['Shipping the Harness itself.'],
  max_goal_rounds: 24,
}

const runStartGoal = (context, args = goalArgs) => context.tools.get('start_goal').execute(args, {
  agent: context.agent,
  name: 'start_goal',
  arguments: args,
  deferContext: () => {},
})

const goalPath = cwd => join(cwd, '.agi', 'GOAL.md')

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-goal-revision-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('start_goal：首次写 GOAL.md 的 revision 是 1，正文可直接解析回来', async () => {
  const { dir, cleanup } = workspace()
  try {
    const context = harness(dir)
    const result = await runStartGoal(context)
    assert.equal(result.goalFile, goalPath(dir))

    const text = readFileSync(goalPath(dir), 'utf8')
    const meta = parseGoalFrontMatter(text)
    assert.equal(meta.revision, 1)
    assert.equal(meta.objectiveDigest, sha12('Keep the loop honest.'))
    assert.equal(goalDocDigest(text), sha12(text.slice(text.indexOf('---\n\n') + 5).trim()))
  } finally {
    cleanup()
  }
})

test('start_goal：第二次写进 revision 2，旧版本被归档而不是覆盖', async () => {
  const { dir, cleanup } = workspace()
  try {
    const context = harness(dir)
    await runStartGoal(context)
    // 第一个 goal 必须收尾，否则 start_goal 会按策略拒绝（那是另一条契约）。
    context.goals.value = goalRecord({ phase: 'complete' })

    await runStartGoal(context, { ...goalArgs, objective: 'A different objective.' })

    const text = readFileSync(goalPath(dir), 'utf8')
    const meta = parseGoalFrontMatter(text)
    assert.equal(meta.revision, 2)
    assert.equal(meta.objectiveDigest, sha12('A different objective.'))

    // 归档里留着 revision 1 的原件 —— 「上一版长什么样」是可追的。
    const archive = readdirSync(join(dir, '.agi', 'goals'))
    assert.equal(archive.length, 1)
    const archived = readFileSync(join(dir, '.agi', 'goals', archive[0]), 'utf8')
    assert.equal(parseGoalFrontMatter(archived).revision, 1)
    assert.equal(parseGoalFrontMatter(archived).objectiveDigest, sha12('Keep the loop honest.'))
  } finally {
    cleanup()
  }
})

test('start_goal：磁盘上被人改到更高版本时接着往上写，不回退', async () => {
  const { dir, cleanup } = workspace()
  try {
    const context = harness(dir)
    await runStartGoal(context)
    // 有人手工把 GOAL.md 改成了第 7 版（比如上一轮 worktree 里遗留的文件）。
    const hand = renderGoalMarkdown({ ...setup(), revision: 7, updated: '2026-11-08T00:00:00.000Z' })
    writeFileSync(goalPath(dir), hand, 'utf8')
    context.goals.value = goalRecord({ phase: 'complete' })

    await runStartGoal(context)

    assert.equal(parseGoalFrontMatter(readFileSync(goalPath(dir), 'utf8')).revision, 8)
  } finally {
    cleanup()
  }
})

test('start_goal：没有 front-matter 的旧文件按 revision 0 处理，下一次写 1', async () => {
  const { dir, cleanup } = workspace()
  try {
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(goalPath(dir), '# 目标\n\n## 目标陈述\n\n旧格式，没有 front-matter。\n', 'utf8')

    const context = harness(dir)
    await runStartGoal(context)

    assert.equal(parseGoalFrontMatter(readFileSync(goalPath(dir), 'utf8')).revision, 1)
    // 旧文件同样被归档，不是静默丢弃。
    assert.equal(readdirSync(join(dir, '.agi', 'goals')).length, 1)
  } finally {
    cleanup()
  }
})

// ── BRIEF 里那一行 ────────────────────────────────────────────────────────────

test('renderBrief：GOAL.md 变更行渲染在策略变更行之后、正文之前', () => {
  const { dir, cleanup } = workspace()
  try {
    const policyChange = '- 策略已变更：maxParallelWorkers 6→1，本轮起生效'
    const goalChange = '- GOAL.md 已被修改：revision 1→2，本轮起按新版本执行'
    const text = renderBrief({ cwd: dir, objective: '目标', state: {}, policyChange, goalChange })
    const lines = text.split('\n')
    assert.equal(lines[0], '# 循环摘要')
    assert.equal(lines[2], policyChange)
    assert.equal(lines[4], goalChange)
    assert.ok(text.indexOf(policyChange) < text.indexOf(goalChange))
    assert.ok(text.indexOf(goalChange) < text.indexOf('## 目标'))

    // 只有目标变化时策略行不留空位。
    const onlyGoal = renderBrief({ cwd: dir, objective: '目标', state: {}, goalChange })
    assert.equal(onlyGoal.split('\n')[2], goalChange)

    // 两者都没有时与旧版逐字相同：去掉这两行就是原样。
    const plain = renderBrief({ cwd: dir, objective: '目标', state: {} })
    assert.equal(plain.includes('GOAL.md 已被修改'), false)
    assert.equal(text.replace(`${policyChange}\n\n${goalChange}\n\n`, ''), plain)
    assert.equal(existsSync(join(dir, '.agi', 'BRIEF.md')), false)
  } finally {
    cleanup()
  }
})
