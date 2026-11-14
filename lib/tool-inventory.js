/**
 * dsh-main-agent — 角色 → 工具面正面清单（纯数据 + 一个查询函数）。
 *
 * 这个文件存在的理由：过去「谁能用哪些工具」只有反面表述 —— 一句
 * `WORKER_DENIED_TOOLS = ['ask_user_question']`。反面清单只能回答「worker 不能
 * 用 ask_user_question」，回答不了「worker 到底能用什么」，更回答不了「新加的
 * 工具默认归谁」。于是每加一个工具，都要有人凭记忆决定它属于哪一层。
 *
 * 这里把答案写成正面表：每一个本插件注册的工具必须在这里有一行，并写清理由。
 * `tests/tools-doc.test.mjs` 会拿 `lib/*.js` 里真实的 `defineTool({ name })` 与
 * `docs/TOOLS.md` 三向核对 —— 漏登记、表格与数据漂移、角色写错，测试直接红。
 *
 * 刻意不 import 任何宿主包：这是数据，测试要能在没有 node_modules 的仓库里跑。
 */

/**
 * 三种角色。
 *
 * - `lead`：常驻监督者（本插件的调用方）。它能看见用户的请求、持有 goal、
 *   对整条任务负责 —— 需要「往下看一层」的工具都只有它配用。
 * - `worker`：被派出去做单个单元的 agent。它唯一的向上通道是宿主原生的
 *   `report` 工具（不是本插件注册的），所以这张表里 worker 有零行 —— 这不是
 *   遗漏，是结论：worker 拿不到本插件的任何工具。
 * - `denied`：宿主内建、但**必须**从 worker 的工具面里摘掉的。摘掉的理由写在
 *   行里，`lib/worker-model-policy.js` 的 `WORKER_DENIED_TOOLS` 是它的执行面。
 */
export const ROLES = ['lead', 'worker', 'denied']

/**
 * 工具面矩阵。一行一个工具，`reason` 必须回答「为什么这个角色能用 / 不能用」。
 *
 * 新加一个 `defineTool` 而不在这里登记，`tests/tools-doc.test.mjs` 会失败 ——
 * 这是刻意的：默认归属不存在，每个新工具都得有人明确表态。
 */
export const TOOL_MATRIX = [
  {
    name: 'subagent',
    role: 'lead',
    reason: '派生的决定权属于能看见用户请求的那一层；worker 递归会同时架空并行上限与 authority 闸（maxDepth 只是兜底）。',
  },
  {
    name: 'send_message',
    role: 'lead',
    reason: '消息投给「我派出去的那个子会话」；worker 没有子级，它唯一的上行通道是宿主原生 report。',
  },
  {
    name: 'interrupt_agent',
    role: 'lead',
    reason: '中断的是自己名下的 agent，属于调度动作；worker 的职责是把手上这个单元做完。',
  },
  {
    name: 'list_agents',
    role: 'lead',
    reason: '列出的是「我的子级」；worker 没有子级，结果永远是空表。',
  },
  {
    name: 'wait_agent',
    role: 'lead',
    reason: '等的是「我名下的其他 agent 有没有新动静」；worker 那一层没有可等的对象，等待只会变成空转。dsh 0.2.2-rc.2 起它只在 @deepseek-ai/dsh-tool-subagent-control 里注册，而本插件的 preset 整行替换掉了那个插件，所以由 control 按宿主代数补上。',
  },
  {
    name: 'check_outcome',
    role: 'lead',
    reason: '清单是 worker 自己写的，让它自己跑自己的验收等于自证；只有 Lead 跑出来的结果才算证据。',
  },
  {
    name: 'get_goal',
    role: 'lead',
    reason: 'goal 是会话级的续行契约，只有监督者这一层持有；worker 拿到它只会让范围漂移。',
  },
  {
    name: 'start_goal',
    role: 'lead',
    reason: '写 GOAL.md 等于替整个会话承诺目标，这个承诺必须由看见用户原话的那一层做出。',
  },
  {
    name: 'update_goal',
    role: 'lead',
    reason: 'pause / complete / blocked 是对整条任务的判断；worker 只看得到自己那一个单元。',
  },
  {
    name: 'ask_user_question',
    role: 'denied',
    reason: '在子会话里挂起等用户回答不会唤醒任何 report，worker 会死等；上行必须走宿主原生 report。',
  },
]

/**
 * 某个角色能用的工具名。
 *
 * @param {'lead' | 'worker' | 'denied'} role `ROLES` 之一
 * @returns {string[]} 工具名（未知角色返回空数组，不抛 —— 清单查询不该成为新的失败点）
 */
export function listToolsFor(role) {
  return TOOL_MATRIX.filter(row => row.role === role).map(row => row.name)
}

/** 任务书里约定的短名。转发到 `listToolsFor`，只此一处定义，避免两份口径。 */
export const toolsFor = listToolsFor
