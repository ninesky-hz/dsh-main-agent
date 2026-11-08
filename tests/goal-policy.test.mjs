import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  continuationToolDecision,
  isGoalSetupSafeTool,
  isLongRunningContinuation,
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
