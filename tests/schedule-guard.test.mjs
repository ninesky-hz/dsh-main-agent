/**
 * 守住 schedule 层的「自判定让位」：
 *
 *  - `agi-schedule`（`@deepseek-ai/dsh-schedule`）单独放在
 *    `patches/schedule.patch.yml` 这一层，并带一个 `!!js` 守卫；
 *  - 守卫的语义是「loader 里已有**别的生效中**的同模块提供者 ⇒ 本行自动禁用」，
 *    同时排除自己（`e.options.id !== 'agi-schedule'`）并且不把「对方自己也被
 *    禁用」误判成让位（`!e.disabled`）；
 *  - 全新 profile（没有别的提供者）时守卫必须求值为 false —— 一行都不能少，
 *    监督者的定时提醒依赖 schedule 服务。
 *
 * 为什么需要它：schedule 服务每进程只能注册一次，重复注册会抛
 *   service "schedule" has been registered at <ScheduleService>
 * 用户在 UI 里看到的就是 `1 entry did not activate`。此前只能在 profile 的
 * cordis.patch.yml 里手写 id 级 `disabled: true` 压制。
 *
 * 注意 `!!js` 表达式在 `--dump-config` 里是**原样打印、不求值**的，所以
 * 「这条守卫在某个 profile 上到底禁没禁用」只能靠本文件这样的求值，或真启动
 * 的 stderr 来判定。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '')

const manifest = JSON.parse(read(join(ROOT, 'package.json')))
const PATCH_LIST = manifest.dsh?.bundle?.patch ?? []

const SCHEDULE_PATCH = read(join(ROOT, 'patches', 'schedule.patch.yml'))
const HOST_PATCH = read(join(ROOT, 'cordis.patch.yml'))

/** Rows of an entry-list patch file as `{ id, name, text }`. */
function rows(source) {
  const lines = source.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^\s*- id: (\S+)\s*$/.exec(lines[index])
    if (!start) continue
    let end = index + 1
    while (end < lines.length && !/^\s*- id: /.test(lines[end])) end += 1
    const text = lines.slice(index, end).join('\n')
    const name = /^\s*name: '([^']+)'/m.exec(text)?.[1]
    found.push({ id: start[1], name, text })
  }
  return found
}

/** The `!!js` source of a row's `disabled`, folded the way YAML `>-` folds it. */
function guardSource(rowText) {
  const lines = rowText.split('\n')
  const at = lines.findIndex((line) => /^\s*disabled: !!js >-\s*$/.test(line))
  if (at < 0) return undefined
  const indent = /^\s*/.exec(lines[at])[0].length
  const body = []
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') break
    if (/^\s*/.exec(line)[0].length <= indent) break
    body.push(line.trim())
  }
  return body.join(' ')
}

/** Same `with (ctx)` evaluation the Loader uses for a `!!js` `disabled`. */
const evaluate = new Function('ctx', 'expr', 'with (ctx) {\n  return eval(expr)\n}')

/**
 * The Loader's rule: a `!!js` node evaluates against the entry context,
 * anything else is coerced with `Boolean()`.
 */
function isDisabled(source, entries) {
  const guard = guardSource(source)
  if (guard === undefined) {
    return Boolean(/^\s*disabled: (true|false)\s*$/m.exec(source)?.[1] === 'true')
  }
  return Boolean(evaluate({ loader: { entries: () => entries } }, guard))
}

const entryOf = (id, name, disabled = false) => ({ options: { id, name }, disabled })

const OTHER_SCHEDULE = entryOf('schedule', '@deepseek-ai/dsh-schedule')
const OWN_ROW = entryOf('agi-schedule', '@deepseek-ai/dsh-schedule')

test('schedule 行单独成层，且排在 preset 声明层之前', () => {
  assert.ok(
    PATCH_LIST.includes('./patches/schedule.patch.yml'),
    'dsh.bundle.patch 必须包含 schedule 层',
  )
  assert.ok(
    PATCH_LIST.indexOf('./patches/schedule.patch.yml') < PATCH_LIST.indexOf('./presets/main-agent.patch.yml'),
    'schedule 层应当列在 preset 声明层之前',
  )
  assert.ok(PATCH_LIST.includes('./cordis.patch.yml'), 'host 层不能从清单里消失')
})

test('schedule 行只声明一次，且从 host 层搬走后不再重复', () => {
  const all = []
  for (const file of PATCH_LIST) all.push(...rows(read(join(ROOT, file))))
  const scheduleRows = all.filter((row) => row.id === 'agi-schedule')
  assert.equal(scheduleRows.length, 1, 'agi-schedule 只能声明一次')
  assert.equal(scheduleRows[0].name, '@deepseek-ai/dsh-schedule')
  assert.ok(!rows(HOST_PATCH).some((row) => row.id === 'agi-schedule'), 'host 层不该再留 schedule 行')
  assert.ok(rows(HOST_PATCH).some((row) => row.id === 'agi-supervisor-setup'), 'host 层保留 setup 行')
})

test('schedule 行的 disabled 是 !!js 守卫，不再是 id 级压制', () => {
  const [row] = rows(SCHEDULE_PATCH).filter((candidate) => candidate.id === 'agi-schedule')
  assert.ok(row, '未找到 agi-schedule 行')
  assert.ok(!/^\s*disabled: true\s*$/m.test(row.text), '不该再用字面 disabled: true')
  const source = guardSource(row.text)
  assert.ok(source, 'disabled 应当是一个 !!js 表达式')
  assert.match(source, /e\.options\.name === '@deepseek-ai\/dsh-schedule'/, '必须比较模块名')
  assert.match(source, /e\.options\.id !== 'agi-schedule'/, '必须排除自己')
  assert.match(source, /!e\.disabled/, '对方自己被禁用时不能让位，否则整个 profile 会失去 schedule')
  assert.match(source, /ctx\.loader\.entries\(\)/, '必须遍历 loader 里的所有行')
})

test('守卫在「已有别的生效中的 schedule 提供者」时求值为 true', () => {
  assert.equal(isDisabled(SCHEDULE_PATCH, [OTHER_SCHEDULE, OWN_ROW]), true)
  assert.equal(isDisabled(SCHEDULE_PATCH, [OTHER_SCHEDULE, entryOf('other', 'dsh-x'), OWN_ROW]), true)
})

test('守卫在「没有别的提供者」时求值为 false（全新安装必须保住 schedule）', () => {
  assert.equal(isDisabled(SCHEDULE_PATCH, [OWN_ROW]), false)
  assert.equal(isDisabled(SCHEDULE_PATCH, []), false)
  assert.equal(
    isDisabled(SCHEDULE_PATCH, [entryOf('time-context', '@deepseek-ai/dsh-time-context'), OWN_ROW]),
    false,
    '同前缀的别的包不算提供者',
  )
})

test('守卫不把「对方自己也被禁用」误判成让位', () => {
  const paused = entryOf('schedule', '@deepseek-ai/dsh-schedule', true)
  assert.equal(isDisabled(SCHEDULE_PATCH, [paused, OWN_ROW]), false)
})

test('守卫排除自己：同 id 的同名行不会让它自我禁用', () => {
  assert.equal(isDisabled(SCHEDULE_PATCH, [OWN_ROW, entryOf('agi-schedule', '@deepseek-ai/dsh-schedule')]), false)
})

test('负向对照：守卫换成字面 false 时，冲突场景的断言必须失败', () => {
  const conflict = [OTHER_SCHEDULE, OWN_ROW]
  const assertYields = (source) => assert.equal(isDisabled(source, conflict), true)
  assertYields(SCHEDULE_PATCH)
  assert.throws(
    () => assertYields('- insert:\n    - id: agi-schedule\n      name: \'@deepseek-ai/dsh-schedule\'\n      disabled: false\n'),
    '字面 disabled: false 必须复现冲突（否则这条测试没有守住任何东西）',
  )
})
