# 架构：三层，和把三层钉在一起的两张表

这个仓库只有三种东西，各自的规矩完全不同：

- **`lib/`（27 个文件）** —— 纯逻辑 + 宿主接线。能被纯函数写完的就不碰宿主（唤醒策略、
  目标续行判据、命名规则、模型策略都在这一侧），剩下的薄薄一层只做 `ctx` 接线：
  装 preset、挂 `/supervisor/*` 路由、把工具注册进 0.2.x 的 `ctx.subagents` 接缝。
  这条分界线是刻意的：宿主 API 会随版本变，而纯函数不会。
- **`tests/`（51 个文件）** —— 只用 Node 内置模块和相对路径 `import`，**没有
  `node_modules` 也能跑**。所以 `npm test` 在一台刚克隆的空机器上就是全部真话，
  不存在「装完依赖才知道坏没坏」。唯一一个非 `.test.mjs` 的 `harness-stub-loader.js`
  是给 `--import` 用的宿主 stub。
- **`presets/` 与 `prompts/`（生成物）** —— `prompts/*.md` 是**源**，块标量写进
  `agent-presets/main-agent/agent.cordis.yml`，再由 `scripts/sync-preset-patch.mjs`
  生成 `presets/main-agent.patch.yml`。手改这三者里的生成物，下一次 sync 就把它抹掉，
  所以它们不是「也要维护的文档」，是产物。

三条纪律各自有一张受测试约束的表，谁也不靠人记着同步：

| 表 | 文档 | 钉住它的测试 | 方向 |
| --- | --- | --- | --- |
| 状态文件的唯一写者 | [STATE.md](STATE.md) | `tests/state-ownership.test.mjs` | 双向 |
| 命名纪律的四类动词与例外表 | [NAMING.md](NAMING.md) | `tests/naming.test.mjs` | 常量是源，文档须一致 |
| 模块 / 测试 / 未受测导出 | 本文 | `tests/docs-coverage.test.mjs` | 双向 |
| 提示词占位符 | [../prompts/main-agent.md](../prompts/main-agent.md) | `tests/prompt-contract.test.mjs` | 源与生成物必须相等 |

下面三张表全部由 `tests/docs-coverage.test.mjs` 核对：文件集合双向相等、名字真的存在、
漏登记就红。

## 模块表

`lib/` 有 27 个文件、214 处 `export` 声明（去重后 198 个不同名字）。「被谁用」只算
真实的 `import` 方与 preset 挂载行 —— 一个都没有的那几个是宿主入口，宿主不是通过
`import` 进来的。

| 文件 | 职责 | 主要导出 | 被谁用 |
| --- | --- | --- | --- |
| `agents-compat.js` | `ctx.agents` 两代适配：顶层 agent 用 `roots()`（0.2.1–rc.2）或 `list()` 过滤（rc.3 起没有 `roots`），读不到就返回空数组 | `listRootAgents` `isRootAgent` `isRootExecution` | `lib/goal.js` |
| `authority.js` | 每次派生记一条权威凭证：human-direct / rule / assumed，以及它的判据 | `deriveAuthority` `allowsAutoDerive` `recordAuthority` `AUTHORITY_KINDS` | `lib/spawn.js` |
| `checks-tool.js` | `check_outcome` 工具壳：把 checks.json 的每条断言跑成可读报告 | `apply` `name` `inject` | preset 行 `dsh-main-agent/checks` |
| `checks.js` | checks.json 的读取 / 执行 / expect 覆盖判定（纯逻辑，无宿主依赖） | `readChecks` `runChecks` `verifyExpect` `readExpect` | `lib/checks-tool.js` `lib/loop-journal.js` `lib/spawn.js` |
| `client.js` | 浏览器半：Feed 视图渲染，不参与任何构建步骤 | （无导出） | 宿主按 package.json 的 client 入口加载 |
| `control.js` | `send_message` / `interrupt_agent`：把人工干预插到 worker 的下一步 | `apply` `name` `inject` | preset 行 `dsh-main-agent/control` |
| `full-stop.js` | Full stop 事务：停哪个 preset、先写哪张账 | `sessionAgentPreset` `fullStopAgent` | `lib/index.js` `lib/watchdog.js` |
| `goal-policy.js` | 目标续行判据、安全工具白名单、GOAL.md 渲染与指纹（纯函数） | `isLongRunningContinuation` `isGoalSetupSafeTool` `goalDocDigest` `renderGoalMarkdown` | `lib/goal.js` `lib/watchdog.js` |
| `goal.js` | goal 前端（可审阅不阻塞）：写 GOAL.md、暴露 goal 工具面 | `apply` `name` `inject` | preset 行 `dsh-main-agent/goal`；`lib/spawn.js` |
| `index.js` | 宿主半：装 preset、挂 `/supervisor/*` 路由、Feed、设置卡 | `apply` `presetsHandler` `loopHandler` `feedHandler` `SETTINGS_NS` | 宿主 bundle 入口（无 lib 引用者） |
| `list-agents.js` | `list_agents` 工具：Lead 与 teammate 的可寻址目标 | `apply` `name` `inject` | preset 行 `dsh-main-agent/list-agents` |
| `loop-journal.js` | 循环记账：loop-state / progress.jsonl / BRIEF 的读写与渲染，BRIEF 的读回执 | `readLoopState` `appendLoopEvent` `deriveBriefReceipt` `renderBriefReceipt` `renderBrief` `writeBrief` | `lib/spawn.js` `lib/watchdog.js` |
| `loop-policy.js` | 自适应唤醒策略：什么时候醒、醒几次、什么时候判 stale（纯函数） | `adaptiveWake` `watchdogPlan` `budgetVerdict` `policySnapshot` | `lib/goal.js` `lib/index.js` `lib/watchdog.js` |
| `outbox.js` | 待投递持久队列：退避、去重、失败记账 | `enqueue` `dueEntries` `markDelivered` `renderOutboxNotice` | `lib/checks-tool.js` `lib/loop-journal.js` `lib/settlement.js` `lib/watchdog.js` |
| `preset-files.js` | 没有 loader 行的 preset 走文件改写，并留 `.supervisor.bak` 以便回滚 | `applySupervisorToFile` `stripSupervisorFromFile` `presetFile` `hasSupervisorBackup` | `lib/index.js` |
| `report.js` | worker report 六态（progress / waiting / ready / blocked / failed / dropped）的读取与归档 | `readReport` `describeReport` `collectReports` `archiveWorker` | `lib/loop-journal.js` `lib/settlement.js` `lib/watchdog.js`；`scripts/accept-worker.mjs` |
| `schedule-fold.js` | schedule / change 事件的本地折叠：把一串变更读成当前排程 | `foldScheduleEvents` `ScheduleLogError` | `lib/index.js` `lib/watchdog.js` |
| `schedule-compat.js` | 宿主 `schedule` 服务两代接口的适配：建提醒、按会话列提醒、撤提醒 | `ensureReminder` `ensureReminderRemoved` `listSessionReminders` | `lib/watchdog.js` |
| `session-events.js` | 跨宿主版本读 Session 事件；读不到就 fail-open | `sessionEvents` `sessionInheritedEventCount` | `lib/full-stop.js` `lib/goal.js` `lib/index.js` `lib/settlement.js` `lib/watchdog.js` |
| `settlement.js` | 收敛消息富化：worker 停下来的那一句该说什么 | `enrichSettlementMessages` `installSettlementDiagnostics` `terminalFailureAt` | `lib/spawn.js` |
| `spawn.js` | settings 守卫下的 `subagent` 工具：模型白名单、并发上限、后台 job | `apply` `name` `inject` `Config` | preset 行 `dsh-main-agent/spawn` |
| `stage.js` | worker stage 分类（first-match-wins）与标签渲染 | `workerStage` `renderStageLabel` `canRetry` | `lib/loop-journal.js` |
| `subagent-compat.js` | `ctx.subagents` 的单一接缝 + 能力探针：0.2.1（嵌套 request / listChildren）与 0.2.2（扁平 spec / listDescendants）同时适配 | `startWorker` `drainWorkers` `listChildrenOf` `listDescendantsOf` `resolveSubagentGeneration` `subagentCompatible` `missingSubagentMethods` | `lib/index.js` `lib/spawn.js` `lib/watchdog.js` `lib/list-agents.js` |
| `supervise.js` | 监督层人格的纯函数改写：compose / strip / sync / remount | `composeSupervisorPersona` `stripSupervisorLayer` `syncSupervisedLayer` `remountPreset` | `lib/index.js` `lib/preset-files.js`；`scripts/verify-persona-compose.mjs` |
| `tool-inventory.js` | 角色 → 工具面的正面表；「worker 零工具」是它的结论，不是旁注 | `ROLES` `TOOL_MATRIX` `listToolsFor` `toolsFor` | 只有 `tests/tools-doc.test.mjs` 读它（[TOOLS.md](TOOLS.md) 的核对基准） |
| `watchdog.js` | 服务端循环兜底：提醒簿记、stale 回收、BRIEF 重排；重启后按磁盘枚举补齐错过的唤醒 | `reconcileLoop` `activeReminders` `installLoopWatchdog` `recoveryTargets` `filterSupervisorSessionIds` `ensureLoopRecovered` `ensureBootSweep` | `lib/index.js` `lib/spawn.js` |
| `worker-model-policy.js` | worker 的模型 / effort / 工具 deny 纯策略 | `selectWorkerModel` `resolveWorkerEffort` `workerDeniedTools` `WORKER_DENIED_TOOLS` | `lib/index.js` `lib/spawn.js`；`scripts/probe-host-model-selection.mjs` |

## 测试表

51 个 `*.test.mjs`，同目录还有一个 `harness-stub-loader.js` —— 那是给 `--import` 用的
宿主 stub，不是测试。一行一个文件，写清它到底守什么 —— 一个测试文件如果说不出一句
「它守的是什么」，那它就不是测试。

| 文件 | 覆盖什么 |
| --- | --- |
| `agents-compat.test.mjs` | `ctx.agents` 两代：旧宿主走 `roots()`、rc.3 走 `list()` 过滤，两条读法都抛错时退化成空数组而不是抛进工具链 |
| `authority.test.mjs` | 权威判据的分类与标签、凭证账本的写入 |
| `backup-retention.test.mjs` | `scripts/backup-retention.mjs`：备份保留策略与清理边界 |
| `brief-receipt.test.mjs` | BRIEF 读回执：写成功 ≠ 被读过，连续未读才报警 |
| `checks-tool.test.mjs` | `check_outcome` 的 execute 输出契约（含失败项不参与通过计数） |
| `checks.test.mjs` | checks.json 的读写、`expect` 的覆盖判定、超时与输出截断 |
| `client-feed.test.mjs` | 浏览器半的不变量：不依赖构建产物、只读 Feed 形状 |
| `control-tools.test.mjs` | `send_message` / `interrupt_agent` / `wait_agent`：名字与 id 双寻址、歧义即拒、wait_agent 按宿主代数补齐且不重复注册 |
| `expect.test.mjs` | expect.json 的契约：条目上限、文本截断、判定顺序 |
| `feed-view.test.mjs` | Feed 视图的快照渲染（含空态与多 worker） |
| `full-stop.test.mjs` | Full stop 的事务顺序：先记账再收摊，失败可回滚 |
| `goal-policy.test.mjs` | 续行识别、安全工具白名单、GOAL.md 渲染 |
| `goal-revision.test.mjs` | GOAL.md 的 revision 与指纹：改动才换 revision |
| `goal-tools.test.mjs` | goal 前端端到端（用 `snapshotEvents` 走一遍真事件流） |
| `host-seams.test.mjs` | `scripts/probe-host-seams.mjs` 的槽清单与 `lib/client.js` 实际注册的槽集合相等；侧栏行与主面板同 id；浏览器 bundle 不依赖宿主包；`lib/` 的宿主导入都写在 peerDependencies 里 |
| `install-spec.test.mjs` | `scripts/install-spec.mjs`：安装规格的生成 |
| `list-agents.test.mjs` | `list_agents` 的具名投影：`path` 即地址、无名字回落 id、`activity` 能报未 materialize 的 running |
| `loop-journal.test.mjs` | loop-state / progress.jsonl / BRIEF 的读写与 pruner |
| `loop-watchdog.test.mjs` | 唤醒策略曲线 + watchdog 的纯策略部分 |
| `naming.test.mjs` | 命名纪律棘轮：四类动词常量与文档双向相等、例外表仍然对得上源码 |
| `outbox.test.mjs` | 待投递队列的退避、去重、失败重试 |
| `policy-digest.test.mjs` | 策略变更触发的重校验（digest 变了就得重算） |
| `preset-files.test.mjs` | composition 文件改写与 `.supervisor.bak` 回滚 |
| `preset-patch.test.mjs` | `presets/main-agent.patch.yml` 的声明行与生成物一致 |
| `preset-rows.test.mjs` | preset 每一行都指向真实存在的宿主包与工具 |
| `preset-status.test.mjs` | `/supervisor/presets` 的开关字段与序列化 |
| `prompt-contract.test.mjs` | 占位符契约：md ↔ patch 块标量的占位符集合相等、`{{model}}` 活着 |
| `prompts.test.mjs` | prompt 外置与版本：md 与 YAML 块标量逐字节相等、revision 盖章、CHANGELOG 恒一行 |
| `recovery-note.test.mjs` | 重启恢复 note：上一轮怎么停的、这一轮从哪继续 |
| `remount-preset.test.mjs` | `remountPreset` 的即时生效（不重启宿主） |
| `repair-profile.test.mjs` | `scripts/repair-profile.mjs`：坏 profile 的修复路径 |
| `report.test.mjs` | report 六态的容错：缺字段、写坏、并发归档 |
| `schedule-wiring.test.mjs` | schedule service 与工具的接法 |
| `schedule-compat.test.mjs` | 宿主 `schedule` 两代签名（`create(request, actor)` vs `create(sessionId, request)`、`delete` vs `edit`、`list` 不认会话）各自被选中，且不碰别的会话的任务 |
| `session-events.test.mjs` | 跨版本 Session 事件的读取与 fail-open |
| `settings-card.test.mjs` | 设置卡渲染：字段与开关状态 |
| `settlement.test.mjs` | 收敛消息富化：六态各说一句话 |
| `sidebar-entry.test.mjs` | 侧边栏一级入口的挂载与去重 |
| `spawn-tool.test.mjs` | `subagent` 工具层：0.2.x 参数兼容与并发上限 |
| `stage.test.mjs` | stage 的 first-match-wins 顺序与标签 |
| `state-ownership.test.mjs` | [STATE.md](STATE.md) 与源码里的写者双向核对 |
| `subagent-compat.test.mjs` | 0.2.1 / 0.2.2 双代接缝契约、扁平与嵌套 spec、目录回退与能力探针的降级行为 |
| `supervise-anchors.test.mjs` | 监督层 4 个锚点的判定 |
| `supervise-layer.test.mjs` | 监督层纯改写的幂等与回滚 |
| `supervise-persona-compose.test.mjs` | 人格叠加：dev agent + 监督层不互相吃掉 |
| `supervise-sync.test.mjs` | `syncSupervisedLayer` 的收敛条件 |
| `supervisor-routes.test.mjs` | `/supervisor/health` 与 `/supervisor/workers` 的响应形状 |
| `tools-doc.test.mjs` | 工具面三向核对：[TOOLS.md](TOOLS.md)、`lib/tool-inventory.js`、preset 声明 |
| `worker-deny.test.mjs` | worker 工具 deny 的迁移（从黑名单到正面表） |
| `worker-model-policy.test.mjs` | worker 模型 / effort 策略的解析与降级 |
| `docs-coverage.test.mjs` | 本文这三张表与 `lib/`、`tests/` 实际文件双向相等；[REJECTED.md](REJECTED.md) 的格式 |

## 未受测导出（棘轮基线：只许缩小）

28 条。判据是机械的：一个 `export` 名字没有出现在任何 `tests/*.test.mjs` 里，就必须
登记在这里并写明理由 —— **登记不是豁免，是欠账**。反方向也管：谁把它们写进测试，
这一行就必须删掉（表里留着已经受测的名字同样红），所以这张表只会越来越短。

| 名字 | 所在文件 | 为什么可以暂时不受测 |
| --- | --- | --- |
| `DEFAULT_TIMEOUT_MS` | `lib/checks.js` | 常量：单条检查的默认超时；行为由 `runChecks` 的测试间接覆盖 |
| `OUTPUT_TAIL` | `lib/checks.js` | 常量：失败时回显的输出尾部字节数；同上 |
| `describe` | `lib/checks.js` | 只拼一行诊断文本，不参与判定；由宿主路由与日志调用 |
| `hasDirectHumanMessage` | `lib/goal.js` | 只作为 `lib/spawn.js` 的 goal 守卫判据，判据本身是事件扫描，结果由 goal-tools 的端到端路径覆盖 |
| `presetEntries` | `lib/index.js` | 宿主半接线（读 preset 目录装进 composition），需要真宿主 ctx；产物侧由 preset-rows 核对 |
| `syncSupervisedPresets` | `lib/index.js` | 安装期一次性调用，落盘结果由 supervise-sync 的纯函数部分覆盖 |
| `feedFingerprint` | `lib/index.js` | Feed 缓存指纹，只在 `/supervisor/feed` 处理器内用；渲染由 feed-view 覆盖 |
| `SETTINGS_NS` | `lib/index.js` | 设置命名空间字符串常量，值由 settings-card 渲染出的卡片间接钉住 |
| `LOOP_LESSONS_FILE` | `lib/loop-journal.js` | 文件名常量（`LESSONS.md`）；读它的 `readLessons` 有测试 |
| `WAKE_BANDS` | `lib/loop-policy.js` | 策略曲线参数，被 `adaptiveWake` 读取；行为由 loop-watchdog 间接钉住 |
| `MAX_RENEWALS` | `lib/loop-policy.js` | 同上：续期次数上限 |
| `RENEW_AT_RATIO` | `lib/loop-policy.js` | 同上：续期触发比例 |
| `RENEW_MIN_ROUNDS` | `lib/loop-policy.js` | 同上：续期的回合下限 |
| `IDLE_PAUSE_TICKS` | `lib/loop-policy.js` | 同上：空转暂停的 tick 数 |
| `REVIEW_EVERY_ROUNDS` | `lib/loop-policy.js` | 同上：每隔几轮要求一次复核 |
| `ROUNDS_PER_MILESTONE` | `lib/loop-policy.js` | 同上：里程碑折算回合数 |
| `MIN_SUGGESTED_ROUNDS` | `lib/loop-policy.js` | 同上：建议回合数下界 |
| `MAX_SUGGESTED_ROUNDS` | `lib/loop-policy.js` | 同上：建议回合数上界 |
| `presetHome` | `lib/preset-files.js` | 由宿主 ctx 的 home 推导 preset 目录，无 ctx 不可调用；落盘路径由 preset-files 的 apply / strip 覆盖 |
| `BACKUP_SUFFIX` | `lib/preset-files.js` | `.supervisor.bak` 后缀常量；回滚行为由 preset-files 覆盖 |
| `ScheduleLogError` | `lib/schedule-fold.js` | 自定义 error 类，只在日志格式不对时抛出；schedule-wiring 走的是正常路径 |
| `readComposedOrigin` | `lib/supervise.js` | 读已合成人格的来源标记，只给 `remountPreset` 与 `syncSupervisedLayer` 判定用，两者都有测试 |
| `isCurrentSupervisorShape` | `lib/supervise.js` | 形状判定谓词，只在 sync 内部调用；sync 行为由 supervise-sync 覆盖 |
| `SUPERVISOR_NAME_ROWS` | `lib/supervise.js` | 监督层行名表（数据），由 `countSupervisorRows` 与 `supervisorAnchorReport` 消费，后两者有测试 |
| `listReminders` | `lib/watchdog.js` | 服务端提醒簿记，只有在真宿主进程里（真 schedule service + 真定时器）才有意义 |
| `lastDispatchAt` | `lib/watchdog.js` | 同上：读上一次投递时间 |
| `reapStalledWorkers` | `lib/watchdog.js` | 同上：回收卡住的 worker，需要真 worker 生命周期 |
| `loopSnapshot` | `lib/watchdog.js` | 同上：把当前循环状态快照给路由；纯策略部分已由 loop-watchdog 覆盖 |

为什么允许这 28 条存在：它们的共同点是**要么是常量，要么要真宿主才跑得动**。给常量写
一个「断言它等于自己」的测试只是凑数；给必须真定时器的函数写测试则会把 `tests/` 拖进
`node_modules`，那正好毁掉这一层的第二条规矩。真正的欠账是「有独立逻辑却没人测」，
这一张表就是为了让那种情况没地方躲。
