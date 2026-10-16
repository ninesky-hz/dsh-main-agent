# 实施计划 v2 —— Always-On Supervisor，原生优先

`DESIGN.md` 的配套文档（Q1–Q23 + A1–A6 + S1–S4 + **N1–N7 + G1**）。本 v2 取代
v1 的自建方案（保留在 git 历史中：提交 `1f9a480` 与 `4957d66`）；
两者不一致时，以 v2 与 DESIGN §15–16 为准。

**逐步操作指南不再放在这里。** 它在 `tutorial/` 的 15 章课程中
（打开 `tutorial/index.html`），每个里程碑都以一次实机测试收尾，
也位于自动评分器中 `tutorial/grade.py`（见 `tutorial/GRADING.md`）。本文件是
索引：建什么、以什么顺序建、在哪里教、如何评分。

按 DESIGN §15 的构建形态：**一个有作者署名的预设 + 一份 persona + 两行 host 平面配置
+ `.agi/` 文件约定。核心中零自定义插件。** 自定义代码
只出现在可选扩展中（§4）。

---

## 1. 事实基线（本轮已在源码中核实）

以下内容均读取自 `$HOME/src/deepseek-harness` 处的检出副本
（dsh 0.1.1-rc.2）或原生优先重建期间的实机部署。若
部署版本发生变化，请先重新核实本表。

| 事实 | 来源 |
|---|---|
| Cordis 工具集是七个工具，具备 define/run 生命周期（`cordis_inspect_list/_query/_self`、`cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine`）；`editing-cordis-compositions` 技能中的 `cordis_mount`/`cordis_unmount`/`cordis_inspect` 动词已不存在 | `packages/extensions/tool-cordis/src/index.ts` 第 42/61/97/149/241/330/352 行；过时名称见 `apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md` |
| 用于动态 host 半部的沙箱内置能力：`harness.handle`、`harness.defineTool`、`harness.registerTool(ctx, tool)`、受保护的 `ctx.get/on/provide/effect` | `packages/extensions/cordis-host-runner/src/sandbox.ts` 第 18–36 行 |
| 随包发布的 subagent 工具行支持按行的 `persona`（子级遮蔽）、`toolFilter`、`agentOptions{provider,model}`；面向模型的调用 schema 仅为 `{description, prompt, run_in_background}` | `packages/subagent/tool-subagent/src/index.ts` —— `Config.persona` 第 54–57 行，在第 384 行传入 |
| `spawn` provider 声明了全部能力：`{outputSchema, depthLimit, toolFilter, persona} = true`；子级全新开始（无父级历史） | `packages/subagent/subagent-spawn-in-process/src/index.ts` 第 42 行 |
| 一个收敛后可继续的子级会向其直接父级投递一条无条件通知（`source.kind: "subagent-settled"`，含摘要 + 最终内容） | `docs/subsystems/subagent.md`（SubagentSettledMessageSource）；已在真实日志中观察到 |
| `send_message` 路由：running → 排入当前回合之后；waiting → 唤醒；无 Activation → 冷恢复。`interrupt_agent` = 触发即返回的取消；未被发消息的子级不消耗任何东西；不存在 destroy | `docs/subsystems/subagent.md`（followup 表、interrupt） |
| 每个可继续的子级都通过 host 平面的可继续设置获得 `report` 工具（唤醒投递默认开启） | `packages/bundle/base/cordis.patch.yml` 第 331–333 行；`docs/subsystems/subagent.md` reportFrom |
| `listChildren()` 的条目是带标签联合：`{kind:'child', id, mode, activity:'running'\|'inactive', hasChildren, label?}` 对比 `{kind:'diagnostic', id, reason}` —— diagnostics 没有 `activity` 字段 | `packages/subagent/subagent/src/list-children.ts` 第 44–57 行 |
| Schedule：一次性 `after_seconds` 无最小值；循环 `every_seconds` 的下限是 **300 秒**（⇒ `wakeMinutes ≥ 5`）；提醒是持久会话事件，以普通回合投递给原始会话；默认未挂载 —— 该 overlay 是两条 insert 行 | `docs/subsystems/schedule.md`；`examples/web-schedule/cordis.yml` |
| 工具流水线：`'tools/pre-execute'(exec, next)` 是一个瀑布，返回 `PreToolDecision`（`allow`/`deny`/`ask`）；`next()` 委托为 allow | `docs/subsystems/tools.md` 第 693 行 |
| 会话存储：`~/.dsh/sessions/<ws-dashed>/<session-id>/session.jsonl.zstd`；第一行是头部（`cwd`、`agentPreset`，子级还含 `origin:"subagent"` + `parentSession`）；`tool/call` 事件携带 `data.name` + 字符串化的 `data.arguments`；恢复会留下 `session/end-seed` 标记 | 在实机日志中观察到（`--root-agi-acc5--` 等） |
| 树外插件安装模式：带 `dsh.bundle.patch` 清单 + `cordis.patch.yml` 的 npm 包；`dsh plugin --profile web add file:$PWD` 会同时添加依赖与 bundle 条目。Bundle 层在启动时组合（一次重启），而 profile patch 文件是实时监听的 | `packages/boot/app-boot/README.md`（Profiles）；本仓库的 `package.json` 与 `cordis.patch.yml` |
| 预设名册：`list/resolve/read/copy/remove/standingKeyFor`；`copy()` 是创作写入，`standingKeyFor()` 是真正的挂载校验 | `packages/preset/agent-presets/src/index.ts` |
| 用于可选进程记忆实验的客户端槽位：`shell.overlay`（附加式的整帧图层）与 `conversation.view`（每个视图页签一个条目） | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` |

## 2. 交付物 → 章节 → 评分器

| # | 交付物 | 实现形式 | 教程 | 评分器 |
|---|---|---|---|---|
| 0 | 干净 PC 的环境搭建与实验台自检（课程服务器、运行时、源码、模型、进程、工作区） | `tutorial/setup.sh` 用于隔离的评分器依赖/UI；Harness 前置条件仍为显式的学习步骤 | setup + 第 4 章（+1–3、5 用于概念） | 网页评分按钮 / `grade.py m0` |
| 1 | 可安装的 `main-agent` 预设及其策略前端 | 安装本 bundle、重启，然后检查包安装的预设及其 `dsh-main-agent/goal`、`/control`、`/spawn` 行 | 第 6 章 | `grade.py m1` |
| 2 | 监督者大脑 | 检查并试运行打包的 persona（按 DESIGN §3、§15、§16 的 GROUNDING/STATE/GOAL SETUP/LOOP/QUESTIONS/LIMITS）+ 校验 `.agi/` 骨架 | 第 7 章 | `grade.py m2` |
| 3 | 时间 | 校验 bundle 安装的 schedule 行；耐心计时 = 一次性，check-in = 循环（N2）。手工 profile-patch 安装是备选路径，绝不与 bundle 同时使用 | 第 8 章 | `grade.py m3` |
| 4 | Worker | 手工驱动原生循环：派生 / 纠偏（`send_message`）/ 终止（`interrupt_agent`）/ `report` / 收敛通知 —— 即旧的 M0 冒烟测试，五项观察 | 第 9 章 | `grade.py m4` |
| 5 | 监督循环 | persona 精修（计时纪律、日志尾部检查、结论判定）+ 全循环演练，强制注入一次纠偏/终止/静默提问 | 第 10 章 | `grade.py m5` |
| 6 | UI | 原生界面 + 终端 tail 仪表盘 + 持久化监督动态 Feed；历史动态状态胶囊演练为可选项 | 第 11 章 | `grade.py m6` |
| 7 | 验收 | 在全新工作区上脚本化的端到端任务 + 重启演练；通过标准：每个步骤连续两次通过 | 第 12 章 | `grade.py m7`（在 `$HOME/agi-acceptance` 上重跑 m2–m5） |

按顺序完成工作里程碑；前一个评分器未通过（≥90%，退出码 0）之前不要开始下一个。评分器输出中的 MANUAL 行是需要人工判断的步骤 ——
请照做。

## 3. 里程碑索引（每项一行；细节在各章）

- **M0 —— 实验台**（setup + 第 4 章）：在干净 PC 上克隆本课程并运行
  `tutorial/setup.sh`（隔离的评分器环境 + 未占用的 localhost 端口），然后安装 dsh，
  在旁侧 `$HOME/src` 下克隆 Harness，配置一个可用模型，在端口
  3080 上启动 `dsh web`，并创建 `$HOME/agi-lab`。绝不要在同一 home 上运行第二个 dsh；绝不要编辑
  随包发布的预设或 Harness 检出副本。
- **M1 —— 预设**（第 6 章）：用
  `dsh plugin --profile web add file:$PWD` 安装本检出副本，重启 dsh，然后才检查
  包安装的 `main-agent` 预设。校验受设置保护的 `subagent` 行
  （worker 协议 persona 在该行上；必须显式选择，
  全新安装允许从 Settings 下拉框选择 `runtime/current`；
  为每条允许路由附加一个由目录支撑的 effort 选择器，缺失/全新
  值默认为真正的 provider 默认值，不向主代理暴露任何 effort 参数，
  针对精确路由校验，并将固定 effort
  持久化到子级头部）；
  校验已挂载的预设；启动两个会话（领域校验）。在包成为 profile 依赖之前，
  绝不要撰写命名 `dsh-main-agent/*` 的行。
- **M2 —— 大脑**（第 7 章）：校验 `.agi/` 脚手架并读取确切安装的
  监督者 persona；运行
  非阻塞目标设置（`get_goal` → 检查持久状态与相关
  runbook/脚本 → `start_goal`/`GOAL.md` → 同回合执行）；测试修订与
  配置拒绝纪律；打底检查（可发现的事实必须查阅，
  而不是靠提问或委派）。
- **M3 —— 时间**（第 8 章）：校验由 bundle 组合出的 schedule 行；不要添加
  重复的 profile 行。测试 60 秒一次性投递、通向 `assumed`
  提问的耐心流程，以及 300 秒循环下限。手工 patch 仅记录给
  刻意跳过 bundle 的安装方式。
- **M4 —— Worker**（第 9 章）：手工驱动全部五项观察；校验子级的
  persona 已生效且 `outcome.md` 落在 `.agi/subagents/<id>/` 下。
- **M5 —— 循环**（第 10 章）：加入计时纪律 + 检查类的 persona 文本；端到端运行一次小的
  真实任务，每条分支都强制走一次；把 CHANGELOG 当作日记来评分。
- **M6 —— UI**（第 11 章）：采用原生界面、持久化监督动态 Feed 与终端
  仪表盘。已退役的动态状态胶囊仅作为可选的 Cordis 演练保留。
- **M7 —— 验收**（第 12 章）：全新的 `$HOME/agi-acceptance`，只用脚本化的行，不做
  指导；然后做重启演练（`session/end-seed` 标记证明恢复）。把
  账本留在此文件旁边；两次干净运行 = 完成。

## 4. 可选扩展（仅当原生能力不再够用时）

触发条件与修正后的设计在教程第 13 章。一个包
（`$HOME/src/agi-extras`，以本仓库为范本），每个特性一行 bundle 条目，
以便每个特性都能从 profile patch 单独禁用：

| 扩展 | 何时构建 | 关键契约（已核实） |
|---|---|---|
| `agi-wait`（`wait_for_agents`） | 需要 < 5 分钟的监督节奏时 | `defineTool` + `listChildren` 带标签联合（§1）；留意 `dsh-tool-call-timeout-policy` |
| `agi-subagent-trace` | 希望在会话日志之上获得可按子级 grep 的 `trace.log` | `'session/event'(session, event)` 消防水管；子级具有 `header.origin === 'subagent'`；只用叶子字段，一切都要 try/catch |
| `agi-tool-delay` | 需要限流/成本节流时 | `tools/pre-execute` 瀑布；始终 `return next()`；把 `toolDelaySeconds` 重新加入 `config.json` |
| `agi-state-route` | 需要外部仪表盘时 | `ctx.webServer.register({kind,path,handler})`；对 `?ws=` 做路径校验（未认证的 localhost） |
| 硬性派生上限 / 按次派生的 persona 工具 | 文字性限制发生漂移，或确实需要按次派生的 persona 时（恢复 S3/A6） | 包装 `ctx.subagents.startContinuable()`；通过 `listChildren` 计数 |

安装：构建 `lib/`，把 `file:` 依赖 + bundle 名称加入 profile 的 `package.json`，
在 profile 目录中 `pnpm install`，重启 dsh 一次。通过按 id 定位的
`disabled: true` patch 实时禁用某一行。

## 5. 风险观察清单（带入首次真实任务）

1. **靠文字约束的协议** —— 工作区打底质量、changelog 完整性、并行
   上限都是 persona 里的句子。补偿控制：评分器 + 验收
   账本；修复顺序为 persona 措辞 → 机制。观察：在无人强制时，CHANGELOG 是否仍保持
   真实？
2. **跨数周的上下文** —— Q12（"压缩足够"）在周级尺度上未经证实；
   `.agi/` 文件才是真正的记忆。观察压缩之后 NOTES.md 的质量。
3. **无人值守的信任姿态** —— 早期实验台运行使用 `danger-full-access` +
   `approval: never`。在开展带凭据的 24/7 任务（X.com）之前，刻意决定
   沙箱/审批姿态；用按行的 `toolFilter` 限定 worker 范围。
4. **会话本地的计时器** —— 提醒属于创建它的会话；恢复
   监督者会话，不要新起一个。persona 在派生时重新武装 check-in。
5. **动态 UI 是短暂的** —— 状态胶囊随进程消亡；重跑或提升为正式实现。

## 6. 首次真实任务（与 DESIGN §9 一致）

X.com 增长自动化，在 M7 连续两次通过之后：目标设置复用现有脚本，
并且只在凭据确实不可获得时才索取凭据；
浏览器操作型 worker 在运行时安装自己的工具链（Playwright）；里程碑
10 → 100 关注者。循环本身不变 —— 变的只是目标和 worker 角色。
