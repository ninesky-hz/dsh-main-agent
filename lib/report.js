/**
 * dsh-main-agent — worker report 六态的读取（纯逻辑，不碰 ctx）。
 *
 * 目前监督者判断「这个 worker 是在干活、在等我回答、还是已经干完了」靠的是
 * 时间差推断：`lib/watchdog.js` 用 `readAgiFacts` / `lastActivityAt` 猜，主 Agent
 * 醒来后读 `outcome.md` 的散文再用自由文本分类。参考实现明确把这条做法列进
 * 「拒绝概念表」：
 *
 *   "Inferring waiting on a person from a report's free text — the
 *    classification needs structured facts; the Executor asks through a
 *    structured field."
 *
 * 所以 worker 用一行结构化注释声明它这一轮的结论：
 *
 *   <!-- report: blocked; question: 需要确认 A 还是 B -->
 *
 * 六个状态（与参考实现 Report 六态一一对应）：
 *   progress 进展 · waiting 等待 · ready 就绪 · blocked 受阻 ·
 *   failed 失败 · dropped 无需处理
 *
 * 这个文件刻意不 import 任何宿主包：它只读工作区里的两个文件，这样
 * `tests/report.test.mjs` 能在没有 node_modules 的情况下直接跑纯函数。
 * 用它做分类的 `lib/stage.js` 同样不读盘 —— 读盘与分类分开，分类才能被穷举测试。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 六个合法状态。**严格小写** —— 大小写不符按未写处理（见 `readReport`）。 */
export const REPORT_STATES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

/** 头行扫描深度。worker 会把标记写在第一行，但给它十行余量容忍标题/空行。 */
const HEAD_LINES = 10

const OUTCOME_FILE = 'outcome.md'
const REPORT_FILE = 'report.json'

/**
 * 「Lead 已验收，这个 worker 可以退场」的落盘标记。
 *
 * 六个 report 状态里**故意没有**「已归档」：`ready` 是 worker 的自述（「我做完了，
 * 等人验收」），它不知道 Lead 验收了没有。于是「谁验收的」这条事实必须由**验收方**
 * 写下来，否则 `ready` + 不在运行 会被永远判成 `person/review`，BRIEF 每轮都挂
 * 一条「等用户验收」去误导主 Agent。所以归档是 Lead 侧的一份旁路记录，不污染
 * worker 的 report 协议 —— 旧 worker 不需要知道有这回事。
 */
export const ARCHIVE_FILE = 'archived.json'

/** 什么都没写时的回落状态。**progress 而不是 blocked**：没写不等于出事。 */
const DEFAULT_STATE = 'progress'

const isNonEmptyString = value => typeof value === 'string' && value.length > 0

const normalizeState = value => (REPORT_STATES.includes(value) ? value : DEFAULT_STATE)

const cleanText = value => (typeof value === 'string' ? value.trim() : '')

/** `<!-- ... -->`：worker 的标记都写在 HTML 注释里，渲染 Markdown 时不可见。 */
const COMMENT = /<!--([\s\S]*?)-->/g

/**
 * 从一段注释体里取出 `report:` 与 `question:`。
 *
 * 两种写法都要认：
 *   `report: blocked`
 *   `report: blocked; question: 需要确认 A 还是 B`
 * 也认把它们拆进两条注释的写法（worker 协议就是这么要求的）。
 *
 * @param {string} body 一条注释的内部文本
 * @returns {{ state?: string, question?: string }}
 */
function parseComment(body) {
  const result = {}
  // 状态值不做大小写归一：`BLOCKED` 属于「写得不对」，按未写处理并回落。
  const state = /(?:^|[;\s])report\s*:\s*([^\s;]+)/i.exec(body)
  if (state !== null) result.state = state[1]
  const question = /(?:^|[;])\s*question\s*:\s*([\s\S]+)$/i.exec(body)
  if (question !== null) {
    const text = cleanText(question[1])
    if (text.length > 0) result.question = text
  }
  return result
}

/**
 * 扫 `outcome.md` 的头行，找 report 标记。
 *
 * @param {string} path
 * @returns {{ state?: string, question?: string, error?: string }}
 */
function readOutcomeHead(path) {
  if (!existsSync(path)) return {}
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { error: `outcome.md 读不了：${error?.message ?? error}` }
  }
  const lines = text.split('\n').slice(0, HEAD_LINES)
  const found = {}
  for (const line of lines) {
    COMMENT.lastIndex = 0
    let match
    while ((match = COMMENT.exec(line)) !== null) {
      const parsed = parseComment(match[1])
      if (parsed.state !== undefined && found.state === undefined) found.state = parsed.state
      if (parsed.question !== undefined && found.question === undefined) found.question = parsed.question
    }
  }
  return found
}

/**
 * 读 `report.json`（两者都存在时它优先）。
 *
 * 结构化字段不需要从散文里猜，所以只要它能给出一个合法状态就采信它。坏 JSON、
 * 非对象、状态非法、大小写不符都返回 `undefined` 交给下一层回落 —— 连同一条
 * 说明性 `error`，但**绝不**让 error 影响状态。
 *
 * @param {string} path
 * @returns {{ state?: string, question?: string, error?: string } | undefined}
 */
function readJsonReport(path) {
  if (!existsSync(path)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { error: `report.json 不是合法 JSON：${error?.message ?? error}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'report.json 必须是一个对象' }
  }
  if (!REPORT_STATES.includes(parsed.state)) {
    // 写了个不认识的状态：这不是「受阻」，是「没写对」。
    return { error: `report.json 的 state 不是合法六态（收到 ${JSON.stringify(parsed.state)}）` }
  }
  const question = cleanText(parsed.question)
  return { state: parsed.state, ...question.length > 0 ? { question } : {} }
}

/**
 * 读一个 worker 的 report。
 *
 * fail-open 是硬要求：文件缺失、JSON 坏、状态不在六态里、大小写不符 —— 一律
 * 回落到 `{ state: 'progress' }`，绝不抛异常、绝不把「没写」当成 `blocked` 或
 * `failed`。旧 worker 目录（根本不知道有这回事）必须继续按 progress 处理。
 *
 * @param {string} cwd 监督者的工作区
 * @param {string} sessionId worker 的 session id
 * @returns {{ state: string, question?: string, outcomePath: string, error?: string }}
 */
export function readReport(cwd, sessionId) {
  const dir = join(resolve(cwd), '.agi', 'subagents', String(sessionId))
  const outcomePath = join(dir, OUTCOME_FILE)
  const fromJson = readJsonReport(join(dir, REPORT_FILE))
  if (fromJson?.state !== undefined) {
    return { state: fromJson.state, ...fromJsonQuestion(fromJson), outcomePath }
  }
  const fromHead = readOutcomeHead(outcomePath)
  const error = fromJson?.error ?? fromHead.error
  const state = normalizeState(fromHead.state)
  return {
    state,
    ...cleanText(fromHead.question).length > 0 ? { question: cleanText(fromHead.question) } : {},
    outcomePath,
    ...isNonEmptyString(error) ? { error } : {},
  }
}

/** 只在有 question 时才带上该字段，避免给下游一个空字符串。 */
function fromJsonQuestion(fromJson) {
  return isNonEmptyString(fromJson?.question) ? { question: fromJson.question } : {}
}

/** 每个状态的一行中文注解。没有 question 时用它说明「在等什么」。 */
const STATE_GLOSS = {
  progress: '进展中',
  waiting: '等触发',
  ready: '就绪，等验收',
  blocked: '受阻，等人类决定',
  failed: '失败，等人类处理',
  dropped: '无需处理',
}

/**
 * 把 report 渲染成一行中文。
 *
 * 有 question 时 question 就是那句话（它本来就说明了「在等什么」）；没有时用
 * 状态注解补上，避免输出一个裸状态码。
 *
 * @param {{ state?: string, question?: string }} report
 * @returns {string} 例如 `blocked — 需要确认 A 还是 B`
 */
export function describeReport(report) {
  const state = normalizeState(report?.state)
  const question = cleanText(report?.question)
  return question.length > 0
    ? `${state} — ${question}`
    : `${state} — ${STATE_GLOSS[state]}`
}

/**
 * 这个 report 是不是在等人回答。
 *
 * 「存在待投递/待回答的问题」= question 非空，且状态是 blocked / failed /
 * waiting —— 只有这三种状态下提问才有意义：`progress` 是边说边干，`ready` 与
 * `dropped` 已经收尾。判定放在这里而不是 `stage.js`，因为 BRIEF 渲染与 stage
 * 分类必须用同一个判据，否则两处会给出互相矛盾的结论。
 *
 * @param {{ state?: string, question?: string }} report
 * @returns {boolean}
 */
export function hasPendingQuestion(report) {
  const state = report?.state
  if (state !== 'blocked' && state !== 'failed' && state !== 'waiting') return false
  return cleanText(report?.question).length > 0
}

/**
 * 标准 UUID 形状。只有它才截末 8 位。
 *
 * 旧实现无脑 `slice(-8)`：`persona-compose-review` 是个历史目录，不是 session
 * id，被切成 `e-review` 这种碎片写进 BRIEF —— 一个既不是 session 也不是目录名
 * 的字串，读者没法据此去任何地方查它。非 UUID 名字直接整名保留。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * worker 目录名 → BRIEF 里显示的 id。
 *
 * 标准 UUID 取末 8 位（够唯一，也够短，不会把摘要一行撑爆）；其余名字原样返回。
 *
 * @param {string} id 目录名（或 session id）
 * @returns {string}
 */
export function shortWorkerId(id) {
  const name = typeof id === 'string' ? id : String(id ?? '')
  return UUID.test(name) ? name.slice(-8) : name
}

/** worker 目录的绝对路径。`archiveWorker` / `isArchived` 共用，保证两处指同一处。 */
const workerDir = (cwd, sessionId) => join(resolve(cwd), '.agi', 'subagents', String(sessionId))

/**
 * 读一份归档记录；读不到 / 不是合法 JSON 时返回 `undefined`。
 *
 * @param {string} path
 * @returns {object | undefined}
 */
function readArchive(path) {
  if (!existsSync(path)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed
}

/**
 * 记下「Lead 已验收这个 worker」。
 *
 * 幂等：同一份备注重复归档不会重写文件，也不会刷掉第一次的 `ts` —— 归档时间是
 * 「Lead 什么时候验的」，重跑一次命令不该把它改成现在。备注变了才重写，此时保留
 * 首次的 `ts`（那次才是验收发生的时刻）。
 *
 * 硬要求：**绝不抛**。归档是收尾动作，失败只该让调用方看到 `{ok:false}` 并继续
 * 干别的活，不该把一轮唤醒打断。
 *
 * @param {string} cwd 监督者的工作区
 * @param {string} sessionId worker 的 session id（目录名）
 * @param {string} [note] 人写的备注，例如「Lead 已核验：全量测试 360 绿」
 * @returns {{ ok: true, written: boolean, path: string, record: object } | { ok: false, error: string }}
 */
export function archiveWorker(cwd, sessionId, note) {
  const id = String(sessionId ?? '')
  if (id.length === 0) return { ok: false, error: 'sessionId 不能为空' }
  const dir = workerDir(cwd, id)
  const path = join(dir, ARCHIVE_FILE)
  const text = cleanText(note)
  try {
    // 目录不存在就不归档：凭空造一个只有 archived.json 的目录，会让
    // `collectReports` 多出一条没有任何 outcome 的幽灵 worker。
    if (!existsSync(dir)) return { ok: false, error: `没有这个 worker 目录：${dir}` }
    const existing = readArchive(path)
    if (existing !== undefined && cleanText(existing.note) === text) {
      return { ok: true, written: false, path, record: existing }
    }
    const record = {
      ts: isNonEmptyString(existing?.ts) ? existing.ts : new Date().toISOString(),
      by: 'lead',
      note: text,
    }
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return { ok: true, written: true, path, record }
  } catch (error) {
    return { ok: false, error: `写 ${ARCHIVE_FILE} 失败：${error?.message ?? error}` }
  }
}

/**
 * 这个 worker 是否已被 Lead 归档（验收通过、可以退场）。
 *
 * fail-open：读不到、坏 JSON、不是对象 —— 一律 false。把「读不出来」当成「已归档」
 * 会让真在等人的 worker 从 BRIEF 里消失，那是最坏的失效方向。
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isArchived(cwd, sessionId) {
  if (String(sessionId ?? '').length === 0) return false
  return readArchive(join(workerDir(cwd, sessionId), ARCHIVE_FILE)) !== undefined
}

/**
 * 把工作区里所有 worker 的报告捞成摘要要的形状。
 *
 * 只读 `.agi/subagents/<id>/` 里 worker 自己写的结构化标记，这里不做任何推断
 * —— 「谁在等用户」交给 `stage.js` 的规则表判，这一层只负责把事实端出来。
 * 没写标记的旧 worker 会回落成 `progress`，在摘要里显示成「工作中」，不会因为
 * 「它没配合新协议」就从摘要里消失（那才是最坏的失效：看不见的 worker 等于
 * 不存在，而它可能正卡在等人上）。
 *
 * @param {string} cwd
 * @param {Iterable<string>} [running] 当前确实在跑的 child id
 * @param {Iterable<string>} [known] 子会话 catalog 里仍然存在的 id（`continuableChildIds`）。
 *   **不传时返回项的 `known` 恒为 `undefined`** —— 「没人告诉我 catalog 长什么样」
 *   不能等同于「这个 id 已经不在 catalog 里」，否则诊断脚本与老调用方里的每个
 *   worker 都会被判成已结束。
 * @returns {Array<{ id: string, report: object, running: boolean, archived: boolean, known?: boolean }>}
 *   `id` 走 `shortWorkerId`：标准 UUID 截末 8 位，其余整名保留。
 *   `archived` 是 Lead 侧的归档事实（`archived.json`），**已归档的仍然返回** ——
 *   上层要显示「已收尾」，而不是让它凭空消失。
 *   `known === false` 才是硬结论：这个目录名不在任何子会话 catalog 里，它**不可能
 *   再跑**（历史手工目录，或早已退场的 child）。`known === true` 但没在跑，说明它
 *   是个真 worker 只是当前空闲 —— 那两件事的处置完全不同，所以区别必须在这里
 *   端出来，不能由下游拿 `running === false` 猜。
 */
export function collectReports(cwd, running, known) {
  let ids = []
  try {
    ids = readdirSync(join(resolve(cwd), '.agi', 'subagents'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    // 还没有任何 worker —— 摘要少一段，好过让兜底自己崩掉。
    return []
  }
  const live = new Set(running ?? [])
  // 三态：undefined（不知道）/ true（在 catalog 里）/ false（不在 catalog 里）。
  const catalog = known === undefined || known === null ? undefined : new Set(known)
  return ids.map(id => ({
    id: shortWorkerId(id),
    report: readReport(cwd, id),
    running: live.has(id),
    archived: isArchived(cwd, id),
    known: catalog === undefined ? undefined : catalog.has(id),
  }))
}
