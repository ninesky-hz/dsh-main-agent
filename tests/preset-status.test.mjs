/**
 * `GET /supervisor/presets` 的开关状态字段。
 *
 * 背景（0.19.2 的真实误报）：红队模式与破甲模式都是**直接注册进 registry** 的
 * preset，没有 loader 行。给它们开监督层时，宿主既写 composition 文件
 * （`agent.cordis.yml` + `.supervisor.bak`），也用 `remountPreset` 就地替换
 * registry 记录 —— 新会话立刻读到监督层，不需要重启。
 *
 * 但 `pendingRestart` 原来只判 `plugins === undefined && hasSupervisorBackup(id)`：
 * 备份存在就等于「写了盘」，于是这两个**已经挂载生效**的 preset 一直被告知
 * 「已写入磁盘，需要重启 DSH 才生效」。卡片按 `mounted` 优先取值，所以可见文案
 * 没错，可这条字段本身是错的 —— 任何按它判断的调用方都会读错。
 *
 * 现在的规则：`pendingRestart` 只在**没有 loader 行、且 registry 记录不是监督态**
 * 时才为真，也就是「写盘了但没能挂上」，那才真的只能等下次启动。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./harness-stub-loader.js', import.meta.url)

const { presetsHandler } = await import('../lib/index.js')

/** composition 里有全部锚点行，所以 stackable 为真（与 poja/redteam 同形）。 */
const STANDARD_YAML = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: 你是破甲模式。
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
`

/** registry 里已经换好的监督层（`remountPreset` 的产物）。 */
const SUPERVISED_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'x', complete: true } },
  { id: 'tool-goal', name: 'dsh-main-agent/goal' },
  {
    id: 'delegation',
    name: 'cordis:group',
    config: [
      { id: 'tool-subagent-control', name: 'dsh-main-agent/control' },
      { id: 'tool-subagent', name: 'dsh-main-agent/spawn' },
    ],
  },
]

const PRISTINE_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'x', complete: true } },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
]

/** 一份临时 `$DSH_HOME`，里面躺着一个 file-backed preset。
 *  优先用系统临时目录；某些 Windows 主机禁写 `%TEMP%`（EPERM），退回包内。 */
function fixtureHome(id, { backup = true } = {}) {
  let home
  try {
    home = mkdtempSync(join(tmpdir(), 'dsh-preset-status-'))
  } catch {
    home = mkdtempSync(join(process.cwd(), '.tmp-preset-status-'))
  }
  const dir = join(home, '.agent-presets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), STANDARD_YAML, 'utf8')
  if (backup) writeFileSync(join(dir, 'agent.cordis.yml.supervisor.bak'), 'pristine\n', 'utf8')
  return home
}

/** 无 loader 行的 ctx：preset 只能走文件 + registry 这条路。 */
function fileBackedCtx(id, plugins) {
  const registry = {
    list: async () => [{ id, name: id, order: 10 }],
    definitions: new Map([[id, { id, config: { plugins } }]]),
  }
  return {
    get: name => (name === 'agentPresets' ? registry : undefined),
    loader: { entries: () => [] },
  }
}

async function readPresets(ctx, config = { supervisedPresets: ['fixture'] }) {
  return new Promise((resolve, reject) => {
    const res = {
      status: undefined,
      body: undefined,
      writeHead(status) { this.status = status; return this },
      end(payload) {
        try {
          this.body = payload === undefined ? undefined : JSON.parse(payload)
        } catch (error) {
          reject(error)
          return
        }
        resolve({ status: this.status, body: this.body })
      },
    }
    presetsHandler(ctx, { method: 'GET' }, res, { config }).catch(reject)
  })
}

/** 包一层 `$DSH_HOME`，测试结束还原并删掉临时目录，避免碰到用户真实的 preset 目录。 */
async function withHome(home, run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言：临时目录留着也无害。
    }
  }
}

test('已挂载的 file-backed preset 不再宣称需要重启', async () => {
  const home = fixtureHome('fixture')
  const { body } = await withHome(home, () => readPresets(fileBackedCtx('fixture', SUPERVISED_PLUGINS)))
  const preset = body.presets[0]
  assert.equal(preset.supervised, true)
  assert.equal(preset.mounted, true)
  assert.equal(preset.fileBacked, true)
  assert.equal(preset.pendingRestart, false, '挂上去了就不是「需要重启」')
})

test('写盘了但 registry 记录不是监督态，才如实要求重启', async () => {
  const home = fixtureHome('fixture')
  const { body } = await withHome(home, () => readPresets(fileBackedCtx('fixture', PRISTINE_PLUGINS)))
  const preset = body.presets[0]
  assert.equal(preset.mounted, false)
  assert.equal(preset.pendingRestart, true)
})

test('读不到 registry 记录时按「需要重启」处理，不假装已生效', async () => {
  const home = fixtureHome('fixture')
  const ctx = {
    get: () => ({ list: async () => [{ id: 'fixture', name: 'fixture' }] }),
    loader: { entries: () => [] },
  }
  const { body } = await withHome(home, () => readPresets(ctx))
  const preset = body.presets[0]
  assert.equal(preset.fileBacked, true)
  assert.equal(preset.mounted, undefined)
  assert.equal(preset.pendingRestart, true)
})

test('从未写过盘的 file-backed preset 既不需要重启也不算已挂载', async () => {
  const home = fixtureHome('fixture', { backup: false })
  const { body } = await withHome(home, () => readPresets(fileBackedCtx('fixture', PRISTINE_PLUGINS), { supervisedPresets: [] }))
  const preset = body.presets[0]
  assert.equal(preset.pendingRestart, false)
  assert.equal(preset.mounted, false)
})
