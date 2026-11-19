import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  SYSTEM_HOLD_CODES,
  continuationToolDecision,
  deriveGoalActionAuthority,
  deriveGoalActionDenial,
  isGoalSetupSafeTool,
  isLongRunningContinuation,
  isSystemHeld,
  isWorkspaceGroundingPath,
  normalizedGoalList,
  normalizedGoalText,
  normalizedRoundCap,
  renderGoalMarkdown,
} from '../lib/goal-policy.js'

test('long-running continuation detection is narrow and setup tools stay read-only', () => {
  assert.equal(isLongRunningContinuation('continue our quest'), true)
  assert.equal(isLongRunningContinuation('resume', true), true)
  assert.equal(isLongRunningContinuation('continue reading this paragraph'), false)
  assert.equal(isLongRunningContinuation('what is the mission status?'), false)
  for (const name of ['get_goal', 'start_goal', 'read', 'glob', 'grep', 'mnemon_recall']) {
    assert.equal(isGoalSetupSafeTool(name), true, name)
  }
  for (const name of ['bash', 'subagent', 'schedule_create', 'write', 'edit']) {
    assert.equal(isGoalSetupSafeTool(name), false, name)
  }
})

test('workspace grounding recognizes runbooks and scripts but excludes generated state', () => {
  assert.equal(isWorkspaceGroundingPath('browser/BROWSER_TOOL.md'), true)
  assert.equal(isWorkspaceGroundingPath('scripts/recover.sh'), true)
  assert.equal(isWorkspaceGroundingPath('src/operator.ts'), true)
  assert.equal(isWorkspaceGroundingPath('README.md'), true)
  assert.equal(isWorkspaceGroundingPath('.agi/OPERATOR_BRIEF.md'), false)
  assert.equal(isWorkspaceGroundingPath('browser/profile/recovery.js'), false)
  assert.equal(isWorkspaceGroundingPath('browser/.venv/bin/activate.py'), false)
})

test('continuation tool policy enforces goal check and unarmed operation boundary', () => {
  const base = {
    text: 'continue our quest',
    hasDurableMission: true,
    goalPhase: undefined,
    goalChecked: false,
  }
  assert.equal(continuationToolDecision({ ...base, toolName: 'read' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, toolName: 'start_goal' }), 'require-goal-check')
  assert.equal(continuationToolDecision({ ...base, goalChecked: true, toolName: 'start_goal' }), 'allow')
  assert.equal(continuationToolDecision({
    ...base,
    goalChecked: true,
    toolName: 'start_goal',
    workspaceGroundingRequired: true,
  }), 'require-workspace-grounding')
  assert.equal(continuationToolDecision({
    ...base,
    goalChecked: true,
    toolName: 'start_goal',
    workspaceGroundingRequired: true,
    workspaceGrounded: true,
  }), 'allow')
  assert.equal(continuationToolDecision({ ...base, toolName: 'bash' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, toolName: 'schedule_create' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'active', toolName: 'bash' }), 'unrestricted')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'paused', goalChecked: true, toolName: 'update_goal' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, text: 'read the status', toolName: 'bash' }), 'unrestricted')
})

test('GOAL.md renders every setup field in a stable canonical form', () => {
  const markdown = renderGoalMarkdown({
    objective: 'Ship a verified report.',
    constraints: ['No Harness edits.'],
    milestones: ['Inspect.', 'Verify.'],
    outOfScope: [],
    maxGoalRounds: 12,
  })
  // front-matter 在最前面（B7）：revision / updated / objective_sha256 三件套。
  assert.match(
    markdown,
    /^---\nrevision: 1\nupdated: \d{4}-\d{2}-\d{2}T[\d:.]+Z\nobjective_sha256: [0-9a-f]{12}\n---\n\n/,
  )
  // 正文仍以 `# 目标` 开头：front-matter 是加在最前面的，正文格式一字未动。
  assert.match(markdown.slice(markdown.indexOf('---\n\n') + '---\n\n'.length), /^# 目标/)
  assert.match(markdown, /## 目标陈述\n\nShip a verified report\./)
  assert.match(markdown, /## 约束\n\n- No Harness edits\./)
  assert.match(markdown, /## 里程碑\n\n- Inspect\.\n- Verify\./)
  assert.match(markdown, /## 范围之外\n\n- 未指定。/)
  assert.match(markdown, /## 自主回合上限\n\n12\n$/)
})

test('goal inputs normalize safely and reject malformed values', () => {
  assert.equal(normalizedGoalText('  objective  ', 'objective'), 'objective')
  assert.deepEqual(normalizedGoalList([' one ', 'two'], 'milestones'), ['one', 'two'])
  assert.equal(normalizedRoundCap(undefined), 256)
  assert.equal(normalizedRoundCap(8), 8)
  assert.throws(() => normalizedGoalText(' ', 'objective'), /非空字符串/)
  assert.throws(() => normalizedGoalList('one', 'milestones'), /必须是数组/)
  assert.throws(() => normalizedGoalList([''], 'milestones'), /milestones\[0\]/)
  assert.throws(() => normalizedRoundCap(0), /正的安全整数/)
})

test('preset exposes only the supervisor-owned non-blocking goal frontend', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  const goalSource = await readFile(new URL('../lib/goal.js', import.meta.url), 'utf8')
  assert.match(preset, /- id: tool-goal\n\s+name: dsh-main-agent\/goal/)
  assert.doesNotMatch(preset, /name: '@deepseek-ai\/dsh-tool-goal'/)
  assert.match(goalSource, /name: 'start_goal'/)
  assert.match(goalSource, /ctx\.on\('tools\/pre-execute'/)
  assert.match(goalSource, /不要索要确认/)
  assert.match(goalSource, /都不算操作性检查/)
  assert.doesNotMatch(goalSource, /name: 'create_goal'/)
  assert.doesNotMatch(goalSource, /name: 'propose_goal'/)
  assert.doesNotMatch(goalSource, /name: 'confirm_goal'/)
  assert.doesNotMatch(goalSource, /CONFIRM GOAL/)
  assert.doesNotMatch(goalSource, /enum: \['edit'/)
})

test('preset requires bounded recovery and a durable continuation path', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  assert.match(preset, /PERSISTENCE（持久推进：可恢复的分支不是阻塞项）/)
  assert.match(preset, /走完\n\s+一组有界的、彼此不同的安全恢复尝试/)
  assert.match(preset, /绝不绕开任何安全或审批边界/)
  assert.match(preset, /一个受阻的分支不会让任务停下/)
  assert.match(preset, /至少留下一条持久的续行路径/)
  assert.match(preset, /遗留的 GOAL\.md 只是背景信息，\n\s+而不是运行时循环已经武装的证明/)
  assert.match(preset, /对于每一次要求开始、恢复或继续长期任务的直接人类请求，\n\s+都要先调用 get_goal，再做操作性工作/)
  assert.match(preset, /先检查相关的 runbook 与脚本/)
  assert.match(preset, /绝不索要一句确认口令，也绝不/)
  assert.match(preset, /直接进入 THE LOOP/)
  assert.match(preset, /不要只用提醒\n\s+去模拟一个常驻循环/)
  assert.match(preset, /就安排一条有界的稍后重试/)
})

test('continuation detection accepts Chinese only when an action word and a mission word co-occur', () => {
  // 中文没有词边界，不能照搬英文的 \b 规则：单独一个「继续」会把
  // 「继续看看这个文件」这类日常请求也锁进只读白名单。共现规则比 \b 更严。
  for (const text of ['继续这个长期任务', '恢复任务', '接着做这个 goal', '继续 mission', '重启监督循环']) {
    assert.equal(isLongRunningContinuation(text), true, text)
    assert.equal(isLongRunningContinuation(text, true), true, text)
    // 一旦判定为续行，写操作必须先过 goal 检查 —— 这正是中文会话原先漏掉的闸门。
    assert.equal(continuationToolDecision({
      text,
      hasDurableMission: true,
      goalPhase: undefined,
      toolName: 'bash',
      goalChecked: false,
    }), 'deny-unarmed', `${text} 必须进闸门`)
  }
  // 只有动作词、没有 mission 词 —— 即使 .agi/GOAL.md 存在也不进守卫。
  for (const text of ['继续', '继续看看这个文件', '恢复一下', '接着做下一项']) {
    assert.equal(isLongRunningContinuation(text, true), false, text)
  }
  // 只有 mission 词、没有动作词也不进守卫。
  assert.equal(isLongRunningContinuation('这个长期任务进展如何', true), false)
  // 英文语义保持不变。
  for (const text of ['resume', 'keep going', 'proceed with it', 'carry on']) {
    assert.equal(isLongRunningContinuation(text, true), true, text)
  }
  assert.equal(isLongRunningContinuation('the long-running mission', true), false)
  assert.equal(isLongRunningContinuation('continue reading this paragraph'), false)
})

test('workspace grounding rejects plain .md notes, generated trees, and empty paths', () => {
  // 真实踩坑点：计划文档不叫 README、名字里没有 RUNBOOK/TOOL/SCRIPT，
  // 扩展名也不是脚本 —— 只读它不能满足 start_goal 之前的接地要求。
  assert.equal(isWorkspaceGroundingPath('IMPLEMENTATION_PLAN.md'), false)
  assert.equal(isWorkspaceGroundingPath('docs/ARCHITECTURE.md'), false)
  assert.equal(isWorkspaceGroundingPath('.agi/NOTES.md'), false)
  assert.equal(isWorkspaceGroundingPath('.agi/subagents/abc/outcome.md'), false)
  // 生成物与依赖树一律排除，哪怕扩展名合格。
  assert.equal(isWorkspaceGroundingPath('node_modules/pkg/index.js'), false)
  assert.equal(isWorkspaceGroundingPath('.git/hooks/pre-commit'), false)
  assert.equal(isWorkspaceGroundingPath('browser/.venv/bin/activate.py'), false)
  // 空值与非字符串不崩溃，直接不算。
  assert.equal(isWorkspaceGroundingPath(''), false)
  assert.equal(isWorkspaceGroundingPath(undefined), false)
  // 仓库里真正的脚本与源码算数；Windows 反斜杠先归一化。
  assert.equal(isWorkspaceGroundingPath('scripts/inject-supervisor.mjs'), true)
  assert.equal(isWorkspaceGroundingPath('scripts\\sync-preset-patch.mjs'), true)
  assert.equal(isWorkspaceGroundingPath('lib/goal.js'), true)
})

test('continuation policy gates paused updates, completed goals, and grounding hoisting', () => {
  const base = {
    text: 'continue our quest',
    hasDurableMission: true,
    goalPhase: undefined,
    goalChecked: false,
  }
  // paused 之下 update_goal 仍要先查 goal，查过才放行。
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'paused', toolName: 'update_goal' }), 'require-goal-check')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'paused', goalChecked: true, toolName: 'update_goal' }), 'allow')
  // complete 不是 active：写操作继续被拦，必须重新 start_goal。
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'complete', toolName: 'bash' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'complete', goalChecked: true, toolName: 'start_goal' }), 'allow')
  // 其余白名单工具不因未查 goal 而被拦 —— 勘察本身就是被鼓励的第一步。
  for (const name of ['get_goal', 'read', 'glob', 'grep', 'mnemon_recall']) {
    assert.equal(continuationToolDecision({ ...base, toolName: name }), 'allow', name)
  }
  // workspaceGroundingRequired 为假时，grounded 与否都不额外设卡。
  assert.equal(continuationToolDecision({
    ...base, goalChecked: true, toolName: 'start_goal', workspaceGroundingRequired: false, workspaceGrounded: false,
  }), 'allow')
  // 接地已达成时，即便 required 也不再拦。
  assert.equal(continuationToolDecision({
    ...base, goalChecked: true, toolName: 'start_goal', workspaceGroundingRequired: true, workspaceGrounded: true,
  }), 'allow')
  // 非续行请求完全不受影响。
  assert.equal(continuationToolDecision({
    text: 'what changed in the config?', hasDurableMission: true, goalPhase: undefined, toolName: 'bash', goalChecked: false,
  }), 'unrestricted')
})


// ---------------------------------------------------------------------------
// 系统持有（system hold）：判据是「谁停的」，不是「谁在问」
//
// 看门狗连续空转时用 `goals.block(…, { code: 'idle' })` 停目标 —— 带原因码，重启后
// 仍读得到。既然「为什么停」被持久化了，恢复的授权就该读它：插件自己停的，插件自己
// 开；人停的（paused）、模型自报阻塞的（model-reported），仍然只有人能解除。
// ---------------------------------------------------------------------------

test('SYSTEM_HOLD_CODES：只有看门狗的空转判停算系统持有', () => {
  assert.deepEqual(SYSTEM_HOLD_CODES, ['idle'])

  assert.equal(isSystemHeld({ phase: 'blocked', blockedReason: { code: 'idle' } }), true)
  // 人类暂停：决定是人做的，系统不替人撤销。
  assert.equal(isSystemHeld({ phase: 'paused' }), false)
  // 模型自报阻塞：需要一个成年人拍板，不是「空转」。
  assert.equal(isSystemHeld({ phase: 'blocked', blockedReason: { code: 'model-reported' } }), false)
  assert.equal(isSystemHeld({ phase: 'blocked' }), false)
  assert.equal(isSystemHeld({ phase: 'active' }), false)
  assert.equal(isSystemHeld({ phase: 'complete' }), false)
  assert.equal(isSystemHeld(undefined), false)
  assert.equal(isSystemHeld(null), false)
  assert.equal(isSystemHeld('blocked'), false)
})

test('deriveGoalActionAuthority：system-hold 只对 resume 成立，人开口永远压过它', () => {
  const held = { phase: 'blocked', blockedReason: { code: 'idle', message: '连续空转' } }

  // 系统停的、系统开：这是本方案唯一的自动通道。
  assert.equal(deriveGoalActionAuthority({ action: 'resume', directHuman: false, goal: held }), 'system-hold')
  // 武装新目标与按住循环都在移动自主活动的边界，只有人能决定。
  assert.equal(deriveGoalActionAuthority({ action: 'start', directHuman: false, goal: held }), 'reject')
  assert.equal(deriveGoalActionAuthority({ action: 'pause', directHuman: false, goal: held }), 'reject')
  // 人停的目标不能自动恢复。
  assert.equal(deriveGoalActionAuthority({ action: 'resume', directHuman: false, goal: { phase: 'paused' } }), 'reject')
  // 人开口时永远是人，连空转判停也不改变这一点。
  assert.equal(deriveGoalActionAuthority({ action: 'resume', directHuman: true, goal: held }), 'direct-human')
  assert.equal(deriveGoalActionAuthority({ action: 'start', directHuman: true, goal: undefined }), 'direct-human')
  // 缺省不猜：没有凭证就是拒绝。
  assert.equal(deriveGoalActionAuthority(), 'reject')
  assert.equal(deriveGoalActionAuthority({ action: 'resume', goal: undefined }), 'reject')
})

test('deriveGoalActionDenial：说清现场，而不是只丢一句权限不足', () => {
  const start = deriveGoalActionDenial('start', undefined)
  assert.match(start, /start_goal 需要一个直接人类回合/)
  // 文案必须点名那几类非人类回合 —— 报错长在「权限」上的根因就在这里。
  for (const word of ['定时唤醒', 'goal 回合', '插件通知', '子 agent']) {
    assert.match(start, new RegExp(word))
  }

  assert.match(deriveGoalActionDenial('pause', { phase: 'active' }), /只有人能把正在跑的循环按住/)
  assert.match(deriveGoalActionDenial('resume', undefined), /没有可恢复的 goal/)
  assert.match(deriveGoalActionDenial('resume', { phase: 'paused' }), /被人暂停/)
  // 停在别的原因码上时，把那个码原文报出来，而不是含糊成「不可恢复」。
  assert.match(
    deriveGoalActionDenial('resume', { phase: 'blocked', blockedReason: { code: 'model-reported' } }),
    /model-reported/,
  )
  assert.match(deriveGoalActionDenial('resume', { phase: 'blocked' }), /需要一个直接人类回合/)
})
