import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

function findElement(node, predicate) {
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

async function renderSettingsCard(value, catalog = 'ok', presets = null) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const state = []
  let hook = 0
  let effects = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useEffect(effect) { effects.push(effect) },
    useState(initial) {
      const index = hook++
      if (!(index in state)) state[index] = initial
      return [state[index], next => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
  }
  let pluginFactory
  const fetch = async url => {
    // The preset list is a second, independent request. Without a stub the
    // card must degrade to its "preset 列表读取失败" branch — that is what
    // every test written before presets were stubbed relies on.
    if (url === '/supervisor/presets') {
      if (presets === null) throw new Error('no preset stub')
      return { ok: true, json: async () => ({ presets }) }
    }
    assert.equal(url, '/supervisor/models')
    // 'pending' models a slow catalog: the request never settles, so the card
    // stays in catalogStatus === 'loading'. 'error' is a failed read.
    if (catalog === 'pending') return new Promise(() => {})
    if (catalog === 'error') return { ok: false, status: 503, json: async () => ({}) }
    return {
      ok: true,
      json: async () => ({
        models: [{
          provider: 'runtime', id: 'current', name: 'Current runtime model',
          modalities: [], dynamic: true,
        }, {
          provider: 'antigravity', id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash',
          modalities: ['text', 'image'],
          reasoning: { efforts: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ] },
        }],
      }),
    }
  }
  const window = {
    __ModuleLoader__: { load(definition) { pluginFactory = definition.factory } },
  }
  vm.runInNewContext(source, { window, fetch, console, URL, setInterval, clearInterval })
  const plugin = pluginFactory(name => {
    assert.equal(name, 'react')
    return React
  })
  let SettingsCard
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { value, writable: true } },
    async set() {},
  }
  plugin.apply({
    effect(callback) { return callback() },
    slots: {
      inject(_name, install) { install() },
      register(options, component) {
        if (options.name === 'plugins.item') SettingsCard = component
        return () => {}
      },
    },
    configForms: {
      get() { return scope },
      whileServed(_namespaces, install) { return install() },
    },
  })

  const render = () => {
    hook = 0
    effects = []
    return SettingsCard({ view: 'page' })
  }
  render()
  const pendingEffects = [...effects]
  for (const effect of pendingEffects) effect()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  return render()
}

test('Settings defaults runtime/current into the allowed worker list', async () => {
  const tree = await renderSettingsCard({})
  assert.ok(findElement(tree, node => node.type === 'code'
    && node.children.includes('runtime/current')))
  assert.ok(findElement(tree, node => node.type === 'span'
    && node.children.includes('[current turn — resolved at call time]')))
  assert.ok(findElement(tree, node => node.type === 'select'
    && node.props.value === 'provider/default'
    && node.props.title?.includes('runtime/current')
    && findElement(node, child => child.type === 'option' && child.props.value === 'provider/default')))
  assert.ok(findElement(tree, node => node.type === 'option'
    && node.props.value === 'high'
    && node.children.includes('High (high)')))
  assert.equal(findElement(tree, node => node.type === 'option'
    && node.children.includes('Same as current main turn (default)')), undefined)
})

test('removed runtime/current remains available in the add-model dropdown', async () => {
  const tree = await renderSettingsCard({ workerModels: [] })
  const option = findElement(tree, node => node.type === 'option'
    && node.props.value === 'runtime/current')
  assert.ok(option)
  assert.ok(option.children.some(child => typeof child === 'string'
    && child.includes('当前运行时模型')))
})

test('Settings preserves a configured fixed effort and exposes native capability labels', async () => {
  const tree = await renderSettingsCard({
    workerModels: ['antigravity/gemini-3.7-flash'],
    workerEfforts: { 'antigravity/gemini-3.7-flash': 'high' },
  })
  assert.ok(findElement(tree, node => node.type === 'select'
    && node.props.value === 'high'
    && node.props.title?.includes('antigravity/gemini-3.7-flash')))
  assert.ok(findElement(tree, node => node.type === 'span'
    && node.children.includes('[text,image; effort low/medium/high]')))
})

test('a still-loading catalog never claims a stored effort is unsupported', async () => {
  // Loading the catalog must not degrade into a warning: the model has simply
  // not been read yet, so the row may only offer a neutral hint.
  const tree = await renderSettingsCard({
    workerModels: ['antigravity/gemini-3.7-flash'],
    workerEfforts: { 'antigravity/gemini-3.7-flash': 'high' },
  }, 'pending')
  const placeholder = findElement(tree, node => node.type === 'option'
    && node.props.value === 'high' && node.props.disabled === true)
  assert.ok(placeholder, 'the saved value stays visible while the catalog loads')
  const label = placeholder.children.join(' ')
  assert.match(label, /暂不校验强度/)
  assert.doesNotMatch(label, /未声明支持/)
  assert.equal(findElement(tree, node => node.type === 'span'
    && node.props.role === 'status'), undefined)
})

test('a failed catalog read suppresses the unsupported-effort warning too', async () => {
  const tree = await renderSettingsCard({
    workerModels: ['antigravity/gemini-3.7-flash'],
    workerEfforts: { 'antigravity/gemini-3.7-flash': 'high' },
  }, 'error')
  const placeholder = findElement(tree, node => node.type === 'option'
    && node.props.value === 'high' && node.props.disabled === true)
  assert.ok(placeholder)
  assert.match(placeholder.children.join(' '), /暂不校验强度/)
  assert.equal(findElement(tree, node => node.type === 'span'
    && node.props.role === 'status'), undefined)
})

test('a ready catalog still flags an effort the model really does not declare', async () => {
  const tree = await renderSettingsCard({
    workerModels: ['antigravity/gemini-3.7-flash'],
    workerEfforts: { 'antigravity/gemini-3.7-flash': 'max' },
  })
  const placeholder = findElement(tree, node => node.type === 'option'
    && node.props.value === 'max' && node.props.disabled === true)
  assert.ok(placeholder)
  assert.match(placeholder.children.join(' '), /该模型未声明支持/)
  const flag = findElement(tree, node => node.type === 'span' && node.props.role === 'status')
  assert.ok(flag, '未声明的强度必须在行内标出来')
  assert.ok(findElement(flag, node => node.props?.className === 'dsma-lamp'),
    '标记是一颗指示灯，不是一个字形')
  assert.match(flag.children.join(' '), /未声明/)
})

function collect(node, predicate, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

/** 这个 fake React 只做 createElement，不会调用函数组件 —— 所以 `h(NumberRow)`
 * 留在树里是一层没展开的壳，里面的 input 看不见。这里把无 hook 的纯展示组件
 * 就地调用掉（SettingsSection / NumberRow 都没有 useState，安全）。 */
function renderDeep(node) {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderDeep)
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children
    return renderDeep(node.type({ ...node.props, children }))
  }
  return { ...node, children: (node.children ?? []).map(renderDeep) }
}

const PRESETS = [
  { id: 'standard', name: 'standard', builtin: false, live: true, fileBacked: true, rows: 3 },
  { id: 'main-agent', name: 'Main Agent', builtin: true, live: true },
  { id: 'redteam', name: '红队模式', builtin: false, live: false, fileBacked: true, mounted: true },
  { id: 'unrestricted-child-x', name: '无限制模式·子任务', builtin: false, broken: true },
]

test('the page reads as three divided sections, and a mode row is a whole clickable block', async () => {
  const tree = await renderSettingsCard({ supervisedPresets: ['standard'] }, 'ok', PRESETS)

  const sections = collect(tree, node => typeof node.type === 'function'
    && node.type.name === 'SettingsSection')
  assert.deepEqual(sections.map(node => node.props.title),
    ['Worker 模型白名单', '启用监督循环的模式', '循环节律'])
  // 第一段紧跟页头，不再画线；后两段各有一条分隔线，四块的节奏才对得上。
  assert.deepEqual(sections.map(node => node.props.divider === true), [false, true, true])

  // 函数组件在 fake React 里没被调用，展开后再看它们内部的结构。
  const deep = renderDeep(tree)

  // 选中的模式整块换底色：只靠 14px 勾选框，8 行里认不出哪几个开着。
  const rows = collect(deep, node => node.type === 'label')
  const checkedRow = rows.find(node => node.props.style?.background
    && node.props.style.background !== 'transparent')
  assert.ok(checkedRow, 'the enabled preset row carries its own surface')
  const plainRow = rows.find(node => node.props.style?.background === 'transparent')
  assert.ok(plainRow, '未选中的行回到纸面上，不再每行一个盒子')
  assert.equal(checkedRow.props.style.cursor, 'pointer')
  const box = findElement(checkedRow, node => node.type === 'input')
  assert.equal(box.props.type, 'checkbox')
  assert.equal(box.props.checked, true)
  assert.equal(box.props.className, 'dsma-check')

  // 内置模式常开且不可切换；加载失败的 preset 只是变淡，不给 hover。
  const builtinBox = findElement(deep, node => node.type === 'input'
    && node.props['aria-label'] === '在 Main Agent 模式启用监督循环')
  assert.equal(builtinBox.props.checked, true)
  assert.equal(builtinBox.props.disabled, true)
  const brokenRow = findElement(deep, node => node.type === 'label'
    && node.props.style?.opacity === 0.55)
  assert.ok(brokenRow, 'a broken preset stays visible but muted')
  assert.equal(brokenRow.props.className, undefined)

  // 数字字段：标签在左、输入框靠右对齐成一列（原来固定 220px 标签宽）。
  const numberBox = findElement(deep, node => node.type === 'input'
    && node.props.type === 'number')
  assert.equal(numberBox.props.style.width, 84)
  assert.equal(numberBox.props.style.textAlign, 'right')
  assert.equal(numberBox.props.className, 'dsma-field')

  // 主按钮与次按钮共用一套按钮令牌。
  const addButton = findElement(deep, node => node.type === 'button'
    && node.children.includes('添加'))
  assert.equal(addButton.props.className, 'dsma-btn')
  assert.equal(addButton.props.style.height, 28)
})

