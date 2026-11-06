# dsh-main-agent — 面向 DeepSeek Harness 的常驻监督者 Agent

7×24 小时在线的 **Main Agent**：先记录一个可审阅的目标，然后无人值守地循环：派生开发
子代理 → 休眠 → 因收敛 / 报告 / 定时器 / 你的消息而唤醒 → 巡检 → 纠偏、
终止或继续。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）以 **原生优先** 方式构建：核心就是一个 agent preset、一份人格，以及对
原生 schedule 工具的直接复用 —— 决策留在模型侧，服务端只做兜底（补提醒、
停滞检测、派生预算），不另起一套调度器。本仓库**就是一个可安装的 dsh 插件包**：
一条命令即可把整套配置装到任何运行 dsh 的机器上。

当前版本 **0.21.0**。零依赖（`dependencies` 为空），`yaml` 按需从宿主
`node_modules` 解析，拿不到时相关能力降级而不是让插件加载失败。

在 `glm-5.3`（Z.AI）上做过端到端实测（**0.10.x 时代**的记录，之后的跨模式与
服务端兜底未整体重跑）：目标设置、有打底的委派、飞行中纠偏、回合中途终止 +
更严密的重新派生、静默提问 → 记录假设流程、交付物核验（它抓到了自己那个有
bug 的链接检查器并重跑），以及整进程重启后恢复。评分结果：m0–m5 与 m7 均为 100%。
当前版本改动的单元测试覆盖见下文「dsh 0.2.x 兼容性」里的数字。

## dsh 0.2.x 兼容性

本仓库源自 `n-sky/dsh-supervisor`，自 **0.10.0** 起改名为 **`dsh-main-agent`** 并迁到
`https://gitee.com/n-sky/dsh-main-agent.git`（旧仓库保留 0.9.4 及其以前的版本）。
它承载了向 **dsh 0.2.x**（0.2.0-rc.2 起，现验证到 0.2.2-rc.1）的移植：

- 设置遵循逐行 `Config` 模型 —— `export const Config` 配合 `.volatile()` 字段，
  不再有 `installSettingsSection` / `settingsNamespace`（二者均已在上游移除）；值是实时
  引用，通过 `config.*.get()` 读取，修改由 `loader/volatile-update` 拾取；
- 设置卡片通过 `configForms` 注册进 **`plugins.item`** 槽位
  （`ctx.configForms.get(<entry id>)` + `whileServed` + `scope.mutate`），取代 `settingsScope`
  与旧的 `settings.plugin.item` 槽位；
- worker 消息使用 `subagents.sendMessage`（`followup` 别名已移除），worker
  活动状态读作 `running` / `inactive`；
- persona 使用 0.2.x 的 `prefix` / `suffix` 契约，正文只引用 loop 注册的
  `{{provider}}`、`{{model}}` 模板变量。工作目录由必需的 working-directory 运行时上下文
  注入，**不要**写 `{{cwd}}`：0.2.1 起它不是内建变量，未注册的名字会让 prompt 在装配期
  抛 `unknown prompt variable`，整个 preset 在发出模型请求之前就挂掉（0.10.1 已修）。

本仓库的 **394 项**单元测试（`tests/` 下 35 个 `.test.mjs`）当前 `npm test` 全绿：
**392 通过 / 2 跳过 / 0 失败**（`npm test` = `node --test tests/*.test.mjs`；两个跳过项是
`tests/preset-rows.test.mjs` 里按 preset 行解析真实宿主运行时，只在设置了 `DSH_APP_ASAR`
时才跑）；
0.2.0-rc.2 上还做过完整 profile 的 `--dump-config` 组合与实机启动验证
（`/supervisor/models` 返回 `200`），0.2.2-rc.1 的模型选择 seam 另有真机 probe
（`scripts/probe-host-model-selection.mjs`）。`peerDependencies` 里 `@deepseek-ai/dsh-subagent`
的区间是 `>=0.2.1-rc.2 <0.3.0` —— 更早的宿主没有 `ctx.subagents` 的 0.2.x 方法。

**克隆后自测**：`git clone` 之后 `npm install` 再 `npm test` 即可。仓库根的 `.npmrc`
带 `legacy-peer-deps=true`，跳过 `@deepseek-ai/*` 的 peer 解析 —— 那些包确实发布在
公共 registry 上，但互相钉死了版本（`dsh-subagent@0.2.1-rc.5` 要求
`peer dsh-agent@0.2.1-rc.5`，独立解析会拿到 `0.1.0-rc.8`），在一个没有宿主锁文件的
空目录里 `npm install` 必然 ERESOLVE。那个失败与插件无关，只是 npm 想替你把宿主的
依赖自己解一遍。`devDependencies` 只装了 `yaml`，供 `tests/worker-deny.test.mjs`
与 `scripts/verify-persona-compose.mjs` 解析 YAML；**插件运行时不需要它** ——
`lib/preset-files.js` 是懒加载（`await import('yaml')` 包在 try 里），没有 `yaml`
的 profile 也能正常加载本插件。若系统临时目录不可写（DSH 沙箱会挡），把
`TEMP`/`TMP`/`TMPDIR` 指到仓库内的 `.test-tmp/`，否则 `mkdtemp` 会 `EPERM`，
看起来像七十多个测试失败。

**0.2.1-rc.3 无需改动。** 逐包比对 `npm pack` 下来的 rc.3 与本地 rc.2 原版（比对基准用
`*.dshpurge.bak`，否则会把 dsh-purge 的宿主补丁误判成版本差异）后，本插件触及的 14 个包
运行时 JS **逐字节一致**，`web-app/presets/{standard,minimal,ptc,cordis}.patch.yml` 也完全
没变 —— 这四份正是「启用监督循环的模式」改写 `plugins` 的对象。rc.3 全局只有两处变化，
都与本插件无关：

- `dsh-web-app/cordis.patch.yml` 的 `system-prompt.personaPrefix` 从 `""` 变成
  `You are a coding agent powered by the {{model}} model.`。它在 host 层注册为 section
  `deployment:persona-prefix`，而 preset 内的 `persona` 行会用**同名** section 遮蔽它
  （`dsh-system-prompt` 的 `section()` 契约原文：`A scoped section shadows a global section
  with the same name`）—— main-agent 的监督者人格与四个官方 preset 的空 prefix 都盖住
  这一句，宿主这句只对不挂 preset 的会话生效。
- `dsh-web-app/cordis.patch.yml` 新增 `entry-customization`
  （`@deepseek-ai/dsh-client-ui-entry-customization`）：More 菜单里置顶/取消置顶插件启动器。
  纯 UI，不进入本插件的任何代码路径。

`peerDependencies` 的区间（`>=0.1.0-rc.6 <0.3.0`，`dsh-subagent` 为
`>=0.2.1-rc.2 <0.3.0`）本来就覆盖 rc.3 与 rc.5，不需要放宽。单元测试不加载任何宿主包（全部是对
`lib/*.js` 纯函数与 mock `ctx` 的断言），所以测试结论与宿主小版本无关；升级后请用
`GET /supervisor/health`（看 `ok`、`version`、`supervisorPresets`、`schedule.available`）
与 `GET /supervisor/presets`（看被启用模式的 `rows` 是否为 3）确认运行时接线。

**0.2.1-rc.5 同样无需改动。** 用 `npm pack` 取 rc.3 与 rc.5 两份、逐文件 `sha256` 比对后，
本插件 import 到的 **32 个** `@deepseek-ai/*` 包（`dsh-tool-subagent`、`dsh-tool-subagent-control`、
`dsh-subagent`、`dsh-schedule`、`dsh-tool-schedule`、`dsh-goal`、`dsh-tool-goal`、`dsh-session`、
`dsh-tools`、`dsh-llm`、`dsh-persona`、`dsh-agent-preset`、`dsh-web-app`、
`dsh-client-ui-agent-preset`、`dsh-workflow-ptc`、`dsh-tool-workflow`、`dsh-tool-ralph`、
`dsh-tool-web`、`dsh-tool-todo`、`dsh-tool-skill`、`dsh-tool-pwsh`、`dsh-tool-jobs`、
`dsh-tool-fs-search`、`dsh-tool-fs`、`dsh-tool-bash`、`dsh-tool-ask-user`、`dsh-skill-filesystem`、
`dsh-plan-mode`、`dsh-compaction-tool-result-pruner`、`dsh-compaction-basic`、`dsh-command-compact`、
`dsh-agent-instructions`）**每个包只有 `package.json` 一个文件不同**，且差异仅限 `version`
与内部 `@deepseek-ai/*` 的钉版同步（依赖键集合无增删）。运行时 JS，以及
`dsh-web-app/presets/{standard,minimal,ptc,cordis}.patch.yml` 四份
——「启用监督循环的模式」改写 `plugins` 的对象 —— 一行未改。

rc.3 → rc.5 的实质代码改动只落在两个客户端包上，都不在本插件的接口面内：

- `dsh-client-ui-conversation` 只改了 view tab 的 tooltip 判定（由常显改为「label 估算宽度
  超过 88px 才显示」），顺带删掉一个 locale key `session.moreViewsCurrent`；`contract/slots.d.ts`
  与 `contract/views.d.ts` **逐字节相同**。本插件唯一注册的槽位 `conversation.view`
  （`lib/client.js` 里的 `{ name: 'conversation.view', id: 'supervisor-feed', label: '监督动态' }`）
  契约未变，`监督动态` 四个全角字估算约 52px，不进入 tooltip 分支。
- `dsh-client-ui-chat` 调整了 `conversation.chat.reasoning.*` 的类型（rc.4 起 `text` 变为
  Chat 处理后的显示文本、新增 `rawText` 承载原始模型输出）。本插件**没有**自定义推理渲染器：
  `lib/` 里出现的 `reasoning` 全是 worker 模型目录的 `reasoning.efforts`
  （`lib/worker-model-policy.js`、`lib/spawn.js`），与 Chat 的推理槽位无关。

**0.2.2-rc.1 是第一个必须改代码的宿主版本**（0.20.0 起支持，旧版仍兼容）。
peer 区间、`ctx.tools.register(defineTool(...))`、`ctx.subagents` 六个方法、Session Projection
只读用法、`cordis.patch.yml` 的挂载方式都没变；变的是模型选择的**落定时机**：

- 0.2.2 的 `preStep` 先 `const selection = this.model.current()`
  （`dsh-agent-loop/lib/index.js:666,671`），再发 `agent/pre-step`（`:685`），并在
  `agent/request` 之后校验提案与固化值一致（`:994-1001`），不一致就抛
  `… after step preparation fixed "…"; use agent.model.select() before step preparation`。
  本插件原先正是在 `agent/request` 里改写 `reasoningEffort`，所以**只要 worker 路由配了
  具体推理强度，worker 第一条请求必抛**；配 `provider/default` 不触发，默认配置下看不见。
- 0.2.1 没有 `agent.model`（`dsh-agent` 导出面里没有 `AgentModel`，`dsh-agent-loop` 里也没有
  `this.model =`），所以改法是双路径而不是替换：`hostUsesModelSelection(agent)` 探测
  `agent?.model?.select`，有就在 `agent/created`（此时 Agent 已构造、`model` 已就位、尚未
  `preStep`）里 `pinWorkerEffort(agent, effort)` 落一条 `model/selection`，并让
  `agent/request` 监听直接 `return next()`；没有才走旧桥。
- 结论由真机验证而非读码推断：`scripts/probe-host-model-selection.mjs` 会在你指定的目录里
  加载**真实的**宿主 `AgentModel`，逐字复刻 `:994-1001` 的 gate，双向验证
  「pin 后通过」与「改 request 必抛」。用法见脚本头注释；对 0.2.1 它会打印 `LEGACY: …` 并以
  退出码 2 表示「旧宿主走旧桥」，这不是失败。

```sh
node scripts/probe-host-model-selection.mjs "<装有 0.2.2 宿主包的目录>"
```

`presets/main-agent.patch.yml` 里那条 `@deepseek-ai/dsh-workflow-worker-thread` 是
`disabled: true` 的历史行：该包在 0.2.x 不存在（npm 上 `latest` 停在 `0.0.1-rc.3`，
`next` 已是 `0.1.5-rc.x`），启用会让整个 preset 挂载失败，保持禁用即可。`@deepseek-ai/cordis`
（peer `^4.0.1`）与 `@deepseek-ai/schemastery`（peer `^3.18.0`）是独立版本线，不随 rc 号变化。

`DESIGN.md`、`IMPLEMENTATION_PLAN.md` 与 `tutorial/` 课程作为原始设计
记录保留：当它们提到 `installSettingsSection`、`settingsNamespace`、`followup`、
`settings.plugin.item`，或 worker 活动状态为 `active` 时，请按上表理解。

## 版本沿革

| 版本 | 变化 |
|---|---|
| 0.10.0 | 由 `n-sky/dsh-supervisor` 改名，移植到 dsh 0.2.x |
| 0.10.1 | 修掉 `{{cwd}}` 这类未注册 prompt 变量导致的装配期崩溃 |
| 0.10.7–0.10.9 | Feed 的 worker 跳会话 / 暂停刷新 / ETag 条件刷新；`outcome.md` 头行二次匹配 |
| 0.11.0 | Settings 增加「启用监督循环的模式」，任意 preset 可热切换为监督者 |
| 0.11.1 | `/supervisor/presets` 的 `changed` 改为报告观测到的终态（fibre 重启会抢跑） |
| 0.12.0 | 由插件直接注册的 preset 改走 `agent.cordis.yml` 改写 + `.supervisor.bak` 备份 |
| 0.12.1 | 无 loader 行的 preset 也能即时重挂载（`definitions` + `activate`），不必重启 |
| 0.12.2 | 监督动态 Feed 认设置里开启的模式，不再只认 `main-agent` |
| 0.12.3 | 安装地址补齐 `.git`，避免 pnpm 当成 tarball |
| 0.13.0 | 循环兜底搬到服务端：watchdog 补提醒、自适应唤醒、worker 停滞超时、累计派生预算 |
| 0.13.1 | 重启后监督层不再丢失：settings 文档落地时再对账一次 |
| 0.13.2 | `stop` / `loop` 三处路由改用 `countsAsSupervisor`，不再 409 |
| 0.13.3 | schedule 让位守卫加可选链；`/supervisor/health` 暴露 `schedule.available` |
| 0.13.4 | 删掉 schedule 叠加层（host 层已有该 service），preset 自己声明 `tool-schedule` |
| 0.13.5 | 包描述去掉「加 schedule 叠加层」 |
| 0.13.6 | 安装脚本不再往 profile 写重复的 schedule 行 |
| 0.13.7 | README 与 `files` 白名单对齐（去掉已删除的 `patches/`） |
| 0.13.8 | 核对 dsh 0.2.1-rc.3：相关 14 个包运行时逐字节一致，无需改动 |
| 0.14.0 | 循环可观测：连续空转自动降级并收尾、暂停后不再被兜底唤醒、停止原因落盘、每轮重写 `.agi/BRIEF.md`、每 5 轮复核目标、worker 超时留痕、按里程碑估轮次预算 |
| 0.14.1 | 重启后主动扫一遍根监督者补排提醒（原先只有新的回合才会触发兜底，空闲会话会静默停住）、循环状态按 session 分文件（同工作区两个监督者不再互相覆盖）、自动把派生的状态文件加进 `.gitignore` |
| 0.15.0 | 轮次预算可在有产出时续期（最多两次）、摘要给出每轮耗时与续期次数、兜底唤醒比预期晚太多时留痕、`.agi/LESSONS.md` 让下一个目标继承本工作区的教训 |
| 0.16.0 | worker 可以留 `checks.json`，`check_outcome` 把它的验收断言一次跑完：失败项直接列出来、人工项单独标注，不留「我核过了」这种无法核对的结论 |
| 0.17.0 | 修好 0.16.0 引入的致命缺陷：`check_outcome` 的返回值多带了一个未声明的 `render` 字段，被 dsh-tools 的严格输出校验整次拒收，于是它**从来没有成功过**（明细改为已声明字段 `detail`，并补工具壳测试）。同时给 `ralph` 补上使用判据与 objective 模板：只允许「上下文被污染」与「长收敛」两种情形，完成只是 worker 自述必须有 `check_outcome` 兜底，且它前台阻塞、同回合不得叠第二个长任务 |
| 0.18.0 | persona 注入由「整份替换」改为**拼接**（原人格逐字保留在前、监督层追加在后，标记行带 origin 长度，strip 按长度精确回滚）；缺锚点的 preset 不再可勾选（`GET` 返回 `stackable`/`missing`，卡片灰掉并写明缺哪几行，`POST` 剔除并回 `rejected`）；`dsh-main-agent/spawn` 新增 `deny`，把官方 `tool-subagent` 上的 `toolFilter.deny` 复制过来，使破甲模式的工具限制在改名后仍然生效；`remountPreset` 复检 `record.broken`，热挂载失败时回滚并如实报「需要重启 DSH」 |
| 0.18.1 | 核对 dsh 0.2.1-rc.5：本插件 import 的 32 个 `@deepseek-ai/*` 包每个只有 `package.json` 不同（仅版本号与内部依赖钉版），运行时 JS 与四份 `presets/*.patch.yml` 一行未改；rc.3→rc.5 的实质改动只在两个客户端包（tooltip 判定与推理块类型），都不在本插件的接口面内。同时把 README 的版本号与测试数字对齐现实（298 项、`tests/` 下 29 个文件） |
| 0.19.3 | 修掉设置卡片的一处**状态误报**：`GET /supervisor/presets` 的 `pendingRestart` 原来只判 `plugins === undefined && hasSupervisorBackup(id)`，而 `hasSupervisorBackup` 的含义仅是「旁边躺着 `.supervisor.bak`」＝**曾经写过盘** —— `remountPreset`（`lib/supervise.js:564`）成功时就地换掉 `record.config.plugins` 再 `activate()`，备份照样留着，于是红队模式 / 破甲模式这两个 file-backed preset **已经生效**却持续返回 `pendingRestart: true`，任何按该字段判断的调用方都会读成「需要重启」。卡片之所以没显示错文案，是因为它先判 `mounted === true` 就走了「✓ 已启用，立即生效」；但 `mounted` 读不到（registry 里没有该 preset 的记录，返回 `undefined`）时会落到 `pendingRestart` 分支，那时「需要重启 DSH 才生效」就是真的误报。改法：先算出 `mountedNow`，`pendingRestart = plugins === undefined && mountedNow !== true && hasSupervisorBackup(id)` —— 只有「写盘了但没能挂进注册表」才要求重启；`mounted` 复用同一个值。顺带把 `hasSupervisorBackup` 的 docstring 从「only a restart will load」改成实情（误报的认知源头就在这句注释），卡片兜底文案改为「已写入磁盘，但没能挂进注册表，需重启 DSH 才生效」。导出 `presetsHandler` 以便直接打这个 handler，新增 `tests/preset-status.test.mjs` 四例：已挂载不再宣称重启、写盘未挂载才要求重启、读不到 registry 不假装生效、从未写盘两字段都 false。测试 384/34 → **388 通过 / 0 失败 / 35 个文件** |
| 0.19.2 | 修掉「别人克隆能不能直接用」。**实测三个障碍**：① `npm install` 直接 ERESOLVE 失败 —— `@deepseek-ai/*` 确实发布了，但互相钉死版本（`dsh-subagent@0.2.1-rc.5` 要求 `peer dsh-agent@0.2.1-rc.5`，独立解析拿到 `0.1.0-rc.8`），空目录里必崩；② 即使跳过 install 直接 `node --test`，`tests/worker-deny.test.mjs` 与 `tests/supervise-anchors.test.mjs` 的三个用例也会失败 —— 根因是 `yaml` 包不在 `node_modules` 里，而它此前**没有出现在 `package.json` 的任何依赖字段**（`lib/preset-files.js:45-53` 是懒加载 `await import('yaml')`，缺了它插件能起来、但依赖它的脚本与测试会崩）；③ README 里的测试数字停在 367/33，实际已是 384/34。补 `.npmrc`（`legacy-peer-deps=true`，附注释说明那串 ERESOLVE 与插件无关、是 npm 想替宿主解依赖）、`devDependencies: yaml ^2.9.1`、README 增「克隆后自测」段（含 `TEMP` 指向 `.test-tmp/` 的沙箱坑：系统临时目录不可写时 `mkdtemp` 报 `EPERM`，看起来像七十多个测试失败）。实测结果：干净 clone → `npm install`（exit 0，只装 `yaml` 一个包，2 秒）→ `npm test` **384 通过 / 0 失败** |
| 0.19.1 | 修掉 0.19.0 真机上暴露的三个缺陷，都属「记录只增不减」。**备份永不清理**：`sync-profile --apply` 每次都在 `$DSH_HOME` 下建一份完整备份却从不删（实测四份、1.96 MB、117 个文件），新增 `scripts/backup-retention.mjs`，`--keep` 默认保留 3 份，且删除**只在 `report.apply` 为真时**发生 —— 诊断模式删用户文件是最坏的副作用。**loop-state 永不清理**：`.agi/loop-state.*.json` 每个会话一份、从不清，新增 `pruneLoopStates(cwd, { keep, keep_key })`，只认 `loop-state.<8位key>.json` 形状，`keep_key`（当前会话那份）无条件保留，watchdog 每进程只扫一次。**历史目录被误判成「有 worker 在排队」**：`renderBrief` 从不告诉 `workerStage`「这个 id 已不在任何子会话里」，于是所有不在跑的条目都流进默认分支 `working/queued`，一个 22 字符的旧手工目录因此常年显示「排队中，等空闲槽」；`collectReports` 增第三可选入参 `known` 返回三态（`undefined` = 调用方没查 / `true` / `false`），只有明确 `false` 才判 `ended`。这里踩了个自己挖的坑：`known === false` 是**推断**，一开始让它占了 first-match 第一位，把 `archived`（Lead 验过）与 `dropped`（worker 说没活了）两个**事实**标签全盖掉了，五个已验收 worker 一起从「已验收归档」退化成光秃秃的「已收尾」；改为事实优先于推断后两者并存。测试从「只断言不说排队中」加强到断言标签本身在场 —— `assert.doesNotMatch(x, /排队中/)` 会让「退化成信息更少」悄悄通过 |
| 0.20.0 | 核对并适配 dsh **0.2.2-rc.1**。**唯一硬伤**：0.2.2 把模型选择在 step preparation 阶段就固化（`dsh-agent-loop/lib/index.js:666` `preStep` 先取 `this.model.current()`，`:685` 才发 `agent/pre-step`），随后 `agent/request` 的返回值若与固化值不符就直接抛错（`:994-1001`：`proposed reasoning effort "…" after step preparation fixed "…"; use agent.model.select() before step preparation`）。本插件原先在 `agent/request` 里改写 `reasoningEffort`（`lib/spawn.js` 旧监听），于是**只要 worker 路由配了具体推理强度，worker 的第一条请求必抛**；配 `provider/default`（不改 effort）不触发，所以这个问题在默认配置下看不见。修法是双路径，因为 0.2.1 没有 `agent.model`（`dsh-agent` 导出面只有 `AgentRegistry`/`agentCarrier`/`agentEvents`/`assembleContextFor`/`emitAgentEvent`/`foldConsumedWork`/`installModelSelection`，`dsh-agent-loop` 里也没有 `this.model =`）：`lib/worker-model-policy.js` 新增 `hostUsesModelSelection(agent)`（探测 `typeof agent?.model?.select === 'function'`）与 `pinWorkerEffort(agent, effort)`（用 `current()` 的 provider/model 原样回填、只换 `reasoningEffort` 调 `select()`，`provider/default` 不落盘、无 route 时不半 pin）；`lib/spawn.js` 在 `agent/created`（0.2.2 时序：Agent 已构造、`model` 已就位、尚未 `preStep`，见 `dsh-agent-loop/lib/index.js:1571-1579` 与 `dsh-agent/lib/index.js:703-719`）里优先 pin 并 `pendingEfforts.delete()`，`agent/request` 监听开头 `if (hostUsesModelSelection(agent)) return next()` 直接 stand down，旧桥只留给 ≤0.2.1；两条缝各记一行宿主日志（同值只记一次）。**证据不是读代码推的**：`scripts/probe-host-model-selection.mjs` 装真实 0.2.2-rc.1 包、import 宿主真正的 `AgentModel`、逐字复刻 `:994-1001` 的 gate —— 对 0.2.2 输出 `OK: real host AgentModel accepts the pin and the request gate passes`（并反证「不 pin 而改 request」必抛），对 0.2.1-rc.5 输出 `LEGACY: host has no AgentModel (dsh <= 0.2.1)` 且 exit 2。其余接口面核对均未变：peer 范围本就覆盖（`>=0.1.0-rc.6 <0.3.0`）、`ctx.tools.register(defineTool(...))` 仍是 0.2.2 的注册面、`ctx.subagents` 六个方法签名逐一相同、Session Projection 插件只读不注册、不 import app-boot；`cordis.patch.yml` 与两份 preset patch 无需改动（0.2.2 的 Agent 作用域工具执行与 `agent.model.select()` 变更不触及本插件的挂载方式）。测试 388/35 → **392 通过 / 2 跳过 / 0 失败 / 394 项 / 35 个文件** |
| 0.21.0 | 重做面板页与「监督动态」Feed 的界面，按 `unslop` 的方法过一遍九道：间距、颜色、图标、文案、字体、布局、细节、视觉、动效。**颜色不再硬编码**：改用宿主 alias 令牌（`--dsw-alias-settings-card-fill/-stroke`、`label-primary/secondary/tertiary`、`border-l1/l2`、`interactive-bg-hover`、`brand-primary`），语义色只留 `state-success-primary` / `state-warn-label` / `state-error-primary` 三种，全部 4.5:1 以上 —— 原先的五个彩色状态胶囊、蓝色选中底、`#4070ad` 硬编码因此在浅色主题下也站得住。**信息结构重排**：Feed 从「八个等重的卡片网格」改成一条三段式仪表带（目标轮次刻度尺 / 22px 等宽倒计时 / worker 读数）+ 左主列（进展时间轴、变更记录）+ 320px 右栏（待回答、任务报告、笔记、GOAL.md），900px 以下合单栏、720px 以下仪表带也叠成一列；面板从 780 加宽到 880，模型白名单/模式/Rhythm 三段与底部粘住的保存条保持一屏可见。**去掉装饰性噪音**：`@keyframes dsma-pulse` 的无限脉冲、`transition-all`、hover 放大、⏸▶↻■✕⚠ 六个符号化图标全部删除，只留一种 5px 指示灯（实心在跑 / 空心空闲）；数字统一 `tabular-nums`、时间只到分钟（精确值进 `title`）、所有间距回到 4px 网格。设计过程留在 `unslop/`：旧状态截图、设计参照、以及 `render.mjs` —— 它在 vm 里加载真实的 `lib/client.js` 并把组件树渲成 HTML，再用无头 Chrome 截图，所以那几张 PNG 是插件的真实输出而不是手绘稿。测试数字不变（**392 通过 / 2 跳过 / 0 失败**），只把断言里的旧文案与旧间距换成新契约 |
| 0.19.0 | 从 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) 移植六条机制，均取机制、不取架构。**report 六态**：worker 在 `outcome.md` 头行自述 `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped`，`lib/report.js` 解析、`lib/stage.js` 用纯函数 first-match-wins 判成 `person/*` / `working` / `idle` / `ended`，渲染进 `.agi/BRIEF.md` 新增的「Worker 状态」段 —— 取代原先靠 `lastActivityAt` 时间差猜「是不是卡了」。**人优先预留槽**：`reservedHumanSlots` 在并发上限之外给人留位置，槽满但本轮有直接人类消息时仍可再派。**proactive 三档**（`off` / `observe` / `auto`）：`observe` 不真派生，只把「本会派什么」记进 `.agi/proposals.jsonl`。**outbox 退避投递**：收敛通知落 `.agi/outbox.jsonl`，2 秒起逐次翻倍到 60 秒、同类严格保序，BRIEF 写盘成功才算 `delivered`，写不进去就 `markFailed` 抬高退避而不是假装送过。**人格外置 + 版本化**：`prompts/main-agent.md` / `prompts/worker.md` 为源，`agent-presets/main-agent/agent.cordis.yml` 是生成物，revision 落在 `presets/main-agent.patch.yml` 头行与 `prompts/CHANGELOG.md`。**验收清单兜底**：worker 写 `checks.json`，`check_outcome` 一次跑完。另修掉两个真缺陷：Windows 上 `check_outcome` 因 Node 自动加双引号叠上 cmd.exe 解析而**一半验收项假失败**（退出码有时仍为 0，补 `windowsVerbatimArguments`）；`package.json` 的 `files` 缺 `prompts` 导致发布包缺人格源。新增 `npm run sync-profile` 把仓库同步到 profile 副本与 `~/.dsh/.agent-presets/` 两份运行时拷贝 —— 只同步其中一份是此前「改完重启也没变化」的根因 |

## 在新 PC 上运行本地课程

安装 Git 与 Python 3，克隆本仓库，然后运行它的课程启动器：

```sh
mkdir -p "$HOME/src"
git clone https://gitee.com/n-sky/dsh-main-agent.git "$HOME/src/dsh-main-agent"
cd "$HOME/src/dsh-main-agent"
./tutorial/setup.sh
```

启动器把环境放在 `tutorial/.venv` 下，安装仅评分器需要的 Python 依赖，并挑选
一个未占用的 `127.0.0.1` 端口，然后打印教程 URL。它的本地服务器为嵌入
每个里程碑的评分按钮提供后端。它刻意不安装 dsh、不克隆 DeepSeek Harness、
不配置模型、也不创建工作区；这些步骤由安装章节明确讲授。

## 安装监督者（第 6 章）

前置条件：22.x 系列中的 Node.js 22.19+，或 Node.js 24+，以及 dsh
（`npm i -g @deepseek-ai/dsh`），并配置好模型（web UI → Settings → Models；
已在 Z.AI `glm-5.3` 上测试）。

发布版（0.10.0 起，直接从 git 安装）：

```sh
dsh plugin --profile web add https://gitee.com/n-sky/dsh-main-agent.git

# restart dsh once (bundle layers compose at boot):
dsh web
```

从已克隆的本地仓库安装（第 6 章课程路径，与上面等价）：

```sh
# When chapter 6 tells you to install the already-cloned package:
cd "$HOME/src/dsh-main-agent"
dsh plugin --profile web add "file:$PWD"

# restart dsh once (bundle layers compose at boot):
dsh web
```

> **仓库沿革与改名。** 本包 0.9.4 及以前的版本发布在
> `https://gitee.com/n-sky/dsh-supervisor.git`；自 **0.10.0** 起改名为
> **`dsh-main-agent`**，并迁移到 `https://gitee.com/n-sky/dsh-main-agent.git`
> （旧仓库冻结在 0.9.4，不再发布新版本）。改名只影响安装标识符：pnpm 的
> 依赖键取自包清单里的 `name` 而不是仓库目录名，因此**从哪个 URL 装出来都是
> `node_modules/dsh-main-agent`**。已经用旧 URL 装过 0.9.x 的 profile，请用上面的新
> 仓库 URL 再 `dsh plugin --profile <name> add` 一次，并把旧的
> `dsh-supervisor` 依赖键与 bundle 条目摘掉，避免同一个包挂两遍。

安装就这么多。这一条命令把该包注册为 **profile bundle**
（依赖项 + `dsh.profile.bundles` 条目），启动时该 bundle 会：

1. **不声明 schedule 服务。** `@deepseek-ai/dsh-schedule` 的 service 由 host
   平面提供 —— `dsh-web-app` 的 `- id: schedule` 行，每个挂了 Web GUI 的
   profile 都有。本包只在自己的 `main-agent` preset 里声明四个提醒工具
   （`schedule_create` / `schedule_list` / `schedule_update` / `schedule_remove`），
   与 `standard` / `cordis` / `ptc` 的做法一致。
   （不挂 `dsh-time-context` —— 它会往每个请求注入时间戳块，
   而 Schedule 不依赖它。）

   > 0.13.3 及更早版本曾用 `patches/schedule.patch.yml` + `!!js` 让位守卫自己挂
   > 这个服务。守卫挡不住重复注册（patch 求值时 `ctx.loader` 看不到排在别的
   > bundle 里的行），插件页会显示「任务调度 · 异常」：
   > `service "schedule" has been registered at <ScheduleService>`。
   > 0.13.4 删掉那一层；0.13.6 把 `install-manual.sh` 里同样会重复注册的那一行也删了。
2. 通过 `presets/main-agent.patch.yml`（`dsh.bundle.patch` 里的最后一份 patch）
   向 agent-preset 注册表**声明**随包的 **`main-agent` preset** —— 这是 0.2.x
   唯一被读取的注册路径，`dsh plugin add` 后重启即可在选择器里看到
   「Main Agent（监督者）」；
3. 运行本包的 setup 插件（`lib/index.js`），它把随包携带的
   **`main-agent` preset** 安装到 `${DSH_HOME:-~/.dsh}/.agent-presets/` —— 仅在缺失时安装，
   绝不覆盖你的修改（行配置 `syncPreset: always | if-absent | never`），
4. **对账跨模式勾选**：按设置里的 `supervisedPresets` 把监督层重新叠加到那几条
   preset 上。对账在四个时机跑：mount 时一次、两次延迟重试（0 / 2000 ms，因为
   preset 行未必排在本插件之后），以及 `settings/document-updated` 落地时再补一次
   —— 0.13.1 起这条是必需的：重启时 `config` 由 settings 文档 hydrate，可能晚于
   前面三次，早跑的话 `supervisedPresets` 还是空数组，等于什么也没做。整条链幂等，
   已在目标状态的 preset 不会触发 `entry.update`，也就不会白白重启 fiber。

然后为监督者的状态创建一个工作区：

```sh
mkdir -p "$HOME/agi-lab/.agi/subagents"
cp "$HOME/src/dsh-main-agent/agi-template/config.json" "$HOME/agi-lab/.agi/config.json"
```

<details>
<summary>替代方案：不用插件管理器的手动安装</summary>

`./scripts/install-manual.sh ~/agi-lab` 只写两处：用户 preset 根目录下的
`.agent-presets/main-agent/`，以及工作区里的 `.agi/` 骨架。它同样**不碰**
profile 的 `cordis.patch.yml`。
schedule 完全不用管：service 由 host 提供（`dsh-web-app` 的 `- id: schedule`），
四个工具由 preset 自己声明，两条安装路径都不往 profile 里写 schedule 行。
</details>

### 若 pnpm 报 `ERR_PNPM_TARBALL_EXTRACT`

安装时若撞到下面这条：

```
[ERR_PNPM_TARBALL_EXTRACT] Failed to add tarball from
  "https://gitee.com/n-sky/dsh-main-agent" to store:
  Invalid checksum for TAR header at offset 0. Expected NaN, got 47706
```

**那不是仓库坏了，是安装地址漏了 `.git`。** 注意报错里回显的 URL 就是漏掉后缀的那个。
pnpm 用 npm-package-arg 判定 spec 类型，只有下面几种算 **git 依赖**（走 git 协议）：

- 以 `.git` 结尾的 URL —— `https://gitee.com/n-sky/dsh-main-agent.git`
- `git+…` / `git:` / `ssh://` 前缀，或 `git@host:owner/repo`
- `github:` / `gitlab:` / `bitbucket:` / `gitea:` 简写

**其余任何 http(s) URL 都被当成远程 tarball**（`type: remote`）直接 GET。而 gitee /
github 的仓库页返回的是仓库说明文本（`200 text/plain`，以 `# dsh-main-agent` 开头）
而不是 tar 流，tar 解析器在偏移 0 拿到的自然不是 512 字节 tar 头 —— `Expected NaN`
就是这么来的，重试几次都不会变。

补上三个字符即可：

```sh
# ✗ 浏览器地址栏里直接复制出来的
dsh plugin --profile web add https://gitee.com/n-sky/dsh-main-agent

# ✓ 带 .git
dsh plugin --profile web add https://gitee.com/n-sky/dsh-main-agent.git
```

0.12.3 起随包带一个离线小工具，把地址栏 URL 直接换成能用的 spec，也能反查安装日志
（不联网、不执行 pnpm、不改任何文件）：

```sh
node scripts/install-spec.mjs https://gitee.com/n-sky/dsh-main-agent
# → https://gitee.com/n-sky/dsh-main-agent.git

node scripts/install-spec.mjs --profile desktop https://gitee.com/n-sky/dsh-main-agent
# → dsh plugin --profile desktop add https://gitee.com/n-sky/dsh-main-agent.git

node scripts/install-spec.mjs --diagnose out.log
# → pnpm 把 "https://gitee.com/n-sky/dsh-main-agent" 当成 tarball 下载了……
#   改用 "https://gitee.com/n-sky/dsh-main-agent.git"。
```

它同时收掉几种常见的手抖写法：尾斜杠（`….git/`）、`/tree/<branch>/…` 或
`/blob/<branch>/…` 页面地址（归约成 `owner/repo.git`）、`#<tag>` 片段（保留在 `.git`
之后）。已经是 `git+…` / `github:` 简写 / `file:` 本地路径 / 真正的 `.tgz` 则原样放过。

## 升级与卸载

> 0.10.2 起随包携带 `scripts/repair-profile.mjs`；0.10.10 起它能在 **DSH 完全关闭**
> 的状态下把「卸不掉」一次性救回来：清重复 preset 声明、清本 bundle 在用户层
> `cordis.patch.yml` 里的行、把 preset 目录改名备份，并诊断 pnpm 侧的漂移与冷静期。

**升级请「先卸载再安装」，不要点「更新」。** 已安装的旧副本和新版本会在组合期
同时声明同一条 `preset-main-agent`，插件管理器会报
`user-patch: duplicate loader entry id "preset-main-agent"`，然后回滚并恢复原文件。

### 卸载被拒到底撞在哪

插件管理器的 `removeBundle()`（`@deepseek-ai/dsh-plugin-manager` 的
`lib/index.js:2137-2164`）真实判定顺序是：

```
not-removable → stop-profile → bundle-in-use → runPnpm(["remove", ...])
```

- `stop-profile`（`lib/index.js:2142`）先抛：没有 hmr 服务时，只要 bundle 名还在
  `dsh.profile.bundles` 里、或某条 patch 行有活着的 entry（`entry.fiber !== void 0`），
  就直接拒绝。桌面 app 没有 hmr，所以**运行中的 bundle 先撞的是 `stop-profile`**，
  而不是常被误传的 `bundle-in-use`。关掉开关不够 —— `reload()` 只重算配置，
  真正释放要重启进程。
- `bundle-in-use`（`lib/index.js:2148`）要等 entry 的 fiber 真的没了才会命中，
  真正的来源是**用户层** `cordis.patch.yml` 里本 bundle 的行（`agi-supervisor-setup`、
  `preset-main-agent`，含 `- insert:` 里的内嵌行）。bundle 自己的 patch 文件里那几行
  不会造成它 —— 卸载时那些行随包一起消失。
- 两条都过了，才轮到 `runPnpm(["remove", name, ...])`（`lib/index.js:2152-2156`）；
  pnpm 非 0 退出会把这行输出原样抛给你。

### pnpm 侧的坎：版本漂移 + 冷静期

插件管理器固定用 DSH 自带的 pnpm（本机实测 **11.7.0**，
`<home>/dsh-runtimes/dsh-primary-runtime/dependencies/`），这条 `remove` 路径没有接
`handleResolutionPolicyViolations` 回调。于是只要 profile 的 `package.json` 与
`pnpm-lock.yaml` 有**精确版本漂移**（例如 manifest 写 `0.1.199`、锁文件还停在
`0.1.198`），而漂移版本又没被 `minimumReleaseAgeExclude` 白名单覆盖，任何解析都会报：

```
[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 1 resolution-policy violation was
produced but no handleResolutionPolicyViolations callback was wired to react to them.
```

此时卸载卡死在 pnpm 这一步，脚本不会替你改策略、也不会替你跑 pnpm。两种处置
（A 临时、B 长期，二选一）：

```sh
# 方案 A（不动白名单）：DSH 完全退出后，用 DSH 自带的 node + pnpm 直接卸
"<home>/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
  "<home>/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
  remove dsh-main-agent --config.minimumReleaseAge=0

# 方案 B（推荐，长期有效）：在 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 里加整包豁免
minimumReleaseAgeExclude:
  - "billion-context"
```

**冷静期到底生不生效，脚本会分开报**：`pnpm-workspace.yaml` 里的
`minimumReleaseAge` 是**当前**配置；`node_modules/.pnpm-workspace-state-v1.json`
的 `settings` 只是**上一次安装解析时** pnpm 用过的值（带 `lastValidatedTimestamp`），
pnpm 把它当缓存写下来，之后配置被改掉/删掉它也不会变。所以：

- 配置里有 `minimumReleaseAge` → 报「当前生效」，重跑 pnpm 就会撞上；
- 只在缓存里留下 1440（本机 10-17 22:25 那次失败正是这种）→ 报「上一次解析时生效」，
  当前配置里其实已经没有它了，但仍建议按方案 A 显式关掉再重跑，免得配置一变又踩回去。
  这也是为什么本机 `pnpm config list` 里看不到 `minimumReleaseAge`，日志里却有这次失败。

`repair-profile --json` / 普通输出在检测到这种漂移时会把上面两段**按实测路径**
打印出来（找不到自带运行时才退化成 `<node>` / `<pnpm>` 占位符）。
脚本本身只做诊断，不改 `pnpm-workspace.yaml`、不跑 pnpm、不动 `pnpm-lock.yaml`。

### 用脚本收尾

```sh
# 只诊断，不写任何文件（有发现时退出码为 1）
node scripts/repair-profile.mjs

# 只去重：清掉重复的 preset 声明（保留第一条），写前自动备份 cordis.patch.yml
node scripts/repair-profile.mjs --apply

# 彻底回到可安装状态（--uninstall 隐含 --apply）
node scripts/repair-profile.mjs --apply --uninstall
```

`--apply` 是保守的：只删重复的 `preset-main-agent` 声明，**绝不删唯一的那条**
legacy 行。`--apply --uninstall` 才做完整清理：

1. 删 `package.json` 里的依赖记录与 `dsh.profile.bundles` 条目；
2. 删残留的 `node_modules/dsh-main-agent`（含 `node_modules/.ignored/` 下的）；
3. 删 `cordis.patch.yml` 里**所有**本 bundle 的行 —— `agi-supervisor-setup`、
   `preset-main-agent`，以及 0.13.3 及更早版本可能留下的 `agi-schedule` 孤儿行；
   顶层 override 与 `- insert:` 内嵌行都算，
   删空的 `- insert:` 一并移除，其它行（`ui-settings`、`ui-chat` 等）原样保留；
4. 把 `<home>/.agent-presets/main-agent` **改名**为 `main-agent.bak-<时间戳>`
   （同目录内 rename，可逆，不会 `rm -rf`；确认不需要后自行删除）。

每次写入前生成 `.bak-<时间戳>`：`package.json.bak-<stamp>`、
`cordis.patch.yml.bak-<stamp>`。`cordis.yml` 是生成物，只报告、不修改。
脚本**不改** `pnpm-lock.yaml`（不在同一层解决版本漂移），第二次跑不会产生任何
新动作。

`--home <目录>` 可以指到任意 profile 根（诊断副本、备份目录），
`--profile <名字|目录>` 只处理一个 profile，`--help` 看全部参数。

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `unknown prompt variable "{{cwd}}"` | 旧版 persona 引用了 loop 未注册的变量 | 升级到 0.10.1+；或按「兜底」覆盖文件 |
| `duplicate loader entry id "preset-main-agent"` | 新旧两份 bundle patch 同时声明 preset 行 | 卸载后重装，别点「更新」 |
| `{"code":"stop-profile"}` | 桌面 app 无 hmr，运行中的 bundle 被判定仍在用 | 关开关 + 完整退出；或 `--apply --uninstall` |
| `{"code":"bundle-in-use"}` | 用户层 `cordis.patch.yml` 里还留着本 bundle 的行 | `--apply --uninstall` 清行 |
| `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` | manifest 与 lockfile 精确版本漂移 + 冷静期生效（当前配置，或上次解析记录）且白名单没覆盖 | 上面的方案 A 或 B |
| 安装报「这个包已经安装」 | `package.json` 里还留着依赖记录 | `--apply --uninstall` 之后再安装 |

`--apply --uninstall` 跑完**完全退出 DSH 再启动**（配置在启动时才重新组合），
然后用安装地址重装（不要点「更新」）：

```sh
https://gitee.com/n-sky/dsh-main-agent.git
```

装好后重启一次，模型选择器里应出现 **Main Agent（监督者）**。

<details>
<summary>兜底：不卸载，直接覆盖文件</summary>

UI 实在卸不掉时（比如被运行中的 preset 行锁住，而 pnpm 侧又卡在策略报错），
可以让已安装副本就地变成新版：`git clone https://gitee.com/n-sky/dsh-main-agent.git`，
把 `package.json`、`presets/main-agent.patch.yml`、
`agent-presets/main-agent/agent.cordis.yml` 覆盖到
`${DSH_HOME:-~/.dsh}/profiles/<profile>/node_modules/dsh-main-agent/` 的对应
位置，重启即可。版本号会显示成新版本，但 `pnpm-lock.yaml` 仍指向旧 commit，
下次重装前建议先用 `repair-profile` 清干净。
</details>


## 运行

打开 http://127.0.0.1:3080 → 新建会话 → 工作区 `~/agi-lab` → preset
**Main Agent（监督者）** → 交给它一个任务，例如：

> 目标：产出 SUMMARY.md 描述 `<some docs dir>` 的目录布局 —— 委派
> 工作、监督、交付。

你应当依次看到：它先读取持久任务状态
与相关工作区的 runbook/脚本完成 **打底**，调用 `start_goal` 写入 `.agi/GOAL.md`
并立即武装原生目标，然后在同一回合里继续。不生成
确认短语，也不需要第二次人工回复。接着它用完整的结构化任务
与明确的、经 Settings 批准的模型路由调用受保护的 `subagent` 工具，
武装一个周期性巡检提醒，然后休眠。它会因 worker 的收敛通知而醒来，
**用自己的读取核验交付物**，把一切记录到 `.agi/CHANGELOG.jsonl`，
然后继续或收尾。你随时可以通过聊天纠偏；
worker 就是侧栏里的普通会话 —— 点开一个即可实时观看。

### 可审阅、非阻塞的目标前端

该 preset 刻意禁用了 Harness 原生的、面向模型的
`@deepseek-ai/dsh-tool-goal` 行。那个前端允许 `create_goal` 在没有
先检查持久任务状态或工作区 runbook 的情况下，就推断长时间运行意图。
`dsh-main-agent/goal` 只替换那个
前端；原生 `ctx.goals` 服务、会话投影与带竞态围栏的
goal-round 驱动器仍安装在宿主上。

该替代前端暴露 `get_goal`、`start_goal` 与 `update_goal`。`start_goal`
仅在直接的人类回合中、且仅在该回合调用过 `get_goal` 之后，才对根 agent 可用。
它把目标（objective）、约束、里程碑、
范围外事项与自主回合上限写入规范的 `GOAL.md`，立即调用原生
goal 服务，并返回同一个模型回合，使工作继续。
生成的文档用于可见性与纠偏，不是审批闸门：
人类可以查看它，并通过普通聊天改向、暂停或停止。
`update_goal` 刻意省略了 `edit`；暂停、恢复、完成、阻塞
阈值、原生修订版本、投影与自动续行都保持其
Harness 行为。

只有当原生可续行子级真正收敛后，才会报告 worker 失败。
监督者保留那一次唤醒，并用子级持久的最终 `turn/end` 丰富它，
例如 `Terminal failure [QUOTA]: …`。中间的
`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 与空响应抖动保持静默，
由 Harness 的重试策略负责处理；一次成功的重试产生普通的
完成通知，而重试耗尽时只暴露最终原因。被停止的
子级仍可通过 `send_message` 恢复。

受阻的 worker 同样无法把提问困在自己的会话里。
受保护的派生前端会施加一项原生逐子级工具限制，从 worker 对外公布的 schema
与执行路径中同时移除 `ask_user_question`。子级作用域的 `report` 工具
刻意在该限制下存活，因此提问会以 `subagent-report` 消息到达父级，
唤醒监督者，并可用 `send_message` 回答。因此周期性提醒只是一道恢复检查，
而不是监督者发现某个 worker 一直在等待输入的第一现场。
实时提示词还禁止把 `list_agents: running` 当作有进展的证据。
每次巡检都必须把具体的报告、产物/日志变化或已完成的步骤
与上一次 `NOTES.md` 检查点对比。第一次无变化的巡检触发状态探针；
下一次仍无变化就中断，并恢复或重新派生该 worker。这条策略会
渲染进每个请求，因此监督者在规则上无法围绕
“仍在运行”空转。

计时旋钮分两层：全局默认在设置卡片（`agi-supervisor-setup` 域里的
`wakeMinutes` 与 `questionWaitMinutes`），而 `<workspace>/.agi/config.json` 里
**带着同名键时会覆盖它们**（这个文件是 USER-ONLY 的：agent 可以提议修改，但
绝不直接编辑它）。`wakeMinutes` 是**空闲基线**，实际间隔由服务端按状态自适应
（worker 在跑 60–120 秒、等你回答 5–15 分钟、连续无新证据一路退避到 30 分钟，
下限 60 秒 = schedule 的硬下限），`questionWaitMinutes` 是记录假设并继续之前
等待答复的时长。`watchdogEnabled` 让服务端在「目标还在、却没有任何提醒」时
自己补一条兜底提醒，`workerDeadlineMinutes` 到点中断停滞的 worker，
`maxSpawnTotal` 限制整个会话累计派生量。

兜底不是无限的：`progress.jsonl` 连续 5 轮没有新写入就判定空转，先拉长唤醒
间隔、再以 `code: idle` 结束目标并写明原因 —— 一直叫醒一个不动的循环，只是
把预算烧在「还在看」上。反过来，人类按下的 pause 会让兜底立刻撤掉（判据与
宿主的驱动器一致：`phase === 'active' && activation === 'armed'`），否则
「让它停」这件事永远停不下来。`.agi/BRIEF.md` 每轮重写一次，结构固定五段：**循环状态**（轮次、空转计数、
上次推进在多久之前）、**Worker 状态**、**待投递**（仅在有积压时出现）、
**最近进展**、**之前的目标留下的教训**。

**`## Worker 状态` 不是从自述散文里猜的。** 每个 worker 在 `outcome.md` 头行写一行
`<!-- report: <state> -->`（六态：`progress` / `waiting` / `ready` / `blocked` /
`failed` / `dropped`），插件读这一行，配上「它是否仍在运行」与「有没有待答问题」，
用一个纯函数（`lib/stage.js`）判成 `person/*`（需要人做决定）、`working`（别打扰）、
`idle`（可以给新单元）或 `ended`（已收尾）。摘要里的一行长这样：

```
- `a1b2c3d4` person/answer → 等用户回答 — blocked：需要确认 A 还是 B
```

判据是结构化的，所以「卡了八分钟」与「在跑一个八分钟长命令」终于能分开 ——
旧实现只靠 `lastActivityAt` 的时间差推断，这两件事完全不可区分。`dropped` 表示
「干完了、确实没活」，它不该被记成失败。Lead 验收后写一份 `archived.json`
（`npm run accept -- <id> [备注]`），归档的 worker 变成
`ended/archived — 已验收归档`，不会再以「等用户验收」永远挂在摘要里。

**`## 待投递` 是收敛通知的投递账本**（`lib/outbox.js`）：通知先落进
`.agi/outbox.jsonl`，从 2 秒起逐次翻倍、上限 60 秒退避重试，同类严格保序
（更早的同 kind 未到期就压住后面的，不同 kind 互不阻塞）。BRIEF 写盘成功后
才标记 `delivered` —— 写不进去就带着重试次数与下次时间继续出现，
还会调 `markFailed` 抬高退避，而不是假装送过了。

兜底的触发点是「有回合开始」，这意味着重启之后最需要它的时刻（会话空闲、
提醒表空了、又没有新消息）恰恰不会触发它。所以挂载后 3 秒与 20 秒各扫一遍
根级监督者会话，把提醒重新排上，两次都幂等。兜底状态按 session 分文件存
（`.agi/loop-state.<后 8 位>.json`）：`.agi/` 是 per-workspace 的，但「连续
空转了几轮」「谁按下的暂停」是 per-session 的事实，共用一份会让两个会话互相
把对方的推进判成空转。这些派生文件首次写入时会自动补进 `.gitignore`（若整个
`.agi/` 已被忽略则不动）。

预算是可以续的，但不是自动加码：用到 80% 且最近几轮确实在推进（`idleTicks`
为 0）时，服务端调 `goals.edit` 把上限抬到 1.5 倍，最多两次 —— 一个「永远
不产出、但每轮都在写文件」的目标会让空转计数一直归零，上限是它唯一的刹车。
续期、空转、复核、唤醒丢失都写进同一份时间线，摘要里也会给出「上次推进 N
分钟前、上一轮用了 M 分钟、预算已续期 K 次」：只看「第 12 轮」而不看「一轮
多久」，没法判断这个目标是在推进还是在慢慢烧预算。

`.agi/LESSONS.md` 是跨目标的：每个目标收尾时写三到五条可复用的事实（哪种
查法有效、哪条路径确认走不通），服务端把它附在之后每个目标的摘要里。这份
文件不由插件生成 —— 它是模型写的散文，插件只负责读和转交。

该 preset 把恢复与连续性当作明确的不变量。在升级一个阻塞项之前，
监督者必须检查仓库本地的 runbook 与
脚本，并尝试一组有界的、彼此不同的安全恢复动作；反复硬撞
以及绕过安全或审批边界都是禁止的。仅人类可解的
依赖只阻塞它所在的分支：独立的准备工作与核验
继续进行。每个未完成的长期回合都必须留下一条持久唤醒路径
（一个运行中的 worker、一轮活跃的原生目标，或一个提醒），因此单纯的聊天
承诺「等待」不能悄悄搁浅任务。遗留的 `GOAL.md` 仍是
有用的上下文，但不能冒充已武装的原生目标：
每一次启动、恢复或继续长期工作的直接请求，都必须先
检查 `get_goal`；当不存在活跃的原生目标时，监督者必须检查
工作区相关的 runbook/脚本并调用 `start_goal`。提醒是
恢复辅助手段，不能替代目标驱动器。
这条边界由插件自有的执行前守卫强制执行，而不仅是
人格文本：明确的长期续行可以检查持久状态，
但在当前回合检查原生目标状态并武装一个可审阅目标之前，操作性工具保持关闭。
一旦 `start_goal` 成功，同一回合即可
立即使用工作区既有的自动化。如果工作区含有
runbook、自动化脚本或源码入口，`start_goal` 会被额外
拒绝，直到当前回合成功打开一个 `.agi` 之外的文件；宽泛的
列目录，或只读 GOAL.md/NOTES.md，都不算满足打底要求。

### Ralph：第三种执行载体（fresh-agent 收敛）

`ralph` 不是本插件的工具，它来自官方的
`@deepseek-ai/dsh-experimental-ralph-bundle`。本插件的 preset
**自己插了一份配置相同的 `tool-ralph` 行**，所以即使那个实验性
bundle 被关掉，`ralph` 也仍然可用 —— 插件不依赖它。

它和本插件的 worker 模型是**相反方向**的：本插件的 worker 刻意复用
会话（`send_message` 的消息在下一回合到达、上下文保留），ralph 则每一轮
开一个全新 child，只带上一轮 ≤16KB 的结构化 handoff，以工作区为长期
记忆。所以只有两种情形该用它：

- **上下文被污染。** 某个 worker 反复漂移、会话日志里已经混进失效
  假设，`interrupt_agent` 之后你判断「再加历史只会更糟」。ralph 就是
  「用修订后的任务重新派生」的机制化形式。
- **长收敛。** 同一目标要反复「改 → 验 → 再改」很多轮（修到测试全绿、
  一批批迁移、迭代到幂等），并且每轮都要重读同一批大文件 —— 这时复用
  会话的上下文腐烂成本高于每轮冷启动成本。

其余一并不用：普通长任务走 `start_goal`，有界委派走 `subagent`（复用
上下文更省），大规模扇出走 `workflow`。

两条硬约束：

1. **它的 `complete` 只是 worker 自述**（上游明确没有独立验收）。
   返回后必须 `check_outcome` + 亲自读 `outcome.md` + 亲眼核验真实
   文件，全部通过才可更新 `progress.jsonl` 与目标里程碑。
2. **它是前台阻塞调用**，没有 job id、没有 checkpoint、没有 scheduler，
   单次可能跑几十分钟。所以只在「你愿意整个回合不心跳」时用：调用前先
   `schedule_create` 排一条提醒、把阻塞意图写进 `progress.jsonl`，并且
   同一回合里不要再叠第二个长任务。

验收产物放在**固定目录** `.agi/subagents/ralph/`（`outcome.md` +
`checks.json`），返回后直接 `check_outcome({"session_id":"ralph"})` ——
ralph 的返回结果里**不含子会话 id**，而 `check_outcome` 只按目录名找
`checks.json`，所以固定目录是唯一可行的对接方式。完整的 objective
模板写在 persona 里（`agent-presets/main-agent/agent.cordis.yml`），
两处共用同一份文本，避免漂移。

## 元配置（Meta-config，Settings → Plugins → 监督者）

监督者由用户所有的旋钮位于同一个 settings 域，这个域的名字是这份组合里本插件的
**入口 id（行 id）`agi-supervisor-setup`** —— 它既不是包名
`dsh-main-agent`，也不是历史包名 `dsh-supervisor`。有两种等效的编辑方式：

- **Web UI（推荐）：** Settings → Plugins → *监督者* —— 该卡片带有
  一个「从模型目录添加模型…」下拉框。一个合成的 **当前运行时模型** 选项
  （跟随本次调用回合，`runtime/current`）默认启用；固定模型会标注原生输入模态与
  其模型自述的推理强度。每个被允许的模型行都有自己的
  推理强度选择器，添加流程会同时询问路由与推理强度。
- **文件：** 当前 profile 的 patch 层 `~/.dsh/profiles/<profile>/cordis.patch.yml`
  里以 `- id: agi-supervisor-setup` 开头的那一行 —— 原生设置编辑器写入的就是这份
  文档，键同样是入口 id。

> **`settings.yaml` 是已移除的旧格式，不再是设置文件。** 启动时 `dsh-settings`
> 会把 `~/.dsh/settings.yaml` 改名成 `settings.yaml.imported`，再逐节尝试写回；
> 只有节名正好是某个**运行中的入口 id** 时才会成功（仅 `ui-developer-tools`、
> `ui-onboarding`、`shell` 三个节名有硬编码映射）。所以 `dsh-supervisor:` 这样的节
> 一定会被拒：`update()` 以入口 id 查行（`No configurable plugin entry
> "dsh-supervisor"`），失败只留一条
> `settings: section … was not imported into entry …` 警告，值留在 `.imported`
> 文件里。全新机器上这个文件通常根本不存在 —— 直接改 Settings 卡片，或改上面那份
> profile patch。

| 键 | 含义 | 生效时机 |
|---|---|---|
| `workerModels` | 必填 `subagent.model` 的完整白名单：`runtime/current` 和/或精确的 `provider/model-id` 路由；全新安装 = `runtime/current`；留空 = 禁用派生 | 下一次工具调用与下一份工具 schema（实时） |
| `workerEfforts` | 从每条被允许路由到用户所选推理强度的映射；`provider/default` 不发送显式推理强度（全新安装与缺失条目的默认值），而 `high` 之类的固定 id 来自该路由的原生目录 | 下一次派生与下一份工具描述（实时） |
| `maxParallelWorkers` | 同时打开的 worker 上限，在派生时**强制执行**；0 = 不限 | 下一次工具调用（实时） |
| `reservedHumanSlots` | 并发上限之外**额外留给人**的槽位数（默认 1）。槽满了但本轮存在**直接人类消息**时，仍可再派一个 —— 新工作挡不住人和监督者说话 | 下一次工具调用（实时） |
| `proactive` | 自动派生档位：`off`（直接拒绝新的派生）/ `observe`（不真派，只把「本会派出什么」追加到 `.agi/proposals.jsonl` 并返回说明）/ `auto`（默认，正常派生）。`observe` 是给「先看几条它打算派什么」用的 | 下一次工具调用（实时） |
| `wakeMinutes` | 空闲基线（分钟，≥ 1）：实际唤醒间隔由 `GET /supervisor/loop` 按状态给出（worker 在跑 60–120 秒、等回答 5–15 分钟、无新证据退避到 30 分钟） | 下一回合（实时） |
| `watchdogEnabled` | 服务端兜底：目标未完成且没有任何 active 提醒时，自己补一条 `watchdog · 监督循环兜底`（默认开） | 下一次巡检（实时） |
| `workerDeadlineMinutes` | worker 停滞超时（分钟；0 = 不管）；到点由服务端 `interrupt` 并记停滞 | 下一次巡检（实时） |
| `maxSpawnTotal` | 整个会话累计派生 worker 预算（0 = 不限）；与「同时上限」互补 | 下一次工具调用（实时） |
| `questionWaitMinutes` | 监督者等待问题答复的时长；超时后记录一个假设并继续 | 下一回合（实时） |
| `supervisedPresets` | 还要跑监督循环的 preset id 列表（`main-agent` 永远算，不在此列）；见下面「跨模式」 | 下一次对账即生效（实时，见该节） |
| `syncPreset` | 随包 preset 装到 `.agent-presets/` 的策略：`if-absent`（默认，只在缺失时安装）/ `always` / `never` | **仅 mount 时**，不是 UI 旋钮、不随会话变化 |

修改是**实时**的 —— 无需重启、无需新会话：插件会重新解析
白名单并重新挂载 `subagent`，使其 `model` 枚举与能力标签只显示
当前已批准的选择。执行时也会重新读取设置，从而关闭
「某个模型在请求拿到工具 schema 之后才被移除」这一竞态。一个
`SUPERVISOR META-CONFIG` 系统提示词段落会把同一策略连同
强制上限与时间默认值一起重新渲染进每个请求。

推理强度是每个由 settings 拥有的模型行的属性，而不是工具调用时的选择。
主 agent 收到的是必填的 model 枚举，但没有推理强度参数。它同样
不能从自己的请求继承推理强度：缺失的遗留映射条目会变成
`provider/default`。若某个固定推理强度并非精确解析出的 worker 路由所
自述支持的，则在 provider I/O 之前被拒绝；它绝不会被夹取或悄悄
降级。对于动态的 `runtime/current`，只有 provider/model 路由跟随
调用回合；其推理强度仍来自 `workerEfforts.runtime/current`。
插件预留可续行子级的确切 id（或
捕获前台子级的创建边界），并在其第一次模型调用之前施加一次性、
按 id 过滤的请求覆盖，使该选择成为
子级持久 `request/header` 的一部分。后续热步骤与冷恢复都会
恢复已记录的显式推理强度。无需 Harness 补丁或自定义续行
描述符。

这里刻意没有 preset 模型清单，也没有隐式的父级/默认
继承。全新安装显式允许 `runtime/current`：选择它
会读取调用回合的持久请求头中捕获的 provider/model，解析其能力，
并把该精确路由转发给子级。
它绝不读取父级创建时的选项，因此在某个回合前切换主模型
也会切换 `runtime/current` 的含义，而不会复活
过期路由 bug。如果每个子级都必须使用固定
路由，就在 Settings 中移除该条目；要禁用派生则移除所有条目。

随包携带的原生 spawn 与 fork 前端未出现在 preset 中，因为
它们没有受 settings 保护的 `model` 参数，且可能继承主
会话的路由/推理强度。插件自有的 `subagent` 是唯一的委派
前端。每个成功的工具结果都会列出所选
路由、原生模态与生效的推理强度策略，例如
`antigravity/gemini-3.7-flash [text,image] effort=high`，使层级关系让
由 settings 拥有的选择清晰可见。视觉路由：给它一个
`[text,image]` 模型，监督者就会把图像类工作（截图、UI
检查、图表）派到那里；worker 用 `read_image` 读文件，而 harness
仅在支持图像的模型路由上允许该工具。

### 跨模式：让别的 preset 也跑监督循环

监督循环默认只属于 `main-agent`。若希望 `standard`、`ptc`、`cordis` 这类
preset 也能主动跑循环（而不只是让 Feed 面板可见），在同一张设置卡片里勾选
**启用监督循环的模式** 即可 —— 列表来自 `agentPresets.list()`，一个 preset
对应一个复选框。

**但不是每个 preset 都承载得了。** 监督层要落地靠的是下面表里那四行锚点，
一行都不能缺：缺 `persona` 就没有人格；缺 `tool-goal` / `tool-subagent-control` /
`tool-subagent` 就成了「自称监督者，却没有 `start_goal`、没有 worker、没有
`send_message`」。所以判定按**锚点行是否存在**逐条来（`supervisorAnchorReport`），
不看已经叠了几行 —— 没叠过的 preset 那个计数恒为 0，拿它判断会把 `standard`
也一起判死。

官方 `minimal` 就是反例：它有 `persona`，却没有 `tool-goal`、没有
`tool-subagent-control`、也没有 `delegation` 组，四个锚点缺三个。设置卡片把它
灰掉并写明缺哪几行；即使绕过界面硬塞进去，服务端也会把它从勾选里剔除、在响应
里返回 `rejected`，并且**不去改那个 preset** —— 半应用的监督层比没有更糟。

这个操作改写的是该 preset 的 loader 行 `plugins`，只动三行 `name`、`persona.prefix`，
以及 `tool-subagent` 的 `config`，其余行逐字节不变：

| 位置 | 从 | 到 |
|---|---|---|
| `persona.config.prefix` | 原值（`""` 或该模式自己的人格） | **原值 + 过渡段 + 监督者人格**（拼接，不覆盖） |
| `tool-goal.name` | `@deepseek-ai/dsh-tool-goal` | `dsh-main-agent/goal`（`start_goal`） |
| `tool-subagent-control.name` | `@deepseek-ai/dsh-tool-subagent-control` | `dsh-main-agent/control`（运行中纠偏） |
| `tool-subagent.name` | `@deepseek-ai/dsh-tool-subagent` | `dsh-main-agent/spawn`（强制从白名单选 model） |
| `tool-subagent.config.persona` | 无 | `DEV_AGENT_PERSONA`（worker 协议） |
| `tool-subagent.config.deny` | 无 | 旧式 `toolFilter.deny` 的副本（合并去重） |

`tool-subagent-list-agents` 与 `tool-subagent-fork` 保持官方实现，`disabled`
行、`!!js` 条件与 group 结构都不受影响。`main-agent` 恒为监督者，在列表里
只展示不可勾选。

**为什么还要搬 `deny`。** 新版 `@deepseek-ai/dsh-tool-subagent` 已经不再接受
`persona` 与 `toolFilter`（配置里有任一字段就抛错），所以破甲模式改用「生成一个
子预设 + `agentPreset`」来排除 `subagent_fork` / `workflow` / `ralph`。而监督层
会把那一行改名成 `dsh-main-agent/spawn` —— 改名后 dsh-poja 的迁移就认不出它
（它只匹配官方 name），子预设不再生成，限制会静默丢掉。所以限制必须有 spawn 侧
的落点：`apply` 把 `toolFilter.deny` 复制进 `config.deny`，`dsh-main-agent/spawn`
在构造请求时把两者合并成 `workerToolFilter(workerDeniedTools(config))`。
旧字段刻意保留 —— `strip` 靠「`deny` 与 `toolFilter.deny` 同时存在」判断这是自己
写的副本，从而在**没有 baseline** 时也能精确删掉它，同时不动用户自己写的 `deny`。

**persona 是拼接，不是替换。** 勾一个自带人格的模式（例如破甲模式那 1835 字
「操作者的执行端」），写入结果是 `原人格` + `<!-- dsh-main-agent:supervisor-layer v1 origin=1835 -->`
+ 过渡段 + `监督者人格`。原人格逐字保留在最前，监督者人格追加在后，中间那段
交代分工：模式决定**怎么干活**（身份、执行风格、交付标准、边界），监督层决定
**怎么推进目标**（锁定目标、派 worker、定时唤醒、状态落盘）；冲突时按这个切分，
且「不要亲自做完」只约束长任务编排 —— 一次就能做完的读、查、核验、收尾仍然
由 agent 自己动手。

前缀为空的 preset（自定义精简版之类）行为不变：只得到监督者人格。

标记行里的 `origin=` 是原文长度，它同时承担两件事：**幂等判定**（`origin` 之后
到结尾逐字等于本层写过的尾部，才算「已叠过」）与**回滚定位**（取消勾选时
`stripSupervisorPersona` 直接切到 `origin`，不去文本里找锚点）。所以用户自己
的人格里出现这串标记字面量、甚至整段粘贴了监督者人格，都不会被误判成「已叠过」，
也不会被从中间截断 —— 这是纯 `includes()` 判定做不到的。

有一条边界要记住：`stripSupervisorLayer` 对 `persona` 与三处 `name` 是自足还原的，
但 `tool-subagent.config.provider` 由 apply 钉成 `spawn`，没有快照时无法知道原值，
所以**不回退**它。生产路径（`syncSupervisedLayer`、`lib/index.js`）都在 strip 之前
先存 baseline，不依赖这条自足性。

生效是**热的**：preset 的 `Service.init` 是 async generator，注册返回的
unregister 会在 fiber dispose 时自动调用，所以改写 `plugins` → 重启 fiber
→ 旧定义先注销、新定义再注册，不会撞 `Duplicate agent preset`，也不需要
重启进程。勾选结果持久化在 `agi-supervisor-setup` 域，进程启动后由一次幂等
的对账重建。

> 这一步改变的是**行为**，不只是面板可见性：勾选的 preset 每回合都会想锁定
> 目标、派 worker、写 `.agi/`。对「只想快速改个文件」的会话，留在未勾选状态
> 更省事。
>
> 静态写死等价于 `scripts/inject-supervisor.mjs --target <preset> --write`
> （`--dry-run` 只打印将改的行，`--revert` 把快照撤回），它会往 profile patch
> 里写一份快照；设置卡片里的勾选则始终跟上游 preset 内容走，升级 dsh 后不用重跑脚本。

#### 由插件直接注册的模式

`redteam`、`unrestricted` 这类由别的插件调用 `agentPresets.register()` 注册的
preset 不在 loader 里，没有可改写的 `plugins` 数组。勾选它们时改写的是它自己的
composition 文件 `${DSH_HOME}/.agent-presets/<id>/agent.cordis.yml`：

- 首次改写前把原文整份留成 `agent.cordis.yml.supervisor.bak`；
- 改写走 `yaml` 的 Document API，注释、`!!js` 标签原样保留；
- 取消勾选直接用备份覆盖回去 —— 是字节级还原，不是反向变换；
- 幂等：已经带监督层时再点保存不重写文件（`yaml` 每次序列化都会重排块标量
  缩进，靠文本比较会误判成变更）；
- `redteam` 的 composition 没有 `tool-schedule`，这一行会被补上，否则循环里的
  定时器分支指向不存在的工具。

写盘是**持久的一半**，挂载是**即时的一半**（0.12.1 起）：这些 preset 的定义虽不经过
loader，但注册表把整条记录放在 `definitions` 上、`activate()` 又是原型方法，所以插件
换掉 `record.config.plugins` 再 `activate()` 一次，**之后新建的会话立刻就是监督者**，
不用重启 DSH。已经在跑的会话不会被踢 —— 旧 generation 先置 `retired`，`collect()`
要等 `users` 归零才真正 dispose，它们把旧的那份用完。

这两个成员都是未公开接口，所以每次挂载失败都降级成 `false` 而不是抛异常：换了
harness 版本就退回「写盘、下次启动生效」，绝不假装成功。

**「挂载成功」不能只看 `activate()` 有没有抛错**：它自己 catch 掉挂载失败，只把
诊断写进 `record.broken` 就正常返回。所以 `remountPreset` 在调用后再检查
`broken` 有没有被新写入 —— 有就把 `config` 与 `generation` 一起回滚、返回
`false`，让卡片老实说「需要重启」，而不是报「立即生效」却仍服务旧 revision。

卡片据此显示 `✓ 已启用，立即生效` 或 `! 已写入磁盘，需要重启 DSH 才生效`；
`GET /supervisor/presets` 里对应的字段是 `fileBacked`（这个 preset 有没有可写的
composition 文件）与 `pendingRestart`（磁盘上是否有待下次启动加载的改动）。
`POST` 的响应还会把需要重启的那几个 id 直接列在 `restartRequired` 里，卡片在保存
提示里点名 —— 不必让用户自己去猜哪一项没生效、要不要重启。

这里是**三层还原**：文件层用 `agent.cordis.yml.supervisor.bak` 覆盖回去；内存层
用首次见到时 `structuredClone` 下来的原始 `plugins`（baseline）；最外层还有
`stripSupervisorPersona` 的源码级还原 —— 它按标记行里的原文长度把监督层切掉，
所以没有 baseline 的路径（运行时生成的 preset、首轮挂载之前）也能把用户自己
的模式人格原样还回来，而不是清空。来回切换是字节级一致。

少数 preset（如 `unrestricted` 派生的 `unrestricted-child-*`）完全由运行时生成，
既没有 loader 行也没有文件，卡片上标注`由插件在运行时生成，没有可改写的文件`
且不可勾选（`fileBacked: false` 且无 baseline）。

另一类不可勾选的是**锚点不齐**的 preset（官方 `minimal` 是典型）：`GET /supervisor/presets`
为每一项返回 `stackable` 与 `missing`，卡片据此灰掉整行并写明缺哪几行。判定同时
覆盖两条路径 —— loader 行看 `plugins`，file-backed preset 读它的 `agent.cordis.yml`
（`supervisorFileAnchorReport`），同一个 `supervisorAnchorReport` 规则，不写两份。
这道闸同时在三处生效：卡片禁用、`POST /supervisor/presets` 剔除并在响应里返回
`rejected`、`syncSupervisedLayer`（以及磁盘路径的 `applySupervisorToFile`）再拒绝
一次 —— 旧配置里残留的无效勾选因此既不会施加、也不会卡住别人的保存。

## 监督动态 Feed 标签页

每个会话的视图环（承载 **Chat** 与 **Trajectory** 的标签页）会多出一个
**监督动态 Feed** 条目：对于带 `.agi/` 状态的工作区，它一眼展示整次运行 ——
实时目标卡片、worker（含 `outcome.md`）、进度时间线、提问
栈、动作变更日志、笔记与任务报告，每约 5 秒刷新一次。
它作为持久客户端插件随本 bundle 发布（`lib/client.js`，通过
harness 的 client-modules 扫描提供），外加**六个**宿主路由：

| 路由 | 作用 |
|---|---|
| `GET /supervisor/feed?ws=…` | 读取 `.agi/` 目录树（带 ETag 条件刷新，见下） |
| `GET /supervisor/workers?session=…` | 把子级目录与 live agent 状态合成每-run worker 列表（宿主不再暴露 `subagent.list` RPC，其 catalog 也不报告 activity） |
| `GET /supervisor/health` | 宿主 `ctx.subagents` 是否具备本插件所需的 0.2.x 方法；额外带 `package`、`version` 与 `supervisorPresets`（内置 `main-agent` 恒在首位，其余来自设置里的 `supervisedPresets`）—— Feed 与设置卡片用同一份名单判定「谁是监督者」，不会各说各话 |
| `GET /supervisor/models` | 合成 `runtime/current` + 宿主模型目录（`provider/model-id`、原生输入模态、推理能力），供设置卡片的下拉框 |
| `GET`/`POST /supervisor/presets` | `GET` 列出每个 preset 的 `supervised` / `fileBacked` / `pendingRestart`；`POST {supervised: string[]}` 写回设置并立即对账（见「跨模式」） |
| `GET`/`POST /supervisor/stop` | 循环状态查询与 Full stop（见下文） |

`health` 报不兼容时 Feed 顶部显示红色横幅，而不是静默假装正常。

feed 的读取是**有界且自述的**：单文件只保留末尾 64KB、每个 JSONL 只保留最新
300 条、worker 产物只保留最新 20 个目录，被截断的部分会在 Feed 顶部明说
（`truncated`）；请求失败与"该工作区没有 .agi/"是两种不同的 UI 状态，
只有 400/404 才算后者。标签页隐藏时停止轮询，重新可见时立即刷新一次。
`POST /supervisor/stop` 额外拒绝跨站请求（插件路由不经过宿主的 token 门
—— 没有 Origin 的 curl/脚本调用仍然允许）。
无需重建前端，无需动态插件审批。

Feed 上有三处读法值得单独说清（0.10.7）：
**提问栈**读 `.agi/questions.jsonl` 的 `q` 字段，并把
`pending/assumed/answered/withdrawn` 显示成待答/已假设/已回答/已撤回 ——
看到的是问题本身，而不是问题 id；
**worker 卡片**把每份 `outcome.md` 挂回它自己那一行（**目录名是主键**，
产物头行的 `worker:` 声明是二次匹配 —— 细节见下面 0.10.9 一节；行上同时显示短 id，
`title` 里有完整 id），当前目录已不包含的历史结果
收进下方的「历史结果」兜底区，而不是和行混在一起；
**监督循环**卡片消费 `GET /supervisor/stop?session=…`，显示循环是否还武装着、
有几个活动 worker、以及下一条提醒大约几分钟后醒来（`reminders` 是记录数组
`{ id, kind, title?, everySeconds?, scheduledAt? }`，其中 `scheduledAt` 为毫秒
时间戳；读取失败时卡片里给一行弱化报错，而不是静默消失）。

### 交互（0.10.8）：worker 跳会话 / 暂停刷新 / ETag 条件刷新

三处让 Feed 从「只读快照」变成可操作面板的改动：

**worker 行可以点开它自己的会话。** worker 卡片里的标签现在是一个链接式按钮，
点击后通过客户端的 `uiWorkspace` 服务（`openSession(id)`）跳进那个 worker 的
原生会话 —— `conversation.view` 的 props 里只有 `inspectCall / viewRequest /
openView / completeViewRequest`，其中 `openView` 是**视图标签**切换，不是会话
切换，所以会话导航只能走这个服务。只有该 worker 的 session 仍在当前会话列表里
时标签才可点；否则保持纯文本，`title` 明说「该 worker 会话不在当前会话列表中，
无法直接打开」—— 不给一个点了没反应的空按钮。宿主没有暴露 `uiWorkspace` 时
整个标签页照常渲染（服务用 `ctx.get` 读取而不进 `inject`，缺服务只降级、不阻塞
插件加载）。行本身不可点，「结果」文本仍然可以选中复制。

**暂停 / 手动刷新。** 头部在 Full stop 左边多了 `⏸ 暂停` / `▶ 继续`
（带 `aria-pressed`）与 `↻ 刷新`。暂停是**把 5 秒轮询整个停掉**
（feed、worker 列表、循环状态一起停），不是把请求藏起来；标签页重新可见也不会
自动恢复轮询 —— 只有再点一次「继续」。暂停期间头部显示弱化的
「已暂停自动刷新」（标签页仅仅不可见时不显示这句，那不是暂停）。
`↻ 刷新` 只手动拉取一次，不改变暂停开关。

**ETag 条件刷新。** `GET /supervisor/feed` 现在返回强校验器 `etag`：把 `.agi/`
下被读取的每个文件（`GOAL.md`、`GOAL_AMENDMENTS.md`、`NOTES.md`、
`MISSION_REPORT.md`、`progress.jsonl`、`questions.jsonl`、`CHANGELOG.jsonl`、
`config.json`）加上每个 `subagents/<id>/outcome.md` 的
`mtimeMs:size` 串起来做 SHA-1，**只 stat 不读内容**，所以一次条件轮询的代价
与文件大小无关。客户端下一次轮询带 `if-none-match`，命中则返回 `304` 空响应，
连文档组装都省掉；`200` 的 JSON 形状与原来逐字节一致，
`cache-control: no-store` 保留，`HEAD` 非条件请求仍是 `200` + `etag` + 无 body，
`400/404` 路径不变（不产生 etag）。`if-none-match` 接受字符串或数组，
会剥掉 `W/` 弱前缀、按逗号拆分。
头部的时间标签随之改成「N 秒前 检查」（最后一次轮询完成的时刻，200 或 304），
并在 304 时追加弱化的「· 内容无变化」—— 原来那句「N 秒前 更新」读的是
`generatedAt`，一旦开始条件刷新就不再前进，继续说它就是撒谎。
指纹是 stat 级的：同一文件在同一毫秒内被改成同样大小的内容不会被发现，
下一次真实变化时会自动纠正。

### 结果归属（0.10.9）：`outcome.md` 头行二次匹配

worker 卡片把 `outcome.md` 挂回它自己那一行，原来靠的是「产物目录名 ==
worker session id」。可目录名是人造的（`ui-polish-0107`），标签命名的产物
因此永远掉进「历史结果」。0.10.9 起产物自己声明归属：host 侧只读每个
`subagents/<dir>/outcome.md` 的**前 512 字节**（正文仍只保留末尾 64KB，
头必须单独读，不能指望 `outcome.text`），解析**前三行**里的一条机器可读头：

```
<!-- worker: <session id> -->
worker: <session id>
```

两种写法都收：键名大小写不敏感、两侧空白随意、id 两侧可带引号或反引号。
id 本身必须匹配 `[A-Za-z0-9._:-]+`，否则该头按不存在处理
（`workerId: null`）；放到第 4 行及以后同样不生效。

匹配顺序：**目录名仍是主键**（`feed.subagents[].name`，也就是该 worker 的
artifact 目录），`workerId` 只是**二次匹配**。Feed 先在还没被认领的产物里找
声明了这个 id 的那份，再退回目录名相同的那份，并且每份产物最多被一行认领，
所以同一份结果不会在两行下面各渲染一次；没被任何行认领的才进下方的
「历史结果」。worker 行「结果」折叠标题的悬停提示给出该 artifact 目录名。
这条头由 `subagent` 工具的描述强制要求，监督者必须在每份 worker prompt 里
写明；没写头的标签命名目录仍然只是进兜底区，不会误挂。

### Full stop（完全停止：监督动态 Feed 头部的按钮）

原生停止方块只会中止当前回合 —— 监督者的
巡检提醒是持久的 schedule 事件（存在宿主 domain 表里，不是日志），因此
agent 几分钟后会自行再次运行。监督动态 Feed 头部的 **■ Full stop**
按钮才真正终结它。从某个 worker 的监督动态 Feed 出发，它会沿继承链回溯到
根 `main-agent`；如果那个监督者已冷，宿主侧的 `/supervisor/stop`
用 Harness 自己的 `sessionController.resolveAgent` 把它恢复（预设组合、
blank 规则、写入者归属都由控制器负责），但不启动回合 ——
浏览器不再自己发任何恢复 RPC。
随后 `POST /supervisor/stop?session=…` 会中止活跃回合、等待空闲，并
递归释放每个常驻的可续行 worker 分支；它在折叠前冲刷，
并在 agent 的独占维护窗口内删除**每一条**活跃的 schedule 提醒，
随后再执行第二次持久化冲刷。对同一路由发 `GET` 会核验回合、
提醒与 worker，因此一次成功的停止即使页面刷新后，
也会把按钮替换为已停止状态。之后的手动提示会显式恢复监督者；
被停止的 worker 会话仍留在历史中，
但不会再运行，也不会唤醒它。

在找 **Shots** 标签页（基于浏览器守护进程的
`<workspace>/shots/` 数据源的截图播放器）吗？那是它自己独立的插件 **`dsh-shots`** ——
通用的浏览器守护进程工具，刻意不属于监督者的一部分。

## 本仓库内容

| 路径 | 内容 |
|---|---|
| `package.json` + `cordis.patch.yml` + `lib/` | dsh bundle：manifest（`dsh.bundle.patch` + `dsh.client`）、插入的行、setup/六个宿主路由、非阻塞原生目标前端、最终收敛诊断，以及浏览器那一半（`lib/client.js`：监督动态 Feed 标签页、Full stop、设置卡片）。`lib/supervise.js` 是跨模式监督层（四行替换 + `isSupervised` / `countSupervisorRows`），`lib/preset-files.js` 改注册式 preset 的 `agent.cordis.yml`，`lib/watchdog.js` 与 `lib/loop-policy.js` 是服务端兜底（补提醒、自适应唤醒、worker 停滞、派生预算、空转收尾、目标复核），`lib/loop-journal.js` 负责把循环状态、事件与每轮摘要落到 `.agi/`（`loop-state.json` / `progress.jsonl` / `BRIEF.md`），`lib/checks.js` 是 worker 验收清单的读取与执行（纯函数，不碰 `ctx`，所以测试不依赖 `node_modules`）、`lib/checks-tool.js` 注册 `check_outcome`，`lib/report.js` 读 worker 的 report 六态头行并产出带 `archived` 标记的列表、`lib/stage.js` 把「report + 是否在跑 + 有无待答 + 是否归档」判成结构化 stage、`lib/outbox.js` 是收敛通知的投递账本（入队 / 退避 / 同类保序 / 已投递标记），`lib/spawn.js` / `lib/control.js` / `lib/goal.js` 是 preset 行指向的三个前端 |
| `prompts/` | 两段人格的**源文件**：`main-agent.md`（主 Agent）与 `worker.md`（worker），外加 `CHANGELOG.md` 记录每次 revision。`agent-presets/main-agent/agent.cordis.yml` 里的两个块标量是**生成物**，由 `scripts/sync-prompts.mjs` 单向写回 —— 改人格改这里，不要改 YAML |
| `agent-presets/main-agent/` | 监督者 preset：人格（打底、非阻塞目标设置、循环、提问）、插件自有的目标前端，以及唯一受 settings 保护的 `subagent` worker 行 |
| `presets/main-agent.patch.yml` | 声明 `main-agent` preset 的 bundle patch；由 `scripts/sync-preset-patch.mjs` 从 `agent-presets/main-agent/` 生成（`npm test` 校验两者同步） |
| `agi-template/` | 新工作区的 `.agi/config.json` 模板 |
| `tutorial/` | 自包含的 15 步课程应用：HTML/CSS/JS、安装/服务器、私有依赖、评分 UI/CLI、里程碑评分器与可选的无头驱动器 |
| `scripts/install-manual.sh` | 非 bundle 的兜底安装器：只写 `.agent-presets/main-agent/` 与工作区 `.agi/` 骨架，**不碰** profile 的 `cordis.patch.yml`（0.13.4 起 schedule 服务归 host 层，重复声明会撞注册） |
| `scripts/repair-profile.mjs` | profile 离线修复工具：诊断/清理重复的 `preset-main-agent` 声明、本 bundle 在用户层 patch 里的行、残留依赖与 node_modules、preset 目录，并诊断 `package.json`/`pnpm-lock.yaml` 版本漂移与 pnpm 冷静期（见「升级与卸载」） |
| `scripts/install-spec.mjs` | 安装地址规范化器：把浏览器地址栏复制的裸 URL 补成 `.git` 结尾的 git spec（也收尾斜杠、`/tree/…` 页面地址），并把 `ERR_PNPM_TARBALL_EXTRACT` 日志反查成该用的地址（见「若 pnpm 报 `ERR_PNPM_TARBALL_EXTRACT`」） |
| `scripts/sync-preset-patch.mjs` | 从 `agent-presets/main-agent/` 重新生成 `presets/main-agent.patch.yml`（`npm run sync-preset`，`prepack` 也会跑） |
| `scripts/sync-prompts.mjs` | 把 `prompts/*.md` 单向写回 `agent-presets/main-agent/agent.cordis.yml` 的两个块标量，并把 revision（两份 md 的 sha256 前 8 位）盖到 patch 头行与 `prompts/CHANGELOG.md`。`--stamp` 只盖章、不碰 YAML —— 因为 patch 由生成器整份重写，revision 只能在生成**之后**才盖得住，所以 `sync-preset` 是三步而不是两步 |
| `scripts/sync-profile.mjs` | 把仓库同步到运行时**真正加载的两份拷贝**：profile 的 `node_modules/dsh-main-agent/`（宿主 `require` 这份）与 `~/.dsh/.agent-presets/main-agent/`（宿主启动时读这份 preset，`installPreset` 默认 `if-absent`，**已存在就永不覆盖**）。默认只诊断并列差异，`--apply` 才写、且先整目录备份。只同步其中一份，是「改完代码重启也没变化」的典型死法 |
| `scripts/accept-worker.mjs` | `npm run accept -- <sessionId 或目录名> [备注]`：写 `.agi/subagents/<id>/archived.json`，把已验收的 worker 从 BRIEF 的「等用户验收」里摘掉，改显示 `ended/archived — 已验收归档` |
| `scripts/inject-supervisor.mjs` | 命令行版的「跨模式」：把监督层写进 profile patch 的 preset 行快照（`--target <preset> --write` / `--dry-run` / `--revert`） |
| `tests/` | 35 个 `node --test` 文件、388 项断言：preset 行与 patch 同步、settings 卡片、feed/stop 路由、跨模式叠加与文件改写、preset 开关状态（`pendingRestart` / `mounted`）、worker 模型策略、worker 验收（`checks.json` / `check_outcome`）、worker report 六态与 stage 分类、outbox 退避与同类保序、备份保留与 loop-state 清理、`prompts/*.md` 与 YAML 块标量的逐字节相等与写回幂等、install-spec、repair-profile 等 |
| `DESIGN.md` / `IMPLEMENTATION_PLAN.md` | 设计记录（Q1–Q23、A1–A6、S1–S4、N1–N23、G1）与 v2 计划 |

## 评分

```sh
./tutorial/grade.sh all --ws ~/agi-lab    # m0–m6 report with bar chart
./tutorial/grade.sh m7 --ws ~/agi-acceptance  # m7 会先在验收工作区重跑 m2–m5，再做验收 + 重启证据
./tutorial/grade.sh doctor                # what the grader can see

# dsh web 带令牌启动时（启动行里的 ?token=…），把令牌也交给评分器 ——
# 否则 m6 的 HTTP 检查读到的是未认证的 401，而不是真实结果：
./tutorial/grade.sh m6 --token <t>        # 或 DSH_TOKEN=<t>
                                          # 或 DSH_URL="http://127.0.0.1:3080/?token=<t>"
```

评分器只读取持久产物（preset 文件、patch/bundle 行、`.agi/`、会话
事件日志）—— 不会在你的 agent 里执行任何东西。`tutorial/GRADING.md` 记录了每一项
检查。

## 无头驱动（可选）

```sh
S=$(python3 tutorial/drive.py create --cwd ~/agi-lab)       # new supervisor session
python3 tutorial/drive.py send "$S" "your mission here"     # prompt + wait + tail
python3 tutorial/drive.py tail "$S"                          # readable event tail
python3 tutorial/drive.py wait "$S" --timeout 1800           # block until the turn ends
python3 tutorial/drive.py watch "$S"                         # follow events live
```

## 从零学起

运行 `./tutorial/setup.sh` 并打开它打印的 URL。第一部分从零讲授 Cordis 与 harness（不预设
TypeScript 基础）；第二部分逐个里程碑构建本仓库中的所有内容，
每个里程碑都配有实测与评分器；第三部分讲解打包插件扩展 ——
正是本仓库采用的模式 —— 以及故障排查。

## 发布与插件生态

这个包如何触达其他人，按投入从低到高排列：

1. **GitHub + `dsh-plugin` 主题。** 给仓库打上
   [`dsh-plugin`](https://github.com/topics/dsh-plugin) 主题（harness README 的
   官方可发现性渠道），并写一行简洁的仓库描述 ——
   社区索引抓取的就是这一行。用户随后直接从 git 安装：
   `dsh plugin --profile web add "github:you/dsh-main-agent"`。
2. **聚合器会自动收录**：awesome-list
   （例如 `vvlife/awesome-deepseek-harness-plugins` 每天从该主题重新生成其 `PLUGINS.md`）
   与主题驱动的市场（例如 WhaleHub，一个带一键安装命令的可视化市场）。
   向精选列表提 PR 可以增加人工收录位置。
3. **发布到 npm**（可选）：`dsh plugin` 会转发给 pnpm，因此已发布的包
   可按名称安装。`package.json` 中的 `files` 列表已限定发布内容
   （`lib`、`cordis.patch.yml`、`presets`、`agent-presets`、`prompts`、`agi-template`、`scripts`）。

以下是随包发布 preset 的插件的打包经验（0.2.x 实测）：

- **preset 只能由 patch 里的声明行注册。** 0.2.x 的 agent-preset 注册表
  既不扫描 `${DSH_HOME}/.agent-presets/` 目录，也不接受部署配置的
  preset 路径；`dsh-agent-presets` 的 Config 只保留 `default` 与
  `selectedDefault`。声明行形如 `- id: preset-x` +
  `name: '@deepseek-ai/dsh-agent-preset'` + `config.plugins`，而
  `dsh.bundle.patch` 可以是**文件路径数组** —— 本仓库就是这样同时发出
  `cordis.patch.yml`（host 层）与 `presets/main-agent.patch.yml`（preset 声明）。
- **坏掉的 preset 不会报错，只会消失。** 声明行解析或挂载失败时，注册表
  把它留在花名册里但带上 `broken`，而新会话选择器会过滤掉所有带
  `broken` 的项；只有在 Settings → 智能体预设 里才会看到「加载失败」
  卡片。所以「装好了但选择器里没有」要先去那里看原因。
- **重复的声明行不会报错、也不会去重。** 如果这个 profile 还手工挂着
  `@local/dsh-main-agent-preset` 之类的 preset bundle（桌面 profile 早期常这样挂过，
  因为它要绕过当时找不到 preset 的问题），就会同时存在**两条**指向同一个 preset id 的
  声明行；后一层获胜，于是选择器里的文案安静地变成另一份。本仓库的安装是自足的，
  装之前请把这类手工 bundle 从 profile 依赖里摘掉。
- **启动时复制到 `${DSH_HOME}/.agent-presets/` 只是旧版兼容路径**：保留它
  不伤 0.2.x（目录被忽略），也让旧版 dsh 仍然能用。
- **0.2.x 的两个字段陷阱**（都表现为整个 preset broken）：
  `dsh-persona` 的 `text` 字段已被 `prefix`（必填）+ `suffix` 取代；
  workflow 引擎包名是 `@deepseek-ai/dsh-workflow-ptc`
  （`@deepseek-ai/dsh-workflow-worker-thread` 在 0.2.x 不存在）。

## 安全须知

- 监督者协议大多仍是文字约定加审计，但目标创建与 worker 模型
  路由由插件自有的前端强制执行。阅读 `.agi/CHANGELOG.jsonl` ——
  它是每一次派生/纠偏/终止/假设的日记。
- 在带有真实凭据的无人值守任务之前，请刻意确定沙箱/审批姿态
  （本实验环境运行在 `danger-full-access`）。
- 每个 `$DSH_HOME` 永远只跑一个 dsh。绝不编辑随包发布的 preset 或 harness 检出目录。
