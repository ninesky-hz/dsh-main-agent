import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/** Render the Feed view against a scripted 0.2.x client snapshot. The 0.2.x
 * session summary carries no top-level `agentPreset` (it is a session
 * projection) and projects the goal as `{ goal, roundsStarted }`; a regression
 * here silently hides Full stop and the worker inventory. */

/** The Feed composes function components (`h(Card, {...})`), while the fake
 * React here only builds element descriptors — so expand function types the
 * way a real renderer would before walking the tree. */
function expand(node) {
  let current = node
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !Array.isArray(current)
    && typeof current.type === 'function'; depth += 1) {
    current = current.type(current.props)
  }
  return current
}

function findElement(node, predicate) {
  node = expand(node)
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findElement(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function textOf(node) {
  node = expand(node)
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}

const FEED = {
  ws: 'E:/probe',
  generatedAt: Date.now(),
  goal: null,
  progress: [],
  questions: [],
  changelog: [],
  subagents: [],
}

const WORKERS = {
  compatible: true,
  workers: [{ id: 'worker-1', label: 'sleep worker', createdAt: Date.now() - 60_000, running: true }],
  running: 1,
  total: 1,
}

async function renderFeed({ sessions, projection = null, workers = WORKERS }) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const state = []
  let hook = 0
  let effects = []
  const React = {
    Fragment: Symbol('Fragment'),
    // Real React exposes children on props (`Card(props)` reads props.children).
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children }, children } },
    useState(initial) {
      const index = hook++
      if (!(index in state)) state[index] = initial
      return [state[index], next => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
    useEffect(effect) { effects.push(effect) },
  }
  let pluginFactory
  const fetch = async url => {
    if (url.startsWith('/supervisor/feed')) return { ok: true, json: async () => FEED }
    if (url.startsWith('/supervisor/workers')) return { ok: true, json: async () => workers }
    if (url.startsWith('/supervisor/stop')) return { ok: true, json: async () => ({ stopped: false, running: false, reminders: [], runningWorkers: [] }) }
    if (url.startsWith('/supervisor/health')) return { ok: true, json: async () => ({ ok: true, subagents: { required: [], missing: [] } }) }
    throw new Error(`unexpected fetch ${url}`)
  }
  const window = { __ModuleLoader__: { load(definition) { pluginFactory = definition.factory } } }
  vm.runInNewContext(source, {
    window, fetch, console, URL,
    setInterval: () => 0,
    clearInterval: () => {},
  })
  const plugin = pluginFactory(() => React)
  let Feed
  plugin.apply({
    effect(callback) { return callback() },
    slots: {
      inject(_name, install) { install() },
      register(options, component) {
        if (options.name === 'conversation.view') Feed = component
        return () => {}
      },
    },
    configForms: { get() { return undefined }, whileServed() { return () => {} } },
  })
  assert.ok(Feed, 'conversation.view must register the Feed')

  const render = () => {
    hook = 0
    effects = []
    const tree = Feed({
      sessionId: 'session-root',
      useProjection: () => projection,
      useSessions: selector => selector({ byId: sessions }),
    })
    return { tree, effects: [...effects] }
  }
  let rendered = render()
  for (const effect of rendered.effects) effect()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  rendered = render()
  for (const effect of rendered.effects) effect()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  return render().tree
}

const ROOT_SESSION = {
  'session-root': {
    id: 'session-root',
    cwd: 'E:/probe',
    running: false,
    updatedAt: Date.now(),
    projectionValues: { agentPreset: 'main-agent' },
  },
}

test('0.2.x session preset projection keeps Full stop and the worker list', async () => {
  const tree = await renderFeed({ sessions: ROOT_SESSION })
  assert.ok(findElement(tree, node => node.type === 'button'
    && node.children.includes('■ Full stop')), 'Full stop must render')
  assert.ok(findElement(tree, node => node.type === 'li'
    && textOf(node).includes('sleep worker')), 'worker row must render')
  assert.ok(findElement(tree, node => node.type === 'span'
    && textOf(node).includes('运行中')), 'running worker must read 运行中')
})

test('worker session resolves its root supervisor through parentId', async () => {
  const sessions = {
    ...ROOT_SESSION,
    'child-1': {
      id: 'child-1', cwd: 'E:/probe', origin: 'subagent', parentId: 'session-root',
      running: true, updatedAt: Date.now(),
    },
  }
  const tree = await renderFeed({ sessions })
  assert.ok(findElement(tree, node => node.type === 'button'
    && node.children.includes('■ Full stop')))
})

test('missing main-agent preset degrades honestly instead of hanging', async () => {
  const sessions = {
    'session-root': { id: 'session-root', cwd: 'E:/probe', running: false, updatedAt: Date.now(), projectionValues: { agentPreset: 'standard' } },
  }
  const tree = await renderFeed({ sessions })
  assert.equal(findElement(tree, node => node.type === 'button'
    && node.children.includes('■ Full stop')), undefined)
  assert.match(textOf(tree), /未识别到监督者会话/)
  assert.match(textOf(tree), /preset=standard/)
})

test('0.2.x goal projection { goal, roundsStarted } fills the goal card', async () => {
  const projection = {
    goal: { id: 'goal-1', objective: '验证 Full stop', phase: 'active', revision: 2, maxGoalRounds: 30 },
    roundsStarted: 4,
    updatedAt: Date.now(),
  }
  const tree = await renderFeed({ sessions: ROOT_SESSION, projection })
  const card = findElement(tree, node => node.type === 'section'
    && findElement(node, child => child.type === 'h3' && child.children.includes('目标')))
  assert.ok(card, 'goal card must render')
  assert.match(textOf(card), /验证 Full stop/)
  assert.match(textOf(card), /rev 2 · 回合 4\/30/)
  assert.match(textOf(card), /ACTIVE/i)
})
