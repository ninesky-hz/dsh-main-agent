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

async function renderSettingsCard(value, catalog = 'ok') {
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
    && node.children.join(' ').includes('⚠ 强度未声明')), undefined)
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
    && node.children.join(' ').includes('⚠ 强度未声明')), undefined)
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
  assert.ok(findElement(tree, node => node.type === 'span'
    && node.children.join(' ').includes('⚠ 强度未声明')))
})
