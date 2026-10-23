/**
 * `syncSupervisedLayer` is the piece the settings toggle actually calls, so
 * its two guarantees are worth pinning: an unchanged selection must not touch
 * the loader, and a changed one must land exactly once.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { isSupervised, syncSupervisedLayer } from '../lib/supervise.js'

const plugins = () => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '' } },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'delegation',
    name: 'cordis:group',
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent' } },
    ],
  },
]

/** A loader row stand-in that records every `update` call. */
function fakePreset(id) {
  const row = {
    options: { config: { id, plugins: plugins() } },
    updates: [],
    failWith: null,
    async update(patch) {
      if (row.failWith !== null) throw new Error(row.failWith)
      row.updates.push(patch)
      row.options = { ...row.options, ...patch }
    },
  }
  return row
}

const rows = (...presets) => presets.map(entry => ({
  entry,
  id: entry.options.config.id,
  plugins: entry.options.config.plugins,
}))

test('a new selection rewrites the row exactly once', async () => {
  const standard = fakePreset('standard')
  const baselines = new Map()
  const entries = rows(standard)

  const first = await syncSupervisedLayer({ entries, wanted: ['standard'], baselines })
  assert.deepEqual(first.changed, [{ id: 'standard', supervised: true }])
  assert.equal(standard.updates.length, 1)
  assert.equal(isSupervised(standard.options.config.plugins), true)
})

test('resyncing the same selection touches nothing', async () => {
  const standard = fakePreset('standard')
  const baselines = new Map()

  await syncSupervisedLayer({ entries: rows(standard), wanted: ['standard'], baselines })
  const before = standard.updates.length
  const second = await syncSupervisedLayer({ entries: rows(standard), wanted: ['standard'], baselines })

  assert.deepEqual(second.changed, [])
  assert.equal(standard.updates.length, before)
})

test('clearing the selection restores the pristine rows', async () => {
  const standard = fakePreset('standard')
  const original = structuredClone(standard.options.config.plugins)
  const baselines = new Map()

  await syncSupervisedLayer({ entries: rows(standard), wanted: ['standard'], baselines })
  const cleared = await syncSupervisedLayer({ entries: rows(standard), wanted: [], baselines })

  assert.deepEqual(cleared.changed, [{ id: 'standard', supervised: false }])
  assert.deepEqual(standard.options.config.plugins, original)
  assert.equal(isSupervised(standard.options.config.plugins), false)
})

test('the baseline is captured once and survives a later rewrite', async () => {
  const standard = fakePreset('standard')
  const original = structuredClone(standard.options.config.plugins)
  const baselines = new Map()

  await syncSupervisedLayer({ entries: rows(standard), wanted: ['standard'], baselines })
  assert.deepEqual(baselines.get('standard'), original)

  // A second enable/disable cycle must still restore the FIRST snapshot, not
  // the already-supervised array.
  await syncSupervisedLayer({ entries: rows(standard), wanted: [], baselines })
  await syncSupervisedLayer({ entries: rows(standard), wanted: ['standard'], baselines })
  await syncSupervisedLayer({ entries: rows(standard), wanted: [], baselines })
  assert.deepEqual(standard.options.config.plugins, original)
})

test('a failing row is reported without blocking the others', async () => {
  const standard = fakePreset('standard')
  const minimal = fakePreset('minimal')
  standard.failWith = 'fiber did not settle'
  const baselines = new Map()

  const result = await syncSupervisedLayer({
    entries: rows(standard, minimal),
    wanted: ['standard', 'minimal'],
    baselines,
  })

  assert.deepEqual(result.changed, [{ id: 'minimal', supervised: true }])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].id, 'standard')
  assert.match(result.errors[0].error, /fiber did not settle/)
  // The failed row keeps its original array, so a retry is still valid.
  assert.equal(isSupervised(standard.options.config.plugins), false)
})

test('presets with nothing to rewrite are skipped', async () => {
  const broken = { options: { config: { id: 'broken' } }, updates: [], async update() { throw new Error('should not run') } }
  const baselines = new Map()

  const result = await syncSupervisedLayer({ entries: rows(broken), wanted: ['broken'], baselines })
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.errors, [])
})

test('a wanted id that has no row is silently ignored', async () => {
  const standard = fakePreset('standard')
  const baselines = new Map()

  const result = await syncSupervisedLayer({ entries: rows(standard), wanted: ['standard', 'ghost'], baselines })
  assert.deepEqual(result.changed, [{ id: 'standard', supervised: true }])
})
