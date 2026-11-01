/**
 * 守住两件 0.2.x 的硬约束（它们坏了不会有报错，只会让 preset
 * 在 agent-preset roster 里变成 broken，从而在选择器中直接消失）：
 *
 *  1. preset 必须通过 bundle patch 里的声明行注册 ——
 *     `dsh-agent-preset` + `config.plugins`；生成物必须与
 *     `agent-presets/main-agent/` 下的源文件保持同步。
 *  2. `dsh-persona` 的 `prefix` 是必填字段，旧版 `text:` 字段
 *     在 0.2.x 会让整行加载失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parsePresetYml, renderPresetPatch } from '../scripts/sync-preset-patch.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_DIR = join(ROOT, 'agent-presets', 'main-agent')

const read = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '')

function sourceInputs() {
  const { name, description } = parsePresetYml(read(join(PRESET_DIR, 'preset.yml')))
  const composition = read(join(PRESET_DIR, 'agent.cordis.yml')).replace(/\n+$/, '')
  return { name, description, composition }
}

test('presets/main-agent.patch.yml 与预设源文件保持同步', () => {
  const { name, description, composition } = sourceInputs()
  const expected = renderPresetPatch({ name, description, composition })
  const actual = read(join(ROOT, 'presets', 'main-agent.patch.yml'))
  // 文件头第一行 `# prompt-revision: ...` 由 `scripts/sync-prompts.mjs --stamp`
  // 在生成之后盖上去，不属于 renderPresetPatch 的产出 —— 这里只比对生成正文。
  const body = actual.replace(/^# prompt-revision: .*\n/, '')
  assert.equal(body, expected, '生成物过期：请运行 `npm run sync-preset` 后提交')
})

test('bundle patch 清单只有 host 层与 preset 声明，不再挂 schedule 层', () => {
  const manifest = JSON.parse(read(join(ROOT, 'package.json')))
  const patch = manifest.dsh?.bundle?.patch
  assert.ok(Array.isArray(patch), 'dsh.bundle.patch 应当是文件路径数组')
  assert.deepEqual(patch, ['./cordis.patch.yml', './presets/main-agent.patch.yml'])
  assert.ok(
    !patch.some((file) => file.includes('schedule')),
    'schedule 服务由 dsh-web-app 在 host 层统一提供，重复挂载必抛 service "schedule" has been registered',
  )
  for (const file of patch) read(join(ROOT, file))
})

test('声明行把 main-agent 注册为 @deepseek-ai/dsh-agent-preset', () => {
  const patch = read(join(ROOT, 'presets', 'main-agent.patch.yml'))
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(patch, /id: main-agent/)
  assert.match(patch, /plugins:/)
})

test('persona 行使用 0.2.x 的 prefix 契约，而不是旧的 text', () => {
  const composition = read(join(PRESET_DIR, 'agent.cordis.yml'))
  const persona = /- id: persona\n(?:.*\n)*?    - id: /m.exec(composition)
  assert.ok(persona, '未找到 persona 行')
  assert.ok(!/^\s{4}text: /m.test(persona[0]), 'dsh-persona 不再接受 text 字段')
  assert.match(persona[0], /^\s{4}prefix: \|-?/m, 'dsh-persona 的 prefix 是必填字段')
})

test('workflow 引擎行不指向 0.2.x 中不存在的包', () => {
  const composition = read(join(PRESET_DIR, 'agent.cordis.yml'))
  const lines = composition.split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^\s*- id: (\S+)/.exec(lines[index])
    if (!start) continue
    let end = index + 1
    while (end < lines.length && !/^\s*- id: /.test(lines[end])) end += 1
    rows.push({ id: start[1], text: lines.slice(index, end).join('\n') })
  }
  const workflows = rows.filter((row) => row.text.includes('@deepseek-ai/dsh-workflow'))
  assert.ok(workflows.length > 0, '未找到 workflow 引擎行')
  const enabled = workflows.filter((row) => !/disabled: true/.test(row.text))
  assert.deepEqual(
    enabled.map((row) => row.id),
    ['workflow-engine'],
    '唯一启用的 workflow 引擎行应当是 0.2.x 里存在的包',
  )
  assert.match(enabled[0].text, /name: '@deepseek-ai\/dsh-workflow-ptc'/)
  // 上游写过的 worker-thread 包在 0.2.x 不存在：只允许以 disabled 行保留。
  for (const row of workflows) {
    if (!row.text.includes('@deepseek-ai/dsh-workflow-worker-thread')) continue
    assert.match(row.text, /disabled: true/, `${row.id} 行必须 disabled: true`)
  }
})
