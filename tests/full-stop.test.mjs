import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import { fullStopAgent, sessionAgentPreset } from '../lib/full-stop.js'

function fakeAgent(order, activeIds = ['schedule-2', 'schedule-7']) {
  const session = {
    events: [],
    header: { seedLength: 0 },
    append(type, data) {
      order.push(`append:${data.id}`)
      this.events.push({ type, data })
    },
  }
  return {
    session,
    cancel(cause) { order.push(`cancel:${cause.kind}`) },
    whenIdle() { order.push('idle'); return Promise.resolve() },
    runMaintenance(task) {
      order.push('maintenance')
      return task(new AbortController().signal)
    },
    fold() {
      order.push('fold')
      return { active: activeIds.map(id => ({ id })) }
    },
  }
}

test('the latest logged preset selection wins over the creation header', () => {
  assert.equal(sessionAgentPreset({
    header: { agentPreset: 'cordis' },
    events: [
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
      { type: 'turn/start', data: {} },
      { type: 'agent-preset/selected', data: { agentPreset: 'main-agent' } },
    ],
  }), 'main-agent')
  assert.equal(sessionAgentPreset({ header: { agentPreset: 'cordis' }, events: [] }), 'cordis')
})

test('the declared 0.2 Session surface resolves the live preset and fold offset', () => {
  const log = [
    { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
    { type: 'agent-preset/selected', data: { agentPreset: 'main-agent' } },
  ]
  assert.equal(sessionAgentPreset({
    header: { version: 4, agentPreset: 'cordis' },
    inheritedEventCount: 0,
    snapshotEvents: () => log,
  }), 'main-agent')

  // dsh dropped `session.events`; both readers must stay fail-open.
  assert.equal(sessionAgentPreset({ header: { version: 4, agentPreset: 'cordis' } }), 'cordis')
  assert.equal(sessionAgentPreset({}), undefined)
})

test('full stop folds the declared Session log with its fork offset', async () => {
  const order = []
  const agent = fakeAgent(order)
  const log = [{ type: 'schedule/change', data: { id: 'schedule-2' } }]
  agent.session = {
    header: { version: 4, agentPreset: 'main-agent' },
    inheritedEventCount: 1,
    snapshotEvents: () => log,
    append(type, data) { order.push(`append:${data.id}`) },
  }
  let foldArgs
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    (events, inheritedEventCount) => {
      foldArgs = [events, inheritedEventCount]
      return agent.fold()
    },
  )

  assert.deepEqual(outcome, { kind: 'stopped', ids: ['schedule-2', 'schedule-7'] })
  assert.equal(foldArgs[0], log)
  assert.equal(foldArgs[1], 1)
  assert.deepEqual(order, [
    'cancel:user', 'idle', 'maintenance', 'flush', 'fold',
    'append:schedule-2', 'append:schedule-7', 'flush',
  ])
})

test('a Session without any readable log folds nothing instead of failing the stop', async () => {
  const order = []
  const agent = fakeAgent(order)
  agent.session = {
    header: { version: 4, agentPreset: 'main-agent' },
    append(type, data) { order.push(`append:${data.id}`) },
  }
  let foldArgs
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    (events, inheritedEventCount) => {
      foldArgs = [events, inheritedEventCount]
      return { active: [] }
    },
  )

  assert.deepEqual(outcome, { kind: 'stopped', ids: [] })
  assert.deepEqual(foldArgs, [[], 0])
  assert.deepEqual(order.filter(step => step.startsWith('append:')), [])
})

test('full stop flushes before folding and after every deletion', async () => {
  const order = []
  const agent = fakeAgent(order)
  let flushes = 0
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push(`flush:${++flushes}`) },
    () => agent.fold(),
  )

  assert.deepEqual(outcome, { kind: 'stopped', ids: ['schedule-2', 'schedule-7'] })
  assert.deepEqual(order, [
    'cancel:user',
    'idle',
    'maintenance',
    'flush:1',
    'fold',
    'append:schedule-2',
    'append:schedule-7',
    'flush:2',
  ])
})

test('full stop drains worker branches after idle and before schedule maintenance', async () => {
  const order = []
  const agent = fakeAgent(order)
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    () => agent.fold(),
    {
      stopChildren: async (parent) => {
        assert.equal(parent, agent)
        order.push('stop-children')
        return ['worker-1', 'worker-2']
      },
    },
  )

  assert.deepEqual(outcome, {
    kind: 'stopped',
    ids: ['schedule-2', 'schedule-7'],
    workerIds: ['worker-1', 'worker-2'],
  })
  assert.deepEqual(order, [
    'cancel:user', 'idle', 'stop-children', 'cancel:user', 'idle', 'maintenance', 'flush', 'fold',
    'append:schedule-2', 'append:schedule-7', 'flush',
  ])
})

test('worker teardown failure does not mutate reminders', async () => {
  const order = []
  const agent = fakeAgent(order)
  const failure = new Error('worker refused teardown')
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    () => agent.fold(),
    { stopChildren: async () => { order.push('stop-children'); throw failure } },
  )

  assert.equal(outcome.kind, 'worker-stop-failed')
  assert.equal(outcome.error, failure)
  assert.deepEqual(order, ['cancel:user', 'idle', 'stop-children'])
})

test('a durability preflight failure never folds or appends', async () => {
  const order = []
  const agent = fakeAgent(order)
  const failure = new Error('disk unavailable')
  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush'); throw failure },
    () => agent.fold(),
  )

  assert.equal(outcome.kind, 'preflight-failed')
  assert.equal(outcome.error, failure)
  assert.deepEqual(order, ['cancel:user', 'idle', 'maintenance', 'flush'])
})

test('only synchronous maintenance contention is retried', async () => {
  const order = []
  const agent = fakeAgent(order, [])
  const run = agent.runMaintenance.bind(agent)
  let attempts = 0
  agent.runMaintenance = (task) => {
    attempts++
    if (attempts === 1) {
      order.push('busy')
      throw new Error('busy')
    }
    return run(task)
  }

  const outcome = await fullStopAgent(
    agent,
    async () => { order.push('flush') },
    () => agent.fold(),
  )

  assert.deepEqual(outcome, { kind: 'stopped', ids: [] })
  assert.deepEqual(order, [
    'cancel:user', 'idle', 'busy', 'idle', 'maintenance', 'flush', 'fold', 'flush',
  ])
})

function findElement(node, predicate) {
  if (node == null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findElement(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

test('Feed stops the root supervisor from a worker view and removes the button', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const state = []
  let hook = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useEffect() {},
    // The Feed keeps the conditional-refresh ETag in a ref; this harness never
    // runs effects, so a fresh handle per render is enough.
    useRef(initial) { return { current: initial } },
    useState(initial) {
      const index = hook++
      if (!(index in state)) state[index] = initial
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
      }]
    },
  }
  let pluginFactory
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    if (url === '/supervisor/stop?session=root') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ live: true, durable: true, remindersDeleted: 1, workersStopped: 2 }),
      }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const window = {
    confirm: () => true,
    __ModuleLoader__: { load(definition) { pluginFactory = definition.factory } },
  }
  vm.runInNewContext(source, { window, fetch, console, URL, setInterval, clearInterval })
  const plugin = pluginFactory(name => {
    assert.equal(name, 'react')
    return React
  })
  let FeedView
  plugin.apply({
    effect(callback) { return callback() },
    slots: {
      inject(_name, install) { install() },
      register(options, component) {
        if (options.name === 'conversation.view') FeedView = component
        return () => {}
      },
    },
    configForms: {
      get() {
        return { subscribe() { return () => {} }, getSnapshot() { return { value: {}, writable: false } } }
      },
      whileServed(_namespaces, install) { return install() },
    },
  })

  const byId = {
    root: {
      id: 'root', cwd: '/work', agentPreset: 'main-agent', running: false,
      blank: false, updatedAt: 10,
    },
    worker: {
      id: 'worker', cwd: '/work', origin: 'subagent', parentId: 'root',
      running: false, blank: false, updatedAt: 20,
    },
  }
  const props = {
    sessionId: 'worker',
    useProjection: () => null,
    useSessions: selector => selector({ byId }),
  }
  const render = () => {
    hook = 0
    // Since 0.10.8 the slot registers a wrapper that threads the session-
    // navigation capability into the view, so one expansion is needed before
    // the host tree exists — exactly what a real renderer does.
    let node = FeedView(props)
    while (node != null && typeof node === 'object' && typeof node.type === 'function') {
      node = node.type(node.props)
    }
    return node
  }

  const first = render()
  const button = findElement(first, node => node.type === 'button' && node.children.includes('完全停止'))
  assert.ok(button)
  button.props.onClick()
  await new Promise(resolvePromise => setImmediate(resolvePromise))
  await new Promise(resolvePromise => setImmediate(resolvePromise))

  // The host route owns the cold resume, so the browser sends exactly one
  // request — no RPC that can fail before the stop is even attempted.
  assert.deepEqual(calls, ['/supervisor/stop?session=root'])
  const second = render()
  assert.equal(
    findElement(second, node => node.type === 'button' && node.children.includes('完全停止')),
    undefined,
  )
  assert.ok(findElement(second, node => node.type === 'span'
    && node.children.some(child => typeof child === 'string' && child.includes('已停止'))))
})
