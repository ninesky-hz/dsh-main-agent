import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readChecks, runChecks } from '../lib/checks.js'

const WORKER = 'sub-abc123'

const withDir = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-checks-'))
  try {
    return await fn(dir)
  } finally {
    // 刚跑完的命令可能还占着 cwd，Windows 上重试几次再放弃。
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const writeChecks = (dir, sessionId, payload) => {
  const target = join(dir, '.agi', 'subagents', sessionId)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'checks.json'), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
}

test('readChecks：没有清单时报告 error 而不是空列表', () => withDir(dir => {
  const read = readChecks(dir, WORKER)
  assert.deepEqual(read.entries, [])
  assert.match(read.error, /没有写 checks\.json/)
  assert.ok(read.path.endsWith(join('.agi', 'subagents', WORKER, 'checks.json')))
}))

test('readChecks：坏 JSON 给出可读原因', () => withDir(dir => {
  writeChecks(dir, WORKER, '{ not json')
  const read = readChecks(dir, WORKER)
  assert.deepEqual(read.entries, [])
  assert.match(read.error, /不是合法 JSON/)
}))

test('readChecks：数组与 { checks } 两种形状都接受，非对象条目被丢掉', () => withDir(dir => {
  writeChecks(dir, WORKER, [{ id: 'a', note: 'x' }, 'junk', null, 42])
  assert.deepEqual(readChecks(dir, WORKER).entries.map(entry => entry.id), ['a'])

  writeChecks(dir, WORKER, { checks: [{ id: 'b', note: 'y' }] })
  assert.deepEqual(readChecks(dir, WORKER).entries.map(entry => entry.id), ['b'])

  writeChecks(dir, WORKER, { other: [] })
  assert.match(readChecks(dir, WORKER).error, /必须是数组/)
}))

test('runChecks：cmd 按退出码判定，失败时带 stderr', () => withDir(async dir => {
  const results = await runChecks([
    { id: 'ok', cmd: 'echo hello' },
    { id: 'bad', cmd: 'exit 3' },
  ], { cwd: dir })
  assert.equal(results.length, 2)
  assert.equal(results[0].status, 'pass')
  assert.match(results[0].detail, /exit 0/)
  assert.equal(results[1].status, 'fail')
  assert.match(results[1].detail, /期望 0/)
}))

test('runChecks：expectExit 可以翻转期望', () => withDir(async dir => {
  const [result] = await runChecks([{ id: 'grep-like', cmd: 'exit 2', expectExit: 2 }], { cwd: dir })
  assert.equal(result.status, 'pass')
}))

test('runChecks：expectStdout 是子串匹配，缺了就失败', () => withDir(async dir => {
  const results = await runChecks([
    { id: 'hit', cmd: 'echo token-abc', expectStdout: 'token-abc' },
    { id: 'miss', cmd: 'echo other', expectStdout: 'token-abc' },
  ], { cwd: dir })
  assert.equal(results[0].status, 'pass')
  assert.equal(results[1].status, 'fail')
  assert.match(results[1].detail, /输出里没有/)
}))

test('runChecks：命令超时被记成失败而不是挂住', () => withDir(async dir => {
  const [result] = await runChecks(
    [{ id: 'slow', cmd: 'ping -n 10 127.0.0.1', timeoutMs: 400 }],
    { cwd: dir },
  )
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /超时/)
}))

test('runChecks：file 检查覆盖存在、缺失、contains、notContains', () => withDir(async dir => {
  writeFileSync(join(dir, 'a.txt'), 'hello world', 'utf8')
  const results = await runChecks([
    { id: 'exists', file: 'a.txt' },
    { id: 'missing', file: 'nope.txt' },
    { id: 'unexpected', file: 'nope.txt', exists: false },
    { id: 'has', file: 'a.txt', contains: 'world' },
    { id: 'lacks', file: 'a.txt', contains: 'absent' },
    { id: 'clean', file: 'a.txt', notContains: 'absent' },
    { id: 'dirty', file: 'a.txt', notContains: 'hello' },
  ], { cwd: dir })
  assert.deepEqual(results.map(result => result.status), ['pass', 'fail', 'pass', 'pass', 'fail', 'pass', 'fail'])
}))

test('runChecks：note 永远算 manual，未知条目算 error', () => withDir(async dir => {
  const results = await runChecks([
    { id: 'human', note: '截图里按钮文案已改' },
    { id: 'weird', foo: 'bar' },
  ], { cwd: dir })
  assert.equal(results[0].status, 'manual')
  assert.equal(results[1].status, 'error')
  // 人工项不进通过计数 —— 这是这个功能存在的意义，不能被「看起来没问题」糊过去。
  assert.equal(results.filter(result => result.status === 'pass').length, 0)
}))

test('runChecks：缺 id 时用位置编号，不丢条目', () => withDir(async dir => {
  const results = await runChecks([{ note: 'a' }, { note: 'b' }], { cwd: dir })
  assert.deepEqual(results.map(result => result.id), ['#1', '#2'])
}))

test('runChecks：命令自带双引号时不被二次转义', () => withDir(async dir => {
  // Windows 上 Node 默认会给含空格的参数再套一层双引号，而 `node -e "..."` 的源码
  // 本身就带引号 —— 两层叠起来会被 cmd.exe 解析坏。表现是 `SyntaxError: Invalid or
  // unexpected token`，更阴的是退出码有时仍是 0，于是验收项通过与否全凭运气。
  // 验收清单里这种写法极常见（断言文件里有没有某个字符串），所以在这里钉死。
  const results = await runChecks([
    { id: 'doubled', cmd: `node -e "console.log('QUOTED-OK')"` },
    { id: 'cjk', cmd: `node -e "console.log('中文-OK')"` },
    { id: 'expect-out', cmd: `node -e "console.log('MARK')"`, expectStdout: 'MARK' },
  ], { cwd: dir, timeoutMs: 30_000 })
  assert.deepEqual(results.map(result => result.status), ['pass', 'pass', 'pass'])
  assert.deepEqual(results.map(result => result.id), ['doubled', 'cjk', 'expect-out'])
}))
