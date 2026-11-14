/**
 * Tool-level coverage for the guarded `subagent` frontend — the layer that
 * actually broke on dsh-subagent 0.2.x.
 *
 * The 0.1 service exposed `startContinuable()` / `start()`; 0.2.1 exposes
 * `startActivation({…, delivery})`. The plugin called the removed names, so
 * every real delegation died with
 * `TypeError: ctx.subagents.startContinuable is not a function` while the rest
 * of the suite stayed green. This test registers the tool against a fake 0.2.x
 * host and drives `execute()` down both paths, including the hard cap.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/spawn.js')

const PARENT = 'root-supervisor-session'

/** A 0.2.x host that records every activation. */
function host({
  running = () => undefined,
  children = [],
  settings = { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 3 },
  providerReady = true,
  generation = '0.2.1',
} = {}) {
  const activations = []
  const registered = []
  const service = {
    startActivation: async spec => {
      activations.push(spec)
      return {
        childId: spec.childId ?? 'child-internal',
        // rc.2 answers with the resolved name (host-allocated when omitted);
        // 0.2.1 has no names at all.
        ...generation === '0.2.2' ? { name: spec.name ?? 'agent-1' } : {},
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        dispose: async () => {},
      }
    },
    sendMessage: async () => {},
    interrupt: async () => {},
    getProvider: () => (providerReady ? { name: 'spawn' } : undefined),
  }
  if (generation === '0.2.2') {
    service.listDescendants = async () => children
    service.drainDescendants = async () => {}
    service.namesOf = () => []
    service.resolveName = async (_caller, raw) => raw
  } else {
    service.drainChildren = async () => {}
    service.listChildren = async () => children
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    subagents: service,
    agents: { get: id => running(id) },
    effect: callback => callback(),
    on: () => () => {},
    root: { on: () => () => {} },
    get: name => (name === 'supervisorSettings' ? { current: () => settings, subscribe: () => () => {} } : undefined),
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    llm: {
      listProviders: () => [{ provider: 'deepseek-official' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({
        inputModalities: ['text'],
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      }),
    },
    systemPrompt: { section: () => () => {} },
  }
  return { ctx, activations, registered, service }
}

/** Wait for the tool to be mounted (catalog refresh is async). */
async function mountedSystem(options) {
  const system = host(options)
  await apply(system.ctx, {})
  // apply() kicks off reconcile via a promise chain; give it a turn.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const tool = system.registered.at(-1)
  assert.ok(tool !== undefined, 'the subagent tool must be registered on a compatible host')
  return { ...system, tool }
}

function executeContext() {
  return {
    signal: undefined,
    agent: {
      id: PARENT,
      session: {
        header: { id: PARENT },
        // The exact route captured for this turn; runtime/current refuses to
        // fall back to creation-time defaults.
        requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      },
    },
  }
}

async function call(tool, args, exec = executeContext()) {
  return tool.execute(args, exec)
}

test('a background spawn goes through startActivation with delivery "parent"', async () => {
  const { tool, activations } = await mountedSystem()
  const result = await call(tool, { description: 'audit', prompt: 'do the thing', model: 'runtime/current' })

  assert.equal(activations.length, 1)
  const spec = activations[0]
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.label, 'audit')
  assert.equal(spec.request.prompt[0].text, 'do the thing')
  assert.equal(spec.request.parent.id, PARENT)
  assert.deepEqual(spec.request.toolFilter, { deny: ['ask_user_question'] })
  assert.equal(result.kind, 'continuable')
  assert.match(result.subagentId, /^[0-9a-f-]{36}$/)
})

test('a foreground spawn awaits and disposes the activation', async () => {
  const { tool, activations } = await mountedSystem()
  const result = await call(tool, {
    description: 'audit', prompt: 'inline', model: 'runtime/current', run_in_background: false,
  })

  assert.equal(activations[0].delivery, 'caller')
  assert.equal(activations[0].childId, undefined, 'the service allocates a foreground child id')
  assert.equal(result.kind, 'foreground')
})

test('the hard cap refuses the spawn that would exceed it', async () => {
  // One worker is running; the cap is 1, so the next spawn is rejected.
  const { tool, activations } = await mountedSystem({
    running: id => (id === 'busy-child' ? { status: 'running' } : undefined),
    children: [{ id: 'busy-child', mode: 'continuable' }],
    settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 1 },
  })
  await assert.rejects(
    () => call(tool, { description: 'second', prompt: 'x', model: 'runtime/current' }),
    /并行 worker 上限|上限/,
  )
  assert.equal(activations.length, 0, 'nothing may be started past the cap')
})

test('a rejected spawn leaves no ledger entry behind', async () => {
  const { tool, activations } = await mountedSystem({
    children: [{ id: 'busy-child', mode: 'continuable' }],
    running: id => (id === 'busy-child' ? { status: 'running' } : undefined),
    settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 1 },
  })
  // First call is refused by the cap…
  await assert.rejects(() => call(tool, { description: 'a', prompt: 'x', model: 'runtime/current' }))
  // …and repeated calls keep being refused instead of leaking slots.
  await assert.rejects(() => call(tool, { description: 'b', prompt: 'x', model: 'runtime/current' }))
  assert.equal(activations.length, 0)
})

test('an empty allowlist registers no tool at all', async () => {
  const system = host({ settings: { workerModels: [], workerEfforts: {}, maxParallelWorkers: 3 } })
  await apply(system.ctx, {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(system.registered.length, 0, 'no model may be chosen, so there is no spawn tool')
})

// ------------------------------------------------- 权威凭证与提案依据（A1 / A5）
//
// 一次派生必须能回答「凭什么」。下面三条分别钉住：返回值里的凭证、observe 档
// 提案里的逐条依据、以及真派生之后工作区里那一行账。

/** 与 `executeContext()` 相同，但父会话带一个真实工作区。 */
function executeContextIn(cwd) {
  const base = executeContext()
  return { ...base, agent: { ...base.agent, session: { ...base.agent.session, header: { id: PARENT, cwd } } } }
}

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spawn-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const jsonl = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))

test('派生结果的 authority 与 authorityLabel 说明这次凭什么', async () => {
  const { tool } = await mountedSystem()
  const result = await call(tool, { description: 'audit', prompt: 'x', model: 'runtime/current' })
  // 设置里没写 proactive —— 与运行时一致地回落到 auto，也就是一条规则授权。
  assert.deepEqual(result.authority, { kind: 'rule', id: 'proactive-auto' })
  assert.equal(result.authorityLabel, 'rule:proactive-auto')
})

test('observe 档只写提案，且提案里带上逐条依据', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool, activations } = await mountedSystem({
      settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 3, proactive: 'observe' },
    })
    const result = await call(
      tool,
      { description: 'recon', prompt: 'x', model: 'runtime/current' },
      executeContextIn(dir),
    )
    assert.equal(result.kind, 'proposal')
    assert.equal(activations.length, 0)
    assert.deepEqual(result.authority, { kind: 'rule', id: 'proactive-observe' })

    const [entry] = jsonl(join(dir, '.agi', 'proposals.jsonl'))
    assert.deepEqual(entry.basis, {
      authority: { kind: 'rule', id: 'proactive-observe' },
      rules: [{ id: 'proactive-observe', evidence: 'meta.proactive=observe' }],
      humanDirect: false,
    })
  } finally {
    cleanup()
  }
})

test('一次真派生在工作区留下一条带凭据的账，cap 拒绝时不留', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool } = await mountedSystem()
    await call(tool, { description: 'audit', prompt: 'x', model: 'runtime/current' }, executeContextIn(dir))

    const [record] = jsonl(join(dir, '.agi', 'CHANGELOG.jsonl'))
    assert.equal(record.actor, 'main-agent')
    assert.equal(record.action, 'spawn')
    assert.deepEqual(record.authority, { kind: 'rule', id: 'proactive-auto' })
    assert.match(record.summary, /audit/)
    // 账上记的是**真正用的**那条路由（runtime/current 已解析成具体模型），
    // 否则事后读账的人无法判断当时跑的是谁。
    assert.equal(record.detail.model, 'deepseek-official/deepseek-flash')
    assert.equal(record.detail.proactive, 'auto')

    // 被 cap 拒掉的派生不能留下任何「我派过活」的痕迹。
    const capped = workspace()
    try {
      const blocked = await mountedSystem({
        children: [{ id: 'busy-child', mode: 'continuable' }],
        running: id => (id === 'busy-child' ? { status: 'running' } : undefined),
        settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 1 },
      })
      await assert.rejects(() => call(
        blocked.tool,
        { description: 'second', prompt: 'x', model: 'runtime/current' },
        executeContextIn(capped.dir),
      ))
      assert.equal(existsSync(join(capped.dir, '.agi', 'CHANGELOG.jsonl')), false)
    } finally {
      capped.cleanup()
    }
  } finally {
    cleanup()
  }
})

// ------------------------------------------------- 派发时写死验收（B2）
//
// worker 的 checks.json 是它自己写的，所以「全绿」只证明「它想验的都验了」。
// `done_when` 把验收标准固定在被派发的那一刻，落成 `expect.json`，worker 之后
// 只能声明「哪条检查对应哪条验收」，改不了题目本身。这里钉住四件事：
// 落盘、不写时的坦白、参数校验发生在派生之前、以及前台分支拿不到 id 时的降级。

test('done_when 在派发时就落进 worker 目录，编号从 e1 起', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool } = await mountedSystem()
    const result = await call(
      tool,
      {
        description: 'audit',
        prompt: 'x',
        model: 'runtime/current',
        done_when: ['  测试全绿  ', 'docs/TOOLS.md 存在'],
      },
      executeContextIn(dir),
    )

    const path = join(dir, '.agi', 'subagents', result.subagentId, 'expect.json')
    assert.equal(result.expect.declared, true)
    assert.equal(result.expect.error, undefined)
    assert.equal(result.expect.path, path)
    assert.deepEqual(result.expect.items, [
      { id: 'e1', text: '测试全绿' },
      { id: 'e2', text: 'docs/TOOLS.md 存在' },
    ])

    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(written.worker, result.subagentId, 'worker 必须是完整的 child id')
    assert.deepEqual(written.items, result.expect.items)
    assert.match(written.declaredAt, /^\d{4}-\d{2}-\d{2}T/)

    const text = tool.output.render({}, result).filter(part => part.type === 'text').map(part => part.text).join('\n')
    assert.match(text, /验收契约已写进/, '工具结果里必须告诉监督者契约落在哪')
  } finally {
    cleanup()
  }
})

test('不给 done_when 就明说只剩 worker 自述，且不写空文件', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool } = await mountedSystem()
    const result = await call(
      tool,
      { description: 'audit', prompt: 'x', model: 'runtime/current' },
      executeContextIn(dir),
    )

    assert.equal(result.expect.declared, false)
    assert.deepEqual(result.expect.items, [])
    assert.match(result.expect.warning, /未提供 done_when/)
    assert.equal(
      existsSync(join(dir, '.agi', 'subagents', result.subagentId, 'expect.json')),
      false,
      '没有验收就不该留下一个空壳文件',
    )

    const text = tool.output.render({}, result).filter(part => part.type === 'text').map(part => part.text).join('\n')
    assert.match(text, /未提供 done_when/)
  } finally {
    cleanup()
  }
})

test('done_when 不合格时直接拒绝，一个 worker 都不起', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool, activations } = await mountedSystem()
    const base = { description: 'audit', prompt: 'x', model: 'runtime/current' }

    await assert.rejects(
      () => call(tool, { ...base, done_when: ['a', 'b', 'c', 'd', 'e', 'f'] }, executeContextIn(dir)),
      /最多 5 条.*6 条/,
    )
    await assert.rejects(() => call(tool, { ...base, done_when: [] }, executeContextIn(dir)), /空数组/)
    await assert.rejects(
      () => call(tool, { ...base, done_when: ['x'.repeat(201)] }, executeContextIn(dir)),
      /超过 200 的上限/,
    )
    assert.equal(activations.length, 0, '参数说不清就不能派生：校验必须发生在副作用之前')
  } finally {
    cleanup()
  }
})

test('前台派生拿不到 child id 时如实报错，而不是假装写了契约', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool } = await mountedSystem()
    const result = await call(
      tool,
      { description: 'audit', prompt: 'x', model: 'runtime/current', run_in_background: false, done_when: ['跑通'] },
      executeContextIn(dir),
    )
    assert.equal(result.kind, 'foreground')
    // 假宿主从不触发 agent/created，所以前台分支拿不到 childId —— 真机上也会
    // 有拿不到的时刻，这时要说出原因，而不是安静地什么都不写。
    assert.equal(result.expect.declared, true)
    assert.match(result.expect.error, /session id/)
  } finally {
    cleanup()
  }
})

test('observe 档的提案带着 done_when 记进账，但不写 expect.json', async () => {
  const { dir, cleanup } = workspace()
  try {
    const { tool, activations } = await mountedSystem({
      settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 3, proactive: 'observe' },
    })
    const result = await call(
      tool,
      { description: 'recon', prompt: 'x', model: 'runtime/current', done_when: ['列清子域'] },
      executeContextIn(dir),
    )
    assert.equal(result.kind, 'proposal')
    assert.equal(activations.length, 0)
    assert.equal(result.expect.declared, true)
    assert.match(result.expect.warning, /没有写 expect\.json/)

    const [entry] = jsonl(join(dir, '.agi', 'proposals.jsonl'))
    assert.deepEqual(entry.doneWhen, [{ id: 'e1', text: '列清子域' }])
  } finally {
    cleanup()
  }
})

test('三个分支的 schema 都声明了 expect（严格模式里漏一个字段就整次拒收）', async () => {
  const { tool } = await mountedSystem()
  const branches = tool.output.schema.oneOf
  assert.equal(branches.length, 3, 'continuable / foreground / proposal 三个分支都要在')
  for (const branch of branches) {
    assert.equal(branch.additionalProperties, false, '每个分支都必须保持严格模式')
    const expect = branch.properties.expect
    assert.ok(expect !== undefined, `分支 ${branch.properties.kind.const} 没有声明 expect`)
    assert.equal(expect.additionalProperties, false, 'expect 自己也是严格模式')
    for (const key of ['declared', 'items']) {
      assert.equal(expect.properties[key].required, true, `expect.${key} 必须 required`)
    }
    assert.equal(branch.properties.expect.required, undefined, 'expect 本身不必填，不给 done_when 时也要能返回')
  }
})

test('rc.2 上图省下的 name 会透传给宿主并回传', async () => {
  const { tool, activations } = await mountedSystem({ generation: '0.2.2' })
  const result = await call(tool, {
    description: 'audit', prompt: 'x', model: 'runtime/current', name: 'reviewer',
  })

  assert.equal(activations[0].name, 'reviewer')
  assert.equal(result.name, 'reviewer', '调用方拿到的地址必须和宿主认的那个一致')
  assert.equal(result.nameNotice, undefined, '宿主支持时不打「被忽略」的补丁')
})

test('rc.2 上不给 name 就由宿主分配，结果里回传分配到的名字', async () => {
  const { tool, activations } = await mountedSystem({ generation: '0.2.2' })
  const result = await call(tool, { description: 'audit', prompt: 'x', model: 'runtime/current' })

  assert.equal(activations[0].name, undefined)
  assert.equal(result.name, 'agent-1')
})

test('0.2.1 上 name 被忽略，且结果里说明只能按 id 寻址', async () => {
  const { tool, activations } = await mountedSystem()
  const result = await call(tool, {
    description: 'audit', prompt: 'x', model: 'runtime/current', name: 'reviewer',
  })

  assert.equal(activations[0].name, undefined, '0.2.1 的 startActivation 不认 name')
  assert.match(result.nameNotice, /0\.2\.2-rc\.2|被忽略/)
})

test('名字不合法在派生之前就被拒，不消耗并行名额', async () => {
  const { tool, activations } = await mountedSystem()
  for (const name of ['Reviewer', 'lead', 'has space', 'x'.repeat(33), '1abc']) {
    await assert.rejects(
      () => call(tool, { description: 'x', prompt: 'x', model: 'runtime/current', name }),
      /name/,
      `${name} 应该被拒`,
    )
  }
  assert.equal(activations.length, 0)
})
