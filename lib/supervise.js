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

/**
 * 拼接标记的固定前缀。真正写入的那一行还带版本号与「原文有多长」：
 *
 *   <!-- dsh-main-agent:supervisor-layer v1 origin=1835 -->
 *
 * 为什么要带 origin：只靠一个固定锚点做幂等判定和截断定位，会被用户自己人格
 * 正文里的同一串字误命中 —— 那会让 compose 误判「已叠过」而漏注入（工具行却
 * 照改，落成半应用），让 strip 从用户文本中间截断。带上原文长度、并校验「从
 * 这里到结尾逐字等于我写过的尾部」，才能既认出真正叠过的输入，又一个字都不
 * 碰用户自己的文字。
 */
export const SUPERVISOR_ANCHOR = '<!-- dsh-main-agent:supervisor-layer'

/** 拼接时写在原文之后的标记行；`origin` 是原文长度（UTF-16 码元数）。 */
function supervisorMarker(originLength) {
  return `${SUPERVISOR_ANCHOR} v1 origin=${originLength} -->`
}

/** compose 追加在原文之后的完整尾部。strip 靠它做整段比对。 */
function supervisorTail(originLength) {
  return `\n\n${supervisorMarker(originLength)}\n\n${SUPERVISOR_BRIDGE}\n\n${SUPERVISOR_PERSONA}`
}

const SUPERVISOR_MARKER_RE = /<!-- dsh-main-agent:supervisor-layer v1 origin=(\d+) -->/g

/**
 * 两段人格之间的过渡段，只在「原模式已经带自己的人格」时插入。
 *
 * 为什么必须有这段：原模式人格（例如破甲模式）与监督者人格在职责上会互相
 * 拆台 —— 一边说「你是操作者的执行端，能动手就动手」，另一边说「不要亲自把
 * 它做完，派 worker」。缺了切分，模型会在两条指令之间摇摆。这里明确分工：
 * 上面的模式管「怎么干活」，下面的监督层管「怎么推进目标」。
 */
const SUPERVISOR_BRIDGE = `---

以上是当前模式自己的执行纪律与人设，它决定你「怎么干活」：身份、执行风格、交付标准与边界。
以下是叠加在同一身份上的监督循环，它决定你「怎么推进目标」：锁定可验收目标、把工作拆成自包含任务派给 worker、定时唤醒、把状态落到工作区。

两者的分工：
- 不冲突时同时生效。
- 冲突时按「风格归模式、流程归监督层」切分：模式规定怎么执行、怎么交付、什么不做；监督层只规定怎么编排与推进，不改写模式的交付标准与边界。
- 监督层的「不要亲自做完」只约束**长任务编排**（先派生 worker，再验收结果）；一次就能做完的读、查、核验、收尾，仍然由你自己动手，不要为了形式而委派。`

/**
 * 把一个 preset 原有的 prefix 组合成「原人格 + 监督者人格」。
 *
 * 三条分支：
 *   空字符串        → 只返回监督者人格（出厂 standard/minimal 的行为保持不变）
 *   已经含监督层    → 原样返回（幂等，重复 apply 不会越拼越长）
 *   有自己的 prefix  → 原文 + 锚点 + 过渡段 + 监督者人格
 *
 * @param {unknown} current
 * @returns {string}
 */
export function composeSupervisorPersona(current) {
  const prefix = typeof current === 'string' ? current : ''
  if (prefix.length === 0) return SUPERVISOR_PERSONA
  if (hasSupervisorPersona(prefix)) return prefix
  return prefix + supervisorTail(prefix.length)
}

/**
 * 这段 prefix 里是否已经叠过监督层。
 *
 * 只认两种形态，都要求**结构完整**，绝不做子串包含判断：
 *   1. 恰好等于整段监督者人格 —— 早期版本把它当整份替换写过一次。
 *   2. 某个 `origin=N` 标记之后到结尾，逐字等于 compose 会写的那段尾部。
 *
 * 早期版本用 `includes(锚点)`：用户人格里只要出现同一串字就被判成「已叠过」，
 * compose 静默不注入、工具行却照改，落成半应用状态。
 */
export function hasSupervisorPersona(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) return false
  if (prefix === SUPERVISOR_PERSONA) return true
  return readComposedOrigin(prefix) !== null
}

/**
 * 找出「原文有多长」：遍历所有 `origin=N` 候选，只有 `prefix.slice(N)` 恰好
 * 等于 compose 当时写下的尾部时才采信。用户人格里自己写了标记行、或整段粘贴
 * 了监督者人格，都不会命中 —— 位置和内容必须同时对得上。
 *
 * @returns {number | null}
 */
export function readComposedOrigin(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) return null
  for (const match of prefix.matchAll(SUPERVISOR_MARKER_RE)) {
    const origin = Number(match[1])
    if (!Number.isInteger(origin) || origin < 0 || origin > prefix.length) continue
    if (prefix.slice(origin) === supervisorTail(origin)) return origin
  }
  return null
}

/**
 * `composeSupervisorPersona` 的逆运算，用于没有基线快照时把 prefix 还原。
 *
 * 精确回滚靠标记行里的原文长度，而不是「从锚点往左退几步换行」的猜测：长度
 * 对得上就直接切到那里，对不上一个字都不动。所以用户自己的尾换行、空行，甚至
 * 写在正文里的标记行，都原样保留。
 */
export function stripSupervisorPersona(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) return ''
  if (prefix === SUPERVISOR_PERSONA) return ''
  const origin = readComposedOrigin(prefix)
  if (origin !== null) return prefix.slice(0, origin)
  return prefix
}

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
 * 监督层要落地的 4 个锚点行。
 *
 * 判定「能不能叠」只能看**行是否存在**，不能看 `countSupervisorRows`：
 * 未叠过的 preset 那些行的 name 还是官方的，rows 恒为 0 —— 拿它判断会把
 * standard 也一起判成不可叠。
 *
 * 位置必须与 `applySupervisorLayer` 的实际改法逐条对齐，否则会出现
 * 「判定说能叠、实际改不到」的半应用：
 *   persona               顶层
 *   tool-goal             顶层
 *   tool-subagent-control 顶层或 delegation 组内（两处都改）
 *   tool-subagent         仅 delegation 组内（顶层那个不会被处理）
 *
 * `disabled: true` 的行算缺失：apply 尊重 disabled，改完 name 也不会挂载。
 */
export const SUPERVISOR_ANCHOR_IDS = ['persona', 'tool-goal', 'tool-subagent-control', 'tool-subagent']

/**
 * 这份 plugins 能不能被监督层完整改造。
 *
 * 典型反例是官方 minimal：它有 persona，却没有 tool-goal、没有
 * tool-schedule，也没有 delegation 组。叠上去的结果是「模型被告知自己是
 * 监督者，但 start_goal / 派生 worker / 排定时器一个工具都没有」—— 人格
 * 与能力脱节，循环一步都走不了。这类 preset 不该被勾选。
 *
 * @param {unknown} plugins
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function supervisorAnchorReport(plugins) {
  const found = new Set()
  if (Array.isArray(plugins)) {
    for (const row of plugins) {
      if (!row || typeof row !== 'object' || row.disabled === true) continue
      if (row.id === 'persona' || row.id === 'tool-goal' || row.id === 'tool-subagent-control') {
        found.add(row.id)
      }
      if (row.id !== 'delegation' || !Array.isArray(row.config)) continue
      for (const child of row.config) {
        if (!child || typeof child !== 'object' || child.disabled === true) continue
        if (child.id === 'tool-subagent' || child.id === 'tool-subagent-control') {
          found.add(child.id)
        }
      }
    }
  }
  const missing = SUPERVISOR_ANCHOR_IDS.filter((id) => !found.has(id))
  return { ok: missing.length === 0, missing }
}

/**
 * 把监督层套到一份 plugins 数组上，返回新数组（深拷贝，不改入参）。
 *
 * 改这 4 处：
 *   persona.config.prefix            → 原 prefix + 过渡段 + 监督者人格（拼接）
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
      // 拼接而非替换：原模式自己的人格（例如破甲模式那段「操作者的执行端」）
      // 必须留下，否则勾一个模式就等于把它废掉。空 prefix 的出厂 preset 仍然
      // 只得到监督者人格，与旧行为一致。
      config.prefix = composeSupervisorPersona(config.prefix)
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
        // A preset that narrowed its worker catalog with the retired
        // `toolFilter.deny` spelling keeps that restriction: copy the list into
        // the native `deny` field this spawn implementation reads. The old key
        // stays, and not only for tidiness — `stripSupervisorLayer` uses its
        // presence to recognise a copy it made itself.
        const legacyDeny = Array.isArray(config.toolFilter?.deny) ? config.toolFilter.deny : []
        if (legacyDeny.length > 0) {
          const merged = new Set([...(Array.isArray(config.deny) ? config.deny : []), ...legacyDeny])
          config.deny = [...merged]
        }
        child.config = config
      }
    }
  }

  return out
}

/**
 * 去掉监督层：把 4 处换回官方名，并把 persona.prefix 里的监督层切掉。
 *
 * 用于「取消勾选」。能自足还原的部分：`persona.prefix`（标记行里带着原文
 * 长度）、以及 `tool-goal` / `tool-subagent-control` / `tool-subagent` 三处
 * 的 `name` —— 这三处是否被改过由当前值是否等于本层的名字判定，不需要快照。
 *
 * **需要 baseline 的部分**：`tool-subagent.config.provider`。apply 会把它钉成
 * `'spawn'`（`dsh-main-agent/spawn` 这个工具就是 spawn provider 实现），而没有
 * 快照时无法知道原值本来是 `'fork'` 之类还是压根没写这个键，所以这里不回退它。
 * `syncSupervisedLayer` 与 `lib/index.js` 都在调用 strip 之前先存过 baseline，
 * 生产路径不依赖这条自足性。
 */
export function stripSupervisorLayer(plugins) {
  if (!Array.isArray(plugins)) return []
  const out = structuredClone(plugins)

  for (const row of out) {
    if (!row || typeof row !== 'object') continue

    if (row.id === 'persona' && typeof row.config?.prefix === 'string') {
      // 不再是「恰好等于整段人格才还原」：拼接后的 prefix 里，用户/模式自己
      // 那段必须原样留下。`stripSupervisorPersona` 负责精确切掉监督层与过渡
      // 段，所以这条路径即使没有基线快照也能正确回滚。
      const restored = stripSupervisorPersona(row.config.prefix)
      if (restored !== row.config.prefix) row.config = { ...row.config, prefix: restored }
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
        // Drop only the copy `apply` made: a `deny` sitting next to a legacy
        // `toolFilter.deny` is redundant, so removing it cannot change what the
        // workers see — the toolFilter list still applies.
        if (Array.isArray(config.deny) && Array.isArray(config.toolFilter?.deny)) delete config.deny
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
    // Enabling a preset that cannot carry the layer would rewrite the tool rows
    // it happens to have (or nothing at all) and leave the session with a
    // supervisor persona and no supervisor tools. Refuse instead — but always
    // allow disabling, since stripping is safe on any shape.
    if (want) {
      const report = supervisorAnchorReport(base)
      if (!report.ok) {
        errors.push({ id, error: `缺少监督层锚点：${report.missing.join(', ')}` })
        log?.warn?.(`dsh-main-agent: preset ${id} 缺少监督层锚点（${report.missing.join('、')}），跳过`)
        continue
      }
    }
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

/**
 * Re-mount a preset that was registered straight into the registry.
 *
 * Those declarations never pass through the loader, so `entry.update` has
 * nothing to touch. The registry does keep the whole record on a plain
 * `definitions` field and `activate()` is a prototype method, so swapping
 * `config.plugins` and re-activating hands the new revision to every session
 * created from now on. Sessions already bound keep the retired generation until
 * they unbind — `collect` only disposes at `users === 0`.
 *
 * Both members are undocumented, so every failure degrades to `false` rather
 * than throwing: the caller then reports "written to disk, needs a restart"
 * instead of claiming a live switch that did not happen.
 *
 * Lives here rather than in `lib/index.js` so it can be tested without a Cordis
 * container — the caller supplies the registry object.
 *
 * @param {object | undefined} registry
 * @param {string} id
 * @param {unknown} plugins
 * @returns {Promise<boolean>} whether the new revision is mounted right now
 */
export async function remountPreset(registry, id, plugins) {
  if (registry === undefined || registry === null) return false
  const record = registry.definitions?.get?.(id)
  if (record === undefined || record === null) return false
  if (typeof registry.activate !== 'function') return false
  if (!Array.isArray(plugins)) return false

  const previousConfig = record.config
  const previousGeneration = record.generation
  const previousBroken = record.broken
  try {
    record.config = { ...previousConfig, plugins }
    await registry.activate(record)
  } catch {
    record.config = previousConfig
    record.generation = previousGeneration
    return false
  }
  // `activate()` catches its own mount failures and records them on
  // `record.broken` instead of throwing, so a clean return is NOT proof the new
  // generation mounted. Without this check the card would say "effective now"
  // while the old revision keeps serving — and the user would never learn that a
  // restart is what actually applies the change.
  if (record.broken !== undefined && record.broken !== previousBroken) {
    record.config = previousConfig
    record.generation = previousGeneration
    record.broken = previousBroken
    return false
  }
  if (previousGeneration !== undefined) {
    previousGeneration.retired = true
    try {
      await registry.collect?.(previousGeneration)
    } catch {
      // Retiring is enough: the last unbind collects it.
    }
  }
  return true
}
