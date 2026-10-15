const CONTINUATION_ACTION = /\b(?:start|resume|continue|restart|proceed|carry\s+on|keep\s+(?:going|working))\b/i
const CONTINUATION_MISSION = /\b(?:goal|mission|quest|campaign|operation|operator|always[- ]on|continuous(?:ly)?|24\s*\/\s*7|long[- ]running)\b/i
const GROUNDING_FILE = /(?:^|\/)(?:README(?:\.[^/]*)?|[^/]*(?:RUNBOOK|PLAYBOOK|OPERATIONS|TOOL|SCRIPT)[^/]*|[^/]+\.(?:sh|py|js|mjs|cjs|ts|tsx|ps1))$/i
const GROUNDING_EXCLUDED_DIR = /(?:^|\/)(?:\.agi|\.git|node_modules|\.venv|profile)(?:\/|$)/i

/** Recognize an explicit request to (re)enter a long-running execution loop. */
export function isLongRunningContinuation(text, hasDurableMission = false) {
  if (typeof text !== 'string' || !CONTINUATION_ACTION.test(text)) return false
  return hasDurableMission || CONTINUATION_MISSION.test(text)
}

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

/** Canonical user-reviewable goal document written when the native goal starts. */
export function renderGoalMarkdown({ objective, constraints, milestones, outOfScope, maxGoalRounds }) {
  const list = values => values.length === 0 ? '- 未指定。' : values.map(value => `- ${value}`).join('\n')
  return [
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
