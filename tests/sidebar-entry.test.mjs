/**
 * The sidebar's first-level entry (`监督者` above the workspace list).
 *
 * Two registrations make one entry: a KEYED `main` panel that renders the page,
 * and a `sidebar.panellist` row that renders the label. The host validates the
 * pair only when the row is clicked (`layout.selectPanel` throws
 * `main panel "<id>" is not registered`), so the ids are pinned here instead.
 */
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

/** Run `lib/client.js` in a vm and hand back every slot registration it made,
 * plus the React shim so a caller can render a component it picked. */
async function mount() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const state = []
  let hook = 0
  const effects = []
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
    if (url === '/supervisor/presets') return { ok: true, json: async () => ({ presets: [] }) }
    assert.equal(url, '/supervisor/models')
    return { ok: true, json: async () => ({ models: [] }) }
  }
  const window = { __ModuleLoader__: { load(definition) { pluginFactory = definition.factory } } }
  vm.runInNewContext(source, { window, fetch, console, URL, setInterval, clearInterval })
  const plugin = pluginFactory(name => {
    assert.equal(name, 'react')
    return React
  })
  const registrations = []
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { value: {}, writable: true } },
    async set() {},
  }
  plugin.apply({
    effect(callback) { return callback() },
    slots: {
      inject(_name, install) { install() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get() { return scope },
      whileServed(_namespaces, install) { return install() },
    },
  })
  const render = component => {
    hook = 0
    effects.length = 0
    return component({})
  }
  return { registrations, render }
}

const pick = (registrations, name) => registrations.find(row => row.options.name === name)

test('the sidebar lists 监督者 and a main panel backs that same id', async () => {
  const { registrations } = await mount()
  const row = pick(registrations, 'sidebar.panellist')
  const page = pick(registrations, 'main')
  assert.notEqual(row, undefined, 'no sidebar.panellist registration')
  assert.notEqual(page, undefined, 'no main panel registration')
  assert.equal(row.options.label, '监督者')
  assert.equal(page.options.key, 'supervisor')
  // The pair is what the host checks on click: a listed id with no `main`
  // panel behind it throws instead of opening anything.
  assert.equal(row.options.id, page.options.key)
  assert.equal(page.options.label, '监督者')
  assert.equal(typeof page.component, 'function')
})

test('the entry keeps the same order slot and shows up beside the shipped pages', async () => {
  const { registrations } = await mount()
  const row = pick(registrations, 'sidebar.panellist')
  // The shipped Plugins page claims order 0; anything below it sorts after.
  assert.equal(typeof row.options.order, 'number')
  assert.ok(row.options.order > 0)
})

test('the glyph draws itself at the size the column asks for', async () => {
  const { registrations } = await mount()
  const icon = pick(registrations, 'sidebar.panellist').component
  const wide = icon({ size: 18, active: true })
  assert.equal(wide.type, 'svg')
  assert.equal(wide.props.width, 18)
  assert.equal(wide.props.height, 18)
  // Purely decorative: the row's button already carries the accessible name.
  assert.equal(wide.props['aria-hidden'], 'true')
  assert.equal(icon({}).props.width, 16)
})

test('the sidebar page hosts the very card the Plugins tab shows', async () => {
  const { registrations, render } = await mount()
  const page = pick(registrations, 'main').component
  const tree = render(page)
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.style.overflow, 'auto')
  // The frame paints `main` flush to the top edge and reserves this variable
  // for the window controls, so the page has to add it back.
  assert.match(tree.props.style.padding, /--dsh-frame-top-clearance/)
  const inner = tree.children[0]
  assert.equal(inner.props.style.maxWidth, 780)
  const cardType = inner.children[0].type
  assert.equal(typeof cardType, 'function', 'page does not mount a card')
  // ...and that card is the supervisor settings form, not a placeholder.
  const card = render(cardType)
  assert.ok(findElement(card, node => node.type === 'h3'
    && node.children.includes('监督者运行时')))
})
