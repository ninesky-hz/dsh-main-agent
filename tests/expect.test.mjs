/**
 * 派发时写死的验收契约：`expect.json` 的读写与覆盖判定。
 *
 * 这个东西存在的理由：worker 的 checks.json 是它自己写的，所以「全绿」只证明
 * 「它想验的都验了」。`done_when` 在**派发那一刻**由监督者写下，worker 最多只能
 * 声明「哪条检查对应哪一条验收」—— 而覆盖还要求那条检查真的通过。这里测的就是
 * 这条链的三个环节：派发时校验（`parseDeclaredExpect`）、落盘（`writeExpect` /
 * `readExpect`）、事后对账（`verifyExpect`）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EXPECT_FILE,
  MAX_EXPECT_ITEMS,
  MAX_EXPECT_TEXT,
  parseDeclaredExpect,
  readExpect,
  runChecks,
  verifyExpect,
  writeExpect,
} from '../lib/checks.js'

/**
 * 一个用完就删的临时工作区。
 *
 * Windows 上刚写完的文件偶尔还被占用，所以带 maxRetries。
 *
 * @param {(cwd: string) => Promise<void> | void} fn
 */
async function withDir(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-expect-'))
  try {
    await fn(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** 直接往磁盘写一份 expect.json，绕开 writeExpect 的形状约束（要故意写坏）。 */
const plantRaw = (cwd, sessionId, raw) => {
  const dir = join(cwd, '.agi', 'subagents', sessionId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, EXPECT_FILE), raw)
}

test('parseDeclaredExpect: 没写 done_when 就是没有契约', () => {
  assert.deepEqual(parseDeclaredExpect(undefined), { items: [] })
  assert.deepEqual(parseDeclaredExpect(null), { items: [] })
})

test('parseDeclaredExpect: 按顺序发 e1..eN，并去掉首尾空白', () => {
  const parsed = parseDeclaredExpect(['  跑通 npm test  ', 'docs/NAMING.md 存在'])
  assert.deepEqual(parsed.items, [
    { id: 'e1', text: '跑通 npm test' },
    { id: 'e2', text: 'docs/NAMING.md 存在' },
  ])
})

test('parseDeclaredExpect: 上限是 5 条，多了就明确拒绝', () => {
  assert.equal(MAX_EXPECT_ITEMS, 5)
  assert.throws(() => parseDeclaredExpect([]), /空数组/)
  assert.throws(
    () => parseDeclaredExpect(['a', 'b', 'c', 'd', 'e', 'f']),
    /最多 5 条.*6 条/,
    '6 条必须抛错，而且要说清允许多少、这次给了多少',
  )
  assert.equal(parseDeclaredExpect(['1', '2', '3', '4', '5']).items.length, 5, '正好 5 条应该通过')
})

test('parseDeclaredExpect: 每条必须是一句话，且不超过 200 字', () => {
  assert.equal(MAX_EXPECT_TEXT, 200)
  assert.throws(() => parseDeclaredExpect('npm test'), /必须是字符串数组/)
  assert.throws(() => parseDeclaredExpect([42]), /第 1 条不是字符串/)
  assert.throws(() => parseDeclaredExpect(['ok', '   ']), /第 2 条是空/)
  assert.throws(
    () => parseDeclaredExpect(['x'.repeat(MAX_EXPECT_TEXT + 1)]),
    /超过 200 的上限/,
    '超长条目必须抛错，否则验收会变成一段没人读的散文',
  )
  assert.equal(parseDeclaredExpect(['x'.repeat(MAX_EXPECT_TEXT)]).items.length, 1, '正好 200 字应该通过')
})

test('readExpect: 没写文件 → declared:false 且不算错误', () =>
  withDir(async cwd => {
    const read = readExpect(cwd, 'child-a')
    assert.equal(read.declared, false)
    assert.deepEqual(read.items, [])
    assert.equal(read.error, undefined, '「没声明」是正常状态，不该报错')
    assert.equal(read.path, join(cwd, '.agi', 'subagents', 'child-a', EXPECT_FILE))
  }))

test('readExpect: 文件坏了 → declared:false 并给出明确的 error', () =>
  withDir(async cwd => {
    plantRaw(cwd, 'child-bad', '{ not json')
    const broken = readExpect(cwd, 'child-bad')
    assert.equal(broken.declared, false)
    assert.match(broken.error, /不是合法 JSON/)

    plantRaw(cwd, 'child-shape', JSON.stringify({ items: [] }))
    assert.match(readExpect(cwd, 'child-shape').error, /items 是空的/)

    plantRaw(cwd, 'child-item', JSON.stringify({ items: [{ id: 'e1' }] }))
    assert.match(readExpect(cwd, 'child-item').error, /第 1 条不是 \{ id, text \}/)
  }))

test('readExpect: 正常文件 → declared:true，items 原样读出', () =>
  withDir(async cwd => {
    writeExpect(cwd, 'child-ok', [
      { id: 'e1', text: 'npm test 全绿' },
      { id: 'e2', text: 'docs/NAMING.md 存在' },
    ])
    const read = readExpect(cwd, 'child-ok')
    assert.equal(read.declared, true)
    assert.equal(read.error, undefined)
    assert.deepEqual(read.items, [
      { id: 'e1', text: 'npm test 全绿' },
      { id: 'e2', text: 'docs/NAMING.md 存在' },
    ])
  }))

test('writeExpect: 落盘形状就是 handler 里约定的那三个字段', () =>
  withDir(async cwd => {
    const written = writeExpect(cwd, 'child-shape', [
      { id: 'e1', text: '第一条' },
      { id: 'e2', text: '第二条' },
    ])
    assert.equal(written.declared, true)
    assert.equal(written.error, undefined)

    const raw = JSON.parse(readFileSync(written.path, 'utf8'))
    assert.deepEqual(Object.keys(raw).sort(), ['declaredAt', 'items', 'worker'])
    assert.equal(raw.worker, 'child-shape', 'worker 必须是完整的 child id，不是短号')
    assert.match(raw.declaredAt, /^\d{4}-\d{2}-\d{2}T/, 'declaredAt 必须是 ISO 时间')
    assert.deepEqual(raw.items, [
      { id: 'e1', text: '第一条' },
      { id: 'e2', text: '第二条' },
    ])
  }))

test('writeExpect: 只写前 5 条，多出来的丢掉且不抛', () =>
  withDir(async cwd => {
    const many = Array.from({ length: 7 }, (_v, index) => ({ id: `e${index + 1}`, text: `第 ${index + 1} 条` }))
    const written = writeExpect(cwd, 'child-many', many)
    assert.equal(written.declared, true)
    assert.equal(written.items.length, 5)
    assert.deepEqual(
      written.items.map(item => item.id),
      ['e1', 'e2', 'e3', 'e4', 'e5'],
    )
  }))

test('verifyExpect: 没有契约 → 全零，不算失败', () => {
  const empty = verifyExpect({ items: [] }, [{ id: 'build', status: 'pass' }])
  assert.deepEqual(empty, { total: 0, covered: 0, items: [] })
  assert.deepEqual(verifyExpect(undefined, []), { total: 0, covered: 0, items: [] })
})

test('verifyExpect: 四条验收全被通过的检查覆盖', () => {
  const expect = {
    items: [
      { id: 'e1', text: '跑通测试' },
      { id: 'e2', text: '文档存在' },
    ],
  }
  const results = [
    { id: 'build', status: 'pass', expect: ['e1', 'e2'] },
    { id: 'idle', status: 'manual' },
  ]
  const verified = verifyExpect(expect, results)
  assert.equal(verified.total, 2)
  assert.equal(verified.covered, 2)
  assert.deepEqual(verified.items, [
    { id: 'e1', text: '跑通测试', covered: true, evidence: ['build'] },
    { id: 'e2', text: '文档存在', covered: true, evidence: ['build'] },
  ])
})

test('verifyExpect: 部分覆盖 —— 没挂上的那条必须显形', () => {
  const expect = {
    items: [
      { id: 'e1', text: '跑通测试' },
      { id: 'e2', text: '文档存在' },
      { id: 'e3', text: '命名表更新' },
    ],
  }
  const results = [
    { id: 'build', status: 'pass', expect: ['e1'] },
    { id: 'docs', status: 'fail', expect: ['e2'] },
  ]
  const verified = verifyExpect(expect, results)
  assert.equal(verified.total, 3)
  assert.equal(verified.covered, 1, 'e2 挂上了但那条检查失败，不算覆盖；e3 没人挂')
  assert.deepEqual(
    verified.items.filter(item => item.covered === false).map(item => item.id),
    ['e2', 'e3'],
  )
})

test('verifyExpect: 检查 id 恰好等于 eN 也算覆盖（不用显式挂 expect）', () => {
  const verified = verifyExpect({ items: [{ id: 'e1', text: '跑通测试' }] }, [{ id: 'e1', status: 'pass' }])
  assert.equal(verified.covered, 1)
  assert.deepEqual(verified.items[0].evidence, ['e1'])
})

test('verifyExpect: 只认 passed —— error 与 manual 都不算覆盖', () => {
  const verified = verifyExpect(
    { items: [{ id: 'e1', text: '跑通测试' }] },
    [
      { id: 'a', status: 'error', expect: ['e1'] },
      { id: 'b', status: 'manual', expect: ['e1'] },
      { id: 'c', status: 'fail', expect: ['e1'] },
    ],
  )
  assert.equal(verified.covered, 0)
  assert.deepEqual(verified.items[0].evidence, [])
})

test('runChecks 会把条目上的 expect 挂到结果上，覆盖判定才连得起来', () =>
  withDir(async cwd => {
    const results = await runChecks(
      [
        { id: 'build', cmd: 'echo ok', expect: ['e1', 'e2'] },
        { id: 'note', note: '人工确认', expect: ['e3'] },
      ],
      { cwd },
    )
    const build = results.find(result => result.id === 'build')
    const note = results.find(result => result.id === 'note')
    assert.equal(build.status, 'pass')
    assert.deepEqual(build.expect, ['e1', 'e2'], 'runChecks 必须把 expect 回显到结果上')
    assert.deepEqual(note.expect, ['e3'])

    const verified = verifyExpect(
      {
        items: [
          { id: 'e1', text: '跑通' },
          { id: 'e2', text: '也跑通' },
          { id: 'e3', text: '人工确认项' },
        ],
      },
      results,
    )
    assert.equal(verified.covered, 2, 'manual 不算覆盖，所以 e3 没被覆盖')
  }))
