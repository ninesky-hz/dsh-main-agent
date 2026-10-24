# dsh-main-agent — 面向 DeepSeek Harness 的常驻监督者 Agent

7×24 小时在线的 **Main Agent**：先记录一个可审阅的目标，然后无人值守地循环：派生开发
子代理 → 休眠 → 因收敛 / 报告 / 定时器 / 你的消息而唤醒 → 巡检 → 纠偏、
终止或继续。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）以 **原生优先** 方式构建：核心就是一个 agent preset、一份人格、以及对
原生 schedule 工具的直接复用 —— 零自研循环机制。本仓库**就是一个可安装的 dsh 插件包**：
一条命令即可把整套配置装到任何运行 dsh 的机器上。

已在 `glm-5.3`（Z.AI）上端到端实测：目标设置、有打底的委派、飞行中
纠偏、回合中途终止 + 更严密的重新派生、静默提问 → 记录假设
流程、交付物核验（它抓到了自己那个有 bug 的链接检查器并重跑），
以及整进程重启后恢复。评分结果：m0–m5 与 m7 均为 100%。

## dsh 0.2.x 兼容性

本仓库源自 `n-sky/dsh-supervisor`，自 **0.10.0** 起改名为 **`dsh-main-agent`** 并迁到
`https://gitee.com/n-sky/dsh-main-agent.git`（旧仓库保留 0.9.4 及其以前的版本）。
它承载了向 **dsh 0.2.x**（0.2.0-rc.2 起，现验证到 0.2.1-rc.2）的移植：

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

本仓库的 **203 项**单元测试（`tests/` 下 21 个 `.test.mjs`）在 dsh `0.2.1-rc.2` 上跑出
**194 通过 / 9 按平台跳过 / 0 失败**（`npm test` = `node --test tests/*.test.mjs`）；
0.2.0-rc.2 上还做过完整 profile 的 `--dump-config` 组合与实机启动验证
（`/supervisor/models` 返回 `200`）。`peerDependencies` 里 `@deepseek-ai/dsh-subagent`
的区间是 `>=0.2.1-rc.2 <0.3.0` —— 更早的宿主没有 `ctx.subagents` 的 0.2.x 方法。

`DESIGN.md`、`IMPLEMENTATION_PLAN.md` 与 `tutorial/` 课程作为原始设计
记录保留：当它们提到 `installSettingsSection`、`settingsNamespace`、`followup`、
`settings.plugin.item`，或 worker 活动状态为 `active` 时，请按上表理解。

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
   「Main Agent（监督者）」；
3. 运行本包的 setup 插件（`lib/index.js`），它把随包携带的
   **`main-agent` preset** 安装到 `${DSH_HOME:-~/.dsh}/.agent-presets/` —— 仅在缺失时安装，
   绝不覆盖你的修改（行配置 `syncPreset: always | if-absent | never`），
4. **对账跨模式勾选**：按设置里的 `supervisedPresets` 把监督层重新叠加到那几条
   preset 的 loader 行上（mount 时一次 + 两次延迟重试，因为 preset 行未必在本插件
   之后挂载）。这一步是幂等的，已在目标状态的 preset 不会触发 `entry.update`，
   也就不会白白重启 fiber。

然后为监督者的状态创建一个工作区：

```sh
mkdir -p "$HOME/agi-lab/.agi/subagents"
cp "$HOME/src/dsh-main-agent/agi-template/config.json" "$HOME/agi-lab/.agi/config.json"
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
   `agi-schedule`、`preset-main-agent`，顶层 override 与 `- insert:` 内嵌行都算，
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

监督循环默认只属于 `main-agent`。若希望 `standard`、`minimal`、`ptc` 这类
preset 也能主动跑循环（而不只是让 Feed 面板可见），在同一张设置卡片里勾选
**启用监督循环的模式** 即可 —— 列表来自 `agentPresets.list()`，一个 preset
对应一个复选框。

这个操作改写的是该 preset 的 loader 行 `plugins`，且只动四行，其余行逐字节不变：

| 行 | 从 | 到 |
|---|---|---|
| `persona.config.prefix` | `""` | 监督者人格（目标 / 状态 / 循环 / 定时器 / 边界） |
| `tool-goal.name` | `@deepseek-ai/dsh-tool-goal` | `dsh-main-agent/goal`（`start_goal`） |
| `tool-subagent-control.name` | `@deepseek-ai/dsh-tool-subagent-control` | `dsh-main-agent/control`（运行中纠偏） |
| `tool-subagent.name` | `@deepseek-ai/dsh-tool-subagent` | `dsh-main-agent/spawn`（强制从白名单选 model） |

`tool-subagent-list-agents` 与 `tool-subagent-fork` 保持官方实现，`disabled`
行、`!!js` 条件与 group 结构都不受影响。`main-agent` 恒为监督者，在列表里
只展示不可勾选。

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
harness 版本就退回「写盘、下次启动生效」，绝不假装成功。卡片据此显示
`✓ 已启用，立即生效` 或 `✓ 已写入磁盘，重启 DSH 后生效`；`GET /supervisor/presets`
里对应的字段是 `fileBacked`（这个 preset 有没有可写的 composition 文件）与
`pendingRestart`（磁盘上是否有待下次启动加载的改动）。

这里是**两层还原**：文件层用 `agent.cordis.yml.supervisor.bak` 覆盖回去（`redteam`
自带 263 字指挥人格，反向剥离会把 persona 清空），内存层用首次见到时
`structuredClone` 下来的原始 `plugins`（baseline），所以来回切换是字节级一致。

少数 preset（如 `unrestricted` 派生的 `unrestricted-child-*`）完全由运行时生成，
既没有 loader 行也没有文件，卡片上标注`由插件在运行时生成，没有可改写的文件`
且不可勾选（`fileBacked: false` 且无 baseline）。

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
| `package.json` + `cordis.patch.yml` + `lib/` | dsh bundle：manifest（`dsh.bundle.patch` + `dsh.client`）、插入的行、setup/六个宿主路由、非阻塞原生目标前端、最终收敛诊断，以及浏览器那一半（`lib/client.js`：监督动态 Feed 标签页、Full stop、设置卡片）。`lib/supervise.js` 是跨模式监督层（四行替换 + `isSupervised` / `countSupervisorRows`），`lib/preset-files.js` 改注册式 preset 的 `agent.cordis.yml`，`lib/spawn.js` / `lib/control.js` / `lib/goal.js` 是 preset 行指向的三个前端 |
| `agent-presets/main-agent/` | 监督者 preset：人格（打底、非阻塞目标设置、循环、提问）、插件自有的目标前端，以及唯一受 settings 保护的 `subagent` worker 行 |
| `patches/schedule.patch.yml` | 声明随包 schedule 行（`agi-schedule`）的 bundle patch，自带 `disabled: !!js` 自判定守卫：组合里已有别的 `@deepseek-ai/dsh-schedule` 提供者时本行自动让位。`dsh.bundle.patch` 里排在 preset 声明之前 |
| `presets/main-agent.patch.yml` | 声明 `main-agent` preset 的 bundle patch；由 `scripts/sync-preset-patch.mjs` 从 `agent-presets/main-agent/` 生成（`npm test` 校验两者同步） |
| `agi-template/` | 新工作区的 `.agi/config.json` 模板 |
| `tutorial/` | 自包含的 15 步课程应用：HTML/CSS/JS、安装/服务器、私有依赖、评分 UI/CLI、里程碑评分器与可选的无头驱动器 |
| `scripts/install-manual.sh` | 非 bundle 的兜底安装器 |
| `scripts/repair-profile.mjs` | profile 离线修复工具：诊断/清理重复的 `preset-main-agent` 声明、本 bundle 在用户层 patch 里的行、残留依赖与 node_modules、preset 目录，并诊断 `package.json`/`pnpm-lock.yaml` 版本漂移与 pnpm 冷静期（见「升级与卸载」） |
| `scripts/install-spec.mjs` | 安装地址规范化器：把浏览器地址栏复制的裸 URL 补成 `.git` 结尾的 git spec（也收尾斜杠、`/tree/…` 页面地址），并把 `ERR_PNPM_TARBALL_EXTRACT` 日志反查成该用的地址（见「若 pnpm 报 `ERR_PNPM_TARBALL_EXTRACT`」） |
| `scripts/sync-preset-patch.mjs` | 从 `agent-presets/main-agent/` 重新生成 `presets/main-agent.patch.yml`（`npm run sync-preset`，`prepack` 也会跑） |
| `scripts/inject-supervisor.mjs` | 命令行版的「跨模式」：把监督层写进 profile patch 的 preset 行快照（`--target <preset> --write` / `--dry-run` / `--revert`） |
| `tests/` | 21 个 `node --test` 文件、203 项断言：preset 行与 patch 同步、settings 卡片、feed/stop 路由、跨模式叠加与文件改写、worker 模型策略、install-spec、repair-profile 等 |
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
