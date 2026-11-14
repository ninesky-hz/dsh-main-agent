/**
 * `send_message` / `interrupt_agent` / `wait_agent` 的契约测试。
 *
 * 三件事在这里钉死，因为它们在 dsh 0.2.2-rc.2 上会静默失效：
 *
 * 1. **具名寻址**：rc.2 的 team 任务面板用名字（`owner`）指人，而名字到会话 id
 *    的解析只有宿主知道（`resolveName`）。旧参数只有 `subagent_id`，模型手里
 *    拿着 `list_agents` 给的名字却找不到投递口。
 * 2. **wait_agent 归属**：rc.2 把 `wait_agent` 从 team 插件挪进了
 *    `tool-subagent-control`，而本插件的 preset 整行替换掉那个插件 —— 不补，
 *    监督者的等待能力就整块消失，且没有任何报错。
 * 3. **旧写法必须继续可用**：升级是单向的，用户手上的 prompt 不会同步改。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/control.js')

const PARENT = 'root-supervisor-session'
const CHILD = 'child-session-id'

/**
 * 一个可切换「宿主代数」的假 ctx。
 *
 * `resolveName` / `rootCallId` 只在 rc.2 上存在，所以它们的有无就是代数开关 ——
 * 和 `lib/subagent-compat.js` 判代数用的是同一批事实。
 */
function host({ generation = '0.2.2', existingTools = [], inbox = [] } = {}) {
  const sent = []
  const interrupted = []
  const registered = []
  const listeners = new Map()
  const resolved = []
  const renamable = new Map([['reviewer', CHILD], [`${CHILD}`, CHILD]])

  const service = {
    sendMessage: async (sender, targetId, content, options) => {
      sent.push({ sender, targetId, content, options })
      return 'message-1'
    },
    interrupt: async (targetId, authority) => {
      interrupted.push({ targetId, authority })
    },
  }
  if (generation === '0.2.2') {
    service.resolveName = async (caller, raw) => {
      resolved.push({ caller, raw })
      const id = renamable.get(raw)
      if (id === undefined) throw new Error(`未知的 agent 名字：${raw}`)
      return id
    }
    service.listDescendants = async () => []
    service.namesOf = () => []
  }
  // 0.2.1 的代际标志
  if (generation === '0.2.1') {
    service.listChildren = async () => []
    service.drainChildren = async () => {}
  }

  const known = new Map(existingTools.map(name => [name, { name }]))
  /** The caller agent itself; `wait_agent` insists the caller is the live object. */
  const agent = {
    id: PARENT,
    // Host contract (`Inbox.nextStep`): a readonly array projected from the
    // event-sourced inbox, not a function.
    inbox: {
      get nextStep() { return inbox },
      get nextTurn() { return [] },
    },
    session: { header: { id: PARENT } },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    subagents: service,
    agents: { get: id => (id === PARENT ? agent : undefined) },
    effect: callback => callback(),
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    root: { on: () => () => {} },
    get: () => undefined,
    tools: {
      get: name => known.get(name),
      register(definition) {
        registered.push(definition)
        known.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {} },
    inbox: { nextStep: () => inbox },
  }

  return { ctx, agent, sent, interrupted, registered, listeners, resolved }
}

function toolOf(system, name) {
  const tool = system.registered.find(definition => definition.name === name)
  assert.ok(tool !== undefined, `${name} 必须被注册`)
  return tool
}

function exec(system, extra = {}) {
  return {
    agent: system.agent,
    signal: undefined,
    ...extra,
  }
}

test('send_message 用名字解析出会话 id', async () => {
  const system = host()
  await apply(system.ctx, {})
  const tool = toolOf(system, 'send_message')

  const result = await tool.execute({ agent: 'reviewer', message: '继续' }, exec(system))

  assert.equal(system.resolved.length, 1)
  assert.equal(system.resolved[0].raw, 'reviewer', '名字必须原样交给宿主解析')
  assert.equal(system.resolved[0].caller.id, PARENT, '解析必须带着调用方，否则宿主无从判断同名可见性')
  assert.equal(system.sent.length, 1)
  assert.equal(system.sent[0].targetId, CHILD, '投递用的是解析出来的会话 id')
  assert.equal(system.sent[0].content[0].text, '继续')
  assert.equal(result.messageId, 'message-1')
})

test('send_message 仍接受旧的 subagent_id', async () => {
  const system = host()
  await apply(system.ctx, {})
  const tool = toolOf(system, 'send_message')

  await tool.execute({ subagent_id: CHILD, message: '旧写法' }, exec(system))

  assert.equal(system.sent.length, 1)
  assert.equal(system.sent[0].targetId, CHILD)
})

test('两个地址同时给算歧义，直接拒', async () => {
  const system = host()
  await apply(system.ctx, {})
  const tool = toolOf(system, 'send_message')

  await assert.rejects(
    () => tool.execute({ agent: 'reviewer', subagent_id: CHILD, message: 'x' }, exec(system)),
    /二选一|只能给一个|冲突/,
  )
  assert.equal(system.sent.length, 0, '歧义调用不能真的投递出去')
})

test('两个地址都没给也要拒，不能猜', async () => {
  const system = host()
  await apply(system.ctx, {})
  const tool = toolOf(system, 'send_message')

  await assert.rejects(() => tool.execute({ message: 'x' }, exec(system)), /agent|subagent_id/)
})

test('interrupt_agent 同样接受名字与旧 id', async () => {
  const system = host()
  await apply(system.ctx, {})
  const tool = toolOf(system, 'interrupt_agent')

  await tool.execute({ agent: 'reviewer' }, exec(system))
  assert.equal(system.interrupted.length, 1)
  assert.equal(system.interrupted[0].targetId, CHILD)
  assert.equal(system.interrupted[0].authority.kind, 'ancestor')
})

test('rc.2 上没有 wait_agent 时由插件补上', async () => {
  const system = host({ generation: '0.2.2' })
  await apply(system.ctx, {})

  assert.ok(system.registered.some(definition => definition.name === 'wait_agent'))
})

test('宿主已经提供 wait_agent 时不再重复注册', async () => {
  const system = host({ generation: '0.2.2', existingTools: ['wait_agent'] })
  await apply(system.ctx, {})

  assert.equal(system.registered.filter(definition => definition.name === 'wait_agent').length, 0)
})

test('rc.1 上不注册 wait_agent（team 插件已提供，重复注册会让插件加载失败）', async () => {
  const system = host({ generation: '0.2.1' })
  await apply(system.ctx, {})

  assert.equal(system.registered.filter(definition => definition.name === 'wait_agent').length, 0)
})

test('wait_agent 有待处理输入时立即返回 timedOut: false', async () => {
  const system = host({ inbox: [{ id: 'message-9', content: [] }] })
  await apply(system.ctx, {})
  const tool = toolOf(system, 'wait_agent')

  const result = await tool.execute({ timeout_ms: 30_000 }, exec(system))

  assert.deepEqual(result, { timedOut: false }, '已经躺在 inbox 里的输入不能让它空等到超时')
})

test('wait_agent 拒绝超出范围的超时', async () => {
  const system = host()
  await apply(system.ctx, {})
  const tool = toolOf(system, 'wait_agent')

  await assert.rejects(() => tool.execute({ timeout_ms: 1 }, exec(system)), /timeout_ms|超时/)
  await assert.rejects(() => tool.execute({ timeout_ms: 3_600_001 }, exec(system)), /timeout_ms|超时/)
})
