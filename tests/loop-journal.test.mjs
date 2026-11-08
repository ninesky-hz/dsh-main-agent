import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  appendLoopEvent,
  briefPathFor,
  ensureIgnored,
  pruneLoopStates,
  readLessons,
  LOOP_BRIEF_FILE,
  LOOP_STATE_FILE,
  progressMtime,
  readLoopEvents,
  readLoopState,
  renderBrief,
  sessionKeyOf,
  writeBrief,
  writeLoopState,
} from '../lib/loop-journal.js'
import { budgetVerdict, idleVerdict, reviewDue, suggestedRounds } from '../lib/loop-policy.js'

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-journal-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('idleVerdict: 0 继续，正数降频，到阈值停', () => {
  assert.equal(idleVerdict({ idleTicks: 0 }).action, 'continue')
  const throttled = idleVerdict({ idleTicks: 2, pauseTicks: 5 })
  assert.equal(throttled.action, 'throttle')
  assert.match(throttled.reason, /2 轮/)
  const paused = idleVerdict({ idleTicks: 5, pauseTicks: 5 })
  assert.equal(paused.action, 'pause')
  assert.match(paused.reason, /5 轮/)
})

test('idleVerdict: 非法输入退化成「继续」而不是「停」', () => {
  assert.equal(idleVerdict({ idleTicks: Number.NaN }).action, 'continue')
  assert.equal(idleVerdict({}).action, 'continue')
  // 阈值传 0/负数时退回默认值，不能因此把一切判成 pause。
  assert.equal(idleVerdict({ idleTicks: 1, pauseTicks: 0 }).action, 'throttle')
})

test('reviewDue: 每个窗口只触发一次', () => {
  assert.equal(reviewDue({ roundsStarted: 4, lastReviewRound: 0, every: 5 }), false)
  assert.equal(reviewDue({ roundsStarted: 5, lastReviewRound: 0, every: 5 }), true)
  // 同一窗口里重复调用不再问。
  assert.equal(reviewDue({ roundsStarted: 9, lastReviewRound: 1, every: 5 }), false)
  assert.equal(reviewDue({ roundsStarted: 10, lastReviewRound: 1, every: 5 }), true)
  assert.equal(reviewDue({ roundsStarted: 0, lastReviewRound: 0, every: 5 }), false)
})

test('suggestedRounds: 按里程碑估并在区间内夹取', () => {
  assert.equal(suggestedRounds({ milestones: 0 }), 20)
  assert.equal(suggestedRounds({ milestones: 3 }), 20)
  assert.equal(suggestedRounds({ milestones: 5 }), 30)
  assert.equal(suggestedRounds({ milestones: 40 }), 120)
})

test('readLoopState: 缺失与损坏都退化成空状态', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(readLoopState(dir).idleTicks, 0)
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(join(dir, '.agi', 'loop-state.json'), '{ not json', 'utf8')
    assert.equal(readLoopState(dir).idleTicks, 0)
  } finally {
    cleanup()
  }
})

test('writeLoopState: 合并写入，undefined 删除键', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(writeLoopState(dir, { idleTicks: 3, pausedBy: 'idle' }), true)
    assert.equal(readLoopState(dir).idleTicks, 3)
    assert.equal(readLoopState(dir).pausedBy, 'idle')

    writeLoopState(dir, { idleTicks: 0, pausedBy: undefined })
    const after = readLoopState(dir)
    assert.equal(after.idleTicks, 0)
    assert.equal(after.pausedBy, undefined)
    // 真正落盘的 JSON 里不该留着 `"pausedBy": null`。
    const raw = readFileSync(join(dir, '.agi', LOOP_STATE_FILE), 'utf8')
    assert.equal(raw.includes('pausedBy'), false)
  } finally {
    cleanup()
  }
})

test('appendLoopEvent / readLoopEvents: 追加可读，坏行不拖垮整条时间线', () => {
  const { dir, cleanup } = workspace()
  try {
    appendLoopEvent(dir, 'goal-started', { objective: '反编译' })
    appendLoopEvent(dir, 'worker-reaped', { worker: 'w1', stalledMinutes: 42 })
    writeFileSync(join(dir, '.agi', 'progress.jsonl'), '{ broken\n', { encoding: 'utf8', flag: 'a' })

    const events = readLoopEvents(dir)
    assert.deepEqual(events.map(event => event.event), ['goal-started', 'worker-reaped'])
    assert.equal(events[1].detail.stalledMinutes, 42)
    assert.equal(typeof events[0].ts, 'string')
    // limit 取尾部。
    assert.deepEqual(readLoopEvents(dir, 1).map(event => event.event), ['worker-reaped'])
  } finally {
    cleanup()
  }
})

test('progressMtime: 真读文件 mtime，不存在时 undefined', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(progressMtime(dir), undefined)
    appendLoopEvent(dir, 'goal-started', {})
    const before = progressMtime(dir)
    assert.equal(typeof before, 'number')
    assert.ok(before > Date.now() - 60_000)
    assert.ok(before <= Date.now() + 1000)
  } finally {
    cleanup()
  }
})

test('renderBrief: 汇总目标、状态、进展与停止原因', () => {
  const { dir, cleanup } = workspace()
  try {
    appendLoopEvent(dir, 'goal-started', { text: '开始' })
    appendLoopEvent(dir, 'goal-stopped', { reason: '目标已 complete' })
    const text = renderBrief({
      cwd: dir,
      objective: '让循环停在正确的地方',
      state: { idleTicks: 2, lastReviewRound: 1 },
      roundsStarted: 7,
      maxGoalRounds: 40,
      phase: 'active',
    })
    assert.match(text, /# 循环摘要/)
    assert.match(text, /让循环停在正确的地方/)
    assert.match(text, /第 7\/40 轮/)
    assert.match(text, /连续空转计数：2/)
    assert.match(text, /goal-started/)
    assert.match(text, /目标已 complete/)
  } finally {
    cleanup()
  }
})

test('writeBrief: 落到 .agi/BRIEF.md 且返回同样的文本', () => {
  const { dir, cleanup } = workspace()
  try {
    const { text } = writeBrief({ cwd: dir, objective: 'x', state: { idleTicks: 0 } })
    const onDisk = readFileSync(join(dir, '.agi', LOOP_BRIEF_FILE), 'utf8')
    assert.equal(onDisk, text)
    assert.equal(briefPathFor(dir), join(dir, '.agi', LOOP_BRIEF_FILE))
    assert.equal(briefPathFor(''), undefined)
  } finally {
    cleanup()
  }
})

test('sessionKeyOf: 取 session id 的后 8 位字母数字', () => {
  // 'session-01JABCDEF' 去掉连字符后是 session01JABCDEF，取后 8 位。
  assert.equal(sessionKeyOf({ id: 'session-01JABCDEF' }), '1JABCDEF')
  assert.equal(sessionKeyOf({ id: 'abc' }), 'abc')
  assert.equal(sessionKeyOf({ id: '' }), undefined)
  assert.equal(sessionKeyOf({}), undefined)
  assert.equal(sessionKeyOf(undefined), undefined)
})

test('多会话：两个 key 的状态各自独立，不会互相覆盖', () => {
  const { dir, cleanup } = workspace()
  try {
    writeLoopState(dir, { idleTicks: 4, pausedBy: 'idle' }, 'aaaa1111')
    writeLoopState(dir, { idleTicks: 0 }, 'bbbb2222')

    assert.equal(readLoopState(dir, 'aaaa1111').idleTicks, 4)
    assert.equal(readLoopState(dir, 'aaaa1111').pausedBy, 'idle')
    assert.equal(readLoopState(dir, 'bbbb2222').idleTicks, 0)
    assert.equal(readLoopState(dir, 'bbbb2222').pausedBy, undefined)

    // 写的是按 key 分开的文件，不是同一份。
    const a = JSON.parse(readFileSync(join(dir, '.agi', 'loop-state.aaaa1111.json'), 'utf8'))
    const b = JSON.parse(readFileSync(join(dir, '.agi', 'loop-state.bbbb2222.json'), 'utf8'))
    assert.equal(a.idleTicks, 4)
    assert.equal(b.idleTicks, 0)
  } finally {
    cleanup()
  }
})

test('多会话：没有 key 时仍读写旧的单文件（向后兼容）', () => {
  const { dir, cleanup } = workspace()
  try {
    writeLoopState(dir, { idleTicks: 2 })
    assert.equal(readLoopState(dir).idleTicks, 2)
    assert.ok(readFileSync(join(dir, '.agi', LOOP_STATE_FILE), 'utf8').includes('"idleTicks": 2'))
    // 带 key 的读不会看到单文件里的值。
    assert.equal(readLoopState(dir, 'zzzz9999').idleTicks, 0)
  } finally {
    cleanup()
  }
})

test('ensureIgnored: 追加两条规则，且只会追加一次', () => {
  const { dir, cleanup } = workspace()
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    assert.equal(ensureIgnored(dir), true)
    const once = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.match(once, /\.agi\/loop-state\*\.json/)
    assert.match(once, /\.agi\/BRIEF\.md/)
    assert.match(once, /^node_modules\/$/m)

    ensureIgnored(dir)
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), once)
  } finally {
    cleanup()
  }
})

test('ensureIgnored: 整个 .agi/ 已被忽略时不再追加', () => {
  const { dir, cleanup } = workspace()
  try {
    writeFileSync(join(dir, '.gitignore'), '.agi/re/\n.agi/\n')
    assert.equal(ensureIgnored(dir), true)
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.agi/re/\n.agi/\n')
  } finally {
    cleanup()
  }
})

test('renderBrief: 带 session 时声明这份摘要属于谁', () => {
  const { dir, cleanup } = workspace()
  try {
    const text = renderBrief({ cwd: dir, session: 'aaaa1111', state: { idleTicks: 1 } })
    assert.match(text, /> 会话 `aaaa1111` 的循环状态/)
    assert.match(text, /不在这里/)
    // 不带时不多这一行（旧的调用点行为不变）。
    assert.doesNotMatch(renderBrief({ cwd: dir, state: { idleTicks: 1 } }), /的循环状态。/)
  } finally {
    cleanup()
  }
})

test('budgetVerdict: 只有「快用完 + 在产出 + 没续太多次」才续', () => {
  const base = { roundsStarted: 80, maxGoalRounds: 100, idleTicks: 0, renewals: 0 }
  const renew = budgetVerdict(base)
  assert.equal(renew.renew, true)
  assert.equal(renew.nextRounds, 150)
  assert.match(renew.reason, /80\/100/)

  // 还没到 80%
  assert.equal(budgetVerdict({ ...base, roundsStarted: 79 }).renew, false)
  // 最近没有产出
  assert.equal(budgetVerdict({ ...base, idleTicks: 1 }).renew, false)
  // 已经续满两次
  assert.equal(budgetVerdict({ ...base, renewals: 2 }).renew, false)
  // 小预算通常是刻意设的
  assert.equal(budgetVerdict({ roundsStarted: 3, maxGoalRounds: 4 }).renew, false)
  // 没有上限 / 轮次未知都退化成不续，而不是抛错
  assert.equal(budgetVerdict({ roundsStarted: 5, maxGoalRounds: 0 }).renew, false)
  assert.equal(budgetVerdict({}).renew, false)
})

test('budgetVerdict: 小预算也至少加 20 轮', () => {
  const verdict = budgetVerdict({ roundsStarted: 8, maxGoalRounds: 10, idleTicks: 0, renewals: 0 })
  assert.equal(verdict.renew, true)
  assert.equal(verdict.step, 20)
  assert.equal(verdict.nextRounds, 30)
})

test('readLessons: 只取以「- 」开头的行，最新在后', () => {
  const { dir, cleanup } = workspace()
  try {
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(join(dir, '.agi', 'LESSONS.md'), [
      '# 教训',
      '',
      '这段说明不是条目。',
      '- 第一条',
      '  - 缩进的也算',
      '- 第二条',
      '',
    ].join('\n'))
    const lessons = readLessons(dir, 5)
    assert.deepEqual(lessons, ['第一条', '缩进的也算', '第二条'])
    assert.deepEqual(readLessons(dir, 1), ['第二条'])
    // 没有文件时是空数组，不抛。
    const other = workspace()
    assert.deepEqual(readLessons(other.dir), [])
    other.cleanup()
  } finally {
    cleanup()
  }
})

test('renderBrief: 有成本数据时给出「上次推进 / 上一轮用时 / 续期次数」', () => {
  const { dir, cleanup } = workspace()
  try {
    const text = renderBrief({
      cwd: dir,
      state: { idleTicks: 0, renewals: 1, lastGapMs: 4 * 60_000, lastProgressAt: Date.now() - 3 * 60_000 },
      roundsStarted: 12,
      maxGoalRounds: 150,
    })
    assert.match(text, /上次推进：\d+ 分钟前/)
    assert.match(text, /上一轮用了：4 分钟/)
    assert.match(text, /预算已续期：1 次/)
    // 没有数据时不写这几行，避免给读者「0 分钟」的错觉。
    const bare = renderBrief({ cwd: dir, state: { idleTicks: 0 } })
    assert.doesNotMatch(bare, /上一轮用了/)
    assert.doesNotMatch(bare, /预算已续期/)
  } finally {
    cleanup()
  }
})

test('renderBrief: 有 LESSONS.md 时附上「之前的目标留下的教训」', () => {
  const { dir, cleanup } = workspace()
  try {
    mkdirSync(join(dir, '.agi'), { recursive: true })
    writeFileSync(join(dir, '.agi', 'LESSONS.md'), '- 先跑 go build 再看 diff\n- 别信静态扫描的路径\n')
    const text = renderBrief({ cwd: dir, state: { idleTicks: 0 } })
    assert.match(text, /之前的目标留下的教训/)
    assert.match(text, /先跑 go build 再看 diff/)
    assert.match(text, /别信静态扫描的路径/)
  } finally {
    cleanup()
  }
})

// ── pruneLoopStates ────────────────────────────────────────────────────────────
//
// 真机症状：一个跑了十来天的工作区里积了 7 个 `loop-state.<8 位>.json`（每个
// 监督者会话一份），永不清理。这些文件被 .gitignore 盖住，所以版本库里看不见。

/** 写一个 loop-state 文件并把它 mtime 钉到 `minutesAgo` 分钟前。 */
function writeLoopStateAt(dir, name, minutesAgo, body = '{}\n') {
  const path = join(dir, '.agi', name)
  mkdirSync(join(dir, '.agi'), { recursive: true })
  writeFileSync(path, body, 'utf8')
  const when = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(path, when, when)
  return path
}

test('pruneLoopStates: 按 mtime 保留最近 5 个，其余删掉', () => {
  const { dir, cleanup } = workspace()
  try {
    const names = ['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005', 'ffff0006', 'gggg0007']
    // 名字顺序与时间顺序**故意相反**：名字越小的越旧。证明排序看 mtime 而不是文件名。
    names.forEach((key, index) => writeLoopStateAt(dir, `loop-state.${key}.json`, names.length - index))
    const { removed, kept } = pruneLoopStates(dir, { keep: 5 })

    assert.equal(kept.length, 5)
    assert.equal(removed.length, 2)
    // 最旧的两个（aaaa0001 / bbbb0002）被删，最新的五个留下。
    assert.deepEqual(removed.map(abs => basename(abs)).sort(), [
      'loop-state.aaaa0001.json',
      'loop-state.bbbb0002.json',
    ])
    assert.deepEqual(kept.map(abs => basename(abs)).sort(), [
      'loop-state.cccc0003.json',
      'loop-state.dddd0004.json',
      'loop-state.eeee0005.json',
      'loop-state.ffff0006.json',
      'loop-state.gggg0007.json',
    ])
    // 磁盘上真的只剩 5 个文件。
    assert.equal(readdirSync(join(dir, '.agi')).length, 5)
  } finally {
    cleanup()
  }
})

test('pruneLoopStates: keep_key 指定的那一份在 keep=1 时也不会被删', () => {
  const { dir, cleanup } = workspace()
  try {
    // 正在被这个进程使用的那份是**最旧的** —— 最坏情形：只按 mtime 排序必删它。
    const pinned = writeLoopStateAt(dir, 'loop-state.ffff0006.json', 60, '{"idleTicks":3}\n')
    writeLoopStateAt(dir, 'loop-state.aaaa0001.json', 1)
    writeLoopStateAt(dir, 'loop-state.bbbb0002.json', 2)

    const { removed, kept } = pruneLoopStates(dir, { keep: 1, keep_key: 'ffff0006' })

    assert.ok(kept.includes(pinned), 'keep_key 指向的状态文件必须无条件保留')
    assert.equal(existsSync(pinned), true)
    // 保留集合 = 最近 1 个（aaaa0001）+ pinned 这个被无条件留下的。
    assert.equal(kept.length, 2)
    assert.equal(removed.length, 1)
    assert.deepEqual(removed.map(abs => basename(abs)), ['loop-state.bbbb0002.json'])
    assert.equal(readFileSync(pinned, 'utf8'), '{"idleTicks":3}\n')
  } finally {
    cleanup()
  }
})

test('pruneLoopStates: 名字不匹配的文件一律不碰（含旧的无 key 单文件）', () => {
  const { dir, cleanup } = workspace()
  try {
    writeLoopStateAt(dir, 'loop-state.aaaa0001.json', 1)
    writeLoopStateAt(dir, 'loop-state.bbbb0002.json', 2)
    // 三种「长得像但不是」的东西：旧单文件、手工起的名字、位数不对。
    const legacy = writeLoopStateAt(dir, 'loop-state.json', 90)
    const manual = writeLoopStateAt(dir, 'loop-state.before-refactor.json', 91)
    const short = writeLoopStateAt(dir, 'loop-state.abc.json', 92)
    const unrelated = join(dir, '.agi', 'BRIEF.md')
    writeFileSync(unrelated, '# 循环摘要\n', 'utf8')

    const { removed, kept } = pruneLoopStates(dir, { keep: 1 })
    assert.deepEqual(removed.map(abs => basename(abs)), ['loop-state.bbbb0002.json'])
    for (const path of [legacy, manual, short, unrelated]) {
      assert.equal(existsSync(path), true, `${basename(path)} 不在清理范围内，必须原样保留`)
    }
    assert.equal(kept.length, 1)
  } finally {
    cleanup()
  }
})

test('pruneLoopStates: 目录不存在、keep 非法、cwd 非法都不抛', () => {
  const { dir, cleanup } = workspace()
  try {
    // 还没有 .agi/
    assert.deepEqual(pruneLoopStates(dir, { keep: 5 }), { removed: [], kept: [] })
    // cwd 非法
    assert.deepEqual(pruneLoopStates('', { keep: 5 }), { removed: [], kept: [] })
    assert.deepEqual(pruneLoopStates(undefined), { removed: [], kept: [] })
    // keep 非法值退回默认 5，而不是「删光」或抛错
    for (const index of [1, 2]) writeLoopStateAt(dir, `loop-state.aaaa000${index}.json`, index)
    const bad = pruneLoopStates(dir, { keep: Number.NaN })
    assert.equal(bad.removed.length, 0)
    assert.equal(bad.kept.length, 2)
  } finally {
    cleanup()
  }
})

// ── renderWorkerLines 的 known 三态 ───────────────────────────────────────────
//
// 真机症状：`.agi/BRIEF.md` 里 `persona-compose-review`（22 字符的手工目录名，
// 根本不是 session）显示「排队中，等空闲槽」，实际早就结束了。原因是 catalog 事实
// 从没传下来，`stage.js` 只能把「不在跑」判成 `queued`。

/** 取「## Worker 状态」段的第一条 worker 行。 */
function workerLine(cwd, workers) {
  const text = renderBrief({ cwd, workers })
  return text.split('\n').find(line => line.startsWith('- `')) ?? ''
}

test('renderWorkerLines: known=false 的历史目录渲染成 ended，不再说「排队中」', () => {
  const { dir, cleanup } = workspace()
  try {
    const line = workerLine(dir, [
      { id: 'persona-compose-review', running: false, known: false, report: { state: 'progress' } },
    ])
    assert.match(line, /persona-compose-review/)
    assert.match(line, /已收尾/)
    assert.doesNotMatch(line, /排队中/)
    assert.doesNotMatch(line, /空闲槽/)
  } finally {
    cleanup()
  }
})

test('renderWorkerLines: known=true 但没在跑，仍按旧行为判 queued', () => {
  const { dir, cleanup } = workspace()
  try {
    const line = workerLine(dir, [
      { id: 'aaaa1111', running: false, known: true, report: { state: 'progress' } },
    ])
    // 真 worker 只是当前没在跑 —— 它是「等空槽」，不是「已经没了」。
    assert.match(line, /排队中/)
    assert.doesNotMatch(line, /已收尾/)
  } finally {
    cleanup()
  }
})

test('renderWorkerLines: 不传 known（诊断脚本/旧调用）不改变既有判定', () => {
  const { dir, cleanup } = workspace()
  try {
    const withoutKnown = workerLine(dir, [{ id: 'aaaa1111', running: false, report: { state: 'progress' } }])
    const withUndefined = workerLine(dir, [
      { id: 'aaaa1111', running: false, known: undefined, report: { state: 'progress' } },
    ])
    // 关键回归点：`undefined` 不能被当成 `false`，否则所有不查 catalog 的调用方
    // （面板、诊断脚本）都会把 worker 判成已结束。
    assert.match(withoutKnown, /排队中/)
    assert.equal(withoutKnown, withUndefined)
  } finally {
    cleanup()
  }
})

test('renderWorkerLines: known=false 也不能遮蔽 archived / dropped 的 action', () => {
  const { dir, cleanup } = workspace()
  try {
    // ended 是 first-match-wins 的第一条，但它是从「不在 catalog 里」**推断**出来
    // 的；archived 与 dropped 是**事实**。事实优先于推断 —— 否则已验收的 worker
    // 会从「已验收归档」退化成只说「已收尾」，读的人看不出「Lead 验过它」。
    const archived = workerLine(dir, [
      { id: 'aaaa1111', running: false, known: false, archived: true, report: { state: 'ready' } },
    ])
    assert.doesNotMatch(archived, /排队中/)
    assert.match(archived, /已验收归档/, '已归档的 worker 必须保留「已验收归档」，不能被推断的 ended 盖成只说「已收尾」')
    assert.doesNotMatch(archived, /已收尾，不再归监督者管/)

    const dropped = workerLine(dir, [
      { id: 'bbbb2222', running: false, known: false, report: { state: 'dropped' } },
    ])
    assert.doesNotMatch(dropped, /排队中/)
    assert.match(dropped, /无需处理/, 'worker 自述 dropped 的必须保留「无需处理」，不能被推断的 ended 盖掉')

    // 对照：既没归档也没自述 dropped，只是不在 catalog 里 → 才该落到推断的 ended。
    const residual = workerLine(dir, [
      { id: 'cccc3333', running: false, known: false, report: { state: 'progress' } },
    ])
    assert.match(residual, /已收尾，不再归监督者管/)
  } finally {
    cleanup()
  }
})

// ── 行尾的验收契约标记 ────────────────────────────────────────────────────────
//
// 派发时写了 `done_when`，worker 目录里就有 `expect.json`；没写就没有。监督者读
// BRIEF 时该一眼看出「这一条交付的验收是我写的，还是只剩 worker 自述」。没人写
// done_when 的那一行必须有标记 —— 否则「全绿」看起来都一样绿。

/** 在 worker 目录里放一份 expect.json（只要文件在，标记就不出现）。 */
function plantExpect(dir, sessionId) {
  const target = join(dir, '.agi', 'subagents', sessionId)
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'expect.json'),
    JSON.stringify({ worker: sessionId, declaredAt: '2026-11-01T00:00:00.000Z', items: [{ id: 'e1', text: '跑通' }] }),
    'utf8',
  )
}

test('renderWorkerLines: 没有 expect.json 的 worker 行尾标「无验收契约」', () => {
  const { dir, cleanup } = workspace()
  try {
    const line = workerLine(dir, [{ id: 'aaaa1111', running: true, known: true, report: { state: 'progress' } }])
    assert.match(line, /（无验收契约）$/, '没有派发时验收的 worker，行尾必须说出来')
  } finally {
    cleanup()
  }
})

test('renderWorkerLines: 有 expect.json 的 worker 行不加噪音', () => {
  const { dir, cleanup } = workspace()
  try {
    plantExpect(dir, 'aaaa1111')
    const line = workerLine(dir, [{ id: 'aaaa1111', running: true, known: true, report: { state: 'progress' } }])
    assert.doesNotMatch(line, /无验收契约/)
    assert.match(line, /aaaa1111/)
  } finally {
    cleanup()
  }
})

test('renderWorkerLines: 调用方显式给的 expect 判定优先于目录扫', () => {
  const { dir, cleanup } = workspace()
  try {
    // 目录里没有 expect.json，但调用方（真机上从 ledger 拿到的事实）说这次有契约。
    const trusted = workerLine(dir, [
      { id: 'aaaa1111', running: true, known: true, expect: true, report: { state: 'progress' } },
    ])
    assert.doesNotMatch(trusted, /无验收契约/)

    plantExpect(dir, 'bbbb2222')
    const denied = workerLine(dir, [
      { id: 'bbbb2222', running: true, known: true, expect: false, report: { state: 'progress' } },
    ])
    assert.match(denied, /（无验收契约）$/, '显式 false 必须压过目录里的文件')
  } finally {
    cleanup()
  }
})

