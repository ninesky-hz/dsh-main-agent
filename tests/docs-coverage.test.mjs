/**
 * `docs/ARCHITECTURE.md` 的三张表与 `docs/REJECTED.md` 的格式，是不是真的钉住了仓库。
 *
 * 文档最容易烂的方式不是写错，而是**写的时候对、之后再也没人回头**：删了一个模块、
 * 加了一个测试、把某个导出写进测试，文档里的那一行还静静地在那里，读的人相信它。
 * 所以这里不做「文档里提到的名字存在吗」这种单向检查，而是**双向**：
 *
 *   1. `lib/*.js` 的实际文件集合 == 模块表的文件集合（多一个少一个都不行）；
 *   2. `tests/*.test.mjs` 的实际集合 == 测试表的集合；
 *   3. 文档里的相对链接必须能解析（死链比没有链接更贵）；
 *   4. 「未受测导出」表里的名字必须真的是对应文件的导出（删了函数不许留白）；
 *   5. 反向：源码里每个 `export function|const|class` 的名字，要么在某个测试里出现过，
 *      要么在这张表里 —— 否则红，并把漏网的名字列出来；
 *   6. 再反向：表里已经受测的名字必须删掉 —— 这张表只许缩小，不许变成垃圾桶。
 *   7. README 里「N 个 `node --test` 文件」必须等于 `tests/` 的实际个数；断言数
 *      故意不钉 —— 那个数字每加一条测试就漂，而 README 没有任何东西钉得住它。
 *
 * 第 5、6 条合起来才叫棘轮：一边堵住「新增的导出没人管」，一边堵住「登记过的欠账
 * 还清了却不销账」。判据是机械的（名字有没有在 `tests/*.test.mjs` 里出现），不是
 * 「这个人觉得测过了」。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const LIB = join(ROOT, 'lib')
const TESTS = join(ROOT, 'tests')
const DOCS = join(ROOT, 'docs')
const ARCHITECTURE = join(DOCS, 'ARCHITECTURE.md')
const REJECTED = join(DOCS, 'REJECTED.md')

const read = path => readFileSync(path, 'utf8')
const untick = cell => cell.replace(/`/g, '').trim()

/**
 * 取某个二级标题下的表格行。
 *
 * 停在下一个 `## ` 处：三张表各自的单元格语义不同（文件 / 文件 / 名字+文件），
 * 按标题分段解析比「靠首格猜」可靠得多。
 *
 * @param {string} doc 文档全文
 * @param {string} heading 二级标题的文字（不含 `## `）
 * @returns {string[][]} 每行拆好的单元格（已 trim）
 */
function sectionRows(doc, heading) {
  const lines = doc.split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${heading}`)
  assert.notEqual(start, -1, `docs/ARCHITECTURE.md 里找不到二级标题「## ${heading}」`)

  const rows = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(line)) continue
    // 紧跟着分隔行的那一行是表头（markdown 表格的硬规矩），表头不是数据。
    const next = (lines[index + 1] ?? '').trim()
    if (/^\|[\s:|-]+\|$/.test(next)) continue
    rows.push(line.split('|').slice(1, -1).map(cell => cell.trim()))
  }
  return rows
}

/** `lib/` 与 `tests/` 的实际文件集合。 */
const libFiles = () => readdirSync(LIB).filter(file => file.endsWith('.js')).sort()
const testFiles = () => readdirSync(TESTS).filter(file => file.endsWith('.test.mjs')).sort()

/** 每个 `lib/*.js` 导出的名字（`export function` / `export const` / `export class`）。 */
const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
  /export\s+(?:const|let)\s+([A-Za-z0-9_]+)/g,
  /export\s+class\s+([A-Za-z0-9_]+)/g,
]

function exportsByFile() {
  const found = new Map()
  for (const file of libFiles()) {
    const source = read(join(LIB, file))
    const names = []
    for (const pattern of EXPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) names.push(match[1])
    }
    found.set(file, names)
  }
  return found
}

const testText = () => testFiles().map(file => read(join(TESTS, file))).join('\n')
const mentionedInTests = (name, text) => new RegExp(`\\b${name}\\b`).test(text)

test('ARCHITECTURE.md 模块表：与 lib/*.js 的实际文件集合双向相等', () => {
  const rows = sectionRows(read(ARCHITECTURE), '模块表')
  const documented = rows.map(row => untick(row[0]))
  assert.deepEqual(
    [...documented].sort(),
    libFiles(),
    `模块表与 lib/*.js 不一致（缺登记 / 多登记 / 文件名写错）`,
  )
  // 同名重复登记往往意味着复制黏贴时忘改文件名。
  assert.equal(new Set(documented).size, documented.length, '模块表里有重复文件')
  for (const row of rows) {
    assert.ok(row.length >= 4, `${row[0]} 这一行列数不足 4（文件 / 职责 / 主要导出 / 被谁用）`)
    assert.ok(row[1].length > 0 && row[2].length > 0 && row[3].length > 0, `${row[0]} 这一行有空单元格`)
  }
})

test('ARCHITECTURE.md 测试表：与 tests/*.test.mjs 的实际文件集合双向相等', () => {
  const rows = sectionRows(read(ARCHITECTURE), '测试表')
  const documented = rows.map(row => untick(row[0]))
  assert.deepEqual([...documented].sort(), testFiles(), '测试表与 tests/*.test.mjs 不一致')
  assert.equal(new Set(documented).size, documented.length, '测试表里有重复文件')
  for (const row of rows) {
    assert.ok(row[1] && row[1].length > 0, `${row[0]} 没写「覆盖什么」`)
  }
})

test('ARCHITECTURE.md 里的相对链接都能解析', () => {
  const doc = read(ARCHITECTURE)
  const links = [...doc.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1])
  assert.ok(links.length >= 4, `链接太少，正则可能失效了：${links.length}`)

  const broken = []
  for (const target of links) {
    if (/^[a-z]+:/i.test(target)) continue // 外链不归这里管
    const path = resolve(DOCS, target.split('#')[0])
    if (!existsSync(path)) broken.push(`${target}（解析为 ${path}）`)
  }
  assert.deepEqual(broken, [], `docs/ARCHITECTURE.md 里有死链：${broken.join('、')}`)
})

test('ARCHITECTURE.md 未受测导出表：名字真的是那个文件的导出，且只许缩小', () => {
  const rows = sectionRows(read(ARCHITECTURE), '未受测导出（棘轮基线：只许缩小）')
  assert.ok(rows.length >= 1, '未受测导出表是空的 —— 解析失败，或者真的全都受测了（那时删掉这张表）')

  const exported = exportsByFile()
  const text = testText()
  const problems = []
  for (const row of rows) {
    const name = untick(row[0])
    const file = untick(row[1]).replace(/^lib\//, '')
    if (!row[2] || row[2].length === 0) problems.push(`${name} 没写理由`)
    const names = exported.get(file)
    if (!names) problems.push(`${name} 写的文件 lib/${file} 不存在`)
    else if (!names.includes(name)) problems.push(`${name} 不是 lib/${file} 的导出（删了函数忘了销账？）`)
    if (mentionedInTests(name, text)) problems.push(`${name} 已经在测试里出现过了，删掉这一行`)
  }
  assert.deepEqual(problems, [], `未受测导出表有问题：${problems.join('；')}`)
})

test('反向：源码里每个导出名字，要么在测试里出现过，要么在未受测表里', () => {
  const registered = new Set(
    sectionRows(read(ARCHITECTURE), '未受测导出（棘轮基线：只许缩小）').map(row => untick(row[0])),
  )
  const text = testText()
  const strays = []
  for (const [file, names] of exportsByFile()) {
    for (const name of names) {
      if (mentionedInTests(name, text)) continue
      if (registered.has(name)) continue
      strays.push(`${name}（lib/${file}）`)
    }
  }
  assert.deepEqual(
    strays,
    [],
    `这些导出既没有出现在任何 tests/*.test.mjs 里，也没登记进 docs/ARCHITECTURE.md 的未受测导出表：${strays.join('、')}`,
  )
})

test('ARCHITECTURE.md 里的数字是实际值，不是「若干」', () => {
  const doc = read(ARCHITECTURE)
  const exported = exportsByFile()
  const declarations = [...exported.values()].reduce((sum, names) => sum + names.length, 0)
  const uniqueNames = new Set([...exported.values()].flat()).size
  const untested = sectionRows(doc, '未受测导出（棘轮基线：只许缩小）').length

  const expected = [
    `${libFiles().length} 个文件`,
    `${testFiles().length} 个文件`,
    `${testFiles().length} 个 \`*.test.mjs\``,
    `${declarations} 处`,
    `${uniqueNames} 个不同名字`,
    `${untested} 条`,
  ]
  for (const phrase of expected) {
    assert.ok(doc.includes(phrase), `docs/ARCHITECTURE.md 里没写实际值「${phrase}」（数字变了记得同步文档）`)
  }
})

test('README.md 里的测试文件个数是实际值，断言数不许写死', () => {
  const readme = read(join(ROOT, 'README.md'))
  const actual = testFiles().length

  const counts = [
    ...[...readme.matchAll(/(\d+) 个 `node --test` 文件/g)].map(match => Number(match[1])),
    ...[...readme.matchAll(/(\d+) 个 `[^`]*\.test\.mjs`/g)].map(match => Number(match[1])),
  ]
  assert.ok(counts.length >= 1, 'README.md 里找不到「N 个 …test.mjs」—— 正则或措辞改过了')
  const wrong = counts.filter(count => count !== actual)
  assert.deepEqual(wrong, [], `README.md 里写的测试文件个数不是实际值（实际 ${actual} 个）`)

  // 断言数每加一条测试就漂，而 README 没有任何东西钉得住它（`npm test` 每次都会自己打印）。
  // 所以这里查的是「有没有写死」，不是「写得对不对」：两种写法都算写死。
  const hardcoded = [
    ...(readme.match(/\*\*\d+ 项\*\*/g) ?? []),
    ...(readme.match(/\d+ 项断言/g) ?? []),
  ]
  assert.deepEqual(hardcoded, [], `README.md 里又写死了断言数（${hardcoded.join('、')}）——交给 npm test 打印`)
})

test('REJECTED.md：每行三列非空、没有含糊措辞、至少 9 行', () => {
  const rows = sectionRows(read(REJECTED), '清单')
  assert.ok(rows.length >= 9, `否决清单少于 9 行：${rows.length}`)

  const vague = /以后再说|再说吧|TBD|TODO|看情况|等有需要|视情况|待定|暂缓/i
  const problems = []
  for (const row of rows) {
    if (row.length !== 3) {
      problems.push(`${row[0] ?? '?'} 这一行不是三列（实际 ${row.length} 列）`)
      continue
    }
    const [content, reason, condition] = row
    if (!content || !reason || !condition) problems.push(`${content || '?'} 有空单元格`)
    for (const cell of row) {
      if (vague.test(cell)) problems.push(`「${cell.slice(0, 24)}…」里有含糊措辞（重开条件必须可判定）`)
    }
  }
  assert.deepEqual(problems, [], `docs/REJECTED.md 有问题：${problems.join('；')}`)
})
