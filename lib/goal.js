/**
 * dsh-main-agent — reviewable, non-blocking goal frontend.
 *
 * The Harness goal service and round driver remain authoritative for durable
 * state, projections, continuation, cancellation, and race fencing. This
 * plugin replaces only the model-facing frontend so every autonomous mission
 * gets a durable GOAL.md without forcing a second human confirmation turn.
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { HarnessError, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  continuationToolDecision,
  isWorkspaceGroundingPath,
  normalizedGoalList,
  normalizedGoalText,
  normalizedRoundCap,
  renderGoalMarkdown,
} from './goal-policy.js'
import { sessionEvents } from './session-events.js'

export const name = 'dsh-main-agent-goal'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt']

const DEFAULT_MAX_GOAL_ROUNDS = 256
const BLOCKED_AFTER_ROUNDS = 3

const GOAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { goal: { type: 'null', required: true } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            revision: { type: 'integer', required: true },
            objective: { type: 'string', required: true },
            phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
            roundsStarted: { type: 'integer', required: true },
            maxGoalRounds: { type: 'integer', required: true },
            blockedReason: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
      },
    },
  ],
}

const GOAL_OUTPUT = {
  schema: GOAL_VALUE_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function goalValue(goal) {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
    },
    activation: goal.activation,
  }
}

function reject(message, code = 'SUPERVISOR_GOAL_POLICY') {
  throw new HarnessError(message, code)
}

/** Authenticate the exact live caller and return its current open turn. */
function goalExecution(ctx, exec) {
  const agent = exec.agent
  if (agent === undefined) reject('goal 工具需要一个调用方 agent', 'SUPERVISOR_GOAL_AGENT_REQUIRED')
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    reject('goal 工具需要正处于其活动驱动器内的、确切存活的调用方 agent', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
  }
  // dsh 0.2 Sessions expose the log only through `snapshotEvents()`; the plain
  // `session.events` field no longer exists, and reading it made `events.length`
  // throw a TypeError on the very first tool call. `sessionEvents` owns the
  // revision-tolerant read and stays fail-open.
  const events = sessionEvents(agent.session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') reject('goal 工具需要一个未结束的模型回合', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
    if (boundary?.type === 'turn/start') {
      return { agent, start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('goal 工具需要一个未结束的模型回合', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
}

function humanMessages(ctx, execution) {
  if (!ctx.agents.roots().includes(execution.agent)) return []
  return execution.events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
}

function requireDirectHuman(ctx, execution) {
  const messages = humanMessages(ctx, execution)
  if (messages.length === 0) reject('该 goal 操作需要一个直接人类回合，且必须位于顶层 agent 上')
  return messages
}

function isMatchingGoalRound(execution, goal) {
  return execution.events.some(event => event.type === 'user/message'
    && event.data?.source?.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

function completionAuthority(ctx, execution) {
  if (humanMessages(ctx, execution).length > 0) return { kind: 'direct-human' }
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal)) return { kind: 'goal-round', goal }
  return reject('complete 与 blocked 需要一个直接人类回合，或当前已准入的 goal 回合')
}

function goalPaths(agent) {
  const cwd = resolve(agent.session.header.cwd)
  const agi = join(cwd, '.agi')
  return {
    goal: join(agi, 'GOAL.md'),
    archive: join(agi, 'goals'),
  }
}

function workspaceRelativePath(agent, filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return undefined
  const cwd = resolve(agent.session.header.cwd)
  const absolute = resolve(cwd, filePath)
  const candidate = relative(cwd, absolute)
  if (candidate === '' || candidate === '..' || candidate.startsWith('../') || candidate.startsWith('..\\')) {
    return undefined
  }
  return candidate
}

function isGroundingRead(agent, exec) {
  if (exec.name !== 'read' || typeof exec.arguments !== 'object' || exec.arguments === null) return false
  const candidate = workspaceRelativePath(agent, exec.arguments.file_path)
  return candidate !== undefined && isWorkspaceGroundingPath(candidate)
}

/** Bounded discovery only decides whether a relevant file exists; the model must still open it. */
function workspaceHasGroundingMaterial(agent) {
  const cwd = resolve(agent.session.header.cwd)
  const pending = [{ absolute: cwd, relative: '', depth: 0 }]
  let visited = 0
  while (pending.length > 0 && visited < 5000) {
    const current = pending.pop()
    let entries
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      const candidate = current.relative === '' ? entry.name : join(current.relative, entry.name)
      if (entry.isFile() && isWorkspaceGroundingPath(candidate)) return true
      if (entry.isDirectory() && current.depth < 4 && isWorkspaceGroundingPath(join(candidate, 'probe.js'))) {
        pending.push({ absolute: join(current.absolute, entry.name), relative: candidate, depth: current.depth + 1 })
      }
      if (visited >= 5000) break
    }
  }
  return false
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
}

function archiveLockedGoal(paths) {
  if (!existsSync(paths.goal)) return
  mkdirSync(paths.archive, { recursive: true })
  const archive = join(paths.archive, `GOAL-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.md`)
  renameSync(paths.goal, archive)
}

function currentTurnNumber(execution) {
  const turn = execution.start.data?.turn
  if (!Number.isSafeInteger(turn)) reject('当前回合没有有效的编号', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
  return turn
}

function messageText(message) {
  return (message.data?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function goalRef(args) {
  if (typeof args.goal_id !== 'string' || args.goal_id.trim().length === 0
    || !Number.isSafeInteger(args.revision) || args.revision < 1) {
    reject('goal_id 与 revision 必须是 get_goal 返回的确切值', 'SUPERVISOR_GOAL_INVALID_UPDATE')
  }
  return { id: args.goal_id, revision: args.revision }
}

function deferWrapup(exec, objective, blocker) {
  if (typeof exec.deferContext !== 'function') return
  const text = blocker === undefined
    ? `goal 已完成：${objective}。请给人类一份简明且证据充分的最终报告。`
    : `goal 已阻塞：${objective}。请向人类说明具体阻塞项：${blocker}`
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-main-agent',
      form: 'notice',
      summary: boundContextSummary(text),
    },
  }))
}

export function apply(ctx) {
  const checkedTurn = new WeakMap()
  const groundedTurn = new WeakMap()

  ctx.systemPrompt.section({
    name: 'dsh-main-agent:goal',
    order: 115,
    text: '本 supervisor 中的长期 goal 可审阅但不阻塞。当人类直接要求启动、恢复或继续一项任务时，先调用 get_goal。如果不存在活动的原生 goal，就检查持久任务状态以及相关的工作区 runbook/脚本，然后调用 start_goal，并给出打底最充分的 objective、constraints、milestones、out_of_scope 与回合上限。start_goal 会写出 GOAL.md、立即武装原生 goal，并把控制权交回同一个回合：继续操作性工作，而不是索要确认或结束回合。人类可以随时检查 GOAL.md，并进行纠偏、暂停或停止。在 update_goal 之前先使用 get_goal；goal 处于活动状态期间，objective 编辑始终不可用。',
  })

  // Persona text is guidance, not enforcement. On an explicit long-running
  // continuation, close mutation and external actions only until the model has
  // checked native goal state and started a reviewable native goal. Read-only
  // grounding remains available so existing runbooks, scripts, and mission
  // state can inform the goal without introducing a human confirmation stop.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.agent === undefined || !ctx.agents.roots().includes(exec.agent)) return next()
    let execution
    try {
      execution = goalExecution(ctx, exec)
    } catch {
      return next()
    }
    const latest = humanMessages(ctx, execution).at(-1)
    if (latest === undefined) return next()
    const current = ctx.goals.get(execution.agent)
    const decision = continuationToolDecision({
      text: messageText(latest),
      hasDurableMission: existsSync(goalPaths(execution.agent).goal),
      goalPhase: current?.phase,
      toolName: exec.name,
      goalChecked: checkedTurn.get(execution.agent) === currentTurnNumber(execution),
      workspaceGroundingRequired: exec.name === 'start_goal' && workspaceHasGroundingMaterial(execution.agent),
      workspaceGrounded: groundedTurn.get(execution.agent) === currentTurnNumber(execution),
    })
    if (decision === 'unrestricted' || decision === 'allow') return next()
    if (decision === 'require-goal-check') {
      return Promise.resolve({
        kind: 'deny',
        reason: '长期任务的续行需要一个当前的原生 goal 检查。请先调用 get_goal。',
      })
    }
    if (decision === 'require-workspace-grounding') {
      return Promise.resolve({
        kind: 'deny',
        reason: '在 start_goal 之前，请在本回合中打开至少一个相关的、位于 .agi 之外的工作区 runbook、自动化脚本或源文件。仅列出文件、或只读 GOAL.md/NOTES.md 都不算操作性检查。',
      })
    }
    return Promise.resolve({
      kind: 'deny',
      reason: '长期任务的续行尚未武装。请调用 get_goal，用只读工具检查持久任务状态与相关 runbook/脚本，然后调用 start_goal。它会立即武装原生 goal；请在同一回合中继续操作性工作，不要索要确认。',
    })
  }, { prepend: true })

  ctx.on('tools/post-execute', (exec, result, next) => {
    if (!result.isError && exec.agent !== undefined && ctx.agents.roots().includes(exec.agent)
      && isGroundingRead(exec.agent, exec)) {
      try {
        const execution = goalExecution(ctx, exec)
        groundedTurn.set(execution.agent, currentTurnNumber(execution))
      } catch {
        // A read that settles after its turn boundary cannot ground a later turn.
      }
    }
    return next()
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: '读取原生持久化的同会话 goal，以及它确切的 id/revision、phase、回合计数、上限与激活状态。',
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      const execution = goalExecution(ctx, exec)
      checkedTurn.set(execution.agent, currentTurnNumber(execution))
      return Promise.resolve(goalValue(ctx.goals.get(execution.agent)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'start_goal',
    description: '写出一份可审阅的 GOAL.md，并立即创建、武装原生同会话 goal。请在 get_goal 之后、于人类直接要求启动/恢复/继续时使用。不要索要单独的确认，也不要在创建成功后结束回合；请使用工作区中已有的 runbook 与脚本继续推进任务。',
    parameters: {
      objective: { type: 'string', required: true },
      constraints: { type: 'array', required: true, items: { type: 'string' } },
      milestones: { type: 'array', required: true, items: { type: 'string' } },
      out_of_scope: { type: 'array', required: true, items: { type: 'string' } },
      max_goal_rounds: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: GOAL_VALUE_SCHEMA.oneOf[1].properties.goal,
          activation: { type: 'string', required: true, enum: ['armed'] },
          goalFile: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `goal 已写入 ${value.goalFile}，并已武装为原生 goal ${value.goal.id}。现在继续推进任务；无需确认回合。`,
      }],
    },
    execute(args, exec) {
      const execution = goalExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const current = ctx.goals.get(execution.agent)
      if (current !== undefined && current.phase !== 'complete') {
        reject(`当 goal ${current.id} 处于 ${current.phase} 状态时无法启动新 goal`)
      }
      const objective = normalizedGoalText(args.objective, 'objective')
      const constraints = normalizedGoalList(args.constraints, 'constraints')
      const milestones = normalizedGoalList(args.milestones, 'milestones')
      const outOfScope = normalizedGoalList(args.out_of_scope, 'out_of_scope')
      const maxGoalRounds = normalizedRoundCap(args.max_goal_rounds, DEFAULT_MAX_GOAL_ROUNDS)
      const markdown = renderGoalMarkdown({ objective, constraints, milestones, outOfScope, maxGoalRounds })
      const paths = goalPaths(execution.agent)
      archiveLockedGoal(paths)
      atomicWrite(paths.goal, markdown)
      const goal = ctx.goals.create(execution.agent, {
        objective,
        maxGoalRounds,
      })
      return Promise.resolve({
        ...goalValue(goal),
        goalFile: paths.goal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_goal',
    description: '更新确切的原生 goal revision。pause 与 resume 需要一个直接人类回合。complete 与 blocked 需要一个直接人类回合，或当前已准入的 goal 回合。goal 处于活动状态期间，objective 编辑被有意设为不可用；变更范围可以在完成后启动一个新的 goal。',
    parameters: {
      goal_id: { type: 'string', required: true },
      revision: { type: 'number', required: true },
      action: { type: 'string', required: true, enum: ['pause', 'resume', 'complete', 'blocked'] },
      blocked_reason: { type: 'string' },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalExecution(ctx, exec)
      const ref = goalRef(args)
      if (args.action === 'pause' || args.action === 'resume') {
        requireDirectHuman(ctx, execution)
        if (typeof args.blocked_reason === 'string' && args.blocked_reason.length > 0) {
          reject('blocked_reason 仅在 action 为 blocked 时有效', 'SUPERVISOR_GOAL_INVALID_UPDATE')
        }
        const goal = args.action === 'pause'
          ? ctx.goals.pause(execution.agent, ref)
          : ctx.goals.resume(execution.agent, ref)
        return Promise.resolve(goalValue(goal))
      }
      const authority = completionAuthority(ctx, execution)
      if (args.action === 'complete' && typeof args.blocked_reason === 'string' && args.blocked_reason.length > 0) {
        reject('blocked_reason 仅在 action 为 blocked 时有效', 'SUPERVISOR_GOAL_INVALID_UPDATE')
      }
      if (args.action === 'blocked'
        && (typeof args.blocked_reason !== 'string' || args.blocked_reason.trim().length === 0)) {
        reject('action 为 blocked 时必须提供 blocked_reason', 'SUPERVISOR_GOAL_INVALID_UPDATE')
      }
      if (args.action === 'blocked' && authority.kind === 'goal-round'
        && authority.goal.roundsStarted < BLOCKED_AFTER_ROUNDS) {
        reject(`blocked 至少需要 ${BLOCKED_AFTER_ROUNDS} 个连续的 goal 回合；当前回合为 ${authority.goal.roundsStarted}`)
      }
      const goal = args.action === 'complete'
        ? ctx.goals.complete(execution.agent, ref)
        : ctx.goals.block(execution.agent, ref, {
          code: 'model-reported',
          message: args.blocked_reason.trim(),
        })
      if (authority.kind === 'goal-round') deferWrapup(exec, goal.objective, args.action === 'blocked' ? args.blocked_reason.trim() : undefined)
      return Promise.resolve(goalValue(goal))
    },
  }))
}
