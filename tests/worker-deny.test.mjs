/**
 * 把 preset 的 worker 工具限制迁到 spawn 侧的 `deny`。
 *
 * 起因：`@deepseek-ai/dsh-tool-subagent` 已经不再接受 `toolFilter` 与
 * `persona`（配置里有就抛错），所以破甲模式改用「生成一个子预设 + agentPreset」
 * 来排除 subagent_fork / workflow / ralph。而监督层会把那一行改名成
 * `dsh-main-agent/spawn`，改名后官方那套迁移就认不出它、不再生成子预设 ——
 * 限制会静默丢掉。所以限制必须有 spawn 侧的落点：`config.deny`。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import YAML from 'yaml'

import { applySupervisorToFile } from '../lib/preset-files.js'
import {
  applySupervisorLayer,
  DEV_AGENT_PERSONA,
  stripSupervisorLayer,
} from '../lib/supervise.js'
import { workerDeniedTools, workerToolFilter, WORKER_DENIED_TOOLS } from '../lib/worker-model-policy.js'

const POJA_DENY = ['subagent_fork', 'workflow', 'ralph']

/** 破甲模式的 tool-subagent 行：旧式 `toolFilter.deny` + `maxDepth: 1`。 */
const pojaLike = () => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '# 工作方式', complete: true } },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: {
          provider: 'spawn',
          toolName: 'subagent',
          modelSelectionSettings: true,
          backgroundMode: 'continuable',
          maxDepth: 1,
          toolFilter: { deny: [...POJA_DENY] },
        },
      },
    ],
  },
]

const spawnRow = (plugins) => plugins.find(row => row.id === 'delegation').config.find(row => row.id === 'tool-subagent')

test('workerDeniedTools 合并两种拼写并去重', () => {
  assert.deepEqual(workerDeniedTools({ deny: ['a'], toolFilter: { deny: ['b', 'a'] } }), ['a', 'b'])
  assert.deepEqual(workerDeniedTools({ deny: ['a'] }), ['a'])
  assert.deepEqual(workerDeniedTools({ toolFilter: { deny: ['b'] } }), ['b'])
  assert.deepEqual(workerDeniedTools(undefined), [])
  assert.deepEqual(workerDeniedTools({ deny: 'not-an-array', toolFilter: { deny: [1, '', null, 'ok'] } }), ['ok'])
})

test('workerToolFilter 在固定项之上加 preset 的额外限制，且去重', () => {
  const filter = workerToolFilter(workerDeniedTools({ deny: ['ralph', ...WORKER_DENIED_TOOLS] }))
  assert.deepEqual(new Set(filter.deny), new Set([...WORKER_DENIED_TOOLS, 'ralph']))
  assert.equal(filter.deny.filter(name => name === 'ask_user_question').length, 1, '固定项不该重复')
  // 每次都是新数组：请求对象之间不能共享可变状态。
  assert.notEqual(workerToolFilter(), workerToolFilter())
})

test('apply 把 toolFilter.deny 复制到 deny，同时保留旧字段供 strip 识别', () => {
  const supervised = applySupervisorLayer(pojaLike())
  const row = spawnRow(supervised)

  assert.equal(row.name, 'dsh-main-agent/spawn')
  assert.deepEqual(row.config.deny, POJA_DENY, '限制必须落到 spawn 认识的位置')
  assert.deepEqual(row.config.toolFilter.deny, POJA_DENY, '旧字段要留着，否则 strip 认不出这是自己写的')
  assert.equal(row.config.persona, DEV_AGENT_PERSONA)
  assert.equal(row.config.maxDepth, 1, 'maxDepth 原样保留')
})

test('strip 自足回滚：删掉 deny，其余与原样一致（不需要 baseline）', () => {
  const original = pojaLike()
  const back = stripSupervisorLayer(applySupervisorLayer(original))

  assert.equal(spawnRow(back).name, '@deepseek-ai/dsh-tool-subagent')
  assert.equal(spawnRow(back).config.deny, undefined, '迁移出来的 deny 必须删掉')
  assert.deepEqual(spawnRow(back).config.toolFilter.deny, POJA_DENY, '原来的 toolFilter 不能被碰')
  assert.deepEqual(back, original, '往返必须结构一致')
})

test('strip 不删用户自己的 deny：没有 toolFilter.deny 就不是我们加的', () => {
  const plugins = [{
    id: 'delegation',
    name: 'cordis:group',
    config: [{
      id: 'tool-subagent',
      name: 'dsh-main-agent/spawn',
      config: { deny: ['my-own-tool'], persona: DEV_AGENT_PERSONA },
    }],
  }]
  const back = stripSupervisorLayer(plugins)
  const row = back[0].config[0]

  assert.deepEqual(row.config.deny, ['my-own-tool'], '用户自己写的 deny 必须留下')
  assert.equal(row.config.persona, undefined)
  assert.equal(row.name, '@deepseek-ai/dsh-tool-subagent')
})

test('apply 幂等：已有 deny 时不会翻倍', () => {
  const once = applySupervisorLayer(pojaLike())
  const twice = applySupervisorLayer(once)
  assert.deepEqual(spawnRow(twice).config.deny, POJA_DENY)
})

test('磁盘路径同样把 toolFilter.deny 提升为 deny', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-worker-deny-'))
  const dir = join(home, '.agent-presets', 'poja')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: '# 工作方式'
    complete: true
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
- id: delegation
  name: cordis:group
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        maxDepth: 1
        toolFilter:
          deny:
            - subagent_fork
            - workflow
            - ralph
`, 'utf8')

  const outcome = await applySupervisorToFile('poja', home)
  assert.equal(outcome.ok, true)

  const written = YAML.parse(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8'))
  const delegation = written.find(row => row.id === 'delegation')
  const row = delegation.config.find(child => child.id === 'tool-subagent')

  assert.equal(row.name, 'dsh-main-agent/spawn')
  assert.deepEqual(row.config.deny, POJA_DENY)
  assert.deepEqual(row.config.toolFilter.deny, POJA_DENY, '旧字段原样保留')
  assert.equal(row.config.maxDepth, 1)
})
