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

function cardTitled(tree, title) {
  return findElement(tree, node => node.type === 'section'
    && findElement(node, child => child.type === 'h3' && child.children.includes(title)))
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

async function renderFeed({ sessions, projection = null, workers = WORKERS, feed = FEED, stop = null }) {
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
    if (url.startsWith('/supervisor/feed')) return { ok: true, json: async () => feed }
    if (url.startsWith('/supervisor/workers')) return { ok: true, json: async () => workers }
    if (url.startsWith('/supervisor/stop')) {
      // A failed status read must stay visible, not be swallowed.
      if (stop?.failed === true) return { ok: false, status: stop.status ?? 500 }
      return {
        ok: true,
        json: async () => stop ?? { stopped: false, running: false, reminders: [], runningWorkers: [] },
      }
    }
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
  const card = cardTitled(tree, '目标')
  assert.ok(card, 'goal card must render')
  assert.match(textOf(card), /验证 Full stop/)
  assert.match(textOf(card), /rev 2 · 回合 4\/30/)
  assert.match(textOf(card), /ACTIVE/i)
})

test('question rows read the durable `q` field, never fall back to the id', async () => {
  // `.agi/questions.jsonl` stores the text under `q`. Reading `question`
  // instead silently rendered the question ID (`q-fullstop-gui-session`).
  const feed = {
    ...FEED,
    questions: [
      { ts: 't1', id: 'q-fullstop-gui-session', status: 'pending', q: 'Full stop 要不要关掉 GUI 会话？' },
      { ts: 't2', id: 'q-2', status: 'assumed', q: '先按最安全假设继续？', note: '假设不重启 Electron' },
      { ts: 't3', id: 'q-3', status: 'answered', q: '镜像到 desktop profile 了吗？' },
      { ts: 't4', id: 'q-4', status: 'withdrawn', q: '已经自己解决了' },
      { ts: 't5', id: 'q-5', status: 'mystery', q: '未知状态原样显示' },
    ],
  }
  const tree = await renderFeed({ sessions: ROOT_SESSION, feed })
  const card = cardTitled(tree, '提问')
  const text = textOf(card)
  assert.match(text, /Full stop 要不要关掉 GUI 会话？/)
  assert.doesNotMatch(text, /q-fullstop-gui-session/, 'the id is not the question')
  for (const label of ['待答', '已假设', '已回答', '已撤回', 'mystery']) {
    assert.ok(text.includes(label), `status label ${label} must render`)
  }
  assert.match(text, /假设：假设不重启 Electron/)
  // A row without `q` still degrades to its alias rather than throwing.
  const alias = { ...FEED, questions: [{ id: 'q-6', status: 'pending', question: '旧格式 question 字段' }] }
  assert.match(textOf(cardTitled(await renderFeed({ sessions: ROOT_SESSION, feed: alias }), '提问')),
    /旧格式 question 字段/)
})

test('each worker row carries its own outcome, matched by session id', async () => {
  const feed = {
    ...FEED,
    subagents: [
      { name: 'worker-1', outcome: { text: 'sleep worker result', mtime: 1 }, files: ['outcome.md'] },
      { name: 'ghost-worker-1234567890', outcome: { text: 'orphan result', mtime: 1 }, files: [] },
      { name: 'worker-2', outcome: null, files: [] },
    ],
  }
  const tree = await renderFeed({ sessions: ROOT_SESSION, feed })
  const card = cardTitled(tree, 'Workers')
  const row = findElement(card, node => node.type === 'li' && textOf(node).includes('sleep worker'))
  assert.ok(row, 'the worker row must render')
  assert.match(textOf(row), /sleep worker result/, 'the outcome belongs under its own worker')
  const idChip = findElement(row, node => node.type === 'span' && node.props.title === 'worker-1')
  assert.ok(idChip, 'the row shows a short id with the full id as a hint')

  const orphan = findElement(card, node => node.type === 'details' && textOf(node).includes('orphan result'))
  assert.ok(orphan, 'an outcome without a catalog row still renders')
  assert.match(textOf(orphan), /ghost-wo…/, 'the fallback uses a short id')
  assert.equal(findElement(orphan, node => node.type === 'summary').props.title, 'ghost-worker-1234567890')
  assert.match(textOf(card), /历史结果/)
  // The in-catalog outcome must not be duplicated into the fallback block.
  const fallback = findElement(card, node => node.type === 'div'
    && textOf(node).includes('历史结果'))
  assert.doesNotMatch(textOf(fallback), /sleep worker result/)
})

test('the loop card shows whether the loop is armed and when it wakes next', async () => {
  const soon = Date.now() + 2 * 60_000
  const later = Date.now() + 90 * 60_000
  const tree = await renderFeed({
    sessions: ROOT_SESSION,
    stop: {
      stopped: false,
      running: true,
      runningWorkers: ['worker-1'],
      reminders: [
        { id: 'r1', kind: 'every', title: '监督者巡检', everySeconds: 300, scheduledAt: soon },
        { id: 'r2', kind: 'at', title: '问答等待', scheduledAt: later },
      ],
    },
  })
  const card = cardTitled(tree, '监督循环')
  assert.ok(card, 'the loop card renders for a supervisor session')
  const text = textOf(card)
  assert.match(text, /运行中/)
  assert.match(text, /worker-1/)
  assert.match(text, /每 5 分钟巡检/)
  assert.match(text, /一次性等待/)
  assert.match(text, /监督者巡检/)
  assert.match(text, /约 2 分钟后/)
  assert.match(text, /约 90 分钟后/)
  // The nearest reminder is the highlighted one.
  const nearest = findElement(card, node => node.type === 'span' && textOf(node).includes('约 2 分钟后'))
  assert.equal(nearest.props.style.fontWeight, 700)
  const far = findElement(card, node => node.type === 'span' && textOf(node).includes('约 90 分钟后'))
  assert.equal(far.props.style.fontWeight, 400)
})

test('the loop card says 已停止 when nothing is armed or running', async () => {
  const tree = await renderFeed({
    sessions: ROOT_SESSION,
    stop: { stopped: true, running: false, reminders: [], runningWorkers: [] },
  })
  const card = cardTitled(tree, '监督循环')
  assert.match(textOf(card), /已停止/)
  assert.match(textOf(card), /没有已启用的提醒/)
})

test('a failed stop-status read is reported inside the loop card', async () => {
  const tree = await renderFeed({ sessions: ROOT_SESSION, stop: { failed: true, status: 503 } })
  const card = cardTitled(tree, '监督循环')
  assert.ok(card, 'the card must not vanish on failure')
  assert.match(textOf(card), /无法读取监督循环状态/)
  assert.match(textOf(card), /HTTP 503/)
})

test('the loop card is absent without a supervisor session', async () => {
  const sessions = {
    'session-root': {
      id: 'session-root', cwd: 'E:/probe', running: false, updatedAt: Date.now(),
      projectionValues: { agentPreset: 'standard' },
    },
  }
  const tree = await renderFeed({ sessions })
  assert.equal(cardTitled(tree, '监督循环'), undefined)
})
