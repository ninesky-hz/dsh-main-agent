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
    && findElement(node, child => (child.type === 'h2' || child.type === 'h3'
      || child.type === 'div') && Array.isArray(child.children) && child.children.includes(title)))
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
    && node.children.includes('完全停止')), 'Full stop must render')
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
    && node.children.includes('完全停止')))
})

test('missing main-agent preset degrades honestly instead of hanging', async () => {
  const sessions = {
    'session-root': { id: 'session-root', cwd: 'E:/probe', running: false, updatedAt: Date.now(), projectionValues: { agentPreset: 'standard' } },
  }
  const tree = await renderFeed({ sessions })
  assert.equal(findElement(tree, node => node.type === 'button'
    && node.children.includes('完全停止')), undefined)
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
  assert.match(textOf(card), /4 \/ 30 轮 · rev 2/)
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
  const card = cardTitled(tree, '待回答')
  const text = textOf(card)
  assert.match(text, /Full stop 要不要关掉 GUI 会话？/)
  assert.doesNotMatch(text, /q-fullstop-gui-session/, 'the id is not the question')
  for (const label of ['待答', '已假设', '已回答', '已撤回', 'mystery']) {
    assert.ok(text.includes(label), `status label ${label} must render`)
  }
  assert.match(text, /假设：假设不重启 Electron/)
  // A row without `q` still degrades to its alias rather than throwing.
  const alias = { ...FEED, questions: [{ id: 'q-6', status: 'pending', question: '旧格式 question 字段' }] }
  assert.match(textOf(cardTitled(await renderFeed({ sessions: ROOT_SESSION, feed: alias }), '待回答')),
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
  const card = cardTitled(tree, 'Worker')
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

/** The Feed's own row for a worker, found by its label. */
function workerRow(card, label) {
  return findElement(card, node => node.type === 'li' && textOf(node).includes(label))
}

const TWO_WORKERS = {
  compatible: true,
  workers: [
    { id: 'worker-1', label: 'first worker', running: false },
    { id: 'worker-2', label: 'second worker', running: false },
  ],
  running: 0,
  total: 2,
}

// Outcome ownership (0.10.9): a label-named artifact directory carries its
// worker's session id only in the header of its outcome.md, which the host
// parses into `workerId`. The directory name stays the primary key.
test('a label-named artifact reaches its row through the declared worker id', async () => {
  const feed = {
    ...FEED,
    subagents: [
      { name: 'ui-polish-0107', workerId: 'worker-1', outcome: { text: 'declared result', mtime: 1 }, files: ['outcome.md'] },
      { name: 'older-label', workerId: null, outcome: { text: 'unclaimed result', mtime: 1 }, files: [] },
    ],
  }
  const tree = await renderFeed({ sessions: ROOT_SESSION, feed, workers: TWO_WORKERS })
  const card = cardTitled(tree, 'Worker')
  const row = workerRow(card, 'first worker')
  assert.ok(row, 'the worker row must render')
  assert.match(textOf(row), /declared result/, 'the header wins over the directory name')
  const folderHint = findElement(row, node => node.type === 'summary' && node.props.title === 'artifact 目录：ui-polish-0107')
  assert.ok(folderHint, 'the row names the artifact folder it read')

  // A directory with no header is not guessed into a row (its name matches no
  // session id), so it stays in the fallback block.
  assert.doesNotMatch(textOf(workerRow(card, 'second worker')), /unclaimed result/)
  const fallback = findElement(card, node => node.type === 'div' && textOf(node).includes('历史结果'))
  assert.match(textOf(fallback), /unclaimed result/)
  assert.doesNotMatch(textOf(fallback), /declared result/, 'a claimed artifact never repeats in the fallback')
})

test('one artifact is claimed by one row only, even when its dir name fits another', async () => {
  // Contradictory artifact: the directory is named after worker-1 but declares
  // worker-2. A row prefers the declared id, and the artifact is claimed once —
  // so it renders exactly once. Row order decides a contradictory match: the
  // worker-2 row is resolved first here and takes it by its declared id.
  const rows = { ...TWO_WORKERS, workers: [TWO_WORKERS.workers[1], TWO_WORKERS.workers[0]] }
  const feed = {
    ...FEED,
    subagents: [
      { name: 'worker-1', workerId: 'worker-2', outcome: { text: 'claimed once', mtime: 1 }, files: [] },
    ],
  }
  const tree = await renderFeed({ sessions: ROOT_SESSION, feed, workers: rows })
  const card = cardTitled(tree, 'Worker')
  assert.match(textOf(workerRow(card, 'second worker')), /claimed once/,
    'the declared workerId wins over the directory name')
  assert.doesNotMatch(textOf(workerRow(card, 'first worker')), /claimed once/,
    'the row whose directory name matched must not render the same artifact')
  assert.equal(textOf(card).split('claimed once').length - 1, 1, 'one outcome renders once')
  assert.equal(findElement(card, node => node.type === 'div'
    && textOf(node).includes('历史结果')), undefined,
  'nothing is left unclaimed, so the fallback block is absent')
})

test('a label-named artifact without a header stays in 历史结果', async () => {
  const feed = {
    ...FEED,
    subagents: [
      { name: 'ui-polish-0107', workerId: null, outcome: { text: 'headerless result', mtime: 1 }, files: [] },
    ],
  }
  const tree = await renderFeed({ sessions: ROOT_SESSION, feed, workers: TWO_WORKERS })
  const card = cardTitled(tree, 'Worker')
  assert.doesNotMatch(textOf(workerRow(card, 'first worker')), /headerless result/)
  assert.doesNotMatch(textOf(workerRow(card, 'second worker')), /headerless result/)
  const fallback = findElement(card, node => node.type === 'div' && textOf(node).includes('历史结果'))
  assert.match(textOf(fallback), /headerless result/, 'an unowned artifact is never silently dropped')
  assert.match(textOf(fallback), /ui-polis…/, 'the fallback shows the artifact folder')
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
  const card = cardTitled(tree, '下一次巡检')
  assert.ok(card, 'the loop card renders for a supervisor session')
  const text = textOf(card)
  assert.match(text, /运行中/)
  assert.match(text, /1 个活动 worker/)
  assert.match(text, /每 5 分钟巡检/)
  assert.match(text, /一次性等待/)
  assert.match(text, /监督者巡检/)
  assert.match(text, /2 分钟后/)
  // 最近的一条用实心指示灯标出来；远的留在空闲色上。
  const nearest = findElement(card, node => node.props?.className === 'dsma-lamp'
    && node.props.style.background.includes('success'))
  assert.ok(nearest, '最近的一条提醒必须点灯')
  const rows = []
  const collect = node => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type === 'li') { rows.push(node); return }
    ;(node.children ?? []).forEach(collect)
  }
  collect(card)
  assert.equal(rows.length, 2, '两条提醒各占一行')
  const lamps = rows.map(row => findElement(row, node => node.props?.className === 'dsma-lamp'))
  assert.notEqual(lamps[0].props.style.background, lamps[1].props.style.background,
    '只有最近的一条亮，远的一条留在空闲色')
})

test('the loop card says 已停止 when nothing is armed or running', async () => {
  const tree = await renderFeed({
    sessions: ROOT_SESSION,
    stop: { stopped: true, running: false, reminders: [], runningWorkers: [] },
  })
  const card = cardTitled(tree, '下一次巡检')
  assert.match(textOf(card), /已停止/)
  assert.match(textOf(card), /没有已启用的提醒/)
})

test('a failed stop-status read is reported inside the loop card', async () => {
  const tree = await renderFeed({ sessions: ROOT_SESSION, stop: { failed: true, status: 503 } })
  const card = cardTitled(tree, '下一次巡检')
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
  assert.equal(cardTitled(tree, '下一次巡检'), undefined)
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
  assert.match(label.props.style.borderBottom, /^1px dotted /)

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
  assert.match(textOf(tree), /监督动态/, 'the tab still renders')
})

test('暂停 stops the poll loop; 刷新 fetches exactly once more', async () => {
  const harness = await mountFeed({ sessions: ROOT_SESSION })
  let tree = await harness.render()
  const initial = harness.feedCalls()
  assert.equal(initial, 1, 'one fetch on mount')

  // A 5-second tick normally fetches again.
  harness.fireTick()
  tree = await harness.render()
  assert.equal(harness.feedCalls(), initial + 1)
  assert.ok(harness.liveTimers() > 0, 'the poll timer is live while not paused')

  harness.click(tree, '暂停')
  tree = await harness.render()
  assert.match(textOf(tree), /已暂停自动刷新/)
  assert.equal(harness.liveTimers(), 0, 'pausing removes the timer instead of hiding it')
  assert.equal(harness.button(tree, '暂停'), undefined)
  assert.ok(harness.button(tree, '继续'), 'the toggle now offers 继续')
  assert.equal(harness.button(tree, '继续').props['aria-pressed'], true)

  // No timer remains, so a tick cannot fetch even if one were replayed.
  harness.fireTick()
  tree = await harness.render()
  assert.equal(harness.feedCalls(), initial + 1, 'paused means no polling at all')

  // Manual refresh is a fetch — exactly one — and it does not resume polling.
  harness.click(tree, '刷新')
  tree = await harness.render()
  assert.equal(harness.feedCalls(), initial + 2)
  assert.match(textOf(tree), /已暂停自动刷新/, '刷新 must not flip the pause switch')
  assert.equal(harness.liveTimers(), 0)

  // 继续 re-arms the timer.
  harness.click(tree, '继续')
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
  assert.match(textOf(tree), /秒前 · 已更新/)
  assert.doesNotMatch(textOf(tree), /无变化/)
  assert.equal(harness.feedEtags[0], null, 'the first poll has nothing to revalidate')

  harness.fireTick()
  await harness.render()
  tree = await harness.render()
  assert.equal(harness.feedEtags[1], '"feed-v1"', 'the second poll revalidates with If-None-Match')
  assert.match(textOf(tree), /无变化/)
  // A 304 must never blank the document.
  assert.match(textOf(cardTitled(tree, '进展')), /还没有内容/)
  assert.match(textOf(tree), /秒前 · 无变化/)
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
  assert.match(textOf(cardTitled(tree, '进展')), /还没有内容/, 'the document is on screen')

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
  assert.doesNotMatch(textOf(tree), /无变化/, 'unchanged must not be left true')
  assert.match(textOf(cardTitled(tree, '进展')), /还没有内容/, 'the document renders again')
})

test('long records are clamped and scroll inside their card, not down the page', async () => {
  // Regression (0.12.4): 进度/提问/变更日志 把每条记录的全文原样铺开，一条几百字
  // 的记录就是十几行，一堵字墙把整页拉到很长。三件事必须同时成立：长卡片的
  // 内容区有高度上限并自己滚、单条记录折成固定行数并给「展开」（默认不折叠会让
  // 断言看不见 clamp，默认折叠但不给展开按钮则是丢内容）、且所有卡片保持同一
  // 列宽 —— 2.x 曾把两张卡整行宽铺，宽度在 1/3 之间跳变、行也对不齐，那正是
  // 用户说的「不协调」。
  const longText = '很长的记录'.repeat(60)
  const feed = {
    ...FEED,
    progress: Array.from({ length: 20 }, (_, index) => ({
      ts: Date.now() - index * 60_000, text: longText,
    })),
    questions: [{ ts: Date.now(), status: 'pending', q: longText }],
    changelog: [{ ts: Date.now(), action: 'spawn', summary: longText }],
  }
  const harness = await mountFeed({ sessions: ROOT_SESSION, feed })
  const tree = await harness.render()

  for (const title of ['进展', '变更记录']) {
    const card = cardTitled(tree, title)
    assert.ok(card, `${title} must render`)
    assert.equal(card.props.style.gridColumn, undefined,
      `${title} 不再整行宽铺：宽度节奏统一后页面才对齐`)
    const scroller = findElement(card,
      node => typeof node.props?.style?.maxHeight === 'number' && node.props.style.overflow === 'auto')
    assert.ok(scroller, `${title} 的内容区必须有内部滚动上限，否则整页跟着它变长`)
  }

  // 长列表卡片用的是同一个高度令牌，一行里的卡片下沿才对得齐。
  const heights = ['进展', '待回答', '变更记录'].map(title => {
    const card = cardTitled(tree, title)
    const scroller = findElement(card,
      node => typeof node.props?.style?.maxHeight === 'number' && node.props.style.overflow === 'auto')
    return scroller.props.style.maxHeight
  })
  assert.equal(new Set(heights).size, 1,
    `长列表卡片应共用同一个高度上限，实际为 ${heights.join(' / ')}`)

  // 每条长记录折叠成两行，并且带一个能展开的按钮（内容不能丢）。
  const clamped = findElement(tree, node => node.props?.style?.WebkitLineClamp === 2)
  assert.ok(clamped, '长记录必须默认 -webkit-line-clamp 折叠')
  assert.equal(clamped.props.style.whiteSpace, 'pre-wrap', '折叠不能把换行压掉')
  const expand = findElement(tree, node => node.type === 'button'
    && typeof node.props?.onClick === 'function'
    && /展开/.test(textOf(node)))
  assert.ok(expand, '折叠的长记录必须给「展开」按钮')

  // 提问卡片里的长问题同样折叠（3 行），否则一条提问就能撑满整列。
  const question = cardTitled(tree, '待回答')
  assert.ok(findElement(question, node => node.props?.style?.WebkitLineClamp === 3))
})

test('the Feed keeps one surface and one type scale, and the strip reads as one dial', async () => {
  // 旧版把 8 张卡平铺成 auto-fit 网格，每张同样的重量 —— 于是没有主次，页脚
  // 还空一大块。新版是三段式仪表带 + 左主列/右栏，宽窄不一样是设计，不是失控：
  // 锁住的是「同一套表面与字号」，不是「所有卡片一样宽」。
  const harness = await mountFeed({ sessions: ROOT_SESSION, feed: FEED })
  const tree = await harness.render()

  const strip = findElement(tree, node => node.props?.className === 'dsma-strip')
  assert.ok(strip, '顶部必须是一块三段式仪表带')
  assert.equal(strip.children.length, 3, '目标 / 下一次巡检 / Worker 三格')

  const body = findElement(tree, node => node.props?.className === 'dsma-body')
  assert.ok(body, '主体是主列 + 右栏')
  // 栏宽在注入的样式表里（媒体查询要在 900px 折成一列），所以这里读源码里的规则。
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\.dsma-body \{[^}]*grid-template-columns: minmax\(0, 1fr\) 320px/)
  assert.match(source, /\.dsma-body \{[^}]*gap: 16px/)

  const cards = []
  const walk = node => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const expanded = expand(node)
    if (expanded !== node) { walk(expanded); return }
    if (node.type === 'section' && node.props?.className === 'dsma-card') cards.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(tree)
  assert.ok(cards.length >= 3, `右栏与主列都要有纸面卡片，实际 ${cards.length}`)
  for (const card of cards) {
    assert.equal(card.props.style.gridColumn, undefined, '没有卡片可以跨列')
    assert.equal(card.props.style.padding, '12px 16px 16px', '卡片内边距必须一致，且落在 4px 网格上')
    assert.equal(card.props.style.borderRadius, 12, '卡片圆角必须一致')
  }

  const title = findElement(cards[0], node => node.type === 'h2')
  assert.equal(title.props.style.textTransform, undefined, '中文标题不需要 uppercase')
  assert.equal(title.props.style.letterSpacing, 0, '标题不再用字距凑样式')
})
