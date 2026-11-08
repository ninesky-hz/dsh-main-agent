/**
 * `docs/STATE.md` 的登记表与源码是否对得上。
 *
 * 这张表的用途只有一个：以后谁新增了一个 `.agi/` 状态文件却忘了登记写者，这里
 * 就红。所以它是**双向**的 ——
 *   1. 表里写的写者模块必须存在，而且源码里真的出现那个文件名（不能凭印象填）；
 *   2. 反过来，`lib/*.js` 里出现的每个 `.json` / `.jsonl` / `.md` 状态文件名，都必须
 *      在表里有一行。
 *
 * 刻意不检查「读者」一列：读者随时会增加，增加读者不构成竞态，也不该让测试红。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const STATE_DOC = join(ROOT, 'docs', 'STATE.md')
const LIB = join(ROOT, 'lib')

/** 非 `.agi/` 状态文件；`package.json` 只是被读来判版本，不是状态。 */
const NOT_STATE = new Set(['package.json'])

/** 表格单元格里的反引号只影响阅读，解析时去掉。 */
const untick = cell => cell.replace(/`/g, '').trim()

/**
 * 解析 `docs/STATE.md` 里所有表格行。
 *
 * 只认三列齐全的行，跳过表头与 `| --- |` 分隔行 —— 文档里同时存在「插件写」与
 * 「非插件写」两张表，所以不能只读第一张。
 *
 * @returns {Array<{ file: string, writer: string, readers: string }>}
 */
function rows() {
  const text = readFileSync(STATE_DOC, 'utf8')
  const parsed = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length < 3) continue
    if (cells[0] === '状态文件') continue
    if (/^-{3,}/.test(cells[0].replace(/:/g, ''))) continue
    parsed.push({ file: untick(cells[0]), writer: cells[1] })
  }
  return parsed
}

/** 写者格里出现的 `lib/<name>.js`（`—（worker 自己写）` 这种没有模块，返回空数组）。 */
function modulesOf(cell) {
  const names = []
  for (const match of cell.matchAll(/lib\/([a-z0-9-]+)\.js/g)) names.push(match[1])
  return names
}

/**
 * 文件名该在源码里以什么字符串出现。
 *
 * `loop-state*.json` 这种带通配的名字，源码里只会写具体形状（`loop-state.json`），
 * 所以把 `*` 去掉再比 —— 检查的是「这个模块负责这个文件族」，不是逐字相等。
 */
function stemsOf(file) {
  const base = file.split('/').pop().replace(/\*/g, '')
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return [...new Set([base, stem])]
}

/** 表里的文件名模式（`loop-state*.json`）能否覆盖一个具体文件名。 */
function matches(base, literal) {
  const pattern = base
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .split('\\*')
    .join('[^/]*')
  return new RegExp(`^${pattern}$`).test(literal)
}

test('STATE.md: 每个写者模块都存在，且源码里真的出现这个文件名', () => {
  const parsed = rows()
  assert.ok(parsed.length >= 12, `状态表行数太少，可能解析漏了：${parsed.length}`)

  const checked = []
  for (const row of parsed) {
    const stems = stemsOf(row.file)
    for (const name of modulesOf(row.writer)) {
      const path = join(LIB, `${name}.js`)
      assert.ok(existsSync(path), `${row.file} 登记的写者模块不存在：lib/${name}.js`)
      const source = readFileSync(path, 'utf8')
      assert.ok(
        stems.some(stem => source.includes(stem)),
        `lib/${name}.js 里找不到 ${row.file} 的字面量（应含 ${stems.join(' 或 ')}）`,
      )
      checked.push(`${name} → ${row.file}`)
    }
  }
  // 大部分行都该有真正的写者模块；只有 worker 自己写的几行是 `—`。
  assert.ok(checked.length >= 9, `真正核对过的写者太少，登记表可能写虚了：${checked.length}`)
})

test('STATE.md: lib/*.js 里出现的每个 .agi 状态文件名都登记在表里', () => {
  const bases = rows().map(row => row.file.split('/').pop())
  const found = new Map()
  for (const name of readdirSync(LIB)) {
    if (!name.endsWith('.js')) continue
    const source = readFileSync(join(LIB, name), 'utf8')
    for (const match of source.matchAll(/'([A-Za-z0-9_.-]+\.(?:jsonl|json|md))'/g)) {
      const literal = match[1]
      if (NOT_STATE.has(literal)) continue
      if (!found.has(literal)) found.set(literal, name)
    }
  }
  assert.ok(found.size >= 10, `扫到的状态文件名太少，正则可能失效了：${found.size}`)

  for (const [literal, where] of found) {
    assert.ok(
      bases.some(base => matches(base, literal)),
      `lib/${where} 写了 ${literal}，但 docs/STATE.md 没有登记它`,
    )
  }
})

test('STATE.md: 关键状态文件一个都不能漏登记', () => {
  const bases = rows().map(row => row.file.split('/').pop())
  const required = [
    'loop-state*.json',
    'BRIEF.md',
    'outbox.jsonl',
    'GOAL.md',
    'CHANGELOG.jsonl',
    'progress.jsonl',
    'questions.jsonl',
    'proposals.jsonl',
    'LESSONS.md',
    'outcome.md',
    'report.json',
    'archived.json',
    'checks.json',
    'config.json',
  ]
  for (const name of required) {
    assert.ok(bases.includes(name), `docs/STATE.md 漏了 ${name}`)
  }
})
