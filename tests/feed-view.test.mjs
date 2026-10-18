import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/** Render the Feed view against a scripted 0.2.x client snapshot. The 0.2.x
 * session summary carries no top-level `agentPreset` (it is a session
 * projection) and projects the goal as `{ goal, roundsStarted }`; a regression
 * here silently hides Full stop and the worker inventory.
 *
 * The fake React below models the three behaviours the interactive Feed
 * depends on, because a flag-only assertion would prove nothing:
 * hooks are ordered, an effect re-runs ONLY when its dependency array changes
 * (running its previous cleanup first), and timers are manual — so "暂停 stops
 * polling" can be proven by removing the timer, not by trusting a boolean. */

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

async function mountFeed({
  sessions,
  projection = null,
  workers = WORKERS,
  feed = FEED,
  stop = null,
  uiWorkspace = null,
  feedScript = null,
}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const ETAG = '"feed-v1"'
  const state = []
  const refs = []
  const depsBySlot = []
  const cleanupBySlot = []
  const timers = new Map()
  let timerSeq = 0
  let hook = 0
  let pending = []
  let feedCalls = 0
  const feedEtags = []
  const React = {
    Fragment: Symbol('Fragment'),
    // Real React exposes children on props (`Card(props)` reads props.children).
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children }, children } },
    useState(initial) {
      const slot = hook++
      if (!(slot in state)) state[slot] = initial
      return [state[slot], next => {
        state[slot] = typeof next === 'function' ? next(state[slot]) : next
      }]
    },
    useRef(initial) {
      const slot = hook++
      if (!(slot in refs)) refs[slot] = { current: initial }
      return refs[slot]
    },
    useEffect(effect, deps) {
      pending.push({ slot: hook++, effect, deps })
    },
  }
  const fetch = async (url, init) => {
    if (url.startsWith('/supervisor/feed')) {
      feedCalls += 1
      const sent = init?.headers?.['if-none-match'] ?? null
      feedEtags.push(sent)
      // `feedScript` pins an explicit answer to one request (1-based), which is
      // how a test scripts a transient host failure. Requests without a
      // scripted entry fall through to the host's real conditional-refresh
      // rule below, so the fake keeps behaving like the route instead of like a
      // call counter: revalidating the document we hold answers 304 (nothing in
      // .agi/ changed), and an unconditional request gets the document.
      const scripted = feedScript?.[feedCalls - 1]
      if (scripted != null) {
        return { ok: false, status: scripted.status, headers: { get: () => null } }
      }
      if (sent === ETAG) return { status: 304, ok: false, headers: { get: () => ETAG } }
      return {
        status: 200,
        ok: true,
        headers: { get: name => (name === 'etag' ? ETAG : null) },
        json: async () => feed,
      }
    }
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
  let pluginFactory
  const window = {
    confirm: () => true,
    __ModuleLoader__: { load(definition) { pluginFactory = definition.factory } },
  }
  vm.runInNewContext(source, {
    window, fetch, console, URL,
    setInterval: callback => {
      timerSeq += 1
      timers.set(timerSeq, callback)
      return timerSeq
    },
    clearInterval: id => { timers.delete(id) },
  })
  const plugin = pluginFactory(() => React)
  let Feed
  plugin.apply({
    // The session-navigation service is resolved with `ctx.get`, exactly like
    // the shipped task-board plugin does it.
    get(name) { return name === 'uiWorkspace' ? uiWorkspace ?? undefined : undefined },
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

  const renderOnce = () => {
    hook = 0
    pending = []
    // The slot component is a wrapper that threads `openSession` into the view,
    // so the tree has to be expanded once before the view's hooks have run.
    const tree = expand(Feed({
      sessionId: 'session-root',
      useProjection: () => projection,
      useSessions: selector => selector({ byId: sessions }),
    }))
    for (const { slot, effect, deps } of pending) {
      const previous = depsBySlot[slot]
      const changed = previous === undefined || deps == null || previous.length !== deps.length
        || deps.some((value, index) => value !== previous[index])
      if (!changed) continue
      depsBySlot[slot] = deps == null ? undefined : [...deps]
      if (typeof cleanupBySlot[slot] === 'function') cleanupBySlot[slot]()
      cleanupBySlot[slot] = undefined
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanupBySlot[slot] = cleanup
    }
    return tree
  }
  const flush = async () => {
    for (let round = 0; round < 4; round += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const render = async () => {
    const tree = renderOnce()
    await flush()
    return tree
  }
  const findButton = (tree, text) => findElement(tree, node => node.type === 'button'
    && (node.children.includes(text) || textOf(node) === text))
  // Mount, then let the first round of effects settle, so a caller's next
  // `render()` already shows the fetched state (a real renderer re-renders).
  await render()
  return {
    render,
    flush,
    /** Fire every live 5-second interval callback, i.e. "wait 5 seconds". */
    fireTick() { for (const callback of [...timers.values()]) callback() },
    liveTimers() { return timers.size },
    click(tree, text) {
      const button = findButton(tree, text)
      assert.ok(button, `the ${text} button must render`)
      button.props.onClick({ stopPropagation() {} })
      return button
    },
    button: findButton,
    feedCalls() { return feedCalls },
    feedEtags,
  }
}

/** Mount, settle, and return the rendered tree (the shape older tests read). */
async function renderFeed(options) {
  const harness = await mountFeed(options)
  return harness.render()
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

// ------------------------------------------------- 0.10.8 interactive Feed

/** The worker's session, as the host's session list would carry it. */
const WORKER_SESSION = {
  id: 'worker-1', cwd: 'E:/probe', origin: 'subagent', parentId: 'session-root',
  running: true, updatedAt: Date.now(),
}

test('a worker row opens that worker’s native session', async () => {
  // `conversation.view` props carry no session switcher — `openView` is a VIEW
  // TAB switch — so the row must navigate through the client `uiWorkspace`
  // service, resolved with `ctx.get` and threaded in by the slot wrapper.
  const opened = []
  const harness = await mountFeed({
    sessions: { ...ROOT_SESSION, 'worker-1': WORKER_SESSION },
    uiWorkspace: { openSession: id => opened.push(id) },
  })
  const tree = await harness.render()
  const row = findElement(tree, node => node.type === 'li' && textOf(node).includes('sleep worker'))
  assert.ok(row, 'the worker row must render')
  assert.notEqual(row.type, 'button', 'the row itself stays unclickable (text stays selectable)')

  const label = findElement(row, node => node.type === 'button'
    && node.props['aria-label'] === '在会话中打开 worker 会话 sleep worker')
  assert.ok(label, 'the worker label is the session link')
  assert.equal(label.props.title, '在会话中打开 sleep worker（worker-1）')
  assert.equal(label.props.style.background, 'transparent')
  assert.equal(label.props.style.border, 'none')
  assert.equal(label.props.style.padding, 0)
  assert.equal(label.props.style.cursor, 'pointer')
  assert.equal(label.props.style.textAlign, 'left')
  assert.match(label.props.style.borderBottom, /^1px dashed /)

  let stopped = 0
  label.props.onClick({ stopPropagation() { stopped += 1 } })
  assert.deepEqual(opened, ['worker-1'])
  assert.equal(stopped, 1, 'the click must not bubble into the row')

  // The short id chip and the outcome sub-block are untouched by the link.
  assert.ok(findElement(row, node => node.type === 'span' && node.props.title === 'worker-1'))
  assert.match(textOf(row), /运行中/)
})

test('a worker whose session left the list stays plain, explainable text', async () => {
  const opened = []
  const harness = await mountFeed({
    sessions: ROOT_SESSION,
    uiWorkspace: { openSession: id => opened.push(id) },
  })
  const tree = await harness.render()
  const row = findElement(tree, node => node.type === 'li' && textOf(node).includes('sleep worker'))
  assert.equal(findElement(row, node => node.type === 'button'), undefined,
    'no dead button when the target session cannot be resolved')
  const label = findElement(row, node => node.type === 'span' && node.children.includes('sleep worker'))
  assert.ok(label, 'the label still renders')
  assert.equal(label.props.title, '该 worker 会话不在当前会话列表中，无法直接打开')
  assert.deepEqual(opened, [])
})

test('a Map-shaped byId snapshot resolves the worker session just as well', async () => {
  const opened = []
  const sessions = {
    ...ROOT_SESSION,
    'worker-1': WORKER_SESSION,
    get(id) { return this[id] },
  }
  const harness = await mountFeed({ sessions, uiWorkspace: { openSession: id => opened.push(id) } })
  const tree = await harness.render()
  harness.click(tree, 'sleep worker')
  assert.deepEqual(opened, ['worker-1'])
})

test('a host without uiWorkspace degrades to labels instead of blocking the tab', async () => {
  const tree = await renderFeed({ sessions: { ...ROOT_SESSION, 'worker-1': WORKER_SESSION } })
  const row = findElement(tree, node => node.type === 'li' && textOf(node).includes('sleep worker'))
  assert.equal(findElement(row, node => node.type === 'button'), undefined)
  assert.match(textOf(tree), /监督动态 Feed/, 'the tab still renders')
})

test('暂停 stops the poll loop; ↻ 刷新 fetches exactly once more', async () => {
  const harness = await mountFeed({ sessions: ROOT_SESSION })
  let tree = await harness.render()
  const initial = harness.feedCalls()
  assert.equal(initial, 1, 'one fetch on mount')

  // A 5-second tick normally fetches again.
  harness.fireTick()
  tree = await harness.render()
  assert.equal(harness.feedCalls(), initial + 1)
  assert.ok(harness.liveTimers() > 0, 'the poll timer is live while not paused')

  harness.click(tree, '⏸ 暂停')
  tree = await harness.render()
  assert.match(textOf(tree), /已暂停自动刷新/)
  assert.equal(harness.liveTimers(), 0, 'pausing removes the timer instead of hiding it')
  assert.equal(harness.button(tree, '⏸ 暂停'), undefined)
  assert.ok(harness.button(tree, '▶ 继续'), 'the toggle now offers 继续')
  assert.equal(harness.button(tree, '▶ 继续').props['aria-pressed'], true)

  // No timer remains, so a tick cannot fetch even if one were replayed.
  harness.fireTick()
  tree = await harness.render()
  assert.equal(harness.feedCalls(), initial + 1, 'paused means no polling at all')

  // Manual refresh is a fetch — exactly one — and it does not resume polling.
  harness.click(tree, '↻ 刷新')
  tree = await harness.render()
  assert.equal(harness.feedCalls(), initial + 2)
  assert.match(textOf(tree), /已暂停自动刷新/, '刷新 must not flip the pause switch')
  assert.equal(harness.liveTimers(), 0)

  // 继续 re-arms the timer.
  harness.click(tree, '▶ 继续')
  tree = await harness.render()
  assert.doesNotMatch(textOf(tree), /已暂停自动刷新/)
  assert.equal(harness.liveTimers(), 1)
  harness.fireTick()
  await harness.render()
  assert.equal(harness.feedCalls(), initial + 3)
})

test('the header reports when the last poll settled, and says 内容无变化 on a 304', async () => {
  // `feed.generatedAt` stops advancing once conditional refresh is on, so it
  // can no longer answer "how fresh is this?" — `checkedAt` must.
  const harness = await mountFeed({ sessions: ROOT_SESSION })
  let tree = await harness.render()
  assert.match(textOf(tree), /秒前 检查/)
  assert.doesNotMatch(textOf(tree), /内容无变化/)
  assert.equal(harness.feedEtags[0], null, 'the first poll has nothing to revalidate')

  harness.fireTick()
  await harness.render()
  tree = await harness.render()
  assert.equal(harness.feedEtags[1], '"feed-v1"', 'the second poll revalidates with If-None-Match')
  assert.match(textOf(tree), /内容无变化/)
  // A 304 must never blank the document.
  assert.match(textOf(cardTitled(tree, '进度')), /还没有任何内容/)
  assert.match(textOf(tree), /秒前 检查/)
})

test('a failed poll drops the ETag, so a stale one cannot wedge the Feed on 304', async () => {
  // Regression (0.10.8): the poll stored the ETag on the 200 path but never
  // cleared it on the failure paths. Sequence: 200 stores "feed-v1", then one
  // transient 500 turns `feed` into an error object — and the NEXT poll still
  // sent `If-None-Match: "feed-v1"`. Nothing in .agi/ had changed on disk, so
  // the host correctly answered 304, the 304 branch only set `unchanged` and
  // returned, and the error card (`无法读取监督动态`) stayed on screen until some
  // file's mtime happened to move. The card then lied about the real state.
  // A conditional request is only honest while a 200 document is actually held.
  const harness = await mountFeed({
    sessions: ROOT_SESSION,
    feedScript: [null, { status: 500 }],
  })
  let tree = await harness.render()
  assert.equal(harness.feedCalls(), 1)
  assert.equal(harness.feedEtags[0], null, 'the first poll has nothing to revalidate')
  assert.match(textOf(cardTitled(tree, '进度')), /还没有任何内容/, 'the document is on screen')

  // The 5-second tick revalidates with the ETag we now hold; the host hiccups.
  // Two renders per tick, exactly like the staleness test above: the first one
  // applies the effect, the second observes the state it settled into.
  harness.fireTick()
  await harness.render()
  tree = await harness.render()
  assert.equal(harness.feedEtags[1], '"feed-v1"', 'a 200 grants the right to revalidate')
  assert.match(textOf(tree), /无法读取监督动态/, 'a 500 is reported, not shown as "no .agi/"')

  // THE REGRESSION: the failure must have dropped the ETag. Revalidating here
  // is what lets the host answer 304 for a document we no longer hold.
  harness.fireTick()
  await harness.render()
  tree = await harness.render()
  assert.equal(harness.feedCalls(), 3)
  assert.equal(harness.feedEtags[2], null, 'a failed poll must not revalidate a stale ETag')

  // Because the request was unconditional, the honest 200 recovers the card.
  assert.doesNotMatch(textOf(tree), /无法读取监督动态/, 'a later 200 clears the error state')
  assert.doesNotMatch(textOf(tree), /内容无变化/, 'unchanged must not be left true')
  assert.match(textOf(cardTitled(tree, '进度')), /还没有任何内容/, 'the document renders again')
})

