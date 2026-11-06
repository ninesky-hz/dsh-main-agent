// 把真实的 Feed 与设置卡片渲染成静态 HTML，用来截图核对设计。
// 这里用的是一个最小 React（createElement + hooks），和 tests/ 里的假 React 同源：
// 组件真的被调用、真的跑 effect，只是不挂到 DOM 上 —— 所以截出来的是产品代码的
// 输出，不是另写一份 mock。
import { readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'

const here = new URL('.', import.meta.url)
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

const UNITLESS = new Set([
  'lineHeight', 'opacity', 'fontWeight', 'flex', 'flexGrow', 'flexShrink',
  'zIndex', 'order', 'WebkitLineClamp', 'fontVariantNumeric',
])

function styleOf(style) {
  if (style == null) return ''
  const out = []
  for (const [key, value] of Object.entries(style)) {
    if (value == null || value === false) continue
    const name = key.startsWith('--') ? key
      : key === 'WebkitLineClamp' ? '-webkit-line-clamp'
        : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    const text = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value)
    out.push(`${name}:${text}`)
  }
  return out.join(';')
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const VOID = new Set(['input', 'br', 'img', 'hr'])
const HTML = new Set([
  'div', 'span', 'section', 'header', 'footer', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
  'h4', 'code', 'pre', 'button', 'details', 'summary', 'label', 'input', 'select',
  'option', 'svg', 'path', 'circle', 'strong', 'em', 'b', 'small', 'table', 'tbody', 'tr',
  'td', 'th', 'a', 'i', 'nav', 'main', 'aside', 'dl', 'dt', 'dd', 'time', 'hr', 'br',
])

function attrsOf(props) {
  const attrs = []
  if (props.className) attrs.push(`class="${props.className}"`)
  const style = styleOf(props.style)
  if (style !== '') attrs.push(`style="${style}"`)
  for (const key of ['title', 'role', 'type', 'value', 'checked', 'disabled', 'placeholder',
    'href', 'width', 'height', 'viewBox', 'fill', 'stroke', 'd', 'aria-label', 'aria-hidden',
    'aria-pressed', 'colSpan']) {
    const value = props[key]
    if (value == null || value === false) continue
    if (value === true) { attrs.push(key); continue }
    attrs.push(`${key}="${escapeHtml(value)}"`)
  }
  return attrs.length === 0 ? '' : ` ${attrs.join(' ')}`
}

function toHtml(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children
    return toHtml(node.type({ ...node.props, children }))
  }
  if (node.type === Symbol.for('Fragment') || typeof node.type === 'symbol') {
    return (node.children ?? []).map(toHtml).join('')
  }
  if (!HTML.has(node.type)) return (node.children ?? []).map(toHtml).join('')
  const inner = (node.children ?? []).map(toHtml).join('')
  const open = `<${node.type}${attrsOf(node.props ?? {})}`
  if (VOID.has(node.type)) return `${open}>`
  return `${open}>${inner}</${node.type}>`
}

/** 一套最小 React，行为与 tests/ 里的假 React 一致。 */
function expandAll(node) {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expandAll)
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children
    return expandAll(node.type({ ...node.props, children }))
  }
  return { ...node, children: (node.children ?? []).map(expandAll) }
}

function makeReact() {
  const state = []
  const hooks = { n: 0 }
  const effects = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children }, children }
    },
    useState(initial) {
      const slot = hooks.n++
      if (!(slot in state)) state[slot] = initial
      return [state[slot], next => {
        state[slot] = typeof next === 'function' ? next(state[slot]) : next
      }]
    },
    useRef(initial) {
      const slot = hooks.n++
      return { current: initial }
    },
    useEffect(effect, deps) { effects.push({ slot: hooks.n++, effect, deps }) },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
  React.__hooks = hooks
  React.__state = state
  React.__effects = effects
  return React
}

/** 跑一遍 effect，按依赖数组决定要不要重跑 —— 和真实 React 的保活规则一致。 */
function runEffects(React, depsBySlot, cleanupBySlot) {
  const pending = React.__effects.splice(0)
  for (const { slot, effect, deps } of pending) {
    const previous = depsBySlot.get(slot)
    const changed = previous === undefined || deps == null || previous.length !== deps.length
      || deps.some((value, index) => value !== previous[index])
    if (!changed) continue
    depsBySlot.set(slot, deps == null ? null : [...deps])
    const cleanup = cleanupBySlot.get(slot)
    if (typeof cleanup === 'function') cleanup()
    const next = effect()
    cleanupBySlot.set(slot, typeof next === 'function' ? next : undefined)
  }
}

async function mount({ React, fetch, extra = {} }) {
  let factory
  const styleText = []
  const window = {
    confirm: () => true,
    __ModuleLoader__: { load(definition) { factory = definition.factory } },
  }
  const document = {
    head: { appendChild(node) { if (node?.textContent) styleText.push(node.textContent) } },
    addEventListener() {}, removeEventListener() {},
    createElement() { return {} },
    getElementById() { return null },
  }
  vm.runInNewContext(source, {
    window, document, fetch, console, URL,
    setInterval: () => 0, clearInterval: () => {},
  })
  const plugin = factory(() => React)
  const registry = {}
  plugin.apply({
    get(name) { return extra.services?.[name] },
    effect(callback) { return callback() },
    slots: {
      inject(_name, install) { install() },
      register(options, component) {
        registry[`${options.name}:${options.id}`] = component
        return () => {}
      },
    },
    configForms: {
      get() { return extra.scope },
      whileServed(_namespaces, install) { return install() },
    },
  })
  return { registry, styleText }
}

const now = Date.now()
const minutes = count => now - count * 60_000

// ---------------------------------------------------------------- Feed 数据
const SESSIONS = {
  'session-root': {
    id: 'session-root', cwd: 'D:/Ai-Project/dsh-main-agent', running: true,
    updatedAt: now, projectionValues: { agentPreset: 'main-agent' },
  },
}

const FEED = {
  ws: 'D:/Ai-Project/dsh-main-agent',
  generatedAt: now,
  goal: {
    id: 'goal-1', phase: 'executing', revision: 3, roundsStarted: 3, maxGoalRounds: 12,
    updatedAt: minutes(2),
    objective: '重新设计面板与 Feed 页，去掉 AI 味',
  },
  progress: [
    { ts: minutes(26), text: '校验 384 项测试基线全绿' },
    { ts: minutes(22), text: '用户提出重新设计需求' },
    { ts: minutes(19), text: '接管工作区，读取 .agi/BRIEF.md 与 GOAL.md' },
    { ts: minutes(12), text: '读取 client.js 结构，登记 9 个卡片与设置页字段' },
    { ts: minutes(3), text: '确认 profile 副本与仓库副本一致，改动需双份同步' },
    { ts: minutes(1), text: '开始审计：列出 panel 与 feed 的 slop 清单' },
  ],
  changelog: [
    { action: 'spawn', summary: '派生 UI 重写 worker，路由 runtime/current' },
    { action: 'steer', summary: '要求先跑 unslop 审计再动手' },
    { action: 'assume', summary: '假设 feed 宽度跟随容器' },
  ],
  questions: [
    { ts: minutes(12), status: 'pending', q: '面板宽度按 880 还是保持 780？' },
  ],
  subagents: [],
  missionReport: { text: 'worker 收敛后写入 outcome.md；此处展示结论与证据摘要。', updatedAt: minutes(4) },
  notes: { text: 'NOTES.md —— 打底记录、假设与检查点，重启后按文件恢复现场。', updatedAt: minutes(3) },
  amendments: null,
}

const WORKERS = {
  compatible: true,
  workers: [{ id: '3f9a2c1e', label: 'UI 重写', running: true, createdAt: minutes(2) }],
  running: 1,
  total: 3,
}

const STOP = {
  stopped: false, running: true, runningWorkers: ['3f9a2c1e'],
  reminders: [
    { id: 'r1', kind: 'every', title: '监督者巡检', everySeconds: 300, scheduledAt: now + 108_000 },
    { id: 'r2', kind: 'at', title: '问答等待', scheduledAt: now + 660_000 },
  ],
}

const LOOP = {
  recommend: { seconds: 108, label: 'worker 巡检间隔 5 分钟' },
  watchdog: { enabled: true },
  staleWake: { stale: false, gapSeconds: 0 },
}

const root = 'D:/Ai-Project/dsh-main-agent'
const css = `
:root {
  --dsw-alias-label-primary: #f2f3f5;
  --dsw-alias-label-secondary: #b3b7bd;
  --dsw-alias-label-tertiary: #82878e;
  --dsw-alias-label-primary-inverted: #101114;
  --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #1b1b1d;
  --dsw-alias-bg-layer-2: #232325;
  --dsw-alias-settings-card-fill: #232325;
  --dsw-alias-settings-card-stroke: #ffffff1a;
  --dsw-alias-interactive-bg-hover: #ffffff10;
  --dsw-alias-brand-primary: #f4f5f7;
  --dsw-alias-state-success-primary: #35b46e;
  --dsw-alias-state-warn-label: #dd8629;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-alias-state-business-primary: #7aaaff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--dsw-alias-bg-base); }
body {
  font-family: -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--dsw-alias-label-primary);
}
button, input, select { font-family: inherit; }
`

{
  const React = makeReact()
  const { registry, styleText } = await mount({
    React,
    fetch: async url => {
      if (url.startsWith('/supervisor/feed')) {
        return {
          ok: true, status: 200,
          headers: { get: name => (name === 'etag' ? '"v1"' : null) },
          json: async () => FEED,
        }
      }
      if (url.startsWith('/supervisor/workers')) return { ok: true, json: async () => WORKERS }
      if (url.startsWith('/supervisor/stop')) return { ok: true, json: async () => STOP }
      if (url.startsWith('/supervisor/loop')) return { ok: true, json: async () => LOOP }
      if (url.startsWith('/supervisor/health')) {
        return { ok: true, json: async () => ({ ok: true, supervisorPresets: ['main-agent', 'general'], subagents: { required: [], missing: [] } }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    },
    extra: { services: { uiWorkspace: { openSession() {} } } },
  })
  const Feed = registry['conversation.view:supervisor-feed']
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(r => setImmediate(r)) }
  const depsBySlot = new Map()
  const cleanupBySlot = new Map()
  const render = async () => {
    React.__hooks.n = 0
    const tree = Feed({
      sessionId: 'session-root',
      // 生产里 FeedView 用 useProjection('goal') 拿目标投影，这里给它同样的形状，
      // 否则 目标 格子只会渲染空状态，截出来的图不能代表真实页面。
      useProjection: key => (key === 'goal'
        ? {
            phase: 'executing', revision: 3, roundsStarted: 3, maxGoalRounds: 12,
            updatedAt: minutes(2), objective: '重新设计面板与 Feed 页，去掉 AI 味',
          }
        : null),
      useSessions: selector => selector({ byId: SESSIONS }),
    })
    // 无 hook 的函数组件就地展开，和测试里的 expand() 同一个意思。
    const expand = node => {
      let current = node
      for (let d = 0; d < 8 && current && typeof current === 'object' && !Array.isArray(current)
        && typeof current.type === 'function'; d += 1) current = current.type(current.props)
      return current
    }
    const html = toHtml(expand(tree))
    runEffects(React, depsBySlot, cleanupBySlot)
    await settle()
    return html
  }
  await render(); await render()
  const html = await render()
  const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>监督动态</title><style>${css}${styleText.join('')}</style></head>
<body style="padding:0"><div style="width:1240px;padding:0 0 24px">${html}</div></body></html>`
  await writeFile(new URL('live-feed.html', here), page)
  console.log('live-feed.html', page.length)
}

// --------------------------------------------------------------- 设置卡片
{
  const React = makeReact()
  const value = {
    workerModels: ['runtime/current', 'deepseek/deepseek-v4'],
    workerEfforts: { 'runtime/current': 'provider-default', 'deepseek/deepseek-v4': 'max' },
    supervisedPresets: ['standard'],
    maxParallelWorkers: 3, maxSpawnTotal: 0, workerDeadlineMinutes: 90,
    wakeMinutes: 5, questionWaitMinutes: 2, proactive: 'auto', watchdog: true,
  }
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { value, writable: true } },
    async set() {},
  }
  const presets = [
    { id: 'standard', name: 'General agent', builtin: false, live: true, fileBacked: true, rows: 3 },
    { id: 'main-agent', name: 'Main Agent', builtin: true, live: true },
    { id: 'minimal', name: 'Minimal', builtin: false, live: true, fileBacked: true, rows: 3 },
    { id: 'redteam', name: 'Reviewer', builtin: false, broken: true },
  ]
  const { registry, styleText } = await mount({
    React,
    fetch: async url => {
      if (url === '/supervisor/models') {
        return {
          ok: true,
          json: async () => ({
            models: [
              { provider: 'runtime', id: 'current', name: 'Current runtime model', modalities: [], dynamic: true },
              {
                provider: 'deepseek', id: 'deepseek-v4', name: 'DeepSeek V4',
                modalities: ['text', 'image'],
                reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
              },
            ],
          }),
        }
      }
      if (url === '/supervisor/presets') return { ok: true, json: async () => ({ presets }) }
      throw new Error(`unexpected fetch ${url}`)
    },
    extra: { scope },
  })
  const Card = registry['plugins.item:supervisor']
  const depsBySlot = new Map()
  const cleanupBySlot = new Map()
  React.__hooks.n = 0
  let tree = Card({ view: 'page' })
  runEffects(React, depsBySlot, cleanupBySlot)
  for (let i = 0; i < 6; i += 1) await new Promise(r => setImmediate(r))
  React.__hooks.n = 0
  tree = Card({ view: 'page' })
  tree = expandAll(tree)
  const html = toHtml(tree)
  const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>监督者</title><style>${css}${styleText.join('')}</style></head>
<body style="padding:0"><div style="width:1240px;padding:28px 24px 40px"><div style="max-width:880px">${html}</div></div></body></html>`
  await writeFile(new URL('live-panel.html', here), page)
  console.log('live-panel.html', page.length)
}
