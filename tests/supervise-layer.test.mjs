/**
 * The supervision layer must be a pure, reversible rewrite of a preset's
 * `plugins` array. These tests pin the four rows it touches, the rows it must
 * leave alone, and the round trip — because the settings toggle relies on
 * `strip(apply(x))` being indistinguishable from `x`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applySupervisorLayer,
  countSupervisorRows,
  DEV_AGENT_PERSONA,
  isSupervised,
  stripSupervisorLayer,
  SUPERVISOR_PERSONA,
} from '../lib/supervise.js'

/** Shape of `preset-standard`, reduced to the rows that matter. */
const standardPlugins = () => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '' } },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true },
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' },
      },
    ],
  },
]

const byId = (rows, id) => rows.find(row => row.id === id)

test('an untouched preset reports no supervision', () => {
  const plugins = standardPlugins()
  assert.equal(isSupervised(plugins), false)
  assert.equal(countSupervisorRows(plugins), 0)
})

test('applying rewrites exactly the four supervision rows', () => {
  const plugins = standardPlugins()
  const supervised = applySupervisorLayer(plugins)

  assert.equal(byId(supervised, 'persona').config.prefix, SUPERVISOR_PERSONA)
  assert.equal(byId(supervised, 'tool-goal').name, 'dsh-main-agent/goal')

  const delegation = byId(supervised, 'delegation').config
  assert.equal(byId(delegation, 'tool-subagent-control').name, 'dsh-main-agent/control')

  const spawn = byId(delegation, 'tool-subagent')
  assert.equal(spawn.name, 'dsh-main-agent/spawn')
  assert.equal(spawn.config.persona, DEV_AGENT_PERSONA)
  // Existing config survives the rewrite.
  assert.equal(spawn.config.provider, 'spawn')
  assert.equal(spawn.config.toolName, 'subagent')
  assert.equal(spawn.config.modelSelectionSettings, true)

  assert.equal(isSupervised(supervised), true)
  assert.equal(countSupervisorRows(supervised), 3)
})

test('rows outside the supervision set are left byte-identical', () => {
  const plugins = standardPlugins()
  const supervised = applySupervisorLayer(plugins)

  assert.deepEqual(byId(supervised, 'tool-schedule'), byId(plugins, 'tool-schedule'))
  assert.deepEqual(byId(supervised, 'tool-web'), byId(plugins, 'tool-web'))
  assert.deepEqual(byId(supervised, 'tool-subagent-list-agents') ?? byId(byId(supervised, 'delegation').config, 'tool-subagent-list-agents'),
    byId(byId(plugins, 'delegation').config, 'tool-subagent-list-agents'))

  // `fork` shares the upstream package name but has unrelated semantics.
  const fork = byId(byId(supervised, 'delegation').config, 'tool-subagent-fork')
  assert.equal(fork.name, '@deepseek-ai/dsh-tool-subagent')
  assert.equal(fork.config.persona, undefined)
})

test('applying never mutates the input array', () => {
  const plugins = standardPlugins()
  const snapshot = structuredClone(plugins)
  applySupervisorLayer(plugins)
  assert.deepEqual(plugins, snapshot)
})

test('stripping an applied layer restores the original exactly', () => {
  const plugins = standardPlugins()
  const restored = stripSupervisorLayer(applySupervisorLayer(plugins))
  assert.deepEqual(restored, plugins)
  assert.equal(isSupervised(restored), false)
  assert.equal(countSupervisorRows(restored), 0)
})

test('applying twice is idempotent', () => {
  const plugins = standardPlugins()
  const once = applySupervisorLayer(plugins)
  const twice = applySupervisorLayer(once)
  assert.deepEqual(twice, once)
})

test('a disabled row keeps its disabled flag', () => {
  const plugins = standardPlugins()
  byId(plugins, 'tool-goal').disabled = true
  const supervised = applySupervisorLayer(plugins)
  assert.equal(byId(supervised, 'tool-goal').disabled, true)
})

test('a preset with no delegation group still gets the top-level rows', () => {
  const plugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'minimal' } },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  ]
  const supervised = applySupervisorLayer(plugins)
  assert.equal(byId(supervised, 'persona').config.prefix, SUPERVISOR_PERSONA)
  assert.equal(byId(supervised, 'tool-goal').name, 'dsh-main-agent/goal')
  assert.equal(countSupervisorRows(supervised), 1)
})

test('non-array input degrades to an empty array instead of throwing', () => {
  assert.deepEqual(applySupervisorLayer(undefined), [])
  assert.deepEqual(stripSupervisorLayer(null), [])
  assert.equal(isSupervised(undefined), false)
  assert.equal(countSupervisorRows(null), 0)
})
