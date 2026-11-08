# `.agi/` 状态文件归属表

每个状态文件只该有一个**写者模块**。这里登记的是事实，不是愿望：写者一列的模块必须
真的在源码里出现过这个文件名。`tests/state-ownership.test.mjs` 会解析这张表并双向核对
——新增状态文件却忘了登记，那条测试就会红。

## 插件写的状态文件

| 状态文件 | 唯一写者模块 | 读者 | 备注 |
| --- | --- | --- | --- |
| `.agi/loop-state*.json` | `lib/loop-journal.js` | `lib/watchdog.js`、`lib/index.js` | `writeLoopState` 是唯一写入口，整份覆盖写；触发方是 watchdog 的 `reconcileLoop`。 |
| `.agi/BRIEF.md` | `lib/loop-journal.js` | 模型（每轮读）、`lib/index.js` | `writeBrief` 整份覆盖写；写盘失败时对每条待投递 entry 记一次投递失败。 |
| `.agi/outbox.jsonl` | `lib/outbox.js` | `lib/loop-journal.js`（渲染待投递）、`lib/watchdog.js`（投递失败事实） | 读-改-写、整份重写；`enqueue` / `markDelivered` / `markFailed` 都在 `.agi/outbox.lock` 里做。 |
| `.agi/GOAL.md` | `lib/goal.js` | `lib/index.js`、`lib/client.js` | 目标生命周期文件；范围变更走 `GOAL_AMENDMENTS.md`。 |
| `.agi/CHANGELOG.jsonl` | `lib/index.js` | `lib/index.js`（Feed） | append-only。 |
| `.agi/progress.jsonl` | `lib/index.js`、`lib/loop-journal.js` | `lib/watchdog.js`、`lib/index.js` | append-only：多写者安全，所以这里登记的「唯一写者」不成立，也不需要有锁。 |
| `.agi/questions.jsonl` | `lib/index.js` | `lib/index.js`、`lib/watchdog.js` | append-only；watchdog 只读它数「还有几个问题没答」。 |
| `.agi/proposals.jsonl` | `lib/spawn.js` | `lib/index.js` | append-only。 |
| `.agi/LESSONS.md` | —（收尾时由 agent 自己用 `write` 追加） | `lib/loop-journal.js`（`readLessons`） | 文件名常量在 `lib/loop-journal.js`，插件只读不写。 |
| `.agi/subagents/<id>/outcome.md` | —（worker 自己写） | `lib/report.js`、`lib/index.js` | 每个 worker 一份，报告正文。 |
| `.agi/subagents/<id>/report.json` | —（worker 自己写） | `lib/report.js` | 结构化 report（`state` / `question`）。 |
| `.agi/subagents/<id>/archived.json` | `lib/report.js` | `lib/report.js`、`lib/loop-journal.js` | Lead 验收记录，`archiveWorker` 写；它把 `person/review` 压成「已验收归档」。 |
| `.agi/subagents/<id>/checks.json` | —（worker 自己写） | `lib/checks.js`、`lib/checks-tool.js` | 验收清单；插件只跑、只读。 |
| `.agi/subagents/<id>/expect.json` | `lib/checks.js`（`writeExpect`） | `lib/checks-tool.js`、`lib/loop-journal.js`、`lib/spawn.js` | 派发时由 Lead 写下、worker 只读：验收标准在这一刻就固定，worker 改不了它。整份覆盖写，写者只有 spawn 的一次派发。 |

## 非插件写（插件只读）

| 状态文件 | 唯一写者模块 | 读者 | 备注 |
| --- | --- | --- | --- |
| `.agi/config.json` | —（用户所有，插件只读） | `lib/index.js` | 改它必须由用户来；插件只能提议。 |
| `.agi/GOAL_AMENDMENTS.md` | —（agent / 用户写） | `lib/index.js` | 目标锁定期间的纠偏记录。 |
| `.agi/NOTES.md` | —（agent 写） | `lib/index.js` | 打底笔记。 |
| `.agi/MISSION_REPORT.md` | —（agent 写） | `lib/index.js` | 收尾报告。 |

## 为什么只给覆盖写的文件登记唯一写者

有竞态的是**整份覆盖写**：读全量、改一处、把整份写回去。两个写者同时做这件事时，
后写的那个会把前一个的改动整段丢掉，而 `rename` 只能保证「单个写者不会写出半个
文件」，保证不了「两个写者不互相覆盖」。所以 `loop-state*.json`、`BRIEF.md`、
`outbox.jsonl`、`archived.json` 必须有唯一写者；`outbox.jsonl` 还额外加了文件锁，
因为它的写者是同一个模块但可能来自多个进程（pre-step、`writeBrief`、`settlement`）。

append-only 的文件（`progress.jsonl`、`questions.jsonl`、`CHANGELOG.jsonl`、
`proposals.jsonl`）没有这个问题：一行一次 `append`，写者之间不覆盖，读的人最多
看到「少一行」或者「多一行还没轮到」，都不会把别人的记录抹掉。给它们强加一个
「唯一写者」既做不到（多个入口都该能记一笔），也没有必要。

worker 自己写的文件（`outcome.md`、`report.json`、`checks.json`）同理：一个目录
只属于一个 worker，并发只会来自它自己。

`expect.json` 是这条规矩的反面：它**只有监督者写**，worker 只读。写它的时机是派发
那一刻，所以整份覆盖写没有第二个写者 —— 这也是它为什么能当验收标准：worker 改不了
自己的题目。
