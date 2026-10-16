# 监督者课程的里程碑评分器

每个里程碑一条命令，在完成该章的“实机验证”小框之后运行：

推荐的入口是嵌在每个教程里程碑小框里的 <strong>运行评分器</strong> 按钮 ——
当课程是用 `./tutorial/setup.sh` 启动的时候。下面是等价的命令行版本：

```sh
"$HOME/src/dsh-supervisor/tutorial/grade.sh" m1
"$HOME/src/dsh-supervisor/tutorial/grade.sh" m4 --ws "$HOME/agi-lab"
"$HOME/src/dsh-supervisor/tutorial/grade.sh" all
"$HOME/src/dsh-supervisor/tutorial/grade.sh" m7
"$HOME/src/dsh-supervisor/tutorial/grade.sh" doctor
```

| 里程碑 | 章节 | 评的是什么 |
|---|---|---|
| m0 | 4  | dsh 在跑、web UI 起来了、profile patch 能解析、工作区存在 |
| m1 | 6  | preset 文件、persona 行、唯一由插件拥有的 `subagent` 行（只走设置的模型策略，且显式写了 `runtime/current`、worker persona、分组位置）、会话已挂载 |
| m2 | 7  | `.agi/` 骨架、配置键、persona 里全部协议标记、GOAL.md、插件拥有的非阻塞 `start_goal` 调用、JSONL 合法性、修订纪律 |
| m3 | 8  | 已装 bundle 或手工 patch 里有 schedule 行、`schedule_create` 被调用过、提醒真的送达、有一条 `assumed` 状态的提问 |
| m4 | 9  | 子会话的父级是这个监督者；有 spawn/steer/kill 调用；有 `subagent-settled` 与 `subagent-report` 消息；有一个子级发来的 `report`；有 `outcome.md` |
| m5 | 10 | CHANGELOG 覆盖了 spawn+steer+kill、假设有记录、NOTES 里有结论、progress 动态有更新、交付物在、≥2 个 worker、定时器卫生 |
| m6 | 11 | 打包的监督动态 Feed client、已伺服的 bundle 与 feed 路由 |
| m7 | 12 | 重启后的恢复标记、完成之后再追加一次修订 —— 外加在验收工作区上重跑 m2–m5 |

## 它是怎么工作的

评分只看持久产物 —— 不在你的 agent 里执行任何东西，
也不改动任何东西：

- **Preset 与 patch**：从 `~/.dsh/.agent-presets/main-agent/`（兼容副本）和
  `~/.dsh/profiles/web/cordis.patch.yml` 里解析出来（YAML 加载器能容忍 `!!js` 标签）。
  注意那里读到的只是**兼容副本**：在 0.2.x 上 preset 是否真的出现在挑选器里，
  由 bundle patch 里 `presets/main-agent.patch.yml` 的 `preset-main-agent`
  （`@deepseek-ai/dsh-agent-preset`）声明行决定，`$DSH_HOME/.agent-presets/` 目录
  已经不再被宿主读取。
- **行为**：从会话事件日志里读
  （`~/.dsh/sessions/<workspace>/<session>/session.jsonl.zstd`，有系统 CLI 就用系统 CLI 解压，
  否则用教程自带的私有 Python 解码器；写到一半的活动日志也能处理）。工具调用靠
  `tool/call` 事件的 `data.name` 匹配；settle/report/schedule 唤醒靠消息里的
  `source.kind` 匹配。
- **状态**：你工作区里的 `.agi/` 文件。

评分：PASS = 1，WARN = 0.5（证据偏弱或不完整 —— 读一下它给的提示），FAIL = 0。
MANUAL 行是提醒你：有些东西只有人能判断（视觉效果、对话记录的质量）；
它们从不影响分数。里程碑在 ≥ 90% 时算“通过”，这个值同时也是
进程退出码（0/1），所以你可以在脚本里把它串起来用。

依赖：Python 3 加上 PyYAML，以及 `zstd` CLI 或 Python 的
`zstandard` 二选一。`./tutorial/setup.sh` 会在一个独立的 venv 里把这两个 Python 包装好。

## 老实说的局限

- 评分器证明的是*证据存在*，不是说它做得好。它能看见
  `send_message` 被调用了；这次纠偏合不合理，得你自己读对话记录来判断。
  MANUAL 行标的就是这些地方。
- m1 那条“第二个会话能干净挂载”是个替身判据（存在两个会话目录），不是真的
  领域冲突测试 —— `standingKeyFor` 只能在运行时内部调用
  （第 6 章的第 4 步才是正规做法）。
- m3 那条“提醒真的送达”会去找来自 schedule 的消息，或者该章脚本里那个字面量
  `patience-test` 提示词；如果你用的是自定义提示词，它可能会 WARN，那就得自己手动读
  `--ws` 那个工作区的日志。
- 日志是在工作区的**所有**会话里扫的，所以一条检查一旦过了
  就会一直算过（证据只追加）。想要一张白纸，就用一个全新的工作区（`--ws`）——
  第 12 章用 `$HOME/agi-acceptance` 干的正是这件事。
