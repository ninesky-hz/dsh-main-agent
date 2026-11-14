# 工具面：谁能用哪些工具

这张表受测试约束 —— `tests/tools-doc.test.mjs` 会拿它和 `lib/tool-inventory.js` 的
`TOOL_MATRIX`、以及 `lib/*.js` 里真实的 `defineTool({ name })` 三向核对。
**改工具必须同步改表**：加一个工具不在表里登记，测试直接失败；表格与代码对不上，
测试也失败。所以「这个工具归谁」不再靠记忆，而是一条会红的断言。

三种角色：

- **lead** —— 常驻监督者。它看得见用户的请求、持有 goal、对整条任务负责。
- **worker** —— 被派出去做单个单元的 agent。它的唯一向上通道是宿主原生的
  `report` 工具（不是本插件注册的），所以本插件这里 worker 有 **零行**：
  这不是遗漏，是结论 —— worker 拿不到本插件的任何工具。
- **denied** —— 宿主内建，但必须从 worker 的工具面里摘掉。
  `lib/worker-model-policy.js` 的 `WORKER_DENIED_TOOLS` 是它的执行面。

| 工具 | 角色 | 理由 |
| --- | --- | --- |
| `subagent` | lead | 派生的决定权属于能看见用户请求的那一层；worker 递归会同时架空并行上限与 authority 闸（maxDepth 只是兜底）。 |
| `send_message` | lead | 消息投给「我派出去的那个子会话」；worker 没有子级，它唯一的上行通道是宿主原生 report。 |
| `interrupt_agent` | lead | 中断的是自己名下的 agent，属于调度动作；worker 的职责是把手上这个单元做完。 |
| `list_agents` | lead | 列出的是「我的子级」；worker 没有子级，结果永远是空表。 |
| `wait_agent` | lead | 等的是「我名下的其他 agent 有没有新动静」；worker 那一层没有可等的对象，等待只会变成空转。dsh 0.2.2-rc.2 起它只在 `@deepseek-ai/dsh-tool-subagent-control` 里注册，而本插件的 preset 整行替换掉了那个插件，所以由 control 按宿主代数补上。 |
| `check_outcome` | lead | 清单是 worker 自己写的，让它自己跑自己的验收等于自证；只有 Lead 跑出来的结果才算证据。 |
| `get_goal` | lead | goal 是会话级的续行契约，只有监督者这一层持有；worker 拿到它只会让范围漂移。 |
| `start_goal` | lead | 写 GOAL.md 等于替整个会话承诺目标，这个承诺必须由看见用户原话的那一层做出。 |
| `update_goal` | lead | pause / complete / blocked 是对整条任务的判断；worker 只看得到自己那一个单元。 |
| `ask_user_question` | denied | 在子会话里挂起等用户回答不会唤醒任何 report，worker 会死等；上行必须走宿主原生 report。 |

## 为什么 worker 那一列是空的

worker 的工具面里只留宿主内建的 `report` 与它自己的读写工具。监督者需要的每一样
东西 —— 派生、调度、读其他人的状态、跑验收、读写 goal —— 单独拿给 worker 都会
制造一个「worker 能替监督者做决定」的入口，而 worker 恰恰看不见做那些决定所需的
信息。真正的缺口不是「worker 工具太少」，而是「worker 想把一件事交回去时没有通道」，
`report` 就是那条通道，也是它唯一需要的那一条。

反面清单（`WORKER_DENIED_TOOLS`）只说明「worker 不能用 ask_user_question」，
说明不了「worker 到底能用什么」，更说明不了「新加的工具默认归谁」。这张表是那个
问题的答案，也是它必须被测试钉住的原因。
