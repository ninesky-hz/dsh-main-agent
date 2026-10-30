/**
 * 「能不能承载监督层」只看 4 个锚点行是否存在。
 *
 * 这条判定存在的唯一理由：官方 minimal 有 persona，却没有 tool-goal、没有
 * tool-subagent-control、也没有 delegation 组。叠上去的结果是「人格说自己是
 * 监督者，start_goal / 派生 worker / send_message 一个工具都没有」—— 人格与
 * 能力脱节，循环一步都走不了。这类 preset 不能出现在可勾列表里。
 *
 * 注意判定**不能**用 `countSupervisorRows`：未叠过的 preset 那些行的 name 还是
 * 官方的，rows 恒为 0 —— 拿它判断会把 standard 也一起判成不可叠。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { supervisorFileAnchorReport } from '../lib/preset-files.js'
import {
  SUPERVISOR_ANCHOR_IDS,
  supervisorAnchorReport,
  syncSupervisedLayer,
} from '../lib/supervise.js'

/** 官方 standard / ptc / cordis 的骨架：4 个锚点齐备，行名还是官方的。 */
const standardLike = () => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.' } },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'delegation',
    name: 'cordis:group',
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn' } },
    ],
  },
]

/** 官方 minimal 的骨架：只有 persona，三个监督工具全无。 */
const minimalLike = () => [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: 'You are a helpful software engineer assistant.', complete: true, includeRuntimeContext: false },
  },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'compaction', name: 'cordis:group', config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }] },
]

test('standard 形状：4 个锚点齐备，可承载', () => {
  const report = supervisorAnchorReport(standardLike())
  assert.equal(report.ok, true)
  assert.deepEqual(report.missing, [])
})

test('minimal 形状：人格能叠但工具全缺，判为不可承载', () => {
  const report = supervisorAnchorReport(minimalLike())
  assert.equal(report.ok, false)
  assert.deepEqual(report.missing, ['tool-goal', 'tool-subagent-control', 'tool-subagent'])
  // 人格这一项是齐的 —— 它缺的从来不是人格，是工具。
  assert.ok(!report.missing.includes('persona'))
})

test('顶层 tool-subagent 不算：apply 只在 delegation 组内处理它', () => {
  const plugins = [
    { id: 'persona' },
    { id: 'tool-goal' },
    { id: 'tool-subagent-control' },
    { id: 'tool-subagent' },
  ]
  assert.deepEqual(supervisorAnchorReport(plugins).missing, ['tool-subagent'])
})

test('tool-subagent-control 在组内也算：apply 两处都改', () => {
  const plugins = [
    { id: 'persona' },
    { id: 'tool-goal' },
    { id: 'delegation', config: [
      { id: 'tool-subagent-control' },
      { id: 'tool-subagent' },
    ] },
  ]
  assert.equal(supervisorAnchorReport(plugins).ok, true)
})

test('disabled 的锚点行算缺失：改完 name 也不会挂载', () => {
  const plugins = standardLike()
  plugins[1].disabled = true
  assert.deepEqual(supervisorAnchorReport(plugins).missing, ['tool-goal'])
})

test('组内 disabled 的 tool-subagent 也算缺失', () => {
  const plugins = standardLike()
  plugins[2].config[2].disabled = true
  assert.deepEqual(supervisorAnchorReport(plugins).missing, ['tool-subagent'])
})

test('非数组输入一律判为不可承载，不抛错', () => {
  for (const input of [undefined, null, {}, 42, 'x']) {
    const report = supervisorAnchorReport(input)
    assert.equal(report.ok, false)
    assert.deepEqual(report.missing, SUPERVISOR_ANCHOR_IDS)
  }
})

test('delegation 的 config 不是数组时跳过，不把它当组', () => {
  const plugins = [
    { id: 'persona' },
    { id: 'tool-goal' },
    { id: 'delegation', config: { toolSubagent: true } },
  ]
  assert.deepEqual(supervisorAnchorReport(plugins).missing, ['tool-subagent-control', 'tool-subagent'])
})

test('sync 拒绝启用缺锚点的 preset，且一次 update 都不发', async () => {
  const updates = []
  const plugins = minimalLike()
  const entries = [{
    id: 'minimal',
    plugins,
    entry: {
      options: { config: { id: 'minimal', plugins } },
      update: async (patch) => { updates.push(patch) },
    },
  }]
  const result = await syncSupervisedLayer({ entries, wanted: ['minimal'], baselines: new Map(), log: {} })
  assert.equal(updates.length, 0, '拒绝时绝不能碰 loader')
  assert.equal(result.changed.length, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].id, 'minimal')
  assert.match(result.errors[0].error, /tool-goal/)
})

test('sync 仍然接受可承载的 preset（判定不能把 standard 一起挡掉）', async () => {
  const updates = []
  const plugins = standardLike()
  const entries = [{
    id: 'standard',
    plugins,
    entry: {
      options: { config: { id: 'standard', plugins } },
      update: async (patch) => { updates.push(patch) },
    },
  }]
  const result = await syncSupervisedLayer({ entries, wanted: ['standard'], baselines: new Map(), log: {} })
  assert.equal(updates.length, 1)
  assert.deepEqual(result.errors, [])
})

/** 在临时 $DSH_HOME 下写一份 preset 的 composition。 */
function writePresetFixture(yaml) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-anchors-'))
  const dir = join(home, '.agent-presets', 'fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), yaml, 'utf8')
  return home
}

const STANDARD_YAML = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding agent.
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
- id: delegation
  name: cordis:group
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
`

const MINIMAL_YAML = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful software engineer assistant.
    complete: true
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

test('磁盘路径与内存路径用同一条规则：standard 形状可承载', async () => {
  const home = writePresetFixture(STANDARD_YAML)
  const report = await supervisorFileAnchorReport('fixture', home)
  assert.equal(report.ok, true)
  assert.deepEqual(report.missing, [])
})

test('磁盘路径：minimal 形状判为不可承载，并指明缺哪几行', async () => {
  const home = writePresetFixture(MINIMAL_YAML)
  const report = await supervisorFileAnchorReport('fixture', home)
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'anchors')
  assert.deepEqual(report.missing, ['tool-goal', 'tool-subagent-control', 'tool-subagent'])
})

test('文件不存在时如实报告 missing，不当成可承载', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-anchors-empty-'))
  const report = await supervisorFileAnchorReport('nope', home)
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'missing')
})
