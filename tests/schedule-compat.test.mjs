/**
 * 宿主 `schedule` 服务两代接口的适配测试。
 *
 * 这里的每条用例都对应一次真实的静默失效：旧签名下 `create` 抛错、`delete`
 * 根本不存在、`list` 不认会话，而三个调用点都在 `try/catch` 里，于是兜底
 * 一次都没成功、日志只有一行 warn。所以测试的重点不是「能建出来」，而是
 * **两代签名各自被正确选中**、以及「不属于本会话的任务绝不动」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ensureReminder,
  ensureReminderRemoved,
  listSessionReminders,
} from '../lib/schedule-compat.js'

/**
 * 造一份新版宿主服务：`create(request, actorSessionId, signal)`、
 * `catalog()`、`edit({ id, action })`，并且**故意不提供** `delete`。
 *
 * @param {object[]} [tasks] 已有任务
 * @returns {object} 假服务，带 `calls` 记录调用顺序
 */
function modernSchedule(tasks = []) {
  const calls = []
  const rows = [...tasks]
  return {
    calls,
    rows,
    async create(request, actorSessionId) {
      calls.push(['create', request, actorSessionId])
      rows.push({
        id: 'created-1',
        title: request.title,
        status: 'active',
        scheduledAt: new Date(Date.now() + request.timing.after_seconds * 1000).toISOString(),
        target: request.target,
      })
      return rows.at(-1)
    },
    async catalog() {
      calls.push(['catalog'])
      return rows
    },
    async edit(request, actorSessionId) {
      calls.push(['edit', request, actorSessionId])
      return { id: request.id, deleted: true }
    },
  }
}

/**
 * 造一份旧版宿主服务：`create(sessionId, request, signal)`、`list({ sessionId })`
 * 直接返回数组、`delete({ sessionId, id })` 存在。
 *
 * @returns {object} 假服务，带 `calls` 记录调用顺序
 */
function legacySchedule() {
  const calls = []
  const rows = [{ id: 'old-1', title: '旧兜底', scheduledAt: new Date(1000).toISOString() }]
  return {
    calls,
    async create(sessionId, request) {
      calls.push(['create', sessionId, request])
      return { id: 'legacy-created' }
    },
    async list(request) {
      calls.push(['list', request])
      return rows
    },
    async delete(request) {
      calls.push(['delete', request])
      return { deleted: true }
    },
  }
}

test('新版接口：create 用请求对象 + session target，而不是把会话 id 塞进第一个位置参数', async () => {
  const schedule = modernSchedule()
  const created = await ensureReminder(schedule, 'session-a', {
    title: '兜底',
    prompt: '继续',
    afterSeconds: 90,
  })
  assert.equal(created.id, 'created-1')
  const [name, request, actor] = schedule.calls[0]
  assert.equal(name, 'create')
  assert.equal(actor, 'session-a')
  assert.equal(request.title, '兜底')
  assert.deepEqual(request.timing, { kind: 'after', after_seconds: 90 })
  assert.deepEqual(request.target, { kind: 'session', sessionId: 'session-a' })
})

test('旧版接口：仍按 (sessionId, request) 调用，不发新形态的请求对象', async () => {
  const schedule = legacySchedule()
  const created = await ensureReminder(schedule, 'session-b', {
    title: '兜底',
    prompt: '继续',
    afterSeconds: 7,
  })
  assert.equal(created.id, 'legacy-created')
  const [name, sessionId, request] = schedule.calls[0]
  assert.equal(name, 'create')
  assert.equal(sessionId, 'session-b')
  assert.equal(request.after_seconds, 7)
  assert.equal(request.timing, undefined)
})

test('秒数被夹到正整数：0 或负数不能变成「立刻无限循环」的提醒', async () => {
  const schedule = modernSchedule()
  await ensureReminder(schedule, 'session-a', { title: 't', prompt: 'p', afterSeconds: 0 })
  assert.deepEqual(schedule.calls[0][1].timing, { kind: 'after', after_seconds: 1 })
  await ensureReminder(schedule, 'session-a', { title: 't', prompt: 'p', afterSeconds: -30.6 })
  assert.deepEqual(schedule.calls[1][1].timing, { kind: 'after', after_seconds: 1 })
})

test('列提醒只认本会话：别的会话与 new_once 任务一律不算自己排的', async () => {
  const schedule = modernSchedule([
    { id: 'mine', title: '我的', status: 'active', scheduledAt: '2026-11-09T08:00:00.000Z', target: { kind: 'session', sessionId: 'session-a' } },
    { id: 'other', title: '别人的', status: 'active', scheduledAt: '2026-11-09T08:00:00.000Z', target: { kind: 'session', sessionId: 'session-b' } },
    { id: 'fresh', title: '每次开新会话', status: 'active', scheduledAt: '2026-11-09T08:00:00.000Z', target: { kind: 'new_once' } },
    { id: 'ended', title: '已结束', status: 'ended', scheduledAt: '2026-11-09T08:00:00.000Z', target: { kind: 'session', sessionId: 'session-a' } },
  ])
  const rows = await listSessionReminders(schedule, 'session-a')
  assert.deepEqual(rows.map(row => row.id), ['mine'])
  assert.equal(rows[0].scheduledAt, Date.parse('2026-11-09T08:00:00.000Z'))
})

test('旧版列提醒走 list({ sessionId }) 并原样映射数组结果', async () => {
  const schedule = legacySchedule()
  const rows = await listSessionReminders(schedule, 'session-b')
  assert.deepEqual(schedule.calls[0], ['list', { sessionId: 'session-b' }])
  assert.deepEqual(rows.map(row => row.id), ['old-1'])
})

test('新版撤提醒走 edit({ action: "delete" })：宿主已经没有 delete 这个方法了', async () => {
  const schedule = modernSchedule()
  assert.equal(schedule.delete, undefined)
  await ensureReminderRemoved(schedule, 'session-a', 'row-9')
  const [name, request, actor] = schedule.calls[0]
  assert.equal(name, 'edit')
  assert.deepEqual(request, { id: 'row-9', action: 'delete' })
  assert.equal(actor, 'session-a')
})

test('旧版撤提醒走 delete({ sessionId, id })', async () => {
  const schedule = legacySchedule()
  await ensureReminderRemoved(schedule, 'session-b', 'row-1')
  assert.deepEqual(schedule.calls[0], ['delete', { sessionId: 'session-b', id: 'row-1' }])
})

test('接口缺失时列提醒返回空数组，而不是抛给对账', async () => {
  assert.deepEqual(await listSessionReminders(undefined, 'session-a'), [])
  assert.deepEqual(await listSessionReminders({}, 'session-a'), [])
})

/**
 * 复刻宿主 `validateTiming` 的校验：timing 必须恰好是 `{ kind, 对应选择器 }` 两个
 * 键，少了 kind 会抛 `invalid_rule`。
 *
 * 这条测试是为了 0.22.4 那次漏网：签名换对了、`kind` 没带，宿主抛错又被
 * `try/catch` 吞成一行 warn，于是「修好之后仍然不 arm」，只能靠人工重启才发现。
 * 现在把这个形状钉死，改坏了本地就红。
 *
 * @param {object} timing 待校验的 timing 对象
 * @returns {void} 形状不符时抛错
 */
function requireHostTiming(timing) {
  const selectors = {
    after: 'after_seconds',
    at: 'at',
    every: 'every_seconds',
    daily: 'daily',
    weekly: 'weekly',
    cron: 'cron',
    rrule: 'rrule',
  }
  const selector = selectors[timing?.kind]
  if (selector === undefined) throw new Error('timing must contain exactly kind and its matching selector.')
  const keys = Object.keys(timing).sort()
  assert.deepEqual(keys, ['kind', selector].sort())
}

test('新形体必须过宿主的 validateTiming：kind 判别键不能省', async () => {
  const schedule = modernSchedule()
  await ensureReminder(schedule, 'session-a', { title: '兜底', prompt: '继续', afterSeconds: 42 })
  requireHostTiming(schedule.calls[0][1].timing)
  assert.deepEqual(schedule.calls[0][1].timing, { kind: 'after', after_seconds: 42 })
})
