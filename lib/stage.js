/**
 * dsh-main-agent — worker 的 stage 分类（纯逻辑，不读盘，不 import 宿主包）。
 *
 * 参考实现把「这个工单现在在等什么」做成一张**有序表**：从上到下读，第一个
 * 匹配的行胜出（docs/003-execution.md「Ticket stages」）。第一行解释了为什么
 * 要这么写：
 *
 *   "Each open Ticket has one stage, determined by what it is waiting for.
 *    Read the table from top to bottom; the first matching row wins."
 *
 * 顺序本身就是信息量：`ended` 压过一切；「有人在等」压过「在跑」；`ready`
 * 压过 `blocked` 的通用分支；而 `running !== true` 的 `queued` 又压过
 * `waiting` 的 `idle`。把它写成 first-match-wins 的 if 链，就不会出现「同时
 * 满足两条、分类取决于判断顺序的偶然」。
 *
 * 为什么单独一个文件：分类必须是可穷举测试的纯函数。读盘（`lib/report.js`）
 * 与分类（这里）分开，`tests/stage.test.mjs` 才能不碰文件系统就把每条规则钉住。
 *
 * 与参考实现的唯一差异：`dropped`（「干完了、但确实没活」）不作为失败留在
 * `person` 阶段，而是直接收尾成 `{ stage: 'ended', action: 'dropped' }` ——
 * 它不该算失败，也不该继续占着一个等人的位置。
 */

/** @typedef {{ stage: string, action?: string }} StageResult */

/** 让 `report` 参数缺省时也能安全取状态。 */
const stateOf = report => (typeof report?.state === 'string' ? report.state : undefined)

/**
 * 分类一个 worker 现在处于哪个 stage。
 *
 * 顺序严格照参考实现的 stage 表（first-match-wins）：
 *   1. `ended`                 → ended            （已收尾，不再归我们管）
 *   2. `archived`              → ended/archived   （Lead 已验收，可以退场）
 *   3. `dropped`               → ended/dropped    （无需处理，不算失败）
 *   4. `deliveryFailed`        → delivery/failed  （消息压根没送到，重启投递）
 *   5. `pendingQuestion`       → person/answer    （有具体问题在等人）
 *   6. `ready`                 → person/review    （交付完，等人验收）
 *   7. `blocked` / `failed`    → person/<state>   （受阻/失败，等人决定）
 *   8. `running !== true`      → working/queued   （还没跑起来，等空槽）
 *   9. `waiting`               → idle             （这一轮干完，等触发）
 *  10. 其余                     → working          （正在跑）
 *
 * `archived` 的位置是这张表的重点：它必须**压过** `ready` —— 一个已验收的 worker
 * 会一直自述 `ready`（它不知道 Lead 验完没有），若 `ready` 先赢，BRIEF 就会永久
 * 挂一条「等用户验收」去误导主 Agent。它排在 `dropped` 之前，是因为「Lead 明确
 * 验收过」比 worker 自述的「没活可干」更硬。
 *
 * `deliveryFailed` 排在 `person/*` 之前、`ended` 三态之后：worker 说了什么（`ready`、
 * `blocked`、甚至报了个具体问题）都以「你能收到我说的话」为前提；队列里躺着一份
 * 连续投递失败的 entry，说明这个前提已经不成立，再按它自述的状态去等人就是空等。
 * 但它压不过 `ended`：已经收尾/归档的 worker，消息送不到也不影响判断，不该让一份
 * 陈旧 entry 把它们从摘要里翻出来。
 *
 * `ended` 的语义要划清：它是「这个 id 已经不在任何子会话目录里，不可能再跑」，
 * **不是**「当前没在跑」。后者是第 8 条（`working/queued`，还没跑起来、在等空槽）
 * 与第 9 条（`idle`，这一轮干完、在等触发）的分工。把「没在跑」写成 `ended` 会让
 * 一个真排队中的 worker 从摘要里消失。
 *
 * @param {object} input
 * @param {{ state?: string, question?: string }} [input.report]
 * @param {boolean} [input.running] 驱动还开着（`list_agents` 的 running）
 * @param {boolean} [input.pendingQuestion] 存在待回答的问题（用 `hasPendingQuestion` 算）
 * @param {object} [input.ended] 非空表示已结束：这个 id 不在任何子会话目录里，不可能再跑
 * @param {boolean} [input.archived] Lead 已验收归档（`isArchived`）
 * @param {boolean} [input.deliveryFailed] 这个 worker 的消息连续投递失败（outbox 里 pending 且 attempts >= 3）
 * @returns {StageResult}
 */
export function workerStage({ report, running, pendingQuestion, ended, archived, deliveryFailed } = {}) {
  const state = stateOf(report)
  if (ended) return { stage: 'ended' }
  if (archived === true) return { stage: 'ended', action: 'archived' }
  if (state === 'dropped') return { stage: 'ended', action: 'dropped' }
  if (deliveryFailed === true) return { stage: 'delivery', action: 'failed' }
  if (pendingQuestion) return { stage: 'person', action: 'answer' }
  if (state === 'ready') return { stage: 'person', action: 'review' }
  if (state === 'blocked' || state === 'failed') return { stage: 'person', action: state }
  if (running !== true) return { stage: 'working', action: 'queued' }
  if (state === 'waiting') return { stage: 'idle' }
  return { stage: 'working' }
}

/**
 * stage 的中文标签，给面板与 BRIEF 用。
 *
 * 标签必须说清「在等谁、等什么」：只写 `person/blocked` 的裸状态码，读者
 * （模型或人）还得回去查表才知道该做什么。所以每一档都带一句人话。
 *
 * @param {StageResult} result `workerStage` 的返回值
 * @returns {string} 例如 `person/answer → 等用户回答`
 */
export function renderStageLabel({ stage, action } = {}) {
  const key = typeof action === 'string' && action.length > 0 ? `${stage}/${action}` : String(stage ?? '')
  switch (key) {
    case 'ended':
      return 'ended → 已收尾，不再归监督者管'
    case 'ended/archived':
      return 'ended/archived → 已验收归档，无需处理'
    case 'ended/dropped':
      return 'ended/dropped → 无需处理，已收尾'
    case 'delivery/failed':
      return 'delivery/failed → 消息未送达（重启投递）'
    case 'person/answer':
      return 'person/answer → 等用户回答'
    case 'person/review':
      return 'person/review → 等用户验收'
    case 'person/blocked':
      return 'person/blocked → 等用户决定（受阻）'
    case 'person/failed':
      return 'person/failed → 等用户处理（失败）'
    case 'working':
      return 'working → 正在跑'
    case 'working/queued':
      return 'working/queued → 排队中，等空闲槽'
    case 'idle':
      return 'idle → 等触发'
    default:
      // 未知组合也要给出人话，绝不把裸状态码当结论输出。
      return `${key === '' ? 'unknown' : key} → 状态未知，按未识别处理`
  }
}

/**
 * 能不能重试派生这个单元。
 *
 * 只有两种情况值得重试：worker 报了 `blocked` / `failed`，而且此后没有更新
 * 的待回答问题 —— 有更新的问题说明人类还没回答，重试只会重复同一个失败。
 * 参考实现里对应的判据是 `!ended && waitsForPerson(...)`。
 *
 * @param {object} input
 * @param {object} [input.ended] 非空表示已结束
 * @param {{ state?: string, question?: string }} [input.report]
 * @param {boolean} [input.pendingQuestion]
 * @param {boolean} [input.archived] Lead 已验收归档：验收完的单元不该再被重派
 * @returns {boolean}
 */
export function canRetry({ ended, report, pendingQuestion, archived } = {}) {
  if (ended) return false
  // 已归档 = Lead 已经验收过这个单元，重派它等于否定那次验收。
  if (archived === true) return false
  const state = stateOf(report)
  if (state !== 'blocked' && state !== 'failed') return false
  return pendingQuestion !== true
}
