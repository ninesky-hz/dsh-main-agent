import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { renderBrief, writeBrief, briefPathFor } from '../lib/loop-journal.js'
import {
  OUTBOX_FILE,
  backoffMs,
  dueEntries,
  enqueue,
  markDelivered,
  markFailed,
  outboxProblems,
  readOutbox,
  renderOutboxNotice,
} from '../lib/outbox.js'

/**
 * 造一个临时工作区。
 *
 * 不能只信 `os.tmpdir()`：DSH 的沙箱可能把系统临时目录整个挡掉（本机实测
 * `EPERM ... mkdtemp 'C:\\Users\\…\\Temp\\…'`）。先试系统临时目录，被拒就退回
 * 工作区内的 `.test-tmp/`（沙箱对工作区是允许的）。
 */
function workspace(prefix = 'outbox-') {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    const base = join(process.cwd(), '.test-tmp')
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, prefix))
  }
}

const withWorkspace = body => {
  const cwd = workspace()
  try {
    return body(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

/** 队列文件的绝对路径，用来断言「磁盘上到底有几行」。 */
const queueFile = cwd => join(cwd, '.agi', OUTBOX_FILE)

/**
 * 直接写队列文件：需要控制 `createdAt` / `nextAt` 的用例不能靠 `enqueue`
 * （它取真实时钟），而 `.agi/outbox.jsonl` 的行格式本来就是这个模块的接口。
 */
function seed(cwd, entries) {
  const path = queueFile(cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
}

/** 一条形状完整的 entry，缺省值让用例只写自己关心的字段。 */
const entry = (overrides = {}) => ({
  id: 'id-1',
  kind: 'settlement',
  dedupeKey: 'abc12345',
  detail: { state: 'blocked', question: '需要确认 A 还是 B' },
  createdAt: 1000,
  nextAt: 1000,
  attempts: 0,
  status: 'pending',
  ...overrides,
})

test('backoffMs: 2 秒起、翻倍、封顶 1 分钟', () => {
  assert.equal(backoffMs(0), 0)
  assert.equal(backoffMs(-1), 0)
  assert.equal(backoffMs(1), 2000)
  assert.equal(backoffMs(2), 4000)
  assert.equal(backoffMs(3), 8000)
  assert.equal(backoffMs(4), 16000)
  assert.equal(backoffMs(5), 32000)
  // 第 6 次起就是 64000 > 60000，必须封顶而不是继续翻倍。
  assert.equal(backoffMs(6), 60000)
  assert.equal(backoffMs(50), 60000)
  // 非法输入不该把队列推进到 NaN 的 nextAt（那会让它永远不到期）。
  assert.equal(backoffMs(Number.NaN), 0)
})

test('enqueue: 同 kind + 同 dedupeKey 是 upsert，磁盘上只有一行', () => withWorkspace(cwd => {
  const first = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345', detail: { state: 'ready' } })
  assert.equal(first.ok, true)
  assert.equal(first.replaced, undefined)

  const second = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345', detail: { state: 'ready' } })
  assert.equal(second.ok, true)
  assert.equal(second.replaced, true)
  assert.equal(second.id, first.id)

  const raw = readFileSync(queueFile(cwd), 'utf8').trim().split('\n')
  assert.equal(raw.length, 1)

  // 不同 kind 用同一个 key 不算重复：那是两件不同的事。
  const other = enqueue(cwd, { kind: 'worker-report', dedupeKey: 'abc12345' })
  assert.equal(other.replaced, undefined)
  assert.equal(readOutbox(cwd).entries.length, 2)
}))

test('enqueue: upsert 保留 id/createdAt/attempts，detail 整体替换（不是合并）', () => withWorkspace(cwd => {
  enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345', detail: { state: 'working' } })
  const before = readOutbox(cwd).entries[0]
  const second = enqueue(cwd, {
    kind: 'settlement',
    dedupeKey: 'abc12345',
    detail: { state: 'blocked', question: '需要确认 A 还是 B' },
  })
  assert.equal(second.replaced, true)
  const entries = readOutbox(cwd).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, before.id)
  assert.equal(entries[0].createdAt, before.createdAt)
  assert.equal(entries[0].attempts, before.attempts)
  // 整体替换：旧 detail 里的多余键不能留下来。
  assert.deepEqual(entries[0].detail, { state: 'blocked', question: '需要确认 A 还是 B' })

  // 这次没给 detail：保留原值，而不是把 detail 抹掉。
  enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  assert.deepEqual(readOutbox(cwd).entries[0].detail, { state: 'blocked', question: '需要确认 A 还是 B' })
}))

test('enqueue: upsert 之后立刻到期（nextAt 置为现在，attempts 不重置）', () => withWorkspace(cwd => {
  const first = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  // 制造一条正在退避的同 key entry：它此刻不该到期。
  seed(cwd, [{ ...entry({ id: first.id }), attempts: 2, nextAt: Date.now() + 60_000 }])
  assert.equal(dueEntries(cwd).length, 0)

  const again = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345', detail: { state: 'blocked' } })
  assert.equal(again.replaced, true)
  const due = dueEntries(cwd)
  assert.equal(due.length, 1)
  assert.equal(due[0].id, first.id)
  assert.ok(due[0].nextAt <= Date.now())
  // 重置 attempts 会把「反复失败」洗白，下一次失败又从 2 秒退避起。
  assert.equal(due[0].attempts, 2)
}))

test('enqueue: upsert 不改队列序（位置留在原地）', () => withWorkspace(cwd => {
  enqueue(cwd, { kind: 'settlement', dedupeKey: 'key1' })
  enqueue(cwd, { kind: 'worker-report', dedupeKey: 'key2' })
  enqueue(cwd, { kind: 'settlement', dedupeKey: 'key1', detail: { state: 'ready' } })
  assert.deepEqual(dueEntries(cwd).map(item => item.dedupeKey), ['key1', 'key2'])
}))

test('enqueue: 已投递的同一件事可以再次入队', () => withWorkspace(cwd => {
  const first = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  markDelivered(cwd, first.id)
  const again = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  assert.equal(again.ok, true)
  assert.equal(again.replaced, undefined)
  assert.notEqual(again.id, first.id)
  assert.equal(readOutbox(cwd).entries.length, 2)
}))

test('enqueue: 没有工作区时返回 failed 而不抛', () => {
  const result = enqueue(undefined, { kind: 'settlement', dedupeKey: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /工作区/)
})

test('dueEntries: 未到期的不返回，到期了才返回', () => withWorkspace(cwd => {
  const { id } = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  assert.equal(dueEntries(cwd).length, 1)

  const failed = markFailed(cwd, id, '主 Agent 那一轮被用户打断')
  assert.equal(failed.ok, true)
  assert.equal(failed.attempts, 1)
  assert.equal(dueEntries(cwd).length, 0)

  // 退避到期之后必须重新出现 —— 否则「重试」就成了「放弃」。
  assert.equal(dueEntries(cwd, failed.nextAt).length, 1)
  assert.equal(dueEntries(cwd, failed.nextAt - 1).length, 0)
}))

test('dueEntries: 同 kind 保序 —— 前一条没走完，后一条不许插队', () => withWorkspace(cwd => {
  seed(cwd, [
    entry({ id: 'a', createdAt: 1000, nextAt: 5000 }),
    entry({ id: 'b', createdAt: 2000, nextAt: 2000 }),
  ])
  // a 还在退避：b 明明到期了也得等 —— 收敛通知说顺序，插队会让 BRIEF 自相矛盾。
  assert.deepEqual(dueEntries(cwd, 3000).map(e => e.id), [])
  // a 到期之后两条一起放行，仍然按 createdAt 排。
  assert.deepEqual(dueEntries(cwd, 5000).map(e => e.id), ['a', 'b'])
}))

test('dueEntries: 不同 kind 互不阻塞', () => withWorkspace(cwd => {
  seed(cwd, [
    entry({ id: 'slow', kind: 'settlement', createdAt: 1000, nextAt: 60000 }),
    entry({ id: 'fresh', kind: 'check-failed', createdAt: 2000, nextAt: 2000 }),
  ])
  assert.deepEqual(dueEntries(cwd, 3000).map(e => e.id), ['fresh'])
}))

test('markFailed: attempts 递增、nextAt 按退避推后并记录原因', () => withWorkspace(cwd => {
  seed(cwd, [entry()])
  const before = Date.now()
  const first = markFailed(cwd, 'id-1', '第一轮没走完')
  const after = Date.now()

  assert.equal(first.ok, true)
  assert.equal(first.attempts, 1)
  assert.ok(first.nextAt >= before + 2000 && first.nextAt <= after + 2000, `nextAt=${first.nextAt}`)

  const second = markFailed(cwd, 'id-1', '第二轮也没走完')
  assert.equal(second.attempts, 2)
  assert.equal(second.nextAt - first.nextAt >= 1000, true)

  const [stored] = readOutbox(cwd).entries
  assert.equal(stored.attempts, 2)
  assert.equal(stored.lastError, '第二轮也没走完')
  assert.equal(stored.status, 'pending')
}))

test('markDelivered: 之后不再出现在 dueEntries，但记录还在', () => withWorkspace(cwd => {
  seed(cwd, [entry()])
  assert.equal(markDelivered(cwd, 'id-1').ok, true)
  assert.equal(dueEntries(cwd, 10_000_000).length, 0)

  const { entries } = readOutbox(cwd)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'delivered')

  // 不存在的 id 是 failed 而不是抛出。
  assert.equal(markDelivered(cwd, 'nope').ok, false)
}))

test('readOutbox: 坏行跳过、其余行照读', () => withWorkspace(cwd => {
  const path = queueFile(cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    '{"id":"good","kind":"settlement","createdAt":1,"nextAt":1,"attempts":0,"status":"pending"}',
    '{"id":"truncated","kind":"settle',
    '{"noId":true}',
    '   ',
    '{"id":"good2","kind":"worker-report","createdAt":2,"nextAt":2,"attempts":0,"status":"pending"}',
  ].join('\n') + '\n', 'utf8')

  const read = readOutbox(cwd)
  assert.deepEqual(read.entries.map(e => e.id), ['good', 'good2'])
  assert.equal(read.badLines, 2)
  assert.match(read.error, /2 行/)
  // 坏行不该让队列停摆：能读到的两条照样可以投递。
  assert.deepEqual(dueEntries(cwd, 10).map(e => e.id), ['good', 'good2'])
}))

test('readOutbox: 文件不存在时是空队列而不是错误', () => withWorkspace(cwd => {
  const read = readOutbox(cwd)
  assert.deepEqual(read.entries, [])
  assert.equal(read.error, undefined)
}))

test('outboxProblems: 连续失败三次才算系统问题', () => {
  const one = entry({ attempts: 1 })
  const three = entry({ id: 'id-3', attempts: 3 })
  const delivered = entry({ id: 'id-4', attempts: 5, status: 'delivered' })
  assert.deepEqual(outboxProblems([one]), [])
  assert.deepEqual(outboxProblems([one, three, delivered]).map(e => e.id), ['id-3'])
  assert.deepEqual(outboxProblems([]), [])
  assert.deepEqual(outboxProblems(undefined), [])
})

test('renderOutboxNotice: 空数组返回空串，有内容时不出现 undefined', () => {
  assert.equal(renderOutboxNotice([]), '')
  assert.equal(renderOutboxNotice(undefined), '')

  const text = renderOutboxNotice([
    entry({ attempts: 2, nextAt: Date.now() + 12_000 }),
  ])
  assert.match(text, /^\- `abc12345` 的收敛通知（blocked：需要确认 A 还是 B）/)
  assert.match(text, /已重试 2 次/)
  assert.match(text, /下次 12 秒后/)
  assert.equal(text.includes('undefined'), false)

  // 字段缺失的 entry 也得说人话，不能把 detail 直接倒给模型。
  const bare = renderOutboxNotice([{ id: 'deadbeef', kind: 'check-failed', status: 'pending' }])
  assert.equal(bare.includes('undefined'), false)
  assert.match(bare, /deadbeef/)
})

test('renderOutboxNotice: 空队列不出现「积压」', () => {
  assert.equal(renderOutboxNotice([]), '')
  assert.equal(renderOutboxNotice(undefined), '')
  // 只有已投递的历史时也没有「待投递」，积压行不该冒出来。
  assert.equal(renderOutboxNotice([entry({ status: 'delivered' })]).includes('积压'), false)
})

test('renderOutboxNotice: 积压的最老年龄按 humanDelay 两档格式化', () => {
  const now = 1_000_000
  const minutes = renderOutboxNotice([entry({ createdAt: now - 12 * 60_000, nextAt: now - 1 })], { now })
  assert.match(minutes, /- 积压：1 条待投递，最老 12 分钟/)
  const seconds = renderOutboxNotice([entry({ createdAt: now - 12_000, nextAt: now - 1 })], { now })
  assert.match(seconds, /- 积压：1 条待投递，最老 12 秒/)
})

test('renderOutboxNotice: 失败数按 KIND_LABEL 列出，零项的 kind 不出现', () => {
  const now = 2_000_000
  const text = renderOutboxNotice([
    entry({ id: 'a', kind: 'worker-report', dedupeKey: 'k1', createdAt: now - 1_000, nextAt: now - 1, attempts: 3 }),
    entry({ id: 'b', kind: 'worker-report', dedupeKey: 'k2', createdAt: now - 2_000, nextAt: now - 1, attempts: 4 }),
    entry({ id: 'c', kind: 'settlement', dedupeKey: 'k3', createdAt: now - 3_000, nextAt: now - 1 }),
    entry({ id: 'd', kind: 'worker-report', dedupeKey: 'k4', createdAt: now - 4_000, nextAt: now - 1, status: 'delivered' }),
  ], { now })
  const backlog = text.split('\n').find(line => line.startsWith('- 积压：'))
  assert.ok(backlog, '必须有积压行')
  assert.match(backlog, /3 条待投递/)
  assert.match(backlog, /最老 3 秒/)
  // 两条 worker-report 到 3 次以上；settlement 一次都没失败，不能出现在括号里。
  assert.match(backlog, /worker 报告 2 条失败/)
  assert.doesNotMatch(backlog, /收敛通知/)
  // 给模型看的文本里不能漏出裸 kind 码。
  assert.doesNotMatch(backlog, /worker-report/)
})

test('outbox 锁: mtime 超过 10 秒的陈旧锁会被接管并清掉', () => withWorkspace(cwd => {
  const lock = join(cwd, '.agi', 'outbox.lock')
  mkdirSync(dirname(lock), { recursive: true })
  writeFileSync(lock, '999999:崩溃掉的持锁进程', 'utf8')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)

  const result = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  assert.equal(result.ok, true)
  assert.equal(readOutbox(cwd).entries.length, 1)
  // 接管之后必须把它删掉：否则下一次进来又得当陈旧锁处理。
  assert.equal(existsSync(lock), false)
}))

test('outbox 锁: 刚写入的锁让 enqueue 有界失败，不永久挂死', () => withWorkspace(cwd => {
  const lock = join(cwd, '.agi', 'outbox.lock')
  mkdirSync(dirname(lock), { recursive: true })
  writeFileSync(lock, '424242:另一个还活着的进程', 'utf8')

  const started = Date.now()
  const result = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2_500, `等锁用了 ${elapsed}ms，超过 2.5 秒上限`)
  assert.equal(result.ok, false)
  assert.match(result.error, /锁等待超过/)
  // 别人的锁不能被删，也不能偷偷把队列写进去。
  assert.equal(existsSync(lock), true)
  assert.equal(readOutbox(cwd).entries.length, 0)
}))

test('outbox 锁: 正常入队之后锁文件不残留', () => withWorkspace(cwd => {
  const lock = join(cwd, '.agi', 'outbox.lock')
  enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  assert.equal(existsSync(lock), false)
}))

test('renderOutboxNotice: recovery note 的正文与中文标签都要露出来', () => {
  const text = renderOutboxNotice([entry({
    id: 'r-1',
    kind: 'recovery',
    dedupeKey: 'recovery:0000aaaa',
    detail: { worker: '0000aaaa', note: '先查工作区产物与 git 历史确认做到哪，再重做外部动作' },
  })], { now: 1000 })
  assert.match(text, /重启恢复/)
  // 只渲染成「重启恢复」等于没说：note 里那句「接下来怎么查」必须出现在 BRIEF 里。
  assert.match(text, /先查工作区产物与 git 历史确认做到哪/)
  assert.doesNotMatch(text, /undefined/)
})

test('renderBrief: 传 outbox 时多出「## 待投递」，不传时没有这一段', () => withWorkspace(cwd => {
  const base = { cwd, objective: '把 outbox 接上', state: { idleTicks: 0 } }

  const without = renderBrief(base)
  assert.equal(without.includes('## 待投递'), false)

  const empty = renderBrief({ ...base, outbox: [] })
  assert.equal(empty.includes('## 待投递'), false)

  const withOutbox = renderBrief({ ...base, outbox: [entry({ attempts: 2, nextAt: Date.now() + 12_000 })] })
  assert.match(withOutbox, /## 待投递/)
  assert.match(withOutbox, /abc12345/)

  // 顺序：待投递在「最近进展」之前 —— 欠账排在历史前面。
  assert.ok(withOutbox.indexOf('## 待投递') < withOutbox.indexOf('## 最近进展'))
}))

test('writeBrief: 写盘成功后把这次渲染的 entry 标记已投递', () => withWorkspace(cwd => {
  const first = enqueue(cwd, { kind: 'settlement', dedupeKey: 'abc12345' })
  const due = dueEntries(cwd)
  assert.equal(due.length, 1)

  const { text } = writeBrief({ cwd, objective: '把 outbox 接上', state: {}, outbox: due })
  assert.match(text, /## 待投递/)
  assert.match(readFileSync(briefPathFor(cwd), 'utf8'), /## 待投递/)

  // 投递给过的事实不该在下一份摘要里重复出现。
  assert.equal(dueEntries(cwd).length, 0)
  assert.equal(readOutbox(cwd).entries.find(e => e.id === first.id).status, 'delivered')
}))

test('writeBrief: 写盘失败时记一次投递失败，而不是标记已投递', () => withWorkspace(cwd => {
  const first = enqueue(cwd, { kind: 'settlement', dedupeKey: 'def67890' })
  // `enqueue` 只回 `{ ok, id }`，退避字段要从落盘结果读。
  const before = readOutbox(cwd).entries.find(e => e.id === first.id)
  assert.equal(before.attempts, 0)

  // 把 BRIEF.md 这个**路径**占成一个目录，于是 writeFileSync 抛 EISDIR。
  // 这样既不依赖文件权限（root/管理员下测不出来），也不影响 outbox 本身读写。
  mkdirSync(briefPathFor(cwd), { recursive: true })

  const { text } = writeBrief({ cwd, objective: '写不进去的摘要', state: {}, outbox: dueEntries(cwd) })

  // 调用方照样拿到文本 —— 摘要写不进去不该连累这一轮的返回值。
  assert.match(text, /## 待投递/)

  const after = readOutbox(cwd).entries.find(e => e.id === first.id)
  assert.notEqual(after.status, 'delivered')
  assert.equal(after.attempts, 1)
  // 退避跟着走：下一次出现时 BRIEF 会写「已重试 1 次」，读的人能看出这不是第一次。
  assert.ok(after.nextAt > before.nextAt)
  assert.match(after.lastError ?? '', /BRIEF/)
}))
