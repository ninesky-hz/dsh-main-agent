# dsh-main-agent — 面向 DeepSeek Harness 的常驻监督者 Agent

7×24 小时在线的 **Main Agent**：先记录一个可审阅的目标，然后无人值守地循环：派生开发
子代理 → 休眠 → 因收敛 / 报告 / 定时器 / 你的消息而唤醒 → 巡检 → 纠偏、
终止或继续。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）以 **原生优先** 方式构建：核心就是一个 agent preset、一份人格、一行
schedule 服务配置 —— 零自研循环机制。本仓库**就是一个可安装的 dsh 插件包**：一条命令即可把
整套配置装到任何运行 dsh 的机器上。

已在 `glm-5.3`（Z.AI）上端到端实测：目标设置、有打底的委派、飞行中
纠偏、回合中途终止 + 更严密的重新派生、静默提问 → 记录假设
流程、交付物核验（它抓到了自己那个有 bug 的链接检查器并重跑），
以及整进程重启后恢复。评分结果：m0–m5 与 m7 均为 100%。

## dsh 0.2.0 兼容性

本仓库源自 `n-sky/dsh-supervisor`，自 **0.10.0** 起改名为 **`dsh-main-agent`** 并迁到
`https://gitee.com/n-sky/dsh-main-agent.git`（旧仓库保留 0.9.4 及其以前的版本）。
它承载了向 **dsh 0.2.0-rc.2** 的移植：

- 设置遵循逐行 `Config` 模型 —— `export const Config` 配合 `.volatile()` 字段，
  不再有 `installSettingsSection` / `settingsNamespace`（二者均已在上游移除）；值是实时
  引用，通过 `config.*.get()` 读取，修改由 `loader/volatile-update` 拾取；
- 设置卡片通过 `configForms` 注册进 **`plugins.item`** 槽位
  （`ctx.configForms.get(<entry id>)` + `whileServed` + `scope.mutate`），取代 `settingsScope`
  与旧的 `settings.plugin.item` 槽位；
- worker 消息使用 `subagents.sendMessage`（`followup` 别名已移除），worker
  活动状态读作 `running` / `inactive`。

已针对 dsh `0.2.0-rc.2` 验证：51/51 单元测试、完整 profile 的 `--dump-config` 组合成功，
以及同一 profile 的实机启动，其 `/supervisor/models` 路由返回 `200`。

`DESIGN.md`、`IMPLEMENTATION_PLAN.md` 与 `tutorial/` 课程作为原始设计
记录保留：当它们提到 `installSettingsSection`、`settingsNamespace`、`followup`、
`settings.plugin.item`，或 worker 活动状态为 `active` 时，请按上表理解。

## 在新 PC 上运行本地课程

安装 Git 与 Python 3，克隆本仓库，然后运行它的课程启动器：

```sh
mkdir -p "$HOME/src"
git clone https://github.com/dat-lequoc/dsh-supervisor.git "$HOME/src/dsh-supervisor"
cd "$HOME/src/dsh-supervisor"
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
cd "$HOME/src/dsh-supervisor"
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

1. 挂载监督者定时器所需的 schedule 服务（`dsh-schedule`，声明在
   `patches/schedule.patch.yml`）。这一行**自带守卫**：启动时它会检查
   loader 里是否已有别的 `@deepseek-ai/dsh-schedule` 提供者，有就
   **自动让位**（禁用自己），因此默认安装**不再需要**你在 profile 里
   手写任何 patch —— 即使你的 profile 已经通过
   `@deepseek-ai/dsh-experimental-schedule-bundle` 挂了 schedule。
   边界：守卫只能看见**排在它之前**的 loader 行，所以「提供 schedule 的
   bundle 必须列在 `dsh-main-agent` 之前」是本机制的前提（默认组合
   满足）；若你在**自己 profile 的 `cordis.patch.yml`** 里声明 schedule
   行，它排在本 bundle **之后**、守卫看不到它，此时仍请在 profile 里
   保留 id 级 `- id: agi-schedule` / `disabled: true`（写了也无害）。
   （不挂 `dsh-time-context` —— 它会往每个请求注入时间戳块，
   而 Schedule 不依赖它）；
2. 通过 `presets/main-agent.patch.yml`（`dsh.bundle.patch` 里的最后一份 patch）
   向 agent-preset 注册表**声明**随包的 **`main-agent` preset** —— 这是 0.2.x
   唯一被读取的注册路径，`dsh plugin add` 后重启即可在选择器里看到
   「Main Agent（监督者）」，以及
3. 运行本包的 setup 插件（`lib/index.js`），它把随包携带的
   **`main-agent` preset** 安装到 `${DSH_HOME:-~/.dsh}/.agent-presets/` —— 仅在缺失时安装，
   绝不覆盖你的修改（行配置 `syncPreset: always | if-absent | never`）。

然后为监督者的状态创建一个工作区：

```sh
mkdir -p "$HOME/agi-lab/.agi/subagents"
cp "$HOME/src/dsh-supervisor/agi-template/config.json" "$HOME/agi-lab/.agi/config.json"
```

<details>
<summary>替代方案：不用插件管理器的手动安装</summary>

`./scripts/install-manual.sh ~/agi-lab` 则会把 preset 复制到用户 preset 根目录，
并把 schedule 行写进你 profile 的 `cordis.patch.yml`。只选
一条路径，不要两条都用 —— schedule 服务每进程只注册一次，因此 bundle 行
与手动 patch 行不能共存。如果你的 profile 已从别处挂载
`dsh-schedule`（**且那份提供者来自排在 `dsh-main-agent` 之前的 bundle**），
本 bundle 里的 `agi-schedule` 行会**自己让位**，你什么都不用做。
历史写法 —— 针对 id 的 `- id: agi-schedule` / `disabled: true` ——
**不再需要**；已经写过的 profile **保留也安全**（等效于手动兜底，
不会与守卫冲突），不必回退。
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

用户所有的旋钮位于 `<workspace>/.agi/config.json`（agent 可以提议修改，但
绝不直接编辑它）：`wakeMinutes`（巡检节奏，≥ 5 —— schedule 的下限）与
`questionWaitMinutes`（在记录假设并继续之前等待答复的时长）。

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
| `wakeMinutes` | 监督者隔多久醒来巡检运行中的 worker（分钟；周期性提醒，≥ 5） | 下一回合（实时） |
| `questionWaitMinutes` | 监督者等待问题答复的时长；超时后记录一个假设并继续 | 下一回合（实时） |

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

## 监督动态 Feed 标签页

每个会话的视图环（承载 **Chat** 与 **Trajectory** 的标签页）会多出一个
**监督动态 Feed** 条目：对于带 `.agi/` 状态的工作区，它一眼展示整次运行 ——
实时目标卡片、worker（含 `outcome.md`）、进度时间线、提问
栈、动作变更日志、笔记与任务报告，每约 5 秒刷新一次。
它作为持久客户端插件随本 bundle 发布（`lib/client.js`，通过
harness 的 client-modules 扫描提供），外加一个宿主路由（`GET /supervisor/feed?ws=…`）
读取 `.agi/` 目录树。无需重建前端，无需动态插件审批。

### Full stop（完全停止：监督动态 Feed 头部的按钮）

原生停止方块只会中止当前回合 —— 监督者的周期性
巡检提醒（`wakeMinutes`，下限 5 分钟）是持久的 schedule 事件，因此
agent 几分钟后会自行再次运行。监督动态 Feed 头部的 **■ Full stop**
按钮才真正终结它。从某个 worker 的监督动态 Feed 出发，它会沿继承链回溯到
根 `main-agent`；如果那个监督者已冷，浏览器会先通过 Harness 既有的
同 id `session.create` 路径把它恢复，但不启动回合。
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
| `package.json` + `cordis.patch.yml` + `lib/` | dsh bundle：manifest（`dsh.bundle.patch` + `dsh.client`）、插入的行、setup/路由、非阻塞原生目标前端、最终收敛诊断，以及浏览器那一半（`lib/client.js`：监督动态 Feed 标签页、Full stop、设置卡片） |
| `agent-presets/main-agent/` | 监督者 preset：人格（打底、非阻塞目标设置、循环、提问）、插件自有的目标前端，以及唯一受 settings 保护的 `subagent` worker 行 |
| `patches/schedule.patch.yml` | 声明随包 schedule 行（`agi-schedule`）的 bundle patch，自带 `disabled: !!js` 自判定守卫：组合里已有别的 `@deepseek-ai/dsh-schedule` 提供者时本行自动让位。`dsh.bundle.patch` 里排在 preset 声明之前 |
| `presets/main-agent.patch.yml` | 声明 `main-agent` preset 的 bundle patch；由 `scripts/sync-preset-patch.mjs` 从 `agent-presets/main-agent/` 生成（`npm test` 校验两者同步） |
| `agi-template/` | 新工作区的 `.agi/config.json` 模板 |
| `tutorial/` | 自包含的 15 步课程应用：HTML/CSS/JS、安装/服务器、私有依赖、评分 UI/CLI、里程碑评分器与可选的无头驱动器 |
| `scripts/install-manual.sh` | 非 bundle 的兜底安装器 |
| `DESIGN.md` / `IMPLEMENTATION_PLAN.md` | 设计记录（Q1–Q23、A1–A6、S1–S4、N1–N7、G1）与 v2 计划 |

## 评分

```sh
./tutorial/grade.sh all --ws ~/agi-lab    # m0–m6 report with bar chart
./tutorial/grade.sh m7 --ws ~/agi-acceptance  # acceptance + restart evidence
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
   （`lib`、`cordis.patch.yml`、`patches`、`presets`、`agent-presets`、`agi-template`、`scripts`）。

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
