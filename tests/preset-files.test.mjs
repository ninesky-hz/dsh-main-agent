/**
 * Composition-file fallback: presets registered straight into the registry have
 * no loader row, so the supervisor layer is written into their
 * `agent.cordis.yml` instead. These tests drive that path against a fixture in
 * a temp directory — the real presets are never touched.
 *
 * The `yaml` package resolves from the profile's node_modules, so this file
 * skips itself when it is not reachable (a bare checkout has no node_modules).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applySupervisorToFile,
  countSupervisorNodes,
  hasSupervisorBackup,
  presetFile,
  stripSupervisorFromFile,
} from '../lib/preset-files.js'

let YAML = null
try {
  YAML = (await import('yaml')).default
} catch {
  YAML = null
}

const FIXTURE = `# 手工维护的 composition，注释必须活下来
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    # 新版 dsh-persona 用 prefix/suffix 取代了旧的 text 字段
    prefix: |-
      你原本的人格。
      第二行。
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
- id: tool-subagent-control
  name: '@deepseek-ai/dsh-tool-subagent-control'
- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: !!js process.platform === 'win32'
`

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-supervise-'))
  mkdirSync(join(home, '.agent-presets', 'demo'), { recursive: true })
  writeFileSync(presetFile('demo', home), FIXTURE, 'utf8')
  return home
}

function readRows(home) {
  const doc = YAML.parseDocument(readFileSync(presetFile('demo', home), 'utf8'))
  return { doc, rows: doc.contents.items }
}

function names(rows) {
  const flat = []
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (typeof node?.get !== 'function') continue
      flat.push(node)
      const config = node.get('config', true)
      if (Array.isArray(config?.items)) walk(config.items)
    }
  }
  walk(rows)
  const name = (id) => flat.find((row) => row.get('id') === id)?.get('name')
  return { goal: name('tool-goal'), control: name('tool-subagent-control'), spawn: name('tool-subagent') }
}

test('a preset without a composition file reports it instead of throwing', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = mkdtempSync(join(tmpdir(), 'dsh-supervise-'))
  try {
    const result = await applySupervisorToFile('nope', home)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing')
    assert.equal(result.changed, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('apply rewrites all three rows, appends the persona, and adds the schedule row', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    assert.equal(countSupervisorNodes(readRows(home).rows), 0)
    const result = await applySupervisorToFile('demo', home)
    assert.equal(result.changed, true)
    assert.equal(hasSupervisorBackup('demo', home), true)

    const { rows } = readRows(home)
    assert.deepEqual(names(rows), {
      goal: 'dsh-main-agent/goal',
      control: 'dsh-main-agent/control',
      spawn: 'dsh-main-agent/spawn',
    })
    assert.equal(countSupervisorNodes(rows), 3)

    const persona = rows.find((row) => row.get('id') === 'persona')
    const prefix = persona.get('config', true).get('prefix')
    // The existing persona survives; the supervisor text is appended after it.
    assert.match(prefix, /你原本的人格/)
    assert.match(prefix, /常驻监督者/)
    assert.ok(prefix.indexOf('你原本的人格') < prefix.indexOf('常驻监督者'))

    assert.equal(rows.some((row) => row.get('id') === 'tool-schedule'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('apply keeps the !!js tag and the comments', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    await applySupervisorToFile('demo', home)
    const text = readFileSync(presetFile('demo', home), 'utf8')
    assert.equal(text.includes('!!js process.platform'), true)
    assert.match(text, /# 手工维护的 composition/)
    assert.match(text, /# 新版 dsh-persona 用 prefix\/suffix/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a second apply is a byte-level no-op', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    await applySupervisorToFile('demo', home)
    const once = readFileSync(presetFile('demo', home), 'utf8')
    const again = await applySupervisorToFile('demo', home)
    assert.equal(again.changed, false)
    assert.equal(readFileSync(presetFile('demo', home), 'utf8'), once)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('strip restores the original bytes and drops the backup', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    await applySupervisorToFile('demo', home)
    const result = await stripSupervisorFromFile('demo', home)
    assert.equal(result.changed, true)
    assert.equal(readFileSync(presetFile('demo', home), 'utf8'), FIXTURE)
    assert.equal(hasSupervisorBackup('demo', home), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('strip without a backup leaves the file alone', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    const result = await stripSupervisorFromFile('demo', home)
    assert.equal(result.changed, false)
    assert.equal(readFileSync(presetFile('demo', home), 'utf8'), FIXTURE)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a malformed composition is reported, not overwritten', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = mkdtempSync(join(tmpdir(), 'dsh-supervise-'))
  try {
    mkdirSync(join(home, '.agent-presets', 'demo'), { recursive: true })
    writeFileSync(presetFile('demo', home), 'id: not-a-list\n', 'utf8')
    const result = await applySupervisorToFile('demo', home)
    assert.equal(result.ok, false)
    assert.equal(result.changed, false)
    assert.equal(readFileSync(presetFile('demo', home), 'utf8'), 'id: not-a-list\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// 升级后的原文：同一份骨架，人格换了一版 —— 模拟 `dsh-poja` 用打包模板整份覆盖
// 它自己的 managed preset。
const UPDATED_FIXTURE = FIXTURE.replace('你原本的人格。', '更新后的人格。')

test('备份随被替换的原文一起刷新，取消勾选不会回退这次更新', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    const file = presetFile('demo', home)
    const backup = file + '.supervisor.bak'
    await applySupervisorToFile('demo', home)
    assert.equal(readFileSync(backup, 'utf8'), FIXTURE)

    // 声明它的插件把整份文件换掉：叠加层随之消失，磁盘上已经是新原文。
    writeFileSync(file, UPDATED_FIXTURE, 'utf8')

    const again = await applySupervisorToFile('demo', home)
    assert.equal(again.ok, true)
    assert.equal(again.changed, true)
    // 备份换成了新原文，而不是停在上一版 —— 否则「取消勾选」会静默回退这次升级。
    assert.equal(readFileSync(backup, 'utf8'), UPDATED_FIXTURE)

    const stripped = await stripSupervisorFromFile('demo', home)
    assert.equal(stripped.changed, true)
    assert.equal(readFileSync(file, 'utf8'), UPDATED_FIXTURE)
    assert.equal(hasSupervisorBackup('demo', home), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('文件被整份替换后取消勾选：不动磁盘，只丢过期备份', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    const file = presetFile('demo', home)
    await applySupervisorToFile('demo', home)
    // 覆盖发生在下一次 apply 之前：用户此刻直接取消勾选。
    writeFileSync(file, UPDATED_FIXTURE, 'utf8')

    const stripped = await stripSupervisorFromFile('demo', home)
    assert.equal(stripped.changed, false)
    assert.equal(readFileSync(file, 'utf8'), UPDATED_FIXTURE)
    assert.equal(hasSupervisorBackup('demo', home), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('文件读不动时仍然用备份修复', async (t) => {
  if (!YAML) return t.skip('yaml 不可解析（未安装 node_modules）')
  const home = makeHome()
  try {
    const file = presetFile('demo', home)
    await applySupervisorToFile('demo', home)
    // 不是合法 composition：判断不了它带不带层，只能走还原。
    writeFileSync(file, '\u0000not: [valid\n', 'utf8')
    const stripped = await stripSupervisorFromFile('demo', home)
    assert.equal(stripped.changed, true)
    assert.equal(readFileSync(file, 'utf8'), FIXTURE)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
