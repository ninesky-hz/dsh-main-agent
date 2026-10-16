# dsh-main-agent —— 常驻监督者 Agent 设计文档（Always-On Supervisor Agent）

一个 24/7 的 Main Agent，用于监督并行的 Dev Agent（子代理），完全以
DeepSeek Harness（DSH）代理预设 + 可复用 Cordis 插件构建。可移植：把它指向任意
工作区；所有状态都存放在该工作区下相对的 `.agi/` 目录中。

状态：经过三轮访谈后设计锁定（决策 Q1–Q23，日志见文末），
随后**在核实 harness 之后修订**（修订 A1–A6，§13），随后**在用户评审后简化**
（简化 S1–S4，§14），随后**在第二次 harness 深入探查后以原生优先方式重建**
（N1–N7，§15）—— 核心系统现在需要**零自定义
插件** —— 最后**为打底而修订**（G1，§16）：Main Agent 是一个
有事实打底的管理者，绝不是盲目的派发器。
实施载体：`tutorial/` 中的 15 章课程（每个里程碑都可实机测试），
配以 `tutorial/grade.py` 中的自动评分器（m0–m7）。`IMPLEMENTATION_PLAN.md` v2
是把里程碑 → 章节 → 评分器映射起来的索引；v1 的自建方案
保留在 git 历史中，其中可回收利用的骨架在教程第 13 章。

---

## 1. 核心概念

- **Main Agent** —— 一个长期存活的 DSH 会话。它在工作区中为所请求的任务打底，
  写下一个可复核的目标，武装原生循环，然后继续：派生
  子代理 → 休眠 → 唤醒 → 巡检轨迹 → 纠偏 / 终止 / 继续 → 重复。
  它主动与用户沟通，并且只为真正属于人类所有的
  权限或信息而阻塞，从不为一个被生成出来的目标确认仪式而阻塞。
- **Dev Agent** —— 一个拥有完整工具访问权限的通用 worker，按每次派生个性化：
  Main Agent 撰写每个子级的**角色 persona**（浏览器操作员、调研员、
  实现者……）以及一份完整、自包含的任务 —— 两者都在派生调用中传递；
  没有 brief 文件（S4）。可以并行运行多个（默认 1）。它
  在运行时安装自己需要的任何任务工具（例如 Playwright）；没有预置的
  任务工具。实现为 `agi-spawn` host
  插件中的自定义 `spawn_agent` 工具（A6）。
- **文件即事实来源。** Main Agent 的会话上下文只是缓存，绝不是
  记录。目标、笔记、进度、问题、changelog 以及子代理产物
  全都以文件形式存在于 `.agi/`，随工作进展写入。UI 渲染的正是这些文件。

## 2. 组合拆分（各部分所在位置）

| 部件 | 种类 | 说明 |
|---|---|---|
| `main-agent` | 代理预设 | persona、监督协议 |
| Dev Agent | `agi-spawn` host 插件（`spawn_agent` 工具） | 由 Main Agent 撰写的按次派生角色 persona；模型 + 并行上限在其行配置中（A6、S2、S3） |
| `tool-delay` | host 插件 | 工具调用之间的确定性延迟 |
| `subagent-trace` | host 插件 | 自动把子代理活动捕获到 `trace.log` |
| `wait_for_agents` | host 插件（工具） | 休眠/唤醒原语（唯一一处自定义循环部件 —— A5） |
| 状态服务 | host 插件 | 通过一条 web 路由把 `.agi/` 提供给 UI |
| schedule overlay | 随包发布的行 | 用于提问耐心计时器的 `dsh-schedule`（`dsh-time-context` 已弃用 —— 见 N8） |
| Progress Tab | 客户端插件 | 目标 + 事件流 + 提问栈（仅显示） |
| Subagents Tab | 客户端插件 | 运行列表 + 详情面板 + 终止/纠偏按钮 |

插件相互独立且可复用 —— 绝不要内联进预设。只有当某个插件得到验证之后，
才把它提升进 host 组合本体。随包发布的预设安装永不被
编辑；有作者署名的预设存放在 `.agent-presets/` 下各自的目录中。

## 3. Main Agent

### 3.1 生命周期
一个长期存活的会话（Q1a）。v1 没有特殊的上下文机制（Q12）：普通
压缩足够。没有强制的唤醒仪式（S1）：原生会话持久化就是
跨重启的记忆 —— 崩溃或重启会按原样恢复会话。`.agi/`（目标、
笔记、进度、子代理产物）仍是持久、可人工检查的记录；
代理按工作需求查阅并更新它，而不是按仪式去做。

### 3.2 休眠/唤醒循环（系统的心脏）
由 `wait_for_agents` 工具驱动（Q11、Q21）：

- **无参数。** 它会阻塞直到某个子代理收敛（返回或报告
  被某个问题阻塞）**或** `wakeMinutes` 流逝 —— 以先发生者为准。
  超时在调用时从 meta-config 读取，绝不由代理自行选择。
- 派生之后总是立即跟上 `wait_for_agents` —— 由
  persona 中的监督者协议强制执行（v1）—— 这样 Main Agent 不会忘记休眠。
- **超时唤醒：** tail/grep 子代理的 `trace.log`，判断进展。若在正轨上 →
  再次调用 `wait_for_agents`（一个简短、有界的回合 —— 这就是监督成本，
  通过 `wakeMinutes` 调优）。若在漂移 → 纠偏或终止（§5）。
- **收敛唤醒：** 原生收敛通知（或子级的 `report`）会唤醒父级
  回合。读取 `outcome.md`；通过 `send_message` 回答被阻塞的问题（A4），或
  处理结果并规划下一次派生。

理由：纯阻塞会让 Main Agent 在飞行途中失明，并静默删除
纠偏要求；纯轮询浪费 token。这是收敛或超时，
是仍能实施监督的最省成本的循环。注意（A5）：可继续的子级*不是* job，因此
`job_output(wait: true)` 无法替代这个工具 —— 它必须保持自定义。

### 3.3 提问协议（用户 ↔ Main Agent）（Q9、Q18）
- 首先表现得像一个普通代理：在聊天中提问并等待。
- 若在 `questionWaitMinutes`（默认 5）内没有回复：把该问题以
  `assumed` 记入 `questions.jsonl`，并附上所采取的假设，记录日志，继续处理
  未被阻塞的工作。绝不因等待人类而空转阻塞。耐心计时器是一个原生
  `schedule_create` 一次性提醒（随包发布的 schedule overlay），不是自定义机制。
- 迟到的回复是**新的纠偏**，而不是自动追溯重做：代理会说明
  它假设了什么、已经做了什么；由用户决定重做是否值得。
- 当代理自行解决了自己堆叠的问题时，它可以**撤回**这些问题并附上理由
  （例如先索要某个文件，随后通过搜索找到了它）。
- 所有人类输入都经由 Main Agent 聊天流动。Progress Tab 仅用于显示。
  用户聊天消息本身就是一次唤醒（一个回合），所以聊天也是用户对 Main Agent
  实施纠偏的方式。

### 3.4 自我演化（Q4）
允许自行修改：
- 它的 `.agi/` 状态文件与角色 persona（这很轻量）；
- 它**自己的预设**与 **`agi-spawn` 插件**（添加工具、重写子代理设置
  说明和默认 persona 片段、调整提示词各区段）；
- 运行时的**动态 Cordis 插件**（新工具/UI；在被持久化进某个
  预设之前都是临时的）。

绝不修改 host 组合（一次糟糕的编辑会把 harness 变砖）。

规则：
- **每个动作都记入** `CHANGELOG.jsonl` —— 这没有商量余地；日志是
  用户了解真实发生情况的方式。
- 工具新增立即生效（必要时自行重启）；**persona/说明的
  重写会排队等待用户评审** —— persona 漂移是危险的失败模式。
- 预设编辑会在 Progress Tab 动态流中公告。
- 可以*提议*修改 `config.json`，以问题的形式，但绝不编辑它（§6）。

### 3.5 非阻塞目标设置（Q19）
在直接的长期运行请求上，监督者会检查原生目标状态，检查
持久任务文件以及相关工作区 runbook/脚本，写入 `GOAL.md`
（目标、约束、里程碑、范围外），武装原生目标，并在
同一回合继续。`GOAL.md` 可由用户复核，但它不是审批门；
用户可以通过普通聊天纠偏、暂停或停止。在目标激活期间，该文档
不会被随意重写：范围变更以追加方式记入
`GOAL_AMENDMENTS.md`，或在完成后成为替代目标。监督者
只索取无法被发现或无法安全处理的选择、凭据、cookie 或权限
（见 §9）。

## 4. Dev Agent

- **一个自定义派生工具 —— 不是第二个预设，也不是随包发布的委托行
  （A3 + A6）。** 进程内子级共享父级的进程组合，所以第二个
  预设毫无收益（A3）。随包发布的 `tool-subagent` 行也不可取：它每条组合行
  固定一个 persona，对于个性化来说太死板（A6）。再往下一层，
  `ctx.subagents` 服务按请求接受**persona 和工具过滤**（"in-process
  backends scope filters and personas to child creation" —— `docs/subsystems/subagent.md`），
  并且可继续子级的描述符会为其冷恢复快照解析后的 persona 与模型。
  因此 Dev Agent 就是注册
  `spawn_agent(description, role, persona, prompt)` 的 `agi-spawn` host 插件，
  它是 `ctx.subagents.startContinuable()` 之上的一层薄包装。
- **按次派生的个性化：** Main Agent 在派生时撰写每个子级的 persona；
  `prompt` 参数承载完整、自包含的任务（S4），
  按 §7.2 结构化。Persona 说明子级*是*什么；任务说明它必须*做*什么。
- **并行上限由工具强制执行（S3）：** `spawn_agent` 统计运行中的子级，
  并在达到 `maxParallelSubagents` 时以清晰错误拒绝调用。该上限也会在挂载时
  注入工具的描述，所以代理事先就知道它 —— 但
  执行强制的是工具，不是 persona。
- 完整的工具/MCP/技能。按任务需求在运行时安装额外的工具链。
- **始终专注于任务**：没有自我记录职责 —— `subagent-trace` 插件
  自动捕获其活动（Q13b），所以一个糊涂的子代理不可能"忘记"
  留下痕迹。
- **被阻塞提问协议（Q14a，经 A4 修订）：** 若被只有
  监督者或用户才有的信息阻塞，它会用自己的原生 `report` 工具带上该问题并停止
  工作。报告投递（唤醒）会开启一个父级回合；Main Agent 通过
  `send_message` 作答，答案作为子级的下一回合到达 —— 上下文保留，
  无需 fork。
- 完成时它会写入 `outcome.md`（做了什么、核实了什么、还剩下什么），
  然后报告一段摘要。
- **模型：** `subagentModel` 在 `agi-spawn` 行配置中设置（S2）—— 归用户所有；
  代理可以提议更改，由用户编辑组合。该行位于
  实时监听的 profile patch 层，所以更改无需会话重挂载即可生效。
- 任务中刻意不包含节奏控制 —— 由 delay 插件强制执行；任务绝不
  重复基础设施已经保证的东西。

## 5. 监督与纠偏（Q5、Q6、Q15、Q22 —— 经 A1/A2 修订）

只有三个动词，每个都写入一条 `CHANGELOG.jsonl` 记录：

| 动词 | 机制 |
|---|---|
| **spawn** | 以角色 persona 和一份完整、自包含的任务（S4）调用 `spawn_agent` —— 可继续的后台子级；返回持久的子级 id。达到并行上限时以清晰错误拒绝（S3）。 |
| **kill** | 原生 `interrupt_agent` + 不再发消息（A2）：当前回合停止，且未被发消息的子级消耗零 token。`job_kill` 覆盖一次性后台子级。终止可靠性的硬性要求由原生方式满足。 |
| **steer** | 原生 `send_message`（A1）：把纠正排为运行中子级的下一回合 —— 正是 Q15 的措辞，已随包发布。只有当当前回合必须*立刻*停止时才在前面加 `interrupt_agent`。这也是回答被阻塞提问的方式。 |

只用原生 DSH 机制（按 Q22）—— 而且比原计划的 kill+fork 回退方案更好：
飞行中消息注入已随包发布。Kill + 重新派生为*全新*子级（新的派生、修订后的
任务与 persona）在子级上下文本身被污染时仍是回退方案。

**轨迹捕获（Q13b）：** `subagent-trace` host 插件接入原生
`session/event` 消防水管（A5），并把每次工具调用 + 结果摘要追加到
`subagents/<run-id>/trace.log`。确定性的；它支撑了 §3.2 中的 tail/grep 检查循环，
并为 Subagents Tab 提供数据。

## 6. Meta 配置（Q7、Q16）

`.agi/config.json` —— **仅用户可改**。Main Agent 可以以问题形式提议更改，但
绝不编辑它。实时读取：每次休眠都会重新读取它，所以用户可以在不重启任何东西的
情况下调优一个运行中的系统。

```json
{
  "toolDelaySeconds": 2,
  "wakeMinutes": 5,
  "questionWaitMinutes": 5
}
```

- `toolDelaySeconds` —— 由拦截工具执行的 `tool-delay` host 插件强制：
  确定、统一、适用于每个代理。一个开发期针对
  速率限制 / 成本爆炸的节流；**系统得到验证后即移除**（刻意保持简单
  —— 没有按预设覆写，没有预算）。
- `wakeMinutes` —— `wait_for_agents` 的超时（§3.2）。
- `questionWaitMinutes` —— 一个问题被堆叠为 `assumed` 之前的耐心窗口。

`maxParallelSubagents` 与 `subagentModel` **不**在这里：它们在
`agi-spawn` 行配置中（S2、S3）—— 仍归用户所有（代理提议，用户编辑
组合）。并行上限由 `spawn_agent` 自身强制执行，并在
其描述中写明。当用户调高上限时，Main Agent 仍必须处理 >1 个子级（多个活跃子级 id、
交错的收敛通知）。

## 7. 状态目录 `.agi/`（Q2c、Q23）

相对于目标工作区 —— 整套设置（预设 + 插件）与工作区无关，
可在任意仓库上运行。纯文件：可人工检查、可 grep、
可纳入 git 版本管理。由 Main Agent 写入（`config.json` 除外）；状态服务
只负责读取并把它们提供给 UI。

### 7.1 目录树

```
.agi/
  config.json              # user-only meta-config (§6)
  GOAL.md                  # written on native goal start; reviewable by the user
  GOAL_AMENDMENTS.md       # append-only active-goal steering record
  NOTES.md                 # Main Agent free-form working memory
  progress.jsonl           # event feed rendered by the Progress Tab
  questions.jsonl          # question stack (§7.4)
  CHANGELOG.jsonl          # every self-evolution + steering action (§7.3)
  subagents/
    <run-id>/
      trace.log            # automatic capture (subagent-trace plugin)
      outcome.md           # final report, or blocked-question payload
```

### 7.2 任务结构（`spawn_agent` 的 prompt）（S4）

v1 曾保存在每次运行的 `brief.md` 中的同一结构，现在完全由派生
调用承载 —— 没有文件：

```markdown
# Role
One paragraph: who you are for this task.

# Objective
What done looks like, concretely and verifiably.

# Scope
In: ...   Out: ... (touch nothing outside this)

# Context
Pointers to relevant files/URLs/prior outcomes — not prose dumps.

# Protocol
- Blocked on info only the supervisor/user has → call the report tool with the
  precise question, then stop; the answer arrives as your next turn (A4).
- On completion → write outcome.md (done / verified / remaining) under
  .agi/subagents/<run-id>/, then report a one-paragraph summary.

# Constraints
Task-specific rules (e.g. "draft, never post without confirmation").
```

### 7.3 Changelog 记录（每行一个 JSON 对象）

```json
{"ts": "...", "actor": "main-agent",
 "action": "preset-edit | plugin-define | spawn | kill | steer | config-proposal",
 "summary": "one sentence", "detail": "path, diff pointer, or run-id"}
```

### 7.4 提问生命周期（`questions.jsonl`）

`pending`（同时在聊天中提出）
→ `assumed`（在 `questionWaitMinutes` 之后；假设已记录；工作继续）
→ `answered`（用户已回复；迟到的回答 = 新的纠偏，§3.3）
或 → `withdrawn`（代理自行解决；理由已记录）。

## 8. UI（Q8、Q17、Q18）

一个客户端插件注册两个 `conversation.view` 页签，通过
状态服务路由渲染 `.agi/`。**仅用于显示** —— 每个回答/指令都经由 Main
Agent 聊天（按钮可以预组合一条发往 Main 会话的聊天消息，绝不直接
执行动作）。

- **Progress Tab：** (1) 已锁定的目标 + 修订，(2) 来自
  `progress.jsonl` 的逆时序动态流（Main Agent 摘要与关键想法，让用户始终拥有
  高层图景），(3) 提问栈 —— `pending` 与 `assumed` 突出显示。
- **Subagents Tab：** 一个稳定页签（不是每次运行一个页签 —— 它们会在一个 24/7
  系统上堆积）：运行列表，正在运行的固定在顶部；详情面板含状态、派生
  任务、实时轨迹尾部，以及终止/纠偏按钮。子级会话就是 Web GUI 中的普通会话
  （A5），所以每次运行都链接到其原生会话视图以查看完整
  轨迹；`trace.log` 仍是可 grep 的摘要界面。

## 9. 首个测试：X.com 增长自动化

一个刻意开放式、长周期的练习。代理代表用户行动。

1. 用户给出完整指令 → 非阻塞目标设置（§3.5）。Main Agent
   先检查现有自动化，并且只索取只有用户才能提供的凭据 / cookie /
   权限。
2. Main Agent 以一个浏览器操作员 persona 和一份完整的
   自动化任务派生一个 Dev Agent。子代理在运行时自行搭建工具链（例如 Playwright）
   并运行一个多模态循环：屏幕 → 动作 → 新屏幕 → ……
3. Main Agent 按 §3.2 的循环实施监督：每 `wakeMinutes` 唤醒，巡检轨迹，
   在了解到什么有效时纠偏或演进设置（更好的工具、修订后的 persona/任务）。
   在了解到什么有效时纠偏或演进设置（更好的工具、修订后的 persona/任务）。
4. 里程碑：先是 10 个关注者，然后是 100 —— 通过发帖 / 转帖 / 分享
   策略。

## 10. 可行性注意事项 —— 已解决（A5）

五个探针问题全部由 harness 以原生方式回答（来源见
`IMPLEMENTATION_PLAN.md` §1）；M0 在构建前对它们做一次冒烟测试：

1. **收敛通知** —— 原生：可继续子级的收敛会无条件
   向父级投递一条通知（结果 + 最终消息）。
2. **带纠正的 fork** —— 已取代：原生 `send_message` 把一条纠正
   注入为运行中子级的下一回合（A1）；纠偏不再需要 fork。
3. **可靠的终止** —— 原生 `interrupt_agent`；未被发消息的子级不做进一步
   工作，也不消耗 token（A2）。
4. **轨迹访问** —— 子级会话作为普通会话出现在 Web GUI 中；
   Subagents Tab 链接到它们；`trace.log` 是 grep 界面。
5. **事件接入** —— 原生：host 的 `session/event` 消防水管可以从一个
   普通 host 插件中观测。

## 11. 构建顺序（按修订调整）

| # | 交付物 | 种类 |
|---|---|---|
| 0 | 原生循环的 M0 冒烟测试（§10） | spike |
| 1 | `main-agent` 预设（persona、监督协议） | 代理预设 |
| 2 | `agi-spawn` host 插件（`spawn_agent` = Dev Agent，A6；上限强制 S3） | 插件 |
| 3 | schedule overlay 行（提问耐心计时器） | 随包发布的行 |
| 4 | `tool-delay` host 插件 | 插件 |
| 5 | `subagent-trace` host 插件 | 插件 |
| 6 | `wait_for_agents` 工具 | 插件 |
| 7 | 状态服务（`.agi/` 之上的 web 路由） | host 插件 |
| 8 | Progress Tab | 客户端插件 |
| 9 | Subagents Tab | 客户端插件 |

顺序：0 → 1–6 作为**无头核心**，在一个玩具任务上端到端验证（例如
"summarize a repo"），演练完整的 派生 → 休眠 → 唤醒 → 巡检轨迹 → 收敛 →
产出结果 循环，包括一次强制纠偏、一次强制终止和一次被阻塞的提问 →
然后是 7–9（UI 读取已经存在的状态）→ 非阻塞目标设置试运行 → X.com 测试。
里程碑细节、代码骨架和验证步骤见
`IMPLEMENTATION_PLAN.md`。

## 12. 决策日志

| Q | 决策 |
|---|---|
| Q1 | (a) 一个长期存活的会话；目标/笔记/记忆文件始终维护 |
| Q2 | (c) 文件即事实；轻量服务向 UI 提供数据；代理自行写入并检查 |
| Q3 | (b) 预设拆分 —— *经 A3/A6 修订：dev agent 是自定义的 `agi-spawn` 派生工具，而非第二个预设* |
| Q4 | (b+c) 可以编辑自己的预设 + 动态插件，绝不编辑 host 组合；一切均记录日志；工具新增立即生效，persona 重写排队评审 |
| Q5 | 休眠 → `wakeMinutes` 后唤醒 → 通过 tail/grep 轨迹日志检查；遇到提问/返回时提前唤醒 |
| Q6 | 双向纠偏：用户→main 通过聊天；main→subagent 通过 steer 动词 |
| Q7 | (b) 通过 host 插件实现确定性工具延迟（2s）；仅开发期、统一、简单 |
| Q8 | Progress Tab + 单个 Subagents Tab（含运行视图） |
| Q9 | 正常提问；沉默 5 分钟后堆叠为 `assumed`；继续；代理可撤回 |
| Q10 | meta-config 含子代理模型（派生时实时读取，A6）；所有任务工具在运行时制作/安装 |
| Q11 | `wait_for_agents` 工具；并行度 = 1 时派生后总是紧跟它 |
| Q12 | 无上下文机制；压缩 + 磁盘文件 |
| Q13 | (b) 由 host 插件自动捕获轨迹；dev agent 保持专注任务 |
| Q14 | (a) 被阻塞的子级提问并暂停 —— *经 A4 修订：原生 `report` 工具，经 `send_message` 回答；无 fork* |
| Q15 | 动词只有：spawn / kill / steer；没有 nudge |
| Q16 | (a) config.json 仅用户可改，适用于两个代理；代理只能提议 |
| Q17 | 单个 Subagents 页签；每次运行链接到原生会话视图（A5） |
| Q18 | 所有输入经由 Main Agent 聊天；页签仅显示；迟到的回答 = 新的纠偏；代理可清除自行解决的问题 |
| Q19 | 非阻塞的原生目标设置；可复核的 GOAL.md + 追加式修订 |
| Q20 | 凭据/cookie 在规划期间向用户索取 |
| Q21 | (b) 收敛或超时；超时来自 meta-config，无工具参数 |
| Q22 | 遵循 DSH 原生机制 —— *经 A1/A2 修订：steer = `send_message`，kill = `interrupt_agent` + 静默；终止可靠性由原生提供* |
| Q23 | 状态存放在每个工作区相对的 `.agi/` 中 —— 可移植到任意仓库 |

以上条目是历史记录；当某条 §14 简化与其冲突时
（例如 Q10 的配置位置），以 §14 为准。

## 13. 核实 harness 之后的修订

对照 DSH 检出副本核验（`$HOME/src/deepseek-harness`，最近为 dsh 0.1.1-rc.2）；确切
来源引用见 `IMPLEMENTATION_PLAN.md` §1。A1–A5 删除了原计划的自定义机制，
改用随包发布的原生机制；A6 刻意把一处重建为自定义，以支持
个性化。

| A | 取代 | 修订 |
|---|---|---|
| A1 | Q22/§5 steer | 纠偏是原生 `send_message`：它把一条消息排为运行中子级的下一回合 —— 即原 Q15 的措辞，严格优于我们设计的 kill+fork 回退方案。只有当当前回合必须立即停止时才先用 `interrupt_agent`。 |
| A2 | §5 kill | 终止是原生 `interrupt_agent` + 不再发消息：子级进入空闲并消耗零 token。`job_kill` 覆盖一次性后台子级。硬性可靠性要求无需自定义代码即可满足。 |
| A3 | Q3/§2/§4 | 没有第二个预设。进程内子级共享父级的组合；Dev Agent 的专门化改为随派生调用传递。（最初实现为随包发布的 `spawn_dev_agent` 委托行；该落点已被 A6 取代。） |
| A4 | Q14/§4/§7.2 | 可继续子级原生携带一个带回唤醒投递的 `report` 工具：被阻塞的子级报告其问题并停止；父级通过 `send_message` 回答。运行结束时阻塞 + fork 恢复的那套舞步被删除。 |
| A5 | §10 spike | 可行性探针由文档加一次 M0 冒烟测试解决：收敛通知、飞行中纠偏、终止、`session/event` 接入，以及 GUI 中按子级的会话视图全都是原生的。只有 `wait_for_agents` 保持自定义（可继续子级不是 job，所以 `job_output(wait)` 无法替代）。 |
| A6 | A3/Q10/§4 | 按次派生的个性化。随包发布的 `tool-subagent` 行每条组合行固定一个 persona，但底层的 `ctx.subagents` 服务按请求接受 persona 与工具过滤，且子级描述符会为冷恢复把它们快照下来。因此 Dev Agent 是自定义的 `agi-spawn` host 插件：一个包装 `startContinuable()` 的 `spawn_agent(description, role, persona, prompt)` 工具。Main Agent 撰写每个子级的 persona；模型落点已被 S2 取代。 |

## 14. 用户评审后的简化

只做有针对性的删减 —— 本文档其余部分仍按设计成立。

| S | 取代 | 简化 |
|---|---|---|
| S1 | §2/§3.1 唤醒仪式 | 没有强制的唤醒仪式。原生会话持久化就是跨重启的记忆；`.agi/` 文件仍是持久记录，按工作需求查阅和更新，而不是按唤醒时读取 / 休眠前写入的仪式。 |
| S2 | Q10/A6/§6 | `subagentModel` 位于 `agi-spawn` 行配置中，而不是 `.agi/config.json` —— 仍仅用户可改；代理提议，用户编辑组合。该行位于实时监听的 profile patch 层，所以更改无需重挂载即可生效。 |
| S3 | §6 `maxParallelSubagents` | 并行上限由 `spawn_agent` 自身强制：达到上限时以清晰错误硬拒绝，上限在挂载时注入工具描述，配置在同一个 `agi-spawn` 行上。persona 不再承载该检查。 |
| S4 | §7.1/§7.2 `brief.md` | 没有 brief 文件。角色 persona 和一份完整、自包含的任务随派生调用传递；§7.2 现在描述任务文本的结构。`trace.log` 与 `outcome.md` 仍按次运行保留。 |

评审未改动：`.agi/` 状态模型与文件格式的其余部分（§7）、
提问生命周期（§7.4）、目标设置（§3.5）、`config.json` 归属（§6）、
自我演化规则（§3.4）、监督动词（§5）以及 UI 范围（§8）。

## 15. 原生优先重建

决策（用户，在评审 harness 事实基线之后）：**在
内置能力之上构建；复用并定制 harness 给我们的一切，使自有改动保持
最小 —— 尤其是 UI。** 自定义插件被设计要做的每件事，结果都
原生存在（已在源码中核实，引用见 `IMPLEMENTATION_PLAN.md` §1）。核心系统
现在是：一个有作者署名的预设 + 一份 persona + 两行 host 平面配置行 +
`.agi/` 文件约定。当某条 N 条目与上述任何内容冲突时（包括 §14 的
S3），以 N 条目为准。

| N | 取代 | 重建 |
|---|---|---|
| N19 | N18 的单一全局 effort 策略与 main 回合继承 | Worker effort 权限完全移入 Plugin Settings，在添加/配置模型时生效。`workerModels` 仍是必需的模型枚举白名单；`workerEfforts` 是一张并行、按路由键控的映射，其值为 `provider/default` 或一个不透明的原生目录 effort id。每一行白名单条目以及添加模型流程都渲染各自由目录支撑的选择器。全新的 `runtime/current` 从 `provider/default` 起步，而没有映射条目的升级路由也解析为 provider 默认值——绝不解析为 main 请求。动态 `runtime/current` 只遵循 `request/header.config.provider/model`；`currentRuntimeModel()` 刻意丢弃 `reasoningEffort`。面向 main 的 `subagent` schema 不含 effort 参数，因此监督者只能选择一个用户批准的路由，而不能选择成本/effort 级别。执行时，选中的路由键会取出其实时设置值，精确模型校验仍在 provider I/O 之前失败，而固定值使用 N18 的精确子级首请求桥接/持久头部。provider 默认不安装任何覆写。白名单重挂载身份包含 effort 映射，因此描述与实时 meta 提示会立即显示每条路由有效的、归用户所有的值。该预设还移除了原生 `subagent_fork` 前端：与原生 spawn 一样，它没有受保护的模型参数，会在此策略之外继承路由/effort。因此，插件自有的受保护 `subagent` 是唯一面向模型的委托路径。 |
| N18 | N14/N15 的仅模型 worker 路由 | Worker 推理 effort 成为用户所有的 meta-config，且不修改 Harness。`dsh-supervisor.workerEffort` 有两个显式哨兵值——`runtime/current`（全新安装默认值，复制调用方 main 回合的显式 `request/header.config.reasoningEffort`）与 `provider/default`（省略 effort）——外加从原生按模型 `reasoning.efforts` 目录中发现的不透明固定 id。`/supervisor/models` 通过精确路由的 `resolveModelInfo()` 丰富轻量 `listModels()` 行，Settings 卡片公开这些能力；spawn 解析实时策略，并在 provider I/O 之前拒绝某个继承/固定值——若它不在精确选中的模型上。首次实机尝试证明，自定义的可合并扩展 `AgentOptions` 标记在嵌套的预设行插件上下文中不可见，所以最终桥接不依赖它：可继续的启动会预留其原生可选 `childId`；前台创建捕获新直接子级的 `agent/created` 边；根注册按该精确 id 过滤，并只替换该子级的首个 `agent/request`。这样把 effort 写入持久请求头，随后丢弃这个一次性预留。后续热步骤与冷继续不需要描述符扩展，因为 AgentLoop 会从头部重建显式、非适配器默认的请求字段。spawn 渲染与实时 meta 提示会公开有效 effort。provider 默认不安装覆写，从而保留真实的适配器/provider 行为。 |
| N17 | A4/N2 的被阻塞 worker 可见性 | 一次实机失败表明仅靠 persona 指引不够：某个 worker 忽略了 `report`，调用继承来的 `ask_user_question`，并在自己的子级会话中等待。该调用不发出 `subagent-report`；原生 `list_agents` 继续把该子级归类为 running，于是每次循环提醒都错误地断定自主工作正在推进。受保护的 spawn 前端现在提供一个固定的按请求 `toolFilter.deny = ['ask_user_question']`。进程内 provider 会从子级提示与执行路径中移除该工具，而可继续的子级作用域 `report` 工具则有意在全局限制下存活。因此，提问只走那条能唤醒父级、并为后续 `send_message` 保留子级句柄的通道。另外，实时按请求提示把 `running` 定义为驱动存活而非进展，并使提醒成为两次检查的有界升级：把具体证据与已保存的检查点对比；首次无变化时发送一次报告探针；下一次仍无变化时中断并恢复/重新派生。单纯重复的"继续监控"判定被明确视为无效。无需修改 Harness 或轮询启发式。 |
| N16 | Q19/N5 的原生面向模型目标前端 | 生产会话呈现出两种相反的失败模式：原生 `create_goal` 前端可能在持久打底之前就推断出自主意图，而第一个插件替代品又矫枉过正，用一个用户从未配置的随机 `CONFIRM GOAL …` 短语。那道第二回合门阻塞了既有工作区自动化，并导致监督者只读了 GOAL.md/NOTES.md 就停止，而没有检查 runbook 与脚本。该预设仍然只禁用 `@deepseek-ai/dsh-tool-goal` 并挂载 `dsh-main-agent/goal`；host 自有的 `ctx.goals` 服务、事件溯源的 `goal/change` 历史、投影/UI、CAS 修订、激活状态以及带竞态围栏的同会话回合驱动器仍然原生。替代前端现在公开 `get_goal`、`start_goal` 以及不可编辑的 `update_goal`。对于显式长期持续，执行前置守卫允许只读打底，但要求在 `start_goal` 之前先做当前回合的 `get_goal`；当有界工作区扫描发现 runbook、自动化脚本或源码入口时，还需要当前回合成功 `read` 一个 `.agi` 之外的这类文件。宽泛 glob 以及只看 GOAL.md/NOTES.md 都不通过。操作类工具在原生目标武装后立即开放。`start_goal` 仅限根/直接人类，会把 objective/constraints/milestones/out-of-scope/round cap 规范化为 GOAL.md，调用 `ctx.goals.create`，并返回同一回合——没有提案记录、哈希、短语或稍后确认。原生暂停/恢复权限、精确目标回合的完成/阻塞权限、三回合阻塞下限、收尾上下文与目标渲染都保留；目标激活期间刻意不提供 objective 编辑。 |
| N15 | N14 的仅固定路由全新安装策略 | 向 Settings 模型下拉框添加一个显式动态白名单值 `runtime/current`，并在全新安装默认值中启用它。它仍是必需的 `subagent.model` 参数，而不是省略/默认路径。执行时插件读取 `exec.agent.session.requestHeader().config`，即当前发起该工具调用的那次请求所捕获的路由（与 Harness 用于图像能力检查的同一权威来源），解析该模型的模态，并转发显式子级 `agentOptions`。当请求头不可用时它刻意失败关闭，绝不回退到 `agent.options`，后者的创建期路由导致了 N14 的陈旧 GLM 事件。工具输出记录解析出的真实路由/模态。固定路由仍与其并存；移除 `runtime/current` 会禁用动态跟随，而空列表仍会移除该工具。升级时保留既有设置；默认值在该命名空间首次安装时生效。 |
| N14 | N1/N10/N11 worker 工具命名、回退与继承策略 | 一次生产失败证明随包发布的 `subagent` 前端可以绕过插件白名单：它不暴露模型参数，且其子级会快照父代理会话创建时的 `options.provider/model`，即使实时模型选择把 main 请求路由到别处，该值也可能陈旧。因此预设移除了那条原生 `provider: spawn` 行，并以规范名称 `subagent` 暴露本包受保护的前端（而不是一个与之竞争、名为 `spawn_dev_agent` 的别名）。`dsh-supervisor.workerModels` 现在是唯一权威：必须提供一个精确的 `provider/model-id` 参数，裸 id 被拒绝，空设置禁用该工具，行配置/父级继承不再存在。工具 schema 会在设置变更时重挂载，其枚举只含当前已解析的允许路由及其原生 `[modalities]`；执行在 spawn 前重新校验当前设置，并始终发送显式 `SubagentRequest.agentOptions`。启动/完成渲染包含精确路由与模态，因此层级结构会暴露实际运行的内容。原生后端、重试、可继续会话句柄、收敛唤醒与终端失败丰富化保持不变。 |
| N13 | 原生可继续收敛的通用 `error` 通知 | 仅插件端的终端诊断：`dsh-main-agent/spawn` 在 `agent/pre-step` 协作式重写一条被接受的 `subagent-settled` 消息，保留其 id、来源与单次原生唤醒。它解析通知的持久收件箱时间，只检查当时已存在的子级前缀，从最新的 `session/end-seed` 之后开始，并附加最终记录的 `turn/end.error` 代码/消息。成功的 Harness 重试以 `completed` 结束且不添加任何内容；重试耗尽只暴露其最终原因。缺失持久化、仅拆卸期错误以及边界模糊时失败开放为原生通知。不修改 Harness 源码或重试策略。 |
| N20 | N12 的保留 worker 的 Full stop | 用户纠正：名为 **Full stop** 的操作控制对整次委托运行都是终态的，而不只是根回合及其计时器。该路由执行 cancel → idle，枚举直接可继续子级，并调用原生 `drainContinuableChildren`，后者按子级优先递归释放其驻地分支；随后它再执行一次 cancel → idle 屏障，以清除在进入排他式 schedule 维护之前抢跑拆卸的任何最终报告。`GET` 还要求零运行中的可继续 worker 才会报告已停止。持久子级会话作为历史保留，之后的用户提示只恢复监督者。 |
| N12 | N9 的 Feed 头部 Full stop（保留 worker 的行为已被 N20 取代） | Bug 修复：Full stop 现在通过持久 `parentSessionId` 血统把任何选中的 worker 会话解析到根 `main-agent`，通过原生同 id 的 `session.create` 路径恢复冷根且不发送提示词，并对冷/非监督者直接目标拒绝虚假成功。删除事务严格遵循 Schedule 的管理纪律：cancel → idle → 排他维护 → 持久性预检 → 折叠 → 追加所有活动删除 → 持久性后检。`GET` 折叠实时或冷持久状态，使成功控制按钮在刷新后保持一致缺席；它在下一次人类提示之后返回。 |
| N1 | A6/S2/S3、§2 `agi-spawn` | 没有自定义 spawn 插件。Dev Agent 是 `main-agent` 预设中的第二条**随包发布的** `dsh-tool-subagent` 行：`toolName: spawn_dev_agent`、`provider: spawn`、`backgroundMode: continuable`、按行的 `persona` 承载不变的 worker 协议（已核实：`Config.persona`、`tool-subagent/src/index.ts` 54–57/384；spawn provider 能力 `persona: true`）。按*次派生*的部分（角色）随任务提示词的 `# Role` 区段传递。`subagentModel` = 该行的 `agentOptions`。接受的取舍：并行上限又变成 persona 文字（S3 的硬强制随自定义工具一起被删除）；不同的 worker 类型 = 更多行（`spawn_browser_agent`、……）；按次派生 persona 的自定义工具仍是一个有记录的可选扩展。 |
| N2 | Q21/§3.2 `wait_for_agents`、§2 | 没有阻塞式等待工具。休眠 = 结束回合；唤醒 = 四种原生收件箱投递（收敛通知、子级 `report`、schedule 提醒、用户消息）。超时唤醒是一个**循环 schedule 提醒**（`every_seconds = wakeMinutes*60`），在派生时武装，在无 worker 运行时删除。随包发布的 300 秒循环下限带来的后果是：`wakeMinutes ≥ 5`。低于 5 分钟的节奏是构建可选 `wait_for_agents` 扩展的第一个正当理由。 |
| N3 | §2/§6 `tool-delay` | 完全弃用。`toolDelaySeconds` 从 `config.json` 中移除（它现在只保留 `wakeMinutes` 与 `questionWaitMinutes`）。可作为可选的 `tools/pre-execute` 瀑布插件恢复。 |
| N4 | §2/§5/Q13b `subagent-trace` | 没有轨迹插件。子级本身就是轨迹：每个子级都是一个持久会话（`~/.dsh/sessions/<ws>/<id>/session.jsonl.zstd`，每行一个 JSON 事件），在 web GUI 中完整渲染，并可在磁盘上 grep。计时唤醒检查 = `list_agents` + 日志尾部，结论记入 `NOTES.md`。结构化的按子级 `trace.log` 仍是一个可选的 `session/event` 扩展。 |
| N5 | §2 状态服务、§8 UI/页签 | 没有自定义页签，没有状态路由。随包发布的 UI 就是 UI：会话列表 = 运行列表；子级会话视图 = 详情面板 + 实时轨迹；目标工具的显示 = 目标界面；对 `progress.jsonl`/`questions.jsonl`/`CHANGELOG.jsonl` 执行 `tail -f` = 动态流。Q18 的仅显示规则自然成立（聊天是控制界面）。一个可选的点缀：一个约 60 行的动态客户端插件，把一个状态胶囊注册进随包发布的 `shell.overlay` 槽位（附加式，按契约点击穿透）。动态 = 进程记忆；重启后重跑，或按 §15-ext 提升为正式实现。 |
| N6 | §2 schedule overlay | 确认是唯一的 host 平面变更：在 `~/.dsh/profiles/web/cordis.patch.yml` 中一行 `insert`（`dsh-schedule`）—— 实时监听层，无需重启。 |
| N11 | N10 的行配置白名单（作为主要旋钮已被取代） | 用户要求的 META-CONFIG：一个设置命名空间 `dsh-supervisor`（原生 settings 域，`installSettingsSection`），持有 `workerModels`、按路由键控的 `workerEfforts`（N19）、`maxParallelWorkers`、`wakeMinutes`、`questionWaitMinutes` —— 可在 `~/.dsh/settings.yaml` 与 Settings → Plugins 卡片中编辑（浏览器半部注册 `settings.plugin.item` 键 `dsh-supervisor`；添加模型下拉框由新的 `GET /supervisor/models` 路由供给 = 带模态与推理能力的原生目录；卡片外壳为手工实现，因为 bundle 纯净门禁禁止导入 ui-settings-plugins 的表单模型）。构造上即是 LIVE：host 半部把该值发布为 `supervisorSettings` 服务；spawn 工具在*每次*调用时读取它（白名单 + 按路由 effort + 上限），而一个带文本函数的 `systemPrompt.section` 会把当前值重新渲染进每个请求 —— 无需重启、无需新会话、无需重新注册。`maxParallelWorkers` 现在是硬强制（S3 恢复）：open workers = 活动子级 + 一个 fiber 局部的启动账本（刚派生的子级在其首个回合前报告 `inactive`，所以单纯的活动计数会让两个同步骤派生同时通过 —— 实机测试中已捕获），且该工具刻意为非并发安全，使同步骤的派生体串行化。计时键：工作区 `.agi/config.json` 仍可覆写；设置是部署默认值。 |
| N10 | N1 的固定 worker 行 | 用户要求：worker 模型选择现在是通用的。预设的 dev 行挂载本包自己的工具（`dsh-main-agent/spawn`，预设行 `name:` 引用该包子路径导出），而不是 `@deepseek-ai/dsh-tool-subagent`。相同的 provider（`spawn`）、相同的可继续子级、相同的按行 worker persona —— 另加一个可选的按调用 `model` 参数（`provider/model-id`，无歧义时可只写 id）。该机制是原生的：`SubagentRequest.agentOptions` 在 `ctx.subagents` 中按请求生效（`continuation.ts` 按子级快照 `request.agentOptions?.provider/model`）；只有随包发布工具的按行配置把它藏了起来。模型选择由用户所有的白名单把关（行配置 `models: [provider/model-id, …]`）：缺失/为空时，该工具没有 `model` 参数，子级只能继承 —— 代理绝不会发现用户未点名的路由（模型是要花钱的）。允许的条目会连同其原生 `inputModalities`（`ctx.llm.resolveModelInfo`）以 `[text]` / `[text,image]` 渲染进工具描述，因此监督者*能看见*哪些允许的模型具备视觉能力，并只在某个单元必须看图时才选择它（worker 通过 `read_image` 读图，该工具在纯文本路由上会拒绝 —— 同一个模态标志，原生强制）。记录的视觉事实：Z.AI `glm-5.3` 上游为纯文本（图像内容返回 HTTP 400，文档："supports text-only inputs"）；`glm-5v-turbo` 是 `[text,image]` 路由。 |
| N9 | N5 的"无自定义页签"（部分） | 用户要求：bundle 现在**随包发布一个 Feed 视图页签** —— 一个持久客户端插件，而非动态插件。浏览器半部（`lib/client.js`，按 `docs/cookbook/adding-a-settings-card.md` §Packaging 手写的惰性 CJS）把 id `supervisor-feed` 注册进随包发布的 `conversation.view` 环（即承载 Chat/Trajectory 的原生视图页签槽位），由客户端模块扫描供给（`dsh.client` + `exports["./client"]` —— 无需前端重建）。host 半部添加 `GET /supervisor/feed?ws=`（嵌套 fiber 注入 `webServer`，因此非 web profile 仍会挂载预设安装器）。数据原生优先：目标 = `goal` 投影（`useProjection`），worker = `subagent.list` RPC，文件 = 读取 `.agi/` 的 feed 路由。动态状态胶囊已退役（曾是进程记忆 + 审批门控）；N5 的其他决策仍成立。 |
| N8 | N6 的 `dsh-time-context` 行 | 已弃用。time-context 会向*每个*请求步骤注入一个"Time sampled while preparing turn N, step M …"块 —— 恒定上下文噪声，且每步都自我取代。它不是 Schedule 的依赖（已核实：`packages/schedule/schedule/README.md` —— "Time-context is not a Schedule dependency"），并且监督者的计时器都是相对的 `after_seconds`，从不是时区本地的 `at` 形式。如果某个部署想要自然语言的绝对时间，就在它自己的 profile patch 中挂载 `@deepseek-ai/dsh-time-context`。 |
| N7 | （文档发现） | 随包发布的 `editing-cordis-compositions` 技能仍在教已移除的工具（`cordis_inspect`/`cordis_mount`/`cordis_unmount`）。实时工具集是七个具备 define/run 生命周期的工具：`cordis_inspect_list/_query/_self`、`cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine`（`packages/extensions/tool-cordis/src/index.ts`）。该技能关于平面/复制/校验的建议仍然正确；只有工具名称过时。预设创作仍走名册：`copy('standard', 'main-agent', …)` + `standingKeyFor` 校验，由 Creator 模式（`cordis` 预设）的会话驱动。 |

可选扩展（ext）：当原生能力不再够用时，旧的自定义部件会
构建为一个树外包，作为 `file:` 依赖 + bundle（`dsh.bundle.patch` 清单字段）
安装进 profile，并使用本仓库的无构建包作为
安装模板；不假设存在任何无关的第三方检出副本。delay / trace / wait / state-route 的
修正骨架在教程第 13 章。

打包（N6 之后的细化）：本仓库本身就是这样一个 bundle（`dsh-main-agent`）。
它的 `cordis.patch.yml` 承载 N6 的 schedule 行（id `agi-schedule`；time-context
行已按 N8 弃用），并且在启动时有一个无构建的设置插件（`lib/index.js`）把随包的
`main-agent` 预设安装进用户预设根目录（非破坏性；
`syncPreset: if-absent | always | never`）。在任意机器上安装：
`dsh plugin --profile web add <git-or-path>` + 一次重启。手工 patch 层
路径保留为 `scripts/install-manual.sh`；两条路径互斥，
因为 schedule 服务每个进程只注册一次。

## 16. 打底修订

| G | 取代 | 修订 |
|---|---|---|
| G1 | §1/§3 的措辞"自身不做实现工作" | Main Agent 是一个**有事实打底的管理者，而不是盲目的派发器**。委托边界是**变更，而非好奇心**：写代码和更改系统交给 worker；读取、搜索、检查、判断与核实是监督者自己的工作，用它自己的全套工具完成。规则现已写入 persona（GROUNDING 段落）：绝不为一个 30 秒阅读就能回答的问题发起委托；对于超出其上下文的大范围勘察，派生一个**调研型 worker**，其全部交付物就是一份报告，并归并入 `NOTES.md`；打底结果记入 `NOTES.md`，以便在重启后仍然存活；worker 说"完成"只是一个声称，文件存在才是事实 —— 交付物要用监督者自己的眼睛核实后才记录进展。循环第 1 步现在是"先打底，再规划"。 |
