/**
 * dsh-main-agent — worker 验收清单的读取与执行（纯逻辑，不碰 ctx）。
 *
 * 目前 worker 的产出是一份 `outcome.md`，父代理醒来后读它、再「亲眼核验」。
 * 这条路径的问题是核验全靠人（模型）的记忆与注意力：跑了哪些命令、退出码是
 * 不是 0、文件到底有没有落地，读完就只剩一句「我核过了」。
 *
 * 所以给 worker 一个结构化的旁路：`.agi/subagents/<session id>/checks.json`。
 * 里面每条是机器可判定的断言，父代理用一个工具调用把它们全部跑完，拿到
 * 通过/失败/人工 三类结果。写不出清单不影响 worker 工作，只是父代理少一层
 * 证据来源。
 *
 * 三种条目：
 *   { "id": "build", "cmd": "go build ./...", "expectExit": 0 }
 *   { "id": "route", "file": "internal/api/router.go", "contains": "/api/u/:code" }
 *   { "id": "ui", "note": "截图里按钮文案已改" }   // 人工项，永远不算通过
 *
 * 清单是**不可信输入**：它由 subagent 生成，只当作数据执行 —— `cmd` 会被
 * 真的跑起来，所以这里给每条加超时和输出上限，并始终在父代理的工作区里跑。
 *
 * 这个文件刻意不 import 任何宿主包：工具注册在 `checks-tool.js`，这样测试
 * 能在没有 node_modules 的仓库里直接跑纯函数。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 单条检查的默认超时。够跑构建，又不至于让一条卡死的命令拖住整个验收。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** 每条结果里保留的输出长度上限。 */
export const OUTPUT_TAIL = 2_000

const isNonEmptyString = value => typeof value === 'string' && value.length > 0

/**
 * 读一个 worker 的验收清单。
 *
 * @param {string} cwd 父代理的工作区
 * @param {string} sessionId worker 的 session id
 * @returns {{ entries: object[], path: string, error?: string }}
 */
export function readChecks(cwd, sessionId) {
  const path = join(resolve(cwd), '.agi', 'subagents', sessionId, 'checks.json')
  if (!existsSync(path)) {
    return { entries: [], path, error: '这个 worker 没有写 checks.json' }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { entries: [], path, error: `checks.json 不是合法 JSON：${error?.message ?? error}` }
  }
  // 允许直接写数组，也允许包一层 { checks: [...] }（后者更像人会写的样子）。
  const entries = Array.isArray(parsed) ? parsed : parsed?.checks
  if (!Array.isArray(entries)) {
    return { entries: [], path, error: 'checks.json 必须是数组，或含 checks 数组的对象' }
  }
  return { entries: entries.filter(entry => entry !== null && typeof entry === 'object'), path }
}

const tail = text => {
  const trimmed = typeof text === 'string' ? text.trimEnd() : ''
  return trimmed.length <= OUTPUT_TAIL ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL)}`
}

const shellFor = () => (process.platform === 'win32'
  ? { command: 'cmd.exe', flag: '/c' }
  : { command: '/bin/sh', flag: '-c' })

/**
 * 跑一条 `cmd` 检查。
 *
 * @returns {Promise<object>} 结果记录
 */
function runCommand(id, entry, cwd, signal, timeoutMs) {
  const expectExit = Number.isInteger(entry.expectExit) ? entry.expectExit : 0
  const limit = Number.isInteger(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : timeoutMs
  const { command, flag } = shellFor()

  return new Promise(done => {
    let settled = false
    let timer
    const finish = record => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(record)
    }
    const child = spawn(command, [flag, entry.cmd], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Windows 下 Node 默认会给「含空格的参数」套一层双引号。而 `entry.cmd`
      // 自己经常已经带引号（`node -e "..."`、`set "X=..."`），两层引号叠在
      // 一起会被 cmd.exe 解析坏：node 收到的源码引号被剥掉，报
      // `SyntaxError: Invalid or unexpected token`。实测更阴的是这种情况退出码
      // 有时仍是 0，于是验收项「到底通过了没有」全凭运气（见 NOTES 里
      // 2026-11-01 那条坑）。verbatim 让参数原样拼进命令行，交给 cmd 自己解析。
      windowsVerbatimArguments: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    let timedOut = false
    const killTree = () => {
      // Windows 上 cmd.exe 只是外壳，真正干活的是它的子进程；只杀外壳会留下
      // 孤儿占着工作目录，调用方删临时目录时会 EBUSY。整棵树一起杀。
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        return
      }
      child.kill()
    }
    timer = setTimeout(() => {
      timedOut = true
      killTree()
      // 等 close 再收尾：进程被杀之后仍可能短暂占着工作目录，提前返回会让
      // 调用方在下一条检查里撞上 EBUSY；同时留一个兜底，close 不来也能返回。
      setTimeout(() => finish({
        id,
        kind: 'cmd',
        status: 'fail',
        detail: `超时（${limit} ms）：${entry.cmd}`,
        stderr: tail(stderr),
      }), 2_000)
    }, limit)

    const onAbort = () => {
      killTree()
      finish({ id, kind: 'cmd', status: 'error', detail: '被调用方取消' })
    }
    signal?.addEventListener?.('abort', onAbort)

    child.on('error', error => {
      signal?.removeEventListener?.('abort', onAbort)
      finish({ id, kind: 'cmd', status: 'error', detail: `无法启动命令：${error?.message ?? error}` })
    })
    child.on('close', code => {
      signal?.removeEventListener?.('abort', onAbort)
      if (timedOut) {
        finish({
          id,
          kind: 'cmd',
          status: 'fail',
          detail: `超时（${limit} ms）：${entry.cmd}`,
          stderr: tail(stderr),
        })
        return
      }
      const passed = code === expectExit
      // `expectStdout` 是有意做成子串而不是正则：清单由模型生成，正则写错的
      // 代价是「检查悄悄永远通过」，子串写错至少会失败。
      const wantsOut = isNonEmptyString(entry.expectStdout)
      const outOk = !wantsOut || stdout.includes(entry.expectStdout)
      finish({
        id,
        kind: 'cmd',
        status: passed && outOk ? 'pass' : 'fail',
        detail: passed
          ? (outOk ? `exit ${code}：${entry.cmd}` : `exit ${code}，但输出里没有「${entry.expectStdout}」`)
          : `exit ${code}（期望 ${expectExit}）：${entry.cmd}`,
        ...(passed && outOk ? {} : { stderr: tail(stderr), stdout: tail(stdout) }),
      })
    })
  })
}

/** 跑一条 `file` 检查。 */
function runFileCheck(id, entry, cwd) {
  const target = join(cwd, entry.file)
  const wantsExists = entry.exists === undefined ? true : entry.exists === true
  const present = existsSync(target)
  if (present !== wantsExists) {
    return {
      id,
      kind: 'file',
      status: 'fail',
      detail: wantsExists ? `文件不存在：${entry.file}` : `文件不该存在但存在：${entry.file}`,
    }
  }
  if (!present) return { id, kind: 'file', status: 'pass', detail: `确认不存在：${entry.file}` }

  let content
  try {
    content = readFileSync(target, 'utf8')
  } catch (error) {
    return { id, kind: 'file', status: 'error', detail: `读不了 ${entry.file}：${error?.message ?? error}` }
  }
  if (isNonEmptyString(entry.contains) && !content.includes(entry.contains)) {
    return { id, kind: 'file', status: 'fail', detail: `${entry.file} 里没有「${entry.contains}」` }
  }
  if (isNonEmptyString(entry.notContains) && content.includes(entry.notContains)) {
    return { id, kind: 'file', status: 'fail', detail: `${entry.file} 里仍有「${entry.notContains}」` }
  }
  return { id, kind: 'file', status: 'pass', detail: `符合预期：${entry.file}` }
}

/**
 * 逐条执行。
 *
 * @param {object[]} entries `readChecks` 返回的条目
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<object[]>} 结果记录
 */
export async function runChecks(entries, { cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const results = []
  for (const [index, entry] of entries.entries()) {
    const id = isNonEmptyString(entry.id) ? entry.id : `#${index + 1}`
    if (typeof entry.note === 'string') {
      results.push({ id, kind: 'note', status: 'manual', detail: entry.note })
      continue
    }
    if (isNonEmptyString(entry.cmd)) {
      results.push(await runCommand(id, entry, cwd, signal, timeoutMs))
      continue
    }
    if (isNonEmptyString(entry.file)) {
      results.push(runFileCheck(id, entry, cwd))
      continue
    }
    results.push({ id, kind: 'unknown', status: 'error', detail: '这条检查既不是 cmd，也不是 file 或 note' })
  }
  return results
}

/** 一条结果适合给人看的一行（带输出尾部）。 */
export const describe = result => {
  const mark = result.status === 'pass' ? '✓' : (result.status === 'manual' ? '·' : '✗')
  const lines = [`${mark} ${result.id} — ${result.detail}`]
  if (isNonEmptyString(result.stderr)) lines.push(`  stderr: ${result.stderr.split('\n').slice(-8).join('\n  ')}`)
  if (isNonEmptyString(result.stdout)) lines.push(`  stdout: ${result.stdout.split('\n').slice(-8).join('\n  ')}`)
  return lines.join('\n')
}
