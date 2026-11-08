/**
 * 「谁能用哪些工具」的正面清单有没有和代码对上。
 *
 * `lib/tool-inventory.js` 是数据，`docs/TOOLS.md` 是给人看的同一份数据，
 * `lib/*.js` 里的 `defineTool({ name })` 是事实来源。三者任意两个漂移都该红 ——
 * 尤其是「新加了工具却没登记角色」：那正是这张表要防的事，也是过去只能靠记忆的
 * 那件事（反面清单 `WORKER_DENIED_TOOLS` 回答不了「新工具默认归谁」）。
 *
 * 这里还钉住 `lib/worker-model-policy.js` 的 `WORKER_DENIED_TOOLS`：它列的每个名字
 * 在表里必须是 `denied`，而且绝不出现在 `toolsFor('worker')` 里 —— 执行面与文档面
 * 不许各说各的。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ROLES, TOOL_MATRIX, toolsFor } from '../lib/tool-inventory.js'
import { WORKER_DENIED_TOOLS } from '../lib/worker-model-policy.js'

const ROOT = process.cwd()
const LIB = join(ROOT, 'lib')
const TOOLS_DOC = join(ROOT, 'docs', 'TOOLS.md')

/** 表格单元格里的反引号只影响阅读，解析时去掉。 */
const untick = cell => cell.replace(/`/g, '').trim()

/**
 * 解析 `docs/TOOLS.md` 的表格行。
 *
 * 只认三列齐全、且不是表头的行 —— 文档开头还有一段说明文字，不能整篇当表读。
 *
 * @returns {Array<{ name: string, role: string }>}
 */
function docRows() {
  const text = readFileSync(TOOLS_DOC, 'utf8')
  const parsed = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length < 3) continue
    if (cells[0] === '工具') continue
    if (/^-{3,}/.test(cells[0].replace(/:/g, ''))) continue
    parsed.push({ name: untick(cells[0]), role: untick(cells[1]) })
  }
  return parsed
}

/**
 * `lib/*.js` 里真正注册的工具名。
 *
 * 两种写法都要抓：
 *   1. `defineTool({ name: 'x' })` —— 大多是字面量；
 *   2. `defineTool({ name: toolName })` —— `lib/spawn.js` 用配置里的名字，
 *      字面量只出现在 `Config` 的 default 里。抓不到这类就等于放行「登记表里
 *      没有 subagent」，所以顺着 default 把它取出来。
 *
 * @returns {Set<string>}
 */
function registeredNames() {
  const names = new Set()
  for (const file of readdirSync(LIB)) {
    if (!file.endsWith('.js')) continue
    const source = readFileSync(join(LIB, file), 'utf8')
    for (const match of source.matchAll(/defineTool\(\{\s*name:\s*'([^']+)'/g)) {
      names.add(match[1])
    }
    if (/defineTool\(\{\s*name:\s*toolName\b/.test(source)) {
      const declared = source.match(/toolName:\s*z\.string\(\)\.default\('([^']+)'\)/)
      assert.ok(declared, `lib/${file} 用变量注册工具，但找不到 Config 里 toolName 的默认值`)
      names.add(declared[1])
    }
  }
  return names
}

test('TOOLS.md: 表格与 TOOL_MATRIX 双向相等（名字与角色都一致）', () => {
  const doc = docRows()
  assert.ok(doc.length >= 9, `TOOLS.md 表格行数太少，可能解析漏了：${doc.length}`)

  const fromDoc = new Map(doc.map(row => [row.name, row.role]))
  const fromMatrix = new Map(TOOL_MATRIX.map(row => [row.name, row.role]))

  for (const [name, role] of fromMatrix) {
    assert.ok(fromDoc.has(name), `TOOL_MATRIX 有 ${name}，但 docs/TOOLS.md 没有这一行`)
    assert.equal(fromDoc.get(name), role, `${name} 的角色不一致：表里是 ${fromDoc.get(name)}，代码里是 ${role}`)
  }
  for (const [name, role] of fromDoc) {
    assert.ok(fromMatrix.has(name), `docs/TOOLS.md 列了 ${name}，但 TOOL_MATRIX 没有它`)
    assert.equal(fromMatrix.get(name), role, `${name} 在 TOOL_MATRIX 里的角色是 ${fromMatrix.get(name)}，表里写的是 ${role}`)
  }

  for (const row of TOOL_MATRIX) {
    assert.ok(ROLES.includes(row.role), `${row.name} 的角色 ${row.role} 不在 ROLES 里`)
    assert.equal(typeof row.reason, 'string', `${row.name} 缺一行理由`)
    assert.ok(row.reason.trim().length >= 10, `${row.name} 的理由太短，等于没写为什么`)
  }

  assert.equal(doc.length, TOOL_MATRIX.length, '表格行数与 TOOL_MATRIX 长度不一致')
})

test('TOOLS.md: 每个真实注册的工具都登记了角色', () => {
  const registered = registeredNames()
  assert.ok(registered.size >= 8, `扫到的工具太少，正则可能失效了：${[...registered].join(',')}`)

  const declared = new Set(TOOL_MATRIX.map(row => row.name))
  const missing = [...registered].filter(name => !declared.has(name))
  assert.deepEqual(missing, [], `这些工具真的注册了，但 TOOL_MATRIX 没有登记角色：${missing.join(', ')}`)

  const ghosts = [...declared].filter(name => !registered.has(name) && !WORKER_DENIED_TOOLS.includes(name))
  assert.deepEqual(
    ghosts,
    [],
    `TOOL_MATRIX 登记了这些名字，但 lib/*.js 里找不到对应的 defineTool：${ghosts.join(', ')}`,
  )
})

test('TOOLS.md: WORKER_DENIED_TOOLS 在执行面和文档面都成立', () => {
  const byName = new Map(TOOL_MATRIX.map(row => [row.name, row.role]))
  const workerTools = toolsFor('worker')

  for (const name of WORKER_DENIED_TOOLS) {
    assert.equal(byName.get(name), 'denied', `${name} 在 WORKER_DENIED_TOOLS 里，但表里登记的角色是 ${byName.get(name)}`)
    assert.ok(!workerTools.includes(name), `WORKER_DENIED_TOOLS 里的 ${name} 竟然出现在 toolsFor('worker') 里`)
  }
  assert.ok(WORKER_DENIED_TOOLS.length >= 1, 'WORKER_DENIED_TOOLS 空了，这个断言就没意义了')
})

test('TOOLS.md: lead 的工具面覆盖真实的监督工具', () => {
  const lead = toolsFor('lead')
  assert.ok(lead.length >= 8, `lead 的工具太少：${lead.join(', ')}`)

  // 用扫到的真实名字断言，而不是硬编码一份可能过期的名单。
  const registered = registeredNames()
  for (const name of ['check_outcome', 'list_agents', 'subagent']) {
    assert.ok(registered.has(name), `lib/*.js 里没有注册 ${name}，这个断言的基准已经过期`)
    assert.ok(lead.includes(name), `lead 的工具面里缺 ${name}`)
  }

  for (const row of TOOL_MATRIX) {
    assert.ok(row.role === 'denied' || lead.includes(row.name), `${row.name} 应该由 lead 使用，但它不在 toolsFor('lead') 里`)
  }

  assert.deepEqual(toolsFor('nobody'), [], '未知角色应返回空数组，不抛错')
})
