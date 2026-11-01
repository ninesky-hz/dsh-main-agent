/**
 * `lib/report.js` 的直测：从 `outcome.md` 头行 / `report.json` 读出 report 六态。
 *
 * 这份测试的重点不是「能读出正确的状态」，而是**读不出来时不出事**：缺文件、
 * 坏 JSON、大小写不符、旧 worker 目录没写标记 —— 每一条都必须回落成
 * `progress`。把「没写」当成 `blocked` 会让监督者以为 worker 在等人，从而
 * 干等着一个不存在的依赖。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ARCHIVE_FILE,
  archiveWorker,
  collectReports,
  describeReport,
  hasPendingQuestion,
  isArchived,
  readReport,
  REPORT_STATES,
  shortWorkerId,
} from '../lib/report.js'

const AGENT = 'abcd-1234'

/**
 * 造一个临时目录。
 *
 * 不能只信 `os.tmpdir()`：DSH 的沙箱可能把系统临时目录整个挡掉（本机实测
 * `EPERM ... mkdtemp 'C:\\Users\\…\\Temp\\report-XXXXXX'`），那样整份测试会因为
 * 一个与被测逻辑无关的原因全红。这里先试系统临时目录，被拒就退回工作区内的
 * `.test-tmp/`（沙箱对工作区是允许的），两条路径都用独立的 mkdtemp 名字。
 */
function mkdtempAnywhere(prefix) {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    const base = join(process.cwd(), '.test-tmp')
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, prefix))
  }
}

/** 造一个工作区 + 一个 worker 目录；`files` 里的内容按文件名写入。 */
function fixture(files = {}) {
  const cwd = mkdtempAnywhere('report-')
  const dir = join(cwd, '.agi', 'subagents', AGENT)
  if (Object.keys(files).length > 0) {
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, 'utf8')
    }
  }
  return { cwd, dir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

test('REPORT_STATES 就是参考实现的六态，顺序固定', () => {
  assert.deepEqual(REPORT_STATES, ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
})

test('读 outcome.md 头行的 report 标记', () => {
  const { cwd, cleanup } = fixture({
    'outcome.md': '<!-- worker: abcd-1234 -->\n<!-- report: ready -->\n\n正文\n',
  })
  try {
    const report = readReport(cwd, AGENT)
    assert.equal(report.state, 'ready')
    assert.equal(report.outcomePath, join(cwd, '.agi', 'subagents', AGENT, 'outcome.md'))
    assert.equal(report.error, undefined)
  } finally {
    cleanup()
  }
})

test('读 `report: blocked; question: …` 的一行写法', () => {
  const { cwd, cleanup } = fixture({
    'outcome.md': '<!-- report: blocked; question: 需要确认 A 还是 B -->\n',
  })
  try {
    const report = readReport(cwd, AGENT)
    assert.equal(report.state, 'blocked')
    assert.equal(report.question, '需要确认 A 还是 B')
    assert.equal(describeReport(report), 'blocked — 需要确认 A 还是 B')
  } finally {
    cleanup()
  }
})

test('把 question 写在独立注释里也认', () => {
  const { cwd, cleanup } = fixture({
    'outcome.md': '# 结论\n\n<!-- report: blocked -->\n<!-- question: 需要决定用哪个 profile -->\n',
  })
  try {
    assert.equal(readReport(cwd, AGENT).question, '需要决定用哪个 profile')
  } finally {
    cleanup()
  }
})

test('report.json 结构化字段优先于 outcome.md 头行', () => {
  const { cwd, cleanup } = fixture({
    'outcome.md': '<!-- report: blocked; question: 头行的说法 -->\n',
    'report.json': JSON.stringify({ state: 'ready' }),
  })
  try {
    const report = readReport(cwd, AGENT)
    assert.equal(report.state, 'ready')
    // 结构化字段胜出时，不该把被否决的头行文本当成问题带出来。
    assert.equal(report.question, undefined)
  } finally {
    cleanup()
  }
})

test('只有 report.json 也能读', () => {
  const { cwd, cleanup } = fixture({
    'report.json': JSON.stringify({ state: 'failed', question: 'build 挂了，需要人看' }),
  })
  try {
    const report = readReport(cwd, AGENT)
    assert.equal(report.state, 'failed')
    assert.equal(report.question, 'build 挂了，需要人看')
  } finally {
    cleanup()
  }
})

test('fail-open：目录不存在回落 progress，且不抛异常', () => {
  const cwd = mkdtempAnywhere('report-empty-')
  try {
    const report = readReport(cwd, AGENT)
    assert.equal(report.state, 'progress')
    assert.equal(report.question, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('fail-open：旧 worker 目录（没有 report 标记）依旧是 progress', () => {
  const { cwd, cleanup } = fixture({ 'outcome.md': '<!-- worker: abcd-1234 -->\n做完了。\n' })
  try {
    assert.equal(readReport(cwd, AGENT).state, 'progress')
  } finally {
    cleanup()
  }
})

test('fail-open：坏 JSON 回落，且 error 只说明情况、不影响 state', () => {
  const { cwd, cleanup } = fixture({ 'report.json': '{ not json' })
  try {
    const report = readReport(cwd, AGENT)
    assert.equal(report.state, 'progress')
    assert.match(report.error, /report\.json/)
  } finally {
    cleanup()
  }
})

test('fail-open：state 不在六态里 / 大小写不符一律 progress', () => {
  const lower = fixture({ 'report.json': JSON.stringify({ state: 'BLOCKED' }) })
  const unknown = fixture({ 'report.json': JSON.stringify({ state: 'stalled' }) })
  const headCase = fixture({ 'outcome.md': '<!-- report: Blocked -->\n' })
  try {
    assert.equal(readReport(lower.cwd, AGENT).state, 'progress')
    assert.equal(readReport(unknown.cwd, AGENT).state, 'progress')
    assert.equal(readReport(headCase.cwd, AGENT).state, 'progress')
  } finally {
    lower.cleanup()
    unknown.cleanup()
    headCase.cleanup()
  }
})

test('fail-open：report.json 是数组或 null 都不算合法 report', () => {
  const array = fixture({ 'report.json': '[]' })
  const empty = fixture({ 'report.json': 'null' })
  try {
    assert.equal(readReport(array.cwd, AGENT).state, 'progress')
    assert.equal(readReport(empty.cwd, AGENT).state, 'progress')
  } finally {
    array.cleanup()
    empty.cleanup()
  }
})

test('describeReport：没有 question 时用中文注解，绝不只给裸状态码', () => {
  for (const state of REPORT_STATES) {
    const line = describeReport({ state })
    assert.match(line, new RegExp(`^${state} — \\S`), `${state} 缺少中文注解`)
  }
  assert.equal(describeReport({ state: 'nonsense' }).startsWith('progress — '), true)
})

test('hasPendingQuestion：只有 blocked/failed/waiting 且问题非空才算在等人', () => {
  assert.equal(hasPendingQuestion({ state: 'blocked', question: 'A 还是 B' }), true)
  assert.equal(hasPendingQuestion({ state: 'waiting', question: 'A 还是 B' }), true)
  assert.equal(hasPendingQuestion({ state: 'failed', question: 'A 还是 B' }), true)
  assert.equal(hasPendingQuestion({ state: 'blocked' }), false)
  assert.equal(hasPendingQuestion({ state: 'blocked', question: '   ' }), false)
  // progress/ready/dropped 上挂个问题也不算「在等人」：这三态不阻塞进度。
  assert.equal(hasPendingQuestion({ state: 'progress', question: 'A 还是 B' }), false)
  assert.equal(hasPendingQuestion({ state: 'ready', question: 'A 还是 B' }), false)
  assert.equal(hasPendingQuestion({ state: 'dropped', question: 'A 还是 B' }), false)
  assert.equal(hasPendingQuestion(undefined), false)
})

/** 在工作区里造一个 worker 目录，`files` 按文件名写入。 */
function writeWorker(cwd, id, files = {}) {
  const dir = join(cwd, '.agi', 'subagents', id)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
}

test('collectReports：列出每个 worker，id 截末 8 位，running 按全 id 匹配', () => {
  const cwd = mkdtempAnywhere('collect-')
  try {
    const asking = 'aaaa1111-2222-3333-4444-555566667777'
    const legacy = 'bbbb0000-9999-8888-7777-666655554444'
    writeWorker(cwd, asking, { 'outcome.md': '<!-- report: blocked; question: 需要确认 A 还是 B -->\n正文' })
    // 第二个只建目录、不写任何标记 —— 模拟批次A 之前的老 worker。
    writeWorker(cwd, legacy, {})

    const reports = collectReports(cwd, [legacy])

    // 目录名排序，短的 id 才好塞进摘要一行。
    assert.deepEqual(reports.map(report => report.id), ['66667777', '55554444'])
    // 没写标记的那个必须回落成 progress，而不是变成 blocked（那会让监督者空等）。
    assert.deepEqual(reports.map(report => report.report.state), ['blocked', 'progress'])
    assert.deepEqual(reports.map(report => report.running), [false, true])
    assert.equal(reports[0].report.question, '需要确认 A 还是 B')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collectReports：没有 subagents 目录时给空数组，不抛错', () => {
  const cwd = mkdtempAnywhere('collect-none-')
  try {
    // 兜底路径上抛异常会把整轮唤醒打断，摘要少一段是无害的。
    assert.deepEqual(collectReports(cwd, []), [])
    assert.deepEqual(collectReports(cwd, undefined), [])
    // 带 catalog 的调用也一样：没有目录就没有任何 worker 可报。
    assert.deepEqual(collectReports(cwd, [], new Set()), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collectReports：known 三态 —— 不传是 undefined，传了才给真假', () => {
  const cwd = mkdtempAnywhere('collect-known-')
  try {
    const live = 'aaaa1111-2222-3333-4444-555566667777'
    const gone = 'bbbb0000-9999-8888-7777-666655554444'
    writeWorker(cwd, live, { 'outcome.md': '<!-- report: progress -->\n' })
    // 历史手工目录：不是 session，永远不可能再跑。
    writeWorker(cwd, 'persona-compose-review', { 'outcome.md': '<!-- report: progress -->\n' })

    // ① 不传 known：每个都是 undefined —— 「没人告诉我 catalog 长什么样」。
    const blind = collectReports(cwd, [])
    assert.deepEqual(blind.map(report => report.known), [undefined, undefined])

    // ② 传 Set：在 catalog 里 true，不在的 false。目录名排序在前的是 UUID 那个。
    const known = collectReports(cwd, [], new Set([live, gone]))
    assert.deepEqual(known.map(report => [report.id, report.known]), [
      ['66667777', true],
      ['persona-compose-review', false],
    ])

    // ③ 数组也接受（调用方不必先自己包成 Set）。
    const fromArray = collectReports(cwd, [], [live])
    assert.deepEqual(fromArray.map(report => report.known), [true, false])

    // ④ 空集合 = 「catalog 里一个都没有」，与不传不同（这是硬结论，不是不知道）。
    const empty = collectReports(cwd, [], new Set())
    assert.deepEqual(empty.map(report => report.known), [false, false])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('shortWorkerId：标准 UUID 取末 8 位，非 UUID 名字整名保留', () => {
  // 旧实现无脑 slice(-8)，把历史目录 persona-compose-review 切成 e-review：
  // 一个既不是 session、也不是目录名的碎片，读者没法据此去查任何东西。
  assert.equal(shortWorkerId('e4baac95-087f-4e90-96d7-3b1c5ae51548'), '5ae51548')
  assert.equal(shortWorkerId('3DB7F59F-DDD3-4B92-AB6C-E685BEA9EF0F'), 'BEA9EF0F')
  assert.equal(shortWorkerId('persona-compose-review'), 'persona-compose-review')
  // 短于 8 位的非 UUID 名也不会被截。
  assert.equal(shortWorkerId('e-review'), 'e-review')
  // 形状差一点（少一段 / 多一段）就不是 UUID，整名保留。
  assert.equal(shortWorkerId('e4baac95-087f-4e90-3b1c5ae51548'), 'e4baac95-087f-4e90-3b1c5ae51548')
  assert.equal(shortWorkerId(''), '')
})

test('archiveWorker：写 {ts, by, note}，重复调用幂等且不刷掉首次时间', () => {
  const { cwd, dir, cleanup } = fixture({ 'outcome.md': '<!-- report: ready -->\n' })
  try {
    const first = archiveWorker(cwd, AGENT, 'Lead 已核验：全量测试 360 绿')
    assert.equal(first.ok, true)
    assert.equal(first.written, true)
    assert.equal(first.path, join(dir, ARCHIVE_FILE))
    assert.equal(first.record.by, 'lead')
    assert.equal(first.record.note, 'Lead 已核验：全量测试 360 绿')
    assert.match(first.record.ts, /^\d{4}-\d{2}-\d{2}T/)

    // 同一份备注再跑一次：不重写，也不把 ts 改成现在。
    const again = archiveWorker(cwd, AGENT, 'Lead 已核验：全量测试 360 绿')
    assert.equal(again.ok, true)
    assert.equal(again.written, false)
    assert.equal(again.record.ts, first.record.ts)

    // 备注变了才算更新，且仍然保留首次的 ts（那次才是验收发生的时刻）。
    const changed = archiveWorker(cwd, AGENT, 'Lead 已核验：补跑一遍，364 绿')
    assert.equal(changed.written, true)
    assert.equal(changed.record.ts, first.record.ts)
    assert.equal(JSON.parse(readFileSync(join(dir, ARCHIVE_FILE), 'utf8')).note, 'Lead 已核验：补跑一遍，364 绿')
  } finally {
    cleanup()
  }
})

test('archiveWorker：目录不存在时返 ok:false 并且绝不抛', () => {
  const cwd = mkdtempAnywhere('archive-missing-')
  try {
    // 凭空造目录会让 collectReports 多出一条没有任何 outcome 的幽灵 worker。
    const missing = archiveWorker(cwd, AGENT, '随手指一个')
    assert.equal(missing.ok, false)
    assert.match(missing.error, /没有这个 worker 目录/)
    assert.deepEqual(collectReports(cwd, []), [])
    // 空 id 同样只是失败，不是异常。
    assert.equal(archiveWorker(cwd, '', 'x').ok, false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('isArchived：读得到且能 JSON.parse 才是 true，坏 JSON / 不存在一律 false', () => {
  const cwd = mkdtempAnywhere('archived-')
  try {
    const dirOf = id => join(cwd, '.agi', 'subagents', id)
    mkdirSync(dirOf('good'), { recursive: true })
    writeFileSync(join(dirOf('good'), ARCHIVE_FILE), '{"ts":"2026-11-01T00:00:00.000Z","by":"lead","note":"ok"}\n', 'utf8')
    mkdirSync(dirOf('broken'), { recursive: true })
    writeFileSync(join(dirOf('broken'), ARCHIVE_FILE), '{ not json', 'utf8')
    mkdirSync(dirOf('no-archive'), { recursive: true })

    assert.equal(isArchived(cwd, 'good'), true)
    assert.equal(isArchived(cwd, 'no-archive'), false)
    // 坏标记不能当成「已归档」：那会让真在等人的 worker 从 BRIEF 里消失。
    assert.equal(isArchived(cwd, 'broken'), false)
    assert.equal(isArchived(cwd, 'never-existed'), false)
    assert.equal(isArchived(cwd, ''), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collectReports：archived 字段真假两态，且已归档的仍列出来', () => {
  const cwd = mkdtempAnywhere('collect-archived-')
  try {
    const done = 'aaaa1111-2222-3333-4444-555566667777'
    const open = 'bbbb0000-9999-8888-7777-666655554444'
    writeWorker(cwd, done, { 'outcome.md': '<!-- report: ready -->\n正文' })
    writeWorker(cwd, open, { 'outcome.md': '<!-- report: ready -->\n正文' })
    assert.equal(archiveWorker(cwd, done, 'Lead 已核验').ok, true)

    const reports = collectReports(cwd, [])
    // 已归档的不能从摘要里消失 —— 上层要显示「已收尾」，而不是让其凭空不见。
    assert.equal(reports.length, 2)
    assert.deepEqual(reports.map(r => [r.id, r.archived]), [['66667777', true], ['55554444', false]])
    // 归档不改变 worker 自述的 report，它就是 ready（worker 无从知道 Lead 验没验）。
    assert.deepEqual(reports.map(r => r.report.state), ['ready', 'ready'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collectReports：非 UUID 目录名整名保留，不再被切成 e-review', () => {
  const cwd = mkdtempAnywhere('collect-name-')
  try {
    writeWorker(cwd, 'persona-compose-review', { 'outcome.md': '<!-- report: progress -->\n' })
    writeWorker(cwd, 'e4baac95-087f-4e90-96d7-3b1c5ae51548', {})
    const ids = collectReports(cwd, []).map(report => report.id)
    assert.deepEqual(ids, ['5ae51548', 'persona-compose-review'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
