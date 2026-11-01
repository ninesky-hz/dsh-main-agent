# dsh-superagent-prototype 对照分析

对照对象：`deepseek-ai/dsh-superagent-prototype`（本机克隆于 `D:\Ai-Project\_ext\superagent-proto`，commit `6337fc8`）
对照本体：本仓库 `dsh-main-agent`（常驻监督者插件）
结论时间：2026-11 初

## 0. 一句话结论

两者是同一问题空间的两个侧面，不是同一产品的两代版本。

- 原型解决的是「**外部世界源源不断地提需求，我怎么判断该不该接、接了怎么不丢**」——多源触发、准入、工单生命周期、投递可靠性。
- 本插件解决的是「**人给定一个长期目标，我怎么持续把它推完**」——持久目标、可执行验收、巡检节奏、纠偏。

因此启发不是「照抄架构」，而是**六个具体机制**：其中 2.1 与 2.2 成本极低、收益立竿见影，2.5 长期价值最高。

## 1. 定位差异

| 维度 | dsh-main-agent | dsh-superagent-prototype |
| --- | --- | --- |
| 触发源 | 人（对话）+ worker 收敛 + 定时器 | GitHub / 飞书事件流，可插件化 `Source` kind + instance |
| 准入判定 | prompt 文字 + `lib/goal-policy.js` 的工具闸（`continuationToolDecision`） | 两层 Eval：确定性 gate + 模型 assessment，产出 `Decision` |
| 工作单元 | `goal`（原生 goal）+ 每次派生的 `subagent` | `Ticket`（有 Mandate、状态机、多 Assignment） |
| 验收 | `checks.json` + `check_outcome` 真跑命令 | 无独立验收，靠 worker 自报 `Report` |
| 持久目标 | 有（`GOAL.md` + milestones + 回合上限） | 无（只有单个 Ticket，跨 ticket 的目标要靠人） |
| 收敛模式 | Ralph fresh-agent 循环 | 无对应物 |
| 状态存储 | `.agi/` 下 JSON / JSONL，可读可 diff 可手改 | 单个 SQLite + 46 KB migration |
| Prompt | 内嵌在 `presets/main-agent.patch.yml`（548 行）与 `agent-presets/main-agent/agent.cordis.yml` | 外置 `prompts/*.md`，版本化，面板可编辑 |
| 人机界面 | 监督动态 Feed + full stop + 设置卡片 | 六个标签页面板，按「谁在等」组织 |

## 2. 六个值得移植的点

### 2.1 Ticket stage 是纯函数，不是日志推断

**原型**：`src/core/stage.ts:9-21`，26 行，first-match-wins：

```
ended → person/delivery → person/answer → person/review
      → person/blocked|failed（且 waitsForPerson）→ working/queued → idle → working
```

分类规则见 `docs/003-execution.md:7-17`。关键性质：**同一个 ticket 快照永远算出同一个 stage**，不需要读日志、不需要猜。

**本插件现状**：`lib/watchdog.js` 用 `readAgiFacts` / `lastActivityAt` 判断「是否还有进展」，`lib/loop-journal.js` 生成 `BRIEF.md`。这是**时间差推断**，不是状态推导——「worker 卡了 8 分钟」和「worker 在跑一个 8 分钟的长命令」在数据上不可区分。系统提示里那条「`list_agents` 的 `running` 只证明驱动还开着」正是这个缺口的补丁式说明。

**改法**：`.agi/subagents/<id>/` 增加一条结构化 report（见 2.2），`stage` 由纯函数计算，`BRIEF.md` 直接输出 `person/answer`、`working`、`idle`，巡检时按 stage 分派动作，不再看时间差。

**成本**：约 80 行纯函数 + 一处 BRIEF 渲染。**收益**：巡检判断从「经验」变成「查表」。

### 2.2 Report 六态，禁止从自由文本推断「在等人」

**原型**：`docs/001-domain.md:111` 定义 `Report` 为 `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped`；`docs/001-domain.md:60` 的「Rejected concepts」明确否掉一条做法：

> Inferring "waiting on a person" from a report's free text — The classification needs structured facts; the Executor asks through a structured field.

**本插件现状**：恰恰在做被否掉的那件事。worker 交 `outcome.md`（自由文本）+ `checks.json`（可执行断言），「它是不是卡住了」「它是不是在等我」全靠 Main Agent 读文本判断。而且六态里的 **`dropped`（干完了、但确实没活可干）我们没有**——于是「任务不成立 / 已被别处解决 / 无需改动」会被记成失败或留成悬案。

**改法**：`subagent` 的 worker 协议加第三行头字段，复用已有的 `<!-- worker: <session id> -->` 头行机制：

```
<!-- worker: <session id> -->
<!-- report: blocked -->
<!-- question: 需要确认 A 还是 B -->
```

`lib/checks.js` 旁边加一个 `report` 解析器，非法/缺失按 `progress` 处理（fail-open），不破坏现有 worker。`blocked`/`failed` 时若有 `question`，直接进 `.agi/questions.jsonl` 与 `schedule_create` 的提问等待，不再靠人读出来。

**成本**：一个解析器 + prompt 一行。**收益**：这是全部六条里性价比最高的一条。

### 2.3 人优先的额外并发槽

**原型**：`docs/003-execution.md:59`——并发上限之外**额外留一个槽**给「人的消息或状态查询」，原文结论：*New work therefore cannot prevent a person from continuing an existing Ticket.*

**本插件现状**：meta-config 的并行 worker 上限（当前 6）是硬拒绝，`send_message` 唤醒一个已有 worker 在语义上是「续接」不是「新建」，但计数角度看仍可能被 6 个在跑的 worker 挡住——人反而排在机器后面。

**改法**：`lib/spawn.js` 的计数区分「新派生」与「续接已有会话」，续接不占名额，或显式加一个 reserved slot。

**成本**：小。**收益**：人的纠偏永不被自动任务饿死。

### 2.4 stored work + outbox 指数退避

**原型**：`docs/003-execution.md:153-161`（stored work）、`:177-191`（channel 退避 5s→300s）、`:157`（relay/delivery 2s→1min 翻倍）；持久化在 `effect` / `outbox` 两张表（`docs/007-architecture.md:462-463`），message 一旦入 outbox 就「一个 id 永不入队两次」。`src/app/retry-health.ts` 还把「模型预算耗尽」从事件流里投影成健康条目。

**本插件现状**：`lib/settlement.js` 只做**失败诊断的富化**（`enrichSettlementMessages`），不做投递保证。`send_message` 一旦失败，那条续行线索就没了；定时器提醒是唯一兜底。这是当前最致命的静默失败模式：worker 收敛通知丢了 → 主循环不被唤醒 → 任务停摆而无人知道。

**改法**：`.agi/outbox.jsonl` 存待投递项（含 kind / target / payload / attempts / dueAt），投递失败按 2s→4s→…→60s 退避；用现有的 `schedule_create` 当触发器驱动重试。与 2.2 的 `report` 配合：投递失败不该算 worker 失败，只算 delivery 未达。

**成本**：中。**收益**：消灭「任务静默停摆」。

### 2.5 Prompt 外置 + 版本化 + Default updated 差异标记

**原型**：`docs/004-prompts.md` 全套——`prompts/*.md` 按 `runtime/<part>` 键覆盖；每次保存产生**不可变版本**（`prompt-revision` / `prompt-version:<n>`，含 base revision）；升级改变默认值时面板标 **Default updated** 并给出旧/新默认值的差异，让用户选「保留我的」或「用新默认」；与默认完全相同的覆盖会被删除，从而自动跟随未来默认。

**本插件现状**：prompt 在 `presets/main-agent.patch.yml`（548 行）与 `agent-presets/main-agent/agent.cordis.yml`（34 KB）里；改一句话要改 yml + 跑 `scripts/sync-preset-patch.mjs`；插件升级时用户改过的文本要么被覆盖要么要手工合并。`scripts/verify-persona-compose.mjs` 与 `tests/supervise-persona-compose.test.mjs` 说明「装配」的骨架已经在，缺的是**外置与版本**。

**改法**：抽 `presets/prompts/*.md`（persona / work / dispatch / replies / handoff 分文件），`sync-preset-patch.mjs` 负责组装；`.agi/prompt-versions/<n>.json` 存版本与 base。这一条是**长期价值最高**的，因为它同时解决「升级覆盖用户改动」和「prompt 不可审阅」两个问题。

**成本**：大（一次性重构 + 迁移脚本）。**收益**：插件可维护性的天花板。

### 2.6 accept mode：主动行为先「只记录不执行」

**原型**：`docs/002-authorization.md:93-101` 三档 `off` / `observe`(默认) / `auto`。`observe` 下正向判定只记成「would accept」，不真接单；人看过记录再切 `auto`。

**本插件现状**：主循环**默认自动派生**。虽有 grounding 前置与工具闸，但没有「先看它本会做什么」这个档位。新用户第一次装上就是在看它真花钱、真改文件。

**改法**：meta-config 增 `proactive: off | observe | auto`。`observe` 时把「我本会派生的 worker（description + 完整 prompt）」写进 `.agi/proposals.jsonl`，不真派；人在 Feed 里看几条之后再开 `auto`。

**成本**：小。**收益**：安全阀 + 调试器，顺带成了「提示词效果预览」。

## 3. 次级启发（零散但真）

1. **worker 工具面要按角色裁**：`docs/004-prompts.md:63`——Executor 的工具**排除** `ask_user_question`、`present`、`plugin_manager` 这类「向人提问/展示」的工具，因为「Executors work unattended」。本插件的 worker 若带着 `ask_user_question`，会产出一个没人回答的问题，再被 2.2 那个缺口误读成 `waiting`。裁掉即可。
2. **主循环不许等**：`docs/007-architecture.md:513` 的 `noWait` guard 硬拒 `sleep`、>30s 的 shell timeout、>5s 的 `job_output` wait，理由是「等待只会推迟下一个候选」。本插件靠定时器休眠天然合规，但巡检时一次 `job_output(wait: true)` 就破坏了它。应写成硬约束而不是自觉。
3. **delivered ≠ read**：`docs/003-execution.md:150-152` 与 `src/core/model.ts:341-344`（`readUntil`）区分「投递到会话」与「被某一步取进历史」，重启后既不丢也不重复投递。本插件 `send_message` 续接同一 session 天然接近，但缺「claim 了却被 cancel 打断」的语义。
4. **`unfinished` 判定**：`src/core/tickets.ts:370-379`——工单结束前还要问「worker 有没有接手过一条还没处理完的人消息」。对应本插件的「worker 报 done 但人的追问还没进它的上下文」。
5. **健康条目化**：`docs/002-authorization.md:153` 的 `evals` health 把「一小时内未解决的 unavailable Decision」报成错误。本插件 `lib/settlement.js` 有单点诊断，缺「积压」视角。
6. **拒绝概念表是最好的灵感来源**：`docs/001-domain.md:45-60` 那张表，每一条都是踩过的坑的负面清单。「Cancelling running Tickets on a Policy change」「Locking all tools when it fails」「Waiting or revoked Eval states」——本插件也该有一张自己的，放进 `DESIGN.md`。

## 4. 明确不要照抄的

- **Source / Channel / Thread / Subscription / Correlation 全套领域模型**。那是为「外部世界事件驱动」设计的。本插件的主触发源就是**人**，套六层概念违背原型自己第 19 行的原则（「Few concepts. A business need becomes an attribute of one of them」）。只偷 `stage`、`report`、`outbox` 三个机制足够。
- **SQLite + schema migration**。`.agi/` 现在可读、可 git diff、可被用户手改——对插件分发这是优点不是缺点。原型自己承认 `docs/007-architecture.md:484`：「Nothing deletes old records yet, so these grow without bound」。
- **Mandate / Policy version 全量**。`GOAL.md` 已覆盖 80%。唯一值得偷的是一个字段：`GOAL.md` 加 `revision`，让「目标活跃期被纠偏」有版本可追，而不是只靠 `GOAL_AMENDMENTS.md`。
- **面板六个标签页**。本插件 Feed 的信息密度已经够；要偷的是 `docs/005-panel.md:52-57` 那七条原则，尤其第 2 条「精确的定义：分类要可检验、互斥、覆盖全部情况，像 Ticket stage 那样」和第 6 条「Quiet by default：健康状态不占空间」。

## 5. 反向：原型缺什么

上游没有 `ralph` / `check_outcome` / 持久 goal / 多层定时器纪律（全仓 grep 无命中）。原型的 worker 自报 `ready` 就是 ready，**没有独立验收**——`docs/007-architecture.md` 的工具表里没有任何等价于 `check_outcome` 的东西。以下四项可以反向输出给上游：

1. **`checks.json` 可执行验收**：worker 自己写断言、宿主真跑、失败项即「它自称做完了但没做成的地方」。
2. **持久目标**：`GOAL.md` + milestones + 回合上限，跨 ticket 存在。
3. **Ralph fresh-agent 收敛**：上下文被污染时的机制化重置。
4. **三层定时器纪律**：worker 在跑 / 等用户 / 刚有进展 用不同退避。

## 6. 建议动作顺序

| 顺序 | 动作 | 成本 | 依赖 |
| --- | --- | --- | --- |
| 1 | 2.2 Report 六态（先只读、fail-open） | 小 | 无，今天可做 |
| 2 | 2.1 stage 纯函数 + BRIEF 按 stage 渲染 | 小 | 2.2 |
| 3 | 2.3 人优先槽 + 3.1 worker 裁工具面 | 小 | 无 |
| 4 | 2.6 accept mode `observe` | 小 | 无 |
| 5 | 2.4 outbox 退避重试 | 中 | 2.2（需要 kind 区分） |
| 6 | 2.5 prompt 外置 + 版本化 | 大 | 无，但应在 1–5 稳定后 |

如果只做一件事：**2.2**。它把「巡检靠读文本猜」换成「巡检靠查字段」，且是 2.1 与 2.4 的地基。

## 7. 落地记录（2026-11-01）

按第 6 节的顺序做完五条，第六条在进行中。下表是「机制 → 落点」，代码位置是判断「这条到底有没有真的生效」的入口。

| 启发 | 状态 | 落点 |
| --- | --- | --- |
| 2.2 Report 六态 | 已落地 | `lib/report.js`（`REPORT_STATES` / `readReport` / `hasPendingQuestion` / `collectReports`）；协议写在 `agent-presets/main-agent/agent.cordis.yml` 的 worker persona |
| 2.1 stage 纯函数 | 已落地 | `lib/stage.js`（`workerStage` / `renderStageLabel`）；BRIEF 渲染在 `lib/loop-journal.js` 的 `renderWorkerLines` |
| 2.3 人优先预留槽 | 已落地 | `lib/spawn.js` 的 `reservedHumanSlots`（默认 1）；放行判据依赖 `lib/goal.js:hasDirectHumanMessage` |
| 2.6 accept mode | 已落地 | `lib/spawn.js` 的 `proactive: 'off' \| 'observe' \| 'auto'`（默认 auto）；observe 写 `.agi/proposals.jsonl` 不真派生 |
| 2.4 outbox 退避 | 已落地 | `lib/outbox.js`（`backoffMs` 2000 起翻倍封顶 60000 / `enqueue` 幂等 / `dueEntries` 同类保序）；入队在 `lib/settlement.js`，消费在 `lib/loop-journal.js:writeBrief` |
| 2.5 prompt 外置 + 版本化 | 进行中 | 目标：`prompts/*.md` 为唯一编辑入口，`scripts/sync-prompts.mjs` 幂等写回 `agent-presets/main-agent/agent.cordis.yml`，revision 写进 `presets/main-agent.patch.yml` 头注释 |

### 落地时发现的三件事（原型文档里没有）

**1. 「测试绿」不等于「插件变了」。** 本插件的运行时加载的是 profile 下的实体副本 `C:\Users\Chen\.dsh\profiles\desktop\node_modules\dsh-main-agent`，不是仓库 symlink。实际踩到的情况比「副本旧」更严重：`lib/report.js` / `lib/stage.js` / `lib/outbox.js` 三个新文件在副本里**完全不存在**，批次 A/B 的全部工作在生产路径上等于零。判据不该是 outcome.md 也不该是测试结果，而是 `Get-FileHash` 逐个比对副本。

**2. Windows 上 `check_outcome` 有一半验收项是假的。** `lib/checks.js` 走 `cmd.exe /c`，Node 会给含空格的参数再套一层双引号，而 `node -e "..."` 这类验收项自己已带引号 —— 两层叠起来被 cmd 解析坏。表现是 `SyntaxError: Invalid or unexpected token`，**更阴的是退出码有时仍是 0**。修法是 `windowsVerbatimArguments: process.platform === 'win32'`。

**3. 批次边界会把接线点切断。** 2.1/2.3 的渲染逻辑与 2.4 的消费点都在 `lib/watchdog.js`，被切进了不同批次。结果两边的功能各自单测全过、各自「完成」，但那条从「事实」到「摘要」的线从来没接上。以后按**文件**切批次，不按**机制**切。

## 8. 与原型的三处刻意分歧

1. **不出 `dropped` 之外的第七态。** 原型的 `unfinished` 判定（`src/core/tickets.ts:370-379`）依赖它自己的 Ticket 生命周期，本插件没有对应概念，硬加会得到一个永远为真的状态。
2. **BRIEF 不做水位线。** 原型用 `readUntil`（`src/core/model.ts:341-344`）把 delivered 与 read 分成两个事实。本仓的 BRIEF 是整份覆盖写，「写盘成功 = 已送达」是一个**假设**而非保证；实际风险低（BRIEF 由 watchdog 巡检写，间隔 ≥ 主线一轮），但没修。
3. **不搬 SQLite。** `.agi/` 保持 JSONL：可读、可 diff、可直接被 grep 进摘要。原型自己在 `docs/007-architecture.md` 也承认旧记录永不删除、会无界增长。
