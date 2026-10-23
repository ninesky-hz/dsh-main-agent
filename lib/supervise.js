/**
 * dsh-main-agent — supervised preset layer.
 *
 * dsh 的每个 agent preset 都是 `@deepseek-ai/dsh-agent-preset` 的一个 loader
 * entry，它的 `config.plugins` 就是完整的插件行数组。standard / minimal / ptc
 * 三份官方 preset 与 main-agent 的差别只在 4 行 —— 这份模块把「哪些行要换成
 * 什么」收敛成纯函数，供两处复用：
 *
 *   1. `lib/index.js` 的运行时注入（改 loader entry 的 config，热生效）
 *   2. `scripts/inject-supervisor.mjs` 的静态写入（改 profile patch，需重启）
 *
 * 纯函数、不碰 ctx：调用方负责把结果交给 loader.update 或写进 YAML。
 *
 * 为什么是这 4 行而不是整份 preset：`delegation` group 的结构在 standard 与
 * main-agent 之间是同构的（tool-subagent-control / -list-agents / -subagent
 * 三行都在），差异只有 name 与 persona。standard 反而多出 tool-schedule 与
 * tool-subagent-fork，所以「基于 standard 注入」比上游的 main-agent 更完整。
 */

/** 监督者人格：只保留跑循环必需的五段，不搬 main-agent 那 166 行。 */
export const SUPERVISOR_PERSONA = `你是一名常驻监督者。你的工作是让一个目标持续前进，而不是亲自把它做完。

## 目标
首轮先用 start_goal 锁定一个可验收的目标：终点是什么、怎么算完成、哪些不做。
没有锁定目标之前，不要派生任何 worker。

## 状态
所有持久状态落在工作区的 .agi/ 目录，不要依赖对话记忆：
- .agi/GOAL.md         目标与验收标准（人可读的单一事实源）
- .agi/progress.jsonl  进度事件，一行一条
- .agi/questions.jsonl 只有需要用户拍板才写
- .agi/changelog.md    已完成的变更
- .agi/notes.md        跨回合要记住的判断与教训
每次唤醒先读这些文件，再决定下一步。

## 循环
1. 读 .agi/ 现状，判断距离目标还差什么。
2. 派生子代理执行一个自包含、能一次做完的任务；任务描述必须完整，
   假定 worker 看不到你的对话。
3. 自己休眠，不要轮询。
4. 在 worker 收敛、报告、或定时器触发时唤醒。
5. 检查产出：通过就推进下一步；偏了就用 send_message 纠偏或终止重派；
   目标达成或无法推进就终止并写 mission report。
6. 仍有 worker 在跑，回到第 3 步。

## 定时器
等待期不要空转，但也不要拍一个固定间隔。**每次唤醒时决定下一次睡多久**，
用 schedule_create 排一条「一次性」提醒（after_seconds），而不是 every 死循环：

| 现在的情况 | 下一次唤醒 |
| --- | --- |
| 有 worker 在跑 | 90–120 秒 |
| 在等用户回答 questions.jsonl | 5–15 分钟 |
| 刚有实质进展、还有下一步可做 | 2–5 分钟 |
| 连续几轮没有新证据 | 翻倍退避，直到 15–30 分钟 |

判断依据是最后一条 progress 的时间、待回答的问题数、以及有没有 worker 在跑。
不确定该睡多久时，调 GET /supervisor/loop?sessionId=<你的会话 id>，读数里的
recommend.seconds 与 reason —— 服务端用的是同一套策略，和你手算的结果应当一致。

长睡对账：如果醒来时发现距离上一次真实唤醒已经过去远超预期（读数里的
staleWake.stale 为 true），先做一次全量对账（目标 / worker / .agi/ 三处对齐），
再决定下一步，不要照原计划往下推。

兜底：服务端 watchdog 会在你忘记排提醒时替你补一条（标题带 [watchdog] 前缀）。
看到它就说明这一轮漏了定时器 —— 正常排一条即可，服务端那条会自动撤掉，不会重复。

目标达成或终止时，删掉所有提醒。

## 边界
- 不替 worker 做它的活；你的产出是决策、任务描述与验收。
- 只有真正需要用户拍板的事才进 questions.jsonl，其余自己决定。
- 每次唤醒都重新验证，不要因为「上次看着对」就跳过检查。`

/** Dev Agent 人格：main-agent/spawn 用它把 worker 约束在任务范围内。 */
export const DEV_AGENT_PERSONA = `你是一名 Dev Agent：常驻监督者之下的专注 worker。
你的任务随首条消息送达，内容完整、自包含；严格待在其范围内。
- 你没有直接向用户提问的渠道。report 工具就是你向监督者提问的渠道。
  若被只有监督者或用户掌握的信息阻塞，调用 report 给出准确问题，
  然后停止工作，直到答案作为你的下一轮到来。不要在这个子会话里等答案。
- 完成时：在任务指定的路径写 outcome.md（做了什么、验证了什么、还剩什么），
  然后报告一段话的总结。
- 任务进行中收到的监督者消息是纠偏：它们在你的下一步汇入 —— 立即遵从，
  不要先把原计划做完。
- 除非任务允许，不要自己派生 subagent。`

/** 顶层行的 name 替换表。`delegation` 里的 tool-subagent 单独处理（要带 persona）。 */
export const SUPERVISOR_NAME_ROWS = {
  'tool-goal': 'dsh-main-agent/goal',
  'tool-subagent-control': 'dsh-main-agent/control',
}

const SUPERVISOR_MARKERS = new Set(['dsh-main-agent/goal', 'dsh-main-agent/spawn'])

/** 这份 plugins 数组是否已经带监督层（用于幂等与 UI 状态显示）。 */
export function isSupervised(plugins) {
  if (!Array.isArray(plugins)) return false
  for (const row of plugins) {
    if (!row || typeof row !== 'object') continue
    if (SUPERVISOR_MARKERS.has(row.name)) return true
    if (row.id === 'delegation' && Array.isArray(row.config)) {
      for (const child of row.config) {
        if (child && SUPERVISOR_MARKERS.has(child.name)) return true
      }
    }
  }
  return false
}

/** 已注入的监督行数量，0..3。UI 用它区分「已启用」「部分注入」「未启用」。 */
export function countSupervisorRows(plugins) {
  if (!Array.isArray(plugins)) return 0
  let goal = 0
  let control = 0
  let spawn = 0
  for (const row of plugins) {
    if (!row || typeof row !== 'object') continue
    if (row.id === 'tool-goal' && row.name === 'dsh-main-agent/goal') goal++
    if (row.id === 'tool-subagent-control' && row.name === 'dsh-main-agent/control') control++
    if (row.id === 'delegation' && Array.isArray(row.config)) {
      for (const child of row.config) {
        if (!child || typeof child !== 'object') continue
        if (child.id === 'tool-subagent-control' && child.name === 'dsh-main-agent/control') control++
        if (child.id === 'tool-subagent' && child.name === 'dsh-main-agent/spawn') spawn++
      }
    }
  }
  return goal + control + spawn
}

/**
 * 把监督层套到一份 plugins 数组上，返回新数组（深拷贝，不改入参）。
 *
 * 改这 4 处：
 *   persona.config.prefix            → SUPERVISOR_PERSONA（保留原 suffix）
 *   tool-goal.name                   → dsh-main-agent/goal
 *   tool-subagent-control.name       → dsh-main-agent/control
 *   delegation[].tool-subagent       → dsh-main-agent/spawn + Dev Agent persona
 *
 * 刻意不动：
 *   tool-subagent-list-agents  官方实现本来就通用
 *   tool-subagent-fork         官方 fork 语义与本层无关，留原样
 *   disabled 标记              任何行原有的 disabled 一律尊重
 */
export function applySupervisorLayer(plugins) {
  if (!Array.isArray(plugins)) return []
  const out = structuredClone(plugins)

  for (const row of out) {
    if (!row || typeof row !== 'object') continue

    if (row.id === 'persona') {
      const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? { ...row.config }
        : {}
      config.prefix = SUPERVISOR_PERSONA
      row.config = config
      continue
    }

    const replacement = SUPERVISOR_NAME_ROWS[row.id]
    if (replacement !== undefined) {
      row.name = replacement
      continue
    }

    if (row.id === 'delegation' && Array.isArray(row.config)) {
      for (const child of row.config) {
        if (!child || typeof child !== 'object') continue
        // `tool-subagent-control` lives INSIDE the delegation group, not at
        // the top level, so the name table applies at both depths.
        const childReplacement = SUPERVISOR_NAME_ROWS[child.id]
        if (childReplacement !== undefined) {
          child.name = childReplacement
          continue
        }
        if (child.id !== 'tool-subagent') continue
        child.name = 'dsh-main-agent/spawn'
        const config = child.config && typeof child.config === 'object' && !Array.isArray(child.config)
          ? { ...child.config }
          : {}
        config.provider = 'spawn'
        config.toolName = typeof config.toolName === 'string' ? config.toolName : 'subagent'
        config.persona = DEV_AGENT_PERSONA
        child.config = config
      }
    }
  }

  return out
}

/** 去掉监督层：把 4 处换回官方名。用于「取消勾选」，不依赖外部快照。 */export function stripSupervisorLayer(plugins) {
  if (!Array.isArray(plugins)) return []
  const out = structuredClone(plugins)

  for (const row of out) {
    if (!row || typeof row !== 'object') continue

    if (row.id === 'persona' && row.config?.prefix === SUPERVISOR_PERSONA) {
      // The three shipped presets all declare `prefix: ""`, so restoring the
      // empty string (rather than deleting the key) makes the round trip
      // byte-identical. A preset that shipped a custom prefix is restored by
      // the caller's baseline snapshot, which never carries this layer.
      row.config = { ...row.config, prefix: '' }
      continue
    }

    if (row.id === 'tool-goal' && row.name === 'dsh-main-agent/goal') {
      row.name = '@deepseek-ai/dsh-tool-goal'
      continue
    }

    if (row.id === 'tool-subagent-control' && row.name === 'dsh-main-agent/control') {
      row.name = '@deepseek-ai/dsh-tool-subagent-control'
      continue
    }

    if (row.id === 'delegation' && Array.isArray(row.config)) {
      for (const child of row.config) {
        if (!child || typeof child !== 'object') continue
        if (child.id === 'tool-subagent-control' && child.name === 'dsh-main-agent/control') {
          child.name = '@deepseek-ai/dsh-tool-subagent-control'
          continue
        }
        if (child.id !== 'tool-subagent' || child.name !== 'dsh-main-agent/spawn') continue
        child.name = '@deepseek-ai/dsh-tool-subagent'
        const config = { ...(child.config ?? {}) }
        if (config.persona === DEV_AGENT_PERSONA) delete config.persona
        child.config = config
      }
    }
  }

  return out
}

/**
 * Reconcile live preset loader rows against the wanted selection.
 *
 * Kept here — not in `lib/index.js` — so it can be tested without a Cordis
 * container: the caller supplies the rows, the baselines map, and a logger.
 *
 * Idempotence is the whole point: a row already in the wanted state never
 * reaches `entry.update`, so an unchanged selection restarts no fiber at all.
 *
 * @param {object} input
 * @param {Array<{entry: {options: {config: object}, update: (patch: object) => Promise<unknown>}, id: string, plugins: unknown}>} input.entries
 * @param {Iterable<string>} input.wanted
 * @param {Map<string, unknown[]>} input.baselines  pristine `plugins` per id
 * @param {{info?: Function, warn?: Function}} [input.log]
 * @returns {Promise<{changed: Array<{id: string, supervised: boolean}>, errors: Array<{id: string, error: string}>}>}
 */
export async function syncSupervisedLayer({ entries, wanted, baselines, log }) {
  const changed = []
  const errors = []
  const desired = wanted instanceof Set ? wanted : new Set(wanted ?? [])

  for (const item of Array.isArray(entries) ? entries : []) {
    const { entry, id, plugins } = item ?? {}
    if (typeof id !== 'string' || id.length === 0) continue
    if (!Array.isArray(plugins)) continue
    if (!entry || typeof entry.update !== 'function') continue

    if (!baselines.has(id)) baselines.set(id, structuredClone(plugins))
    const want = desired.has(id)
    const has = isSupervised(plugins)
    if (want === has) continue

    const base = baselines.get(id) ?? plugins
    const next = want ? applySupervisorLayer(base) : stripSupervisorLayer(base)
    try {
      await entry.update({ config: { ...entry.options.config, plugins: next } })
      changed.push({ id, supervised: want })
      log?.info?.(`dsh-main-agent: preset ${id} 监督循环${want ? '已启用' : '已关闭'}`)
    } catch (error) {
      errors.push({ id, error: error?.message ?? String(error) })
      log?.warn?.(`dsh-main-agent: 切换 preset ${id} 失败：${error?.message ?? error}`)
    }
  }

  return { changed, errors }
}
