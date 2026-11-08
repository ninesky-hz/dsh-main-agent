/**
 * dsh-main-agent — 「待投递」的持久队列（纯逻辑 + 文件 IO，不碰宿主 API）。
 *
 * 这个文件存在的原因是一次具体的丢失：DSH 原生的「subagent 已收敛」通知是
 * **一次性**投递 —— 它在 `agent/pre-step` 里被 `lib/settlement.js` 富化，然后
 * 交给主 Agent 那一轮。那一轮只要没走完（用户插话打断、决策被 reject、模型
 * 提前收尾、上下文溢出），这次收敛就**永久消失**：
 *
 *   - `.agi/BRIEF.md` 还是旧的，主 Agent 下一轮看不到「有 worker 交活了」；
 *   - `progress.jsonl` 里没有这条记录，于是「上次推进」停在几十分钟前，
 *     watchdog 把它读成空转；
 *   - worker 报的 `blocked` 问题没人看见 —— 它以为自己在等人，监督者以为
 *     它还在干活，两边一起静默停摆。
 *
 * 参考实现把这条教训写成一句话（`docs/003-execution.md:155`）：*"What
 * dsh-superagent does after a decision ... is stored first and done
 * afterwards."* 先落盘，再做。失败重试 2 秒起、翻倍到 1 分钟（`:157`），
 * 同类保持顺序（`:161`），连续失败三次才升级成系统问题（`:159`）。
 *
 * 这里只实现那一层保障，不搬它的 SQLite 表：全部状态就是
 * `.agi/outbox.jsonl` 一行一个 JSON entry。「读全量 → 改 → 写 `.tmp` →
 * `rename`」是唯一的写盘方式，并发安全靠 rename 的原子性，不引入锁文件。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：`tests/outbox.test.mjs` 要能在没有
 * node_modules 的仓库里直接跑。
 *
 * 一条硬约束写在最前面，因为它最容易被误伤：**这个模块绝不产出
 * `source.kind === 'user'` 的消息**。`lib/goal.js` 的 `hasDirectHumanMessage`
 * 靠「本轮 roots 里有 user 消息」判断有没有人类在说话，`lib/spawn.js` 的
 * 预留槽与 goal 的 direct-human 判定都依赖它。outbox 只写文件、只被 BRIEF
 * 渲染成文本，永远不进对话流。
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 队列文件名（相对 `.agi/`）。 */
export const OUTBOX_FILE = 'outbox.jsonl'

/** 第一次失败后的等待。参考实现就是 2 秒起（`docs/003-execution.md:157`）。 */
const BACKOFF_BASE_MS = 2_000

/** 退避上限。再久就不如让 BRIEF 一直显示它 —— 一分钟已经足够躲过一轮打断。 */
const BACKOFF_MAX_MS = 60_000

/** 连续失败到这个次数才算「系统问题」，而不是某一条偶发的坏运气。 */
const PROBLEM_ATTEMPTS = 3

/** 未投递、待投递两种状态；`delivered` 是唯一的终态。 */
const STATUS_PENDING = 'pending'
const STATUS_DELIVERED = 'delivered'

/**
 * 读-改-写用的锁文件名（相对 `.agi/`）。
 *
 * 为什么需要它：`rename` 只保证「单个写者不会写出半个文件」，不保证「两个
 * 写者不会互相覆盖」——两个人同时读全量、各改一行、各 rename，后写的那个
 * 会把前一个人的改动整段丢掉。丢的往往正是「这条已投递」或「这条又失败了」。
 */
const OUTBOX_LOCK_FILE = 'outbox.lock'

/** 抢不到锁时的轮询间隔（毫秒）。 */
const LOCK_POLL_MS = 5

/** 等锁的上限：超过就明确失败，绝不把调用方无限挂住。 */
const LOCK_TIMEOUT_MS = 2_000

/** 锁文件 mtime 超过这个年龄 = 持锁进程已经死了，可以直接接管。 */
const LOCK_STALE_MS = 10_000

/** 单条通知渲染时的默认上限：再多就该让人去看队列本身了。 */
const NOTICE_LIMIT = 5

const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `cwd` 缺失或不是字符串时返回 undefined —— 绝不猜路径。 */
function outboxPath(cwd) {
  if (!isNonEmptyString(cwd)) return undefined
  let root
  try {
    root = resolve(cwd)
  } catch {
    return undefined
  }
  return join(root, '.agi', OUTBOX_FILE)
}

/** 锁文件路径；`cwd` 不可用时返回 undefined，判据与 {@link outboxPath} 完全一致。 */
function lockPath(cwd) {
  const path = outboxPath(cwd)
  return path === undefined ? undefined : join(dirname(path), OUTBOX_LOCK_FILE)
}

/**
 * 同步睡 `ms` 毫秒。
 *
 * 用 `Atomics.wait` 而不是忙等：它是一次真正的阻塞（Node 主线程允许），等锁
 * 期间不会把 CPU 烧满，也不会把控制权让给别的异步任务 —— 让出去就可能有人在
 * 临界区外读到「改了一半」的队列。
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 在 outbox 的读-改-写外面加一把文件锁。
 *
 * 为什么需要：`enqueue` / `markDelivered` / `markFailed` 都是「读全量 → 改 →
 * 重写」。`rename` 只保证单个写者不会写出半个文件，**不保证两个写者不互相
 * 覆盖**：两个进程同时读、各自改一行、各自 rename，后写的那个会把前一个人的
 * 改动整段丢掉，而丢的往往正是「这条已投递」或「这条又失败了一次」。
 *
 * 锁是 `.agi/outbox.lock`，用 `openSync(path, 'wx')` 抢 —— 这个 flag 是原子的，
 * 只有一个人能创建成功。抢不到就 5ms 后重试，最多等 {@link LOCK_TIMEOUT_MS}；
 * 持锁进程崩溃留下的锁（mtime 超过 {@link LOCK_STALE_MS}）直接接管，否则一次
 * 崩溃会让整个队列永久卡死。
 *
 * 锁文件里写本次调用独有的 token，`finally` 只删「token 还是自己那一个」的锁：
 * 接管过别人的陈旧锁之后再无脑 unlink，会删掉另一个进程刚抢到的新锁。
 *
 * @param {string} cwd
 * @param {() => T} fn 临界区
 * @returns {T}
 * @template T
 */
function withOutboxLock(cwd, fn) {
  const path = lockPath(cwd)
  if (path === undefined) return fn()
  mkdirSync(dirname(path), { recursive: true })
  const token = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`outbox 锁等待超过 ${LOCK_TIMEOUT_MS}ms（${OUTBOX_LOCK_FILE}）`)
    }
    try {
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let ageMs = Number.POSITIVE_INFINITY
      try {
        ageMs = Date.now() - statSync(path).mtimeMs
      } catch {
        // 刚被释放（或刚被别人接管）：下一轮重抢就是。
      }
      if (ageMs > LOCK_STALE_MS) {
        try {
          unlinkSync(path)
          continue
        } catch {
          // 别人先接管了，按「没抢到」继续等。
        }
      }
      sleepSync(LOCK_POLL_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      if (readFileSync(path, 'utf8') === token) unlinkSync(path)
    } catch {
      // 锁已经不在（被当作陈旧锁接管）：那就不是自己该删的那把。
    }
  }
}

/**
 * 第 `attempts` 次失败之后该等多久。
 *
 * 0 → 0（还没失败过，立刻可投）；1 → 2s；2 → 4s；3 → 8s ……封顶 60s。
 * 传 NaN/负数一律当 0：算不出退避时宁可就地重试，也不要抛异常让生产者
 * 把「记不下来」升级成「这一轮失败」。
 *
 * @param {number} attempts 已经失败的次数
 * @returns {number} 毫秒
 */
export function backoffMs(attempts) {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0
  const times = Math.floor(attempts)
  // 2 ** 60 之后早已越界，先夹一次移位数，避免 Infinity 参与比较。
  const shifted = times > 20 ? BACKOFF_MAX_MS : BACKOFF_BASE_MS * 2 ** (times - 1)
  return Math.min(BACKOFF_MAX_MS, shifted)
}

/**
 * 读队列里的所有可解析 entry。
 *
 * 坏行（截断的写、被人手改坏的行）只跳过、不打爆调用方 —— 一行坏数据不该
 * 毁掉整个队列，更不该让监督者的 pre-step 抛异常。坏行数由 {@link readOutbox}
 * 报出去。
 *
 * @param {string} cwd
 * @returns {{ entries: object[], badLines: number, error?: string }}
 */
function readEntries(cwd) {
  const path = outboxPath(cwd)
  if (path === undefined) return { entries: [], badLines: 0 }
  if (!existsSync(path)) return { entries: [], badLines: 0 }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { entries: [], badLines: 0, error: `outbox.jsonl 读不了：${error?.message ?? error}` }
  }
  const entries = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      badLines += 1
      continue
    }
    if (!isObject(parsed) || !isNonEmptyString(parsed.id) || !isNonEmptyString(parsed.kind)) {
      badLines += 1
      continue
    }
    entries.push(parsed)
  }
  return { entries, badLines }
}

/**
 * 「读全量 → 改 → 原子重写」里的最后一步。
 *
 * 先写 `<path>.<pid>.<时间>.tmp` 再 `rename` 覆盖：崩溃时要么看到旧的完整
 * 文件，要么看到新的完整文件，不会看到半个队列。失败时清掉自己的临时文件。
 *
 * @param {string} path
 * @param {object[]} entries
 */
function writeEntries(path, entries) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const body = entries.length === 0
    ? ''
    : `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 临时文件清不掉不影响这次失败本身的结论。
    }
    throw error
  }
}

/**
 * 读队列。
 *
 * @param {string} cwd
 * @returns {{ entries: object[], badLines: number, error?: string }}
 */
export function readOutbox(cwd) {
  const { entries, badLines, error } = readEntries(cwd)
  if (badLines === 0) return error === undefined ? { entries } : { entries, badLines, error }
  return {
    entries,
    badLines,
    error: `outbox.jsonl 有 ${badLines} 行读不出来（已跳过）`,
  }
}

/**
 * 入队一件「必须告知主 Agent 的事实」。
 *
 * 幂等 + 可更新：同 `kind` + 同 `dedupeKey` 且尚未投递的 entry 已存在时**原地
 * 替换**它的 `detail`，而不是把新内容丢掉。这一点是关键 —— pre-step 会重放同一
 * 批消息，没有幂等的话每次重放都会多出一条「worker 交了活」；但只做「跳过」的话，
 * 一条先入队的粗话（比如 `state: 'working'`）会把后来更准的话（`state: 'blocked'`
 * 加一个具体问题）永远挡在门外。所以：位置不动、内容更新。
 *
 * 保留 `id` / `createdAt` / 队列里的位置 / `attempts`（不重置，否则反复失败会被
 * 一次重放洗白）与 `status` 一起回到 `pending`，`nextAt` 置为现在 —— 替换之后
 * 这份新内容应该立刻被下一份 BRIEF 看到。本次没给 `detail` 时保留原来的。
 *
 * 已投递的 entry 不参与替换：新的同一件事要产生新的一条（否则「收敛了 → 又
 * 阻塞了」这种来回会被吞掉一次）。
 *
 * **绝不抛**：调用方（`lib/settlement.js`、`lib/checks-tool.js`）是 fail-open
 * 的生产点，队列写不进去最多 warn 一句，不能反过来把那一轮弄失败。
 *
 * @param {string} cwd
 * @param {{ kind: string, detail?: object, dedupeKey?: string }} item
 * @returns {{ ok: boolean, id?: string, replaced?: boolean, error?: string }}
 */
export function enqueue(cwd, { kind, detail, dedupeKey } = {}) {
  const path = outboxPath(cwd)
  if (path === undefined) return { ok: false, error: 'outbox 需要会话工作区' }
  if (!isNonEmptyString(kind)) return { ok: false, error: 'outbox entry 需要 kind' }
  const key = isNonEmptyString(dedupeKey) ? dedupeKey : undefined
  try {
    return withOutboxLock(cwd, () => {
      const { entries } = readEntries(cwd)
      if (key !== undefined) {
        const index = entries.findIndex(entry => entry.kind === kind
          && entry.dedupeKey === key
          && entry.status !== STATUS_DELIVERED)
        if (index >= 0) {
          const previous = entries[index]
          const now = Date.now()
          // 展开顺序就是要的语义：新 detail 整体替换旧的，其他字段一律沿用。
          entries[index] = {
            ...previous,
            ...isObject(detail) ? { detail } : {},
            nextAt: now,
            status: STATUS_PENDING,
          }
          writeEntries(path, entries)
          return { ok: true, replaced: true, id: previous.id }
        }
      }
      const now = Date.now()
      const entry = {
        id: randomUUID(),
        kind,
        ...key === undefined ? {} : { dedupeKey: key },
        ...isObject(detail) ? { detail } : {},
        createdAt: now,
        nextAt: now,
        // 刚入队就该被下一份 BRIEF 看到：nextAt 就是 createdAt，不是「等一会儿」。
        attempts: 0,
        status: STATUS_PENDING,
      }
      writeEntries(path, [...entries, entry])
      return { ok: true, id: entry.id }
    })
  } catch (error) {
    return { ok: false, error: `outbox 写入失败：${error?.message ?? error}` }
  }
}

/** 保序比较：先比 `createdAt`，同值比 `id`，保证判定与展示都稳定。 */
function byCreatedAt(a, b) {
  const left = Number.isFinite(a.createdAt) ? a.createdAt : 0
  const right = Number.isFinite(b.createdAt) ? b.createdAt : 0
  if (left !== right) return left - right
  const leftId = isNonEmptyString(a.id) ? a.id : ''
  const rightId = isNonEmptyString(b.id) ? b.id : ''
  return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0)
}

const isDue = (entry, now) => entry.status === STATUS_PENDING
  && (!Number.isFinite(entry.nextAt) || entry.nextAt <= now)

/**
 * 现在可以投递的 entry。
 *
 * 两道筛子，顺序不能反：
 *   1. `status === 'pending'` 且 `nextAt <= now`；
 *   2. **同类保序** —— 某个 kind 里只要还有一条更早的 pending entry 没到期，
 *      这个 kind 后面所有的都先压住（参考实现："a failed one holds back the
 *      later ones of its kind"，`docs/003-execution.md:161`）。
 *
 * 保序只在自己的 kind 内生效：一个正在退避的 `settlement` 不该挡住一条
 * `check-failed` —— 那是两件互不相干的事，互相阻塞只会让坏消息更难传出去。
 *
 * @param {string} cwd
 * @param {number} [now]
 * @returns {object[]}
 */
export function dueEntries(cwd, now = Date.now()) {
  const at = Number.isFinite(now) ? now : Date.now()
  const { entries } = readEntries(cwd)
  const pending = entries.filter(entry => entry.status === STATUS_PENDING).sort(byCreatedAt)
  const released = []
  /** 已经有个同 kind 的更早 entry 被压住时，这个 kind 就不再放行。 */
  const held = new Set()
  for (const entry of pending) {
    if (held.has(entry.kind)) continue
    if (!isDue(entry, at)) {
      held.add(entry.kind)
      continue
    }
    released.push(entry)
  }
  return released.sort(byCreatedAt)
}

/**
 * 标记一条已投递（BRIEF 渲染出去之后调用）。
 *
 * 走 {@link withOutboxLock}：它和 `enqueue` 会并发改同一份文件，谁都不能读到
 * 别人的半成品再覆盖回去。
 *
 * @param {string} cwd
 * @param {string} id
 * @returns {{ ok: boolean, error?: string }}
 */
export function markDelivered(cwd, id) {
  const path = outboxPath(cwd)
  if (path === undefined) return { ok: false, error: 'outbox 需要会话工作区' }
  if (!isNonEmptyString(id)) return { ok: false, error: 'markDelivered 需要 id' }
  try {
    return withOutboxLock(cwd, () => {
      const { entries } = readEntries(cwd)
      const target = entries.find(entry => entry.id === id)
      if (target === undefined) return { ok: false, error: `outbox 里没有 ${id}` }
      const next = entries.map(entry => entry.id === id
        ? { ...entry, status: STATUS_DELIVERED, deliveredAt: Date.now() }
        : entry)
      writeEntries(path, next)
      return { ok: true }
    })
  } catch (error) {
    return { ok: false, error: `outbox 写入失败：${error?.message ?? error}` }
  }
}

/**
 * 标记一次投递失败，并按退避推后。
 *
 * `attempts` 递增、`nextAt = now + backoffMs(新 attempts)`、`lastError` 留原因。
 * 状态仍是 `pending`：失败不是终态，只是「本轮先不投」。
 *
 * 同样走 {@link withOutboxLock}：重试计数被并发覆盖掉的话，一条坏掉的投递会
 * 无限重试、永远不升级成「积压」。
 *
 * @param {string} cwd
 * @param {string} id
 * @param {string} reason
 * @returns {{ ok: boolean, attempts?: number, nextAt?: number, error?: string }}
 */
export function markFailed(cwd, id, reason) {
  const path = outboxPath(cwd)
  if (path === undefined) return { ok: false, error: 'outbox 需要会话工作区' }
  if (!isNonEmptyString(id)) return { ok: false, error: 'markFailed 需要 id' }
  try {
    return withOutboxLock(cwd, () => {
      const { entries } = readEntries(cwd)
      const target = entries.find(entry => entry.id === id)
      if (target === undefined) return { ok: false, error: `outbox 里没有 ${id}` }
      const attempts = (Number.isFinite(target.attempts) ? target.attempts : 0) + 1
      const nextAt = Date.now() + backoffMs(attempts)
      const next = entries.map(entry => entry.id === id
        ? {
          ...entry,
          attempts,
          nextAt,
          lastError: typeof reason === 'string' ? reason : String(reason ?? ''),
          status: STATUS_PENDING,
        }
        : entry)
      writeEntries(path, next)
      return { ok: true, attempts, nextAt }
    })
  } catch (error) {
    return { ok: false, error: `outbox 写入失败：${error?.message ?? error}` }
  }
}

/**
 * 该升级成「系统问题」的 entry：连续失败到 3 次还没送出去。
 *
 * 参考实现的口径是「同类连续失败三次才进系统问题列表」—— 一次失败可能只是
 * 撞上了一轮里唯一的机会，三次说明投递这条路本身坏了，必须让人看见。
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
export function outboxProblems(entries) {
  if (!Array.isArray(entries)) return []
  return entries.filter(entry => isObject(entry)
    && entry.status !== STATUS_DELIVERED
    && Number.isFinite(entry.attempts)
    && entry.attempts >= PROBLEM_ATTEMPTS)
}

/** 每种 kind 的中文说法；没登记过的 kind 原样显示（绝不吐 `undefined`）。 */
const KIND_LABEL = {
  settlement: '收敛通知',
  'worker-report': 'worker 报告',
  'check-failed': '验收失败',
  recovery: '重启恢复',
}

/** 秒/分钟两档：12 秒、3 分钟 —— 比「12000ms」更像给人看的。 */
function humanDelay(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1_000))} 秒`
  return `${Math.round(value / 60_000)} 分钟`
}

/**
 * 一条 entry 的「说的是什么事」。
 *
 * 三处都可能缺：老 entry 没有 `detail`、`detail` 里没有 `state`、`question`
 * 是空串。任何一处缺失都只少说一句，绝不让 `undefined` 漏进给模型看的文本。
 *
 * `note` 是恢复 note 的正文（`recovery` 的 detail 只有 `{ worker, note }`）：
 * 不把它渲染出来，BRIEF 里就只剩一句「重启恢复」，读的人不知道该干什么 ——
 * 那正是这条 note 存在的理由。
 *
 * @param {object} entry
 * @returns {string} 例如 `blocked：需要确认 A 还是 B`
 */
function describeDetail(entry) {
  const detail = isObject(entry.detail) ? entry.detail : {}
  const state = isNonEmptyString(detail.state) ? detail.state : ''
  const question = isNonEmptyString(detail.question) ? detail.question : ''
  const note = isNonEmptyString(detail.note) ? detail.note : ''
  const failedIds = Array.isArray(detail.failedIds)
    ? detail.failedIds.filter(isNonEmptyString)
    : []
  if (state.length > 0) return question.length > 0 ? `${state}：${question}` : state
  if (failedIds.length > 0) return `失败项：${failedIds.join(', ')}`
  if (question.length > 0) return question
  return note
}

/**
 * 队列的展示标识：优先 `dedupeKey`（人对它有印象，比如 worker 的 session id），
 * 没有就退回 entry id 的前 8 位。
 *
 * @param {object} entry
 * @returns {string}
 */
function entryKey(entry) {
  if (isNonEmptyString(entry.dedupeKey)) return entry.dedupeKey
  return isNonEmptyString(entry.id) ? entry.id.slice(0, 8) : '（未知）'
}

/**
 * 积压视角：还剩多少、最老的一条压了多久、哪些 kind 在失败。
 *
 * 只列「待投递」会留一个盲点：屏幕上就那几条、每条都说「12 秒后重试」，看着一切
 * 正常，实际上后面压着几十条、最老的一条已经等了半小时。这一行补的就是盲点。
 *
 * 只在真的有 pending 时出现，一条都没有就整段消失（quiet by default）—— 队列健康
 * 的时候不该往 BRIEF 里多写一个字。
 *
 * 失败口径与 {@link outboxProblems} 一致：`status === 'failed'` 或 `attempts >= 3`，
 * 且没投递成功。0 条的 kind 不出现。
 *
 * @param {object[]} entries 队列里的全部 entry
 * @param {number} now
 * @returns {string} 没有 pending 时返回 `''`
 */
function renderBacklog(entries, now) {
  const pending = entries.filter(entry => entry.status === STATUS_PENDING)
  if (pending.length === 0) return ''
  const oldestAt = pending.reduce((min, entry) => {
    const at = Number.isFinite(entry.createdAt) ? entry.createdAt : now
    return at < min ? at : min
  }, now)
  const failures = new Map()
  for (const entry of entries) {
    if (entry.status === STATUS_DELIVERED) continue
    const failed = entry.status === 'failed'
      || (Number.isFinite(entry.attempts) && entry.attempts >= PROBLEM_ATTEMPTS)
    if (!failed) continue
    const kind = isNonEmptyString(entry.kind) ? entry.kind : '未分类'
    failures.set(kind, (failures.get(kind) ?? 0) + 1)
  }
  const failureText = [...failures.entries()]
    .map(([kind, count]) => `${KIND_LABEL[kind] ?? kind} ${count} 条`)
    .join('、')
  const suffix = failureText.length > 0 ? `（${failureText}失败）` : ''
  return `- 积压：${pending.length} 条待投递，最老 ${humanDelay(Math.max(0, now - oldestAt))}${suffix}`
}

/**
 * 渲染成给模型看的中文 Markdown 片段（每条一行）。
 *
 * 形如：
 *   - `abc12345` 的收敛通知（blocked：需要确认 A 还是 B）—— 已重试 2 次，下次 12 秒后
 *   - 积压：3 条待投递，最老 12 分钟（worker 报告 2 条失败）
 *
 * @param {object[]} entries {@link dueEntries} 的结果
 * @param {{ limit?: number, now?: number }} [options]
 * @returns {string} 空数组返回 `''`
 */
export function renderOutboxNotice(entries, { limit = NOTICE_LIMIT, now = Date.now() } = {}) {
  if (!Array.isArray(entries)) return ''
  const clean = entries.filter(isObject)
  if (clean.length === 0) return ''
  const at = Number.isFinite(now) ? now : Date.now()
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : NOTICE_LIMIT
  const shown = clean.slice(0, size)
  const lines = shown.map(entry => {
    const label = KIND_LABEL[entry.kind] ?? (isNonEmptyString(entry.kind) ? entry.kind : '待投递事项')
    const detail = describeDetail(entry)
    const attempts = Number.isFinite(entry.attempts) ? entry.attempts : 0
    const retried = attempts > 0 ? `已重试 ${attempts} 次` : ''
    const wait = Number.isFinite(entry.nextAt) && entry.nextAt > at
      ? `下次 ${humanDelay(entry.nextAt - at)}后`
      : (attempts > 0 ? '已到期' : '待投递')
    const tail = [retried, wait].filter(part => part.length > 0).join('，')
    const head = `- \`${entryKey(entry)}\` 的${label}`
    return `${head}${detail.length > 0 ? `（${detail}）` : ''}${tail.length > 0 ? `—— ${tail}` : ''}`
  })
  if (clean.length > shown.length) {
    lines.push(`- 另有 ${clean.length - shown.length} 条待投递未列出。`)
  }
  const backlog = renderBacklog(clean, at)
  if (backlog.length > 0) lines.push(backlog)
  return lines.join('\n')
}
