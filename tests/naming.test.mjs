/**
 * `docs/NAMING.md` 的四类动词与例外表是不是真的钉住了源码。
 *
 * 命名纪律的难点从来不是「定一套规则」，而是「定完之后代码还是不听」。所以这里
 * 做成棘轮：`lib/*.js` 里每个 `export function` 的首词都必须在允许动词里，或者它
 * 的名字出现在例外表里。
 *
 * **白名单的源是 `VERB_CLASSES` 这个常量，不是文档。** 反过来写过一版（从
 * `docs/NAMING.md` 的表格里读动词），结果这条棘轮形同虚设：谁都可以往文档表里
 * 加一个动词，然后不合规的函数立刻合规 —— 校验规则和被校验对象共用同一个可变
 * 输入。现在方向是「代码是源，文档必须一致」：常量决定放不放行，文档表格只剩
 * 给人读的用途，两边**双向相等**（多一个少一个都红）。
 *
 * 例外表因此变成一笔明账：
 *   1. 新函数不合规却没登记 → 红（不许悄悄往表里加人，也不许视而不见）；
 *   2. 表里留着的名字在源码里已经不存在 → 红（删了函数不删行，表就烂了）；
 *   3. 表必须按字母序、无重复 —— 否则「是否已登记」只能靠肉眼。
 *
 * 本批刻意不改名（193 个导出里 86 个函数不合格，重命名是跨一万行的改造），所以
 * 这张表一开始就很长。它的用法是减法：改到哪个函数就删哪一行。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const LIB = join(ROOT, 'lib')
const NAMING_DOC = join(ROOT, 'docs', 'NAMING.md')

/**
 * 允许动词的唯一口径 —— 四类动词表。
 *
 * 改这里就是改规则：新增一个动词意味着愿意让所有以它开头的函数出现在 `lib/` 里，
 * 而不只是「让眼前这个不合规的函数过掉」。改完必须同步 `docs/NAMING.md` 的表格，
 * 否则下面的双向相等断言会红。
 *
 * 分类的含义（许可范围从小到大）：
 *   - 纯读：不产生任何可观测影响，可以随便调、可以重试；
 *   - 幂等写：写，但同样的输入再来一次不会多出一份；
 *   - 追加事实：只往里加，不改也不删已经落盘的东西；
 *   - 可被拒：会失败并明确告诉调用方（设置没开、名字不合法、前置条件不满足）。
 */
const VERB_CLASSES = {
  纯读: [
    'read',
    'list',
    'find',
    'get',
    'has',
    'is',
    'count',
    'parse',
    'render',
    'format',
    'derive',
    'resolve',
    'collect',
    'compare',
    'sort',
    'filter',
  ],
  幂等写: ['ensure', 'apply', 'sync', 'write'],
  追加事实: ['record', 'mark', 'append'],
  可被拒: ['request', 'dispatch', 'require', 'reject'],
}

/** 例外表所属的小标题；四类动词表用的是四个类别名，靠它区分两张表。 */
const CATEGORIES = new Set(Object.keys(VERB_CLASSES))

const untick = cell => cell.replace(/`/g, '').trim()

/**
 * 解析 `docs/NAMING.md` 的所有表格行（保留原始单元格，两张表靠首格识别）。
 *
 * @returns {Array<{ cells: string[], line: string }>}
 */
function docTableRows() {
  const text = readFileSync(NAMING_DOC, 'utf8')
  const parsed = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length < 3) continue
    if (/^-{3,}/.test(cells[0].replace(/:/g, ''))) continue
    parsed.push({ cells, line: trimmed })
  }
  return parsed
}

/** 放行用的动词集合：来自常量，与文档无关。 */
function allowedVerbs() {
  return new Set(Object.values(VERB_CLASSES).flat())
}

/** 文档的动词表，按类别解析出来 —— 只用于和常量双向核对，不参与放行。 */
function docVerbs() {
  const byCategory = new Map()
  for (const row of docTableRows()) {
    if (!CATEGORIES.has(row.cells[0])) continue
    const verbs = [...row.cells[1].matchAll(/`([a-z]+)`/g)].map(match => match[1])
    byCategory.set(row.cells[0], verbs)
  }
  return byCategory
}

/** 例外表：首格是反引号包着的函数名。 */
function exceptions() {
  return docTableRows()
    .filter(row => row.cells[0].startsWith('`'))
    .map(row => ({ name: untick(row.cells[0]), group: untick(row.cells[1]) }))
}

/** `lib/*.js` 里所有导出的函数名（含 `export async function`）。 */
function exportedFunctions() {
  const found = new Map()
  for (const file of readdirSync(LIB)) {
    if (!file.endsWith('.js')) continue
    const source = readFileSync(join(LIB, file), 'utf8')
    for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g)) {
      if (!found.has(match[1])) found.set(match[1], file)
    }
  }
  return found
}

/** 驼峰首词：`listToolsFor` → `list`。 */
const firstWordOf = name => (name.match(/^[a-z]+/) || [''])[0]

test('NAMING.md: 四类动词表的常量与文档双向相等', () => {
  const verbs = allowedVerbs()
  assert.ok(verbs.size >= 27, `允许动词太少，常量可能被删坏了：${verbs.size}`)
  for (const verb of ['read', 'list', 'get', 'parse', 'render', 'write', 'ensure', 'record', 'mark', 'request', 'reject']) {
    assert.ok(verbs.has(verb), `四类动词表里缺 ${verb}`)
  }

  // 同一类里重复写两个一样的动词，会让「常量 vs 文档」的比对变得不可信。
  let counted = 0
  for (const [category, list] of Object.entries(VERB_CLASSES)) {
    assert.equal(new Set(list).size, list.length, `VERB_CLASSES.${category} 里有重复动词`)
    counted += list.length
  }
  assert.equal(counted, verbs.size, '同一个动词被放进了两个类别')

  const doc = docVerbs()
  assert.deepEqual([...doc.keys()].sort(), [...CATEGORIES].sort(), 'docs/NAMING.md 少了某一类动词表')

  for (const [category, expected] of Object.entries(VERB_CLASSES)) {
    const actual = doc.get(category) ?? []
    assert.equal(new Set(actual).size, actual.length, `docs/NAMING.md 的「${category}」里有重复动词`)
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `docs/NAMING.md 的「${category}」与 tests/naming.test.mjs 的 VERB_CLASSES 不一致（多一个少一个都不行）`,
    )
  }
})

test('NAMING.md: 每个 export function 都用四类动词开头，或在例外表里', () => {
  const verbs = allowedVerbs()
  const declared = new Set(exceptions().map(row => row.name))
  const exported = exportedFunctions()
  assert.ok(exported.size >= 120, `扫到的导出函数太少，正则可能失效了：${exported.size}`)

  const offenders = []
  for (const [name, file] of exported) {
    if (declared.has(name)) continue
    if (verbs.has(firstWordOf(name))) continue
    offenders.push(`${name}（lib/${file}，首词 ${firstWordOf(name) || '空'}）`)
  }
  assert.deepEqual(
    offenders,
    [],
    `这些导出函数的首词不在四类动词里，也没登记进 docs/NAMING.md 的例外表：${offenders.join('、')}`,
  )
})

test('NAMING.md: 例外表里的名字必须真的还在源码里', () => {
  const exported = exportedFunctions()
  const stale = exceptions()
    .map(row => row.name)
    .filter(name => !exported.has(name))
  assert.deepEqual(stale, [], `例外表里这些名字在 lib/*.js 里已经不存在了，删掉对应的行：${stale.join('、')}`)
})

test('NAMING.md: 例外表按字母序、无重复、组别合法', () => {
  const rows = exceptions()
  assert.ok(rows.length >= 50, `例外表行数太少，解析可能漏了：${rows.length}`)

  const names = rows.map(row => row.name)
  assert.equal(new Set(names).size, names.length, `例外表里有重复行：${[...new Set(names.filter((n, i) => names.indexOf(n) !== i))].join('、')}`)

  const sorted = [...names].sort()
  const firstWrong = names.findIndex((name, index) => name !== sorted[index])
  assert.equal(firstWrong, -1, `例外表没按字母序：第 ${firstWrong + 1} 行是 ${names[firstWrong]}，按序应当是 ${sorted[firstWrong]}`)

  for (const row of rows) {
    assert.ok(['A', 'B', 'C'].includes(row.group), `${row.name} 的组别 ${row.group} 不是 A/B/C`)
  }
})
