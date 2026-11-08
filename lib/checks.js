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
 *   { "id": "build", "cmd": "go build ./...", "expectExit": 0, "expect": ["e1"] }
 *   { "id": "route", "file": "internal/api/router.go", "contains": "/api/u/:code" }
 *   { "id": "ui", "note": "截图里按钮文案已改" }   // 人工项，永远不算通过
 *
 * 条目可选带一个 `expect: ["e1", "e3"]`，声明它证明了派发时写死的那几条验收
 * （`expect.json`，见下面的 `readExpect` / `verifyExpect`）。这是 worker 的
 * **弱声明**：它可以把任意检查挂到任意 `eN` 上，所以覆盖判据同时要求那条检查
 * 真的通过。
 *
 * 清单是**不可信输入**：它由 subagent 生成，只当作数据执行 —— `cmd` 会被
 * 真的跑起来，所以这里给每条加超时和输出上限，并始终在父代理的工作区里跑。
 *
 * 这个文件刻意不 import 任何宿主包：工具注册在 `checks-tool.js`，这样测试
 * 能在没有 node_modules 的仓库里直接跑纯函数。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 单条检查的默认超时。够跑构建，又不至于让一条卡死的命令拖住整个验收。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** 每条结果里保留的输出长度上限。 */
export const OUTPUT_TAIL = 2_000

/** 派发时写死的验收契约文件名（相对 `.agi/subagents/<session id>/`）。 */
export const EXPECT_FILE = 'expect.json'

/** 一次交付最多几条验收事实。再多就没人会真的逐条核对。 */
export const MAX_EXPECT_ITEMS = 5

/** 单条验收事实的字符上限。一句话说不完的验收，事后也核不清。 */
export const MAX_EXPECT_TEXT = 200

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

/**
 * 校验派生时声明的验收标准（纯函数，不落盘）。
 *
 * 校验放在派发的最前面而不是事后，是因为它是**喂给 worker 之前**的硬门槛：
 * 一条说不清的验收事实，事后没有任何办法补 —— worker 已经按自己的理解干完了。
 *
 * @param {unknown} raw 工具参数里的 `done_when`
 * @returns {{ items: { id: string, text: string }[] }} 未给时 `items` 为空
 */
export function parseDeclaredExpect(raw) {
  if (raw === undefined || raw === null) return { items: [] }
  if (!Array.isArray(raw)) {
    throw new Error('done_when 必须是字符串数组：每一项是一句可判定的验收事实')
  }
  if (raw.length === 0) {
    throw new Error(`done_when 是空数组 —— 要么不写，要么给 1–${MAX_EXPECT_ITEMS} 条可判定的验收事实`)
  }
  if (raw.length > MAX_EXPECT_ITEMS) {
    throw new Error(`done_when 最多 ${MAX_EXPECT_ITEMS} 条，这次给了 ${raw.length} 条 —— 超过 5 条就没人会真的逐条核对`)
  }
  const items = []
  for (const [index, value] of raw.entries()) {
    const slot = `第 ${index + 1} 条`
    if (typeof value !== 'string') {
      throw new Error(`done_when ${slot}不是字符串（拿到 ${typeof value}）：每条都必须是一句话`)
    }
    const text = value.trim()
    if (text.length === 0) throw new Error(`done_when ${slot}是空的：每条都必须是一句可判定的验收事实`)
    if (text.length > MAX_EXPECT_TEXT) {
      throw new Error(`done_when ${slot}有 ${text.length} 个字符，超过 ${MAX_EXPECT_TEXT} 的上限：${text.slice(0, 40)}…`)
    }
    items.push({ id: `e${items.length + 1}`, text })
  }
  return { items }
}

/** 一个 worker 的验收契约文件路径。 */
const expectPathFor = (cwd, sessionId) =>
  join(resolve(cwd), '.agi', 'subagents', String(sessionId), EXPECT_FILE)

/**
 * 读派发时写死的验收契约。
 *
 * 三态：没有文件（`declared:false`、无 error）、文件坏（`declared:false` + error）、
 * 正常（`declared:true` + items）。坏文件**不**当成「没有契约」—— 否则一份写坏的
 * `expect.json` 会静默退化成「只剩 worker 自述」，而这恰好是这个机制要消除的东西。
 *
 * @param {string} cwd 父代理的工作区
 * @param {string} sessionId worker 的 session id
 * @returns {{ path: string, declared: boolean, items: { id: string, text: string }[], error?: string }}
 */
export function readExpect(cwd, sessionId) {
  const path = expectPathFor(cwd, sessionId)
  if (!existsSync(path)) return { path, declared: false, items: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { path, declared: false, items: [], error: `expect.json 不是合法 JSON：${error?.message ?? error}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path, declared: false, items: [], error: 'expect.json 必须是对象：{ worker, declaredAt, items }' }
  }
  if (!Array.isArray(parsed.items)) {
    return { path, declared: false, items: [], error: 'expect.json 的 items 必须是数组' }
  }
  const items = []
  for (const [index, entry] of parsed.items.entries()) {
    if (entry === null || typeof entry !== 'object' || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.text)) {
      return { path, declared: false, items: [], error: `expect.json 的 items 第 ${index + 1} 条不是 { id, text }` }
    }
    items.push({ id: entry.id, text: entry.text })
  }
  if (items.length === 0) {
    return { path, declared: false, items: [], error: 'expect.json 的 items 是空的 —— 一条都没写下就等于没声明' }
  }
  return { path, declared: true, items }
}

/**
 * 把派发时声明的验收契约落到 worker 目录。
 *
 * 失败不抛：派生已经成功，`expect.json` 写不进去只是少一层证据，不能因此把
 * 一个已经在跑的 worker 判成派生失败。错误随返回值交给调用方展示。
 *
 * @param {string} cwd 父代理的工作区
 * @param {string} sessionId worker 的 session id
 * @param {{ id: string, text: string }[]} items `parseDeclaredExpect` 的结果
 * @returns {{ path: string, declared: boolean, items: object[], error?: string }}
 */
export function writeExpect(cwd, sessionId, items) {
  const path = expectPathFor(cwd, sessionId)
  const kept = (Array.isArray(items) ? items : [])
    .filter(item => item !== null && typeof item === 'object')
    .slice(0, MAX_EXPECT_ITEMS)
    .map(item => ({ id: String(item.id), text: String(item.text) }))
  const payload = { worker: String(sessionId), declaredAt: new Date().toISOString(), items: kept }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { path, declared: kept.length > 0, items: kept, error: `expect.json 没写进去：${error?.message ?? error}` }
  }
  return { path, declared: kept.length > 0, items: kept }
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
 * 一条检查声明它覆盖哪几条验收（`{ "id": "build", "cmd": "...", "expect": ["e1"] }`）。
 *
 * 这是 worker 的弱声明：它可以把任意检查挂到任意 `eN` 上。所以 `verifyExpect`
 * 只把它当作「这条通过了就算覆盖」，覆盖的门槛仍然是那条检查真的通过。
 *
 * @param {object} entry 一条 checks 条目
 * @returns {string[]}
 */
const expectLinksOf = entry => {
  const raw = entry?.expect
  if (!Array.isArray(raw)) return []
  return raw.filter(value => isNonEmptyString(value))
}

/**
 * 逐条执行。
 *
 * @param {object[]} entries `readChecks` 返回的条目
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<object[]>} 结果记录（带 `expect` 链接的条目会把链接抄进结果）
 */
export async function runChecks(entries, { cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const results = []
  for (const [index, entry] of entries.entries()) {
    const id = isNonEmptyString(entry.id) ? entry.id : `#${index + 1}`
    // 链接抄进结果，避免 `verifyExpect` 为了对齐条目再去重跑一次 readChecks。
    const links = expectLinksOf(entry)
    const withLinks = result => (links.length === 0 ? result : { ...result, expect: links })
    if (typeof entry.note === 'string') {
      results.push(withLinks({ id, kind: 'note', status: 'manual', detail: entry.note }))
      continue
    }
    if (isNonEmptyString(entry.cmd)) {
      results.push(withLinks(await runCommand(id, entry, cwd, signal, timeoutMs)))
      continue
    }
    if (isNonEmptyString(entry.file)) {
      results.push(withLinks(runFileCheck(id, entry, cwd)))
      continue
    }
    results.push(withLinks({ id, kind: 'unknown', status: 'error', detail: '这条检查既不是 cmd，也不是 file 或 note' }))
  }
  return results
}

/**
 * 用真实执行结果核对验收契约的覆盖情况。
 *
 * 判据故意窄：一条结果必须 `status === 'pass'`，并且要么自己声明了 `expect: [...]`
 * 里含这个 id，要么它的 `id` 就等于这个 id。`manual`（note）永远不算覆盖 ——
 * 人工项是给人看的，不能当成机器证据。
 *
 * @param {{ items?: { id: string, text: string }[] } | undefined} expect `readExpect` 的返回值
 * @param {object[]} results `runChecks` 的结果
 * @returns {{ total: number, covered: number, items: { id: string, text: string, covered: boolean, evidence: string[] }[] }}
 */
export function verifyExpect(expect, results) {
  const items = Array.isArray(expect?.items) ? expect.items : []
  const passed = (Array.isArray(results) ? results : []).filter(
    result => result !== null && typeof result === 'object' && result.status === 'pass',
  )
  const verdicts = items.map(item => {
    const evidence = passed
      .filter(result => (Array.isArray(result.expect) ? result.expect : []).includes(item.id) || result.id === item.id)
      .map(result => String(result.id))
    return { id: item.id, text: item.text, covered: evidence.length > 0, evidence }
  })
  return { total: verdicts.length, covered: verdicts.filter(item => item.covered).length, items: verdicts }
}

/** 一条结果适合给人看的一行（带输出尾部）。 */
export const describe = result => {
  const mark = result.status === 'pass' ? '✓' : (result.status === 'manual' ? '·' : '✗')
  const lines = [`${mark} ${result.id} — ${result.detail}`]
  if (isNonEmptyString(result.stderr)) lines.push(`  stderr: ${result.stderr.split('\n').slice(-8).join('\n  ')}`)
  if (isNonEmptyString(result.stdout)) lines.push(`  stdout: ${result.stdout.split('\n').slice(-8).join('\n  ')}`)
  return lines.join('\n')
}
