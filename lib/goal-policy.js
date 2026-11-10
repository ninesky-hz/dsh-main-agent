import { createHash } from 'node:crypto'

const CONTINUATION_ACTION = /\b(?:start|resume|continue|restart|proceed|carry\s+on|keep\s+(?:going|working))\b/i
const CONTINUATION_MISSION = /\b(?:goal|mission|quest|campaign|operation|operator|always[- ]on|continuous(?:ly)?|24\s*\/\s*7|long[- ]running)\b/i

/**
 * 中文动作词。
 *
 * 中文没有词边界，`\b` 在这里完全失效，所以不能把中文塞进上面的 ASCII 正则。
 * 而且只做「有动作词」这一层会比英文更松：「继续看看这个文件」「恢复一下」都是
 * 日常中文，一旦它们也进闸门，整个会话会被锁进只读白名单 —— 比漏判更糟。
 *
 * 因此中文走「动作词 AND mission 词」的双重共现：两个正则各自都必须命中。
 * 中文里「继续这个长期任务」「恢复任务」「重启监督循环」这类才成立，
 * 而「继续看看」「恢复一下」因为缺 mission 词被放过。
 */
const CONTINUATION_ACTION_CJK = /(?:繼續|继续|恢復|恢复|接著做|接着做|接著幹|接着干|接著進行|接着进行|啟動|启动|重啟|重启)/
const CONTINUATION_MISSION_CJK = /(?:任務|任务|目標|目标|長期|长期|常駐|常驻|循環|循环|監督|监督|巡檢|巡检|goal|mission|supervisor|24\s*\/\s*7)/i

/** Recognize an explicit request to (re)enter a long-running execution loop. */
export function isLongRunningContinuation(text, hasDurableMission = false) {
  if (typeof text !== 'string') return false
  if (CONTINUATION_ACTION_CJK.test(text) && CONTINUATION_MISSION_CJK.test(text)) return true
  if (!CONTINUATION_ACTION.test(text)) return false
  return hasDurableMission || CONTINUATION_MISSION.test(text)
}

const GROUNDING_FILE = /(?:^|\/)(?:README(?:\.[^/]*)?|[^/]*(?:RUNBOOK|PLAYBOOK|OPERATIONS|TOOL|SCRIPT)[^/]*|[^/]+\.(?:sh|py|js|mjs|cjs|ts|tsx|ps1))$/i
const GROUNDING_EXCLUDED_DIR = /(?:^|\/)(?:\.agi|\.git|node_modules|\.venv|profile)(?:\/|$)/i

/** Identify a workspace runbook, automation script, or source entry worth opening before a goal starts. */
export function isWorkspaceGroundingPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  const normalized = path.replaceAll('\\', '/')
  return !GROUNDING_EXCLUDED_DIR.test(normalized) && GROUNDING_FILE.test(normalized)
}

const GOAL_SETUP_SAFE_TOOLS = new Set([
  'get_goal',
  'start_goal',
  'read',
  'glob',
  'grep',
  'mnemon_document_search',
  'mnemon_memory_bodies',
  'mnemon_recall',
  'mnemon_status',
])

/** Tools allowed while an explicit continuation request is establishing its native goal. */
export function isGoalSetupSafeTool(name) {
  return GOAL_SETUP_SAFE_TOOLS.has(name)
}

/** Deterministic tool policy for one explicit continuation request. */
export function continuationToolDecision({
  text,
  hasDurableMission,
  goalPhase,
  toolName,
  goalChecked,
  workspaceGroundingRequired = false,
  workspaceGrounded = false,
}) {
  if (!isLongRunningContinuation(text, hasDurableMission) || goalPhase === 'active') {
    return 'unrestricted'
  }
  if (isGoalSetupSafeTool(toolName)) {
    if (toolName !== 'start_goal') return 'allow'
    if (!goalChecked) return 'require-goal-check'
    if (workspaceGroundingRequired && !workspaceGrounded) return 'require-workspace-grounding'
    return 'allow'
  }
  if (goalPhase === 'paused' && toolName === 'update_goal') {
    return goalChecked ? 'allow' : 'require-goal-check'
  }
  return 'deny-unarmed'
}

/** 12 位十六进制摘要：短到能贴进一屏，长到足以区分同一个人几天里的两次修改。 */
const digest12 = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

/**
 * Canonical user-reviewable goal document written when the native goal starts.
 *
 * 最前面是一段 front-matter：`revision` 让「这份目标被改过几次」可读，
 * `objective_sha256` 让「目标本身还是不是原来那句」可验，`updated` 只是给人看的。
 * 正文格式刻意一字不动 —— 已有读者（提示词、状态检查、人工）都在按 `## ` 段落读它。
 */
export function renderGoalMarkdown({
  objective,
  constraints,
  milestones,
  outOfScope,
  maxGoalRounds,
  revision = 1,
  updated,
}) {
  const list = values => values.length === 0 ? '- 未指定。' : values.map(value => `- ${value}`).join('\n')
  const rounds = Number.isSafeInteger(revision) && revision > 0 ? revision : 1
  const stamp = typeof updated === 'string' && updated.length > 0 ? updated : new Date().toISOString()
  const subject = typeof objective === 'string' ? objective : String(objective ?? '')
  return [
    '---',
    `revision: ${rounds}`,
    `updated: ${stamp}`,
    `objective_sha256: ${digest12(subject)}`,
    '---',
    '',
    '# 目标',
    '',
    '## 目标陈述',
    '',
    objective,
    '',
    '## 约束',
    '',
    list(constraints),
    '',
    '## 里程碑',
    '',
    list(milestones),
    '',
    '## 范围之外',
    '',
    list(outOfScope),
    '',
    '## 自主回合上限',
    '',
    String(maxGoalRounds),
    '',
  ].join('\n')
}

/**
 * 取 GOAL.md 的正文（front-matter 之后的部分）。
 *
 * `trim()` 是刻意的：正文前后多一个空行不是「有人改了目标」，不该让指纹变化。
 * 没有 front-matter 的旧文件按全文处理 —— 那正是它当时的正文。
 *
 * @param {string} text 整份 GOAL.md
 * @returns {string}
 */
function goalBody(text) {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[0].trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (close > 0) return lines.slice(close + 1).join('\n').trim()
  }
  return text.trim()
}

/**
 * 解析 GOAL.md 的 front-matter。
 *
 * 只认「第一行是 `---`、后面还有一行 `---`」这一种形状，并且三个字段缺一不可：
 * revision 必须是正整数，updated 必须非空，objective_sha256 必须是 12 位十六进制。
 * 任何一条不满足都返回 `null` —— 解析失败可以是「这份文件没有版本信息」，但绝不能
 * 猜一个 revision 出来：猜错的代价是覆盖别人刚改过的目标。
 *
 * @param {string} text
 * @returns {{ revision: number, updated: string, objectiveDigest: string } | null}
 */
export function parseGoalFrontMatter(text) {
  if (typeof text !== 'string') return null
  const lines = text.split('\n')
  if (lines.length < 2 || lines[0].trim() !== '---') return null
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) return null
  const fields = new Map()
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    fields.set(match[1], match[2].trim())
  }
  const revision = Number(fields.get('revision'))
  if (!Number.isSafeInteger(revision) || revision < 1) return null
  const updated = fields.get('updated') ?? ''
  if (updated.length === 0) return null
  const digest = fields.get('objective_sha256') ?? ''
  if (!/^[0-9a-f]{12}$/.test(digest)) return null
  return { revision, updated, objectiveDigest: digest }
}

/**
 * 正文指纹：用来判断「有人改了 GOAL.md 的正文」。
 *
 * 与 `objective_sha256` 分工不同 —— 那个只覆盖目标陈述一句话，说明「为什么做」
 * 有没有变；这个覆盖整份正文，说明「约束/里程碑/范围」有没有被改。
 *
 * @param {string} text 整份 GOAL.md
 * @returns {string | null} 12 位十六进制；非字符串时 `null`（调用方据此跳过）
 */
export function goalDocDigest(text) {
  if (typeof text !== 'string') return null
  return digest12(goalBody(text))
}

export function normalizedGoalText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} 必须是非空字符串`)
  }
  return value.trim()
}

export function normalizedGoalList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} 必须是数组`)
  return value.map((item, index) => normalizedGoalText(item, `${field}[${index}]`))
}

export function normalizedRoundCap(value, fallback = 256) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError('max_goal_rounds 必须是正的安全整数')
  }
  return resolved
}
