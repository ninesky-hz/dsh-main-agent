/**
 * dsh-main-agent — `list_agents`.
 *
 * 为什么本包自己带一份：`@deepseek-ai/dsh-tool-subagent-control` 在 0.1 系列
 * 把三个控制面工具拆成子路径导出（`./list-agents`、`./interrupt`…），main-agent
 * preset 因此可以把 `list_agents` 单独挂一行、把 `send_message` /
 * `interrupt_agent` 换成本包的 `dsh-main-agent/control`（它会给运行中的直接
 * child 做 step 级纠偏）。0.2.2 把包根改成一个注册全部三个工具的插件，
 * `./list-agents` 子路径消失了 —— preset 那一行会在挂载时 import 失败。
 *
 * 直接把包根挂进 preset 也不行：它会把 `send_message` / `interrupt_agent`
 * 一并注册，和 `dsh-main-agent/control` 撞名。所以这里只保留 `list_agents`
 * 一个工具，契约（参数、输出 schema、渲染文本、诊断行）与宿主实现一致：
 *   - children（默认）：直接子级，任何状态都可以 send_message；
 *   - descendants：整棵子树，带 parent/depth，深度 > 1 只能 interrupt_agent。
 *
 * 存活判定只看 live Agent 注册表的 status；目录本身是持久投影，不报告活性。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listChildrenOf, listDescendantsOf } from './subagent-compat.js'

export const name = 'dsh-main-agent-list-agents'
export const inject = ['tools', 'subagents', 'agents']

/** Resolve the optional model request into an internal required-scope spec. */
function resolveRequest(request) {
  return { scope: request?.scope ?? 'children' }
}

/**
 * Report turn activity without exposing whether the child is loaded.
 *
 * The live registry is authoritative; rc.2's catalog also carries `activity`,
 * which still reports a child that is running before its Agent materialized in
 * this process. 0.2.1 rows have neither, so they fall back to `inactive`.
 */
function statusOf(agents, id, entry) {
  if (agents.get(id)?.status === 'running') return 'running'
  return entry?.activity === 'running' ? 'running' : 'inactive'
}

/**
 * The model-facing handle for one child.
 *
 * rc.2 addresses agents by NAME: a named child is reachable as `reviewer`, a
 * grandchild as `reviewer/checker`, and team tasks resolve their `owner` the
 * same way. The catalog's `path` is absent when this child or an ancestor below
 * the root was spawned unnamed, and `resolveName()` passes an unknown bare token
 * through as an id — so falling back to the id keeps every row addressable.
 */
function handleOf(entry) {
  if (typeof entry.path === 'string' && entry.path !== '') return entry.path
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name
  return entry.id
}

/** Project one service row into the model-facing entry, or omit a one-shot child. */
function project(agents, entry, position) {
  const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth }
  if (entry.kind === 'diagnostic') {
    return { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at }
  }
  if (entry.mode !== 'continuable') return undefined
  return {
    kind: 'child',
    id: entry.id,
    name: handleOf(entry),
    label: entry.label,
    status: statusOf(agents, entry.id, entry),
    ...at,
  }
}

function projectAll(agents, entries, withPosition) {
  const rows = Array.isArray(entries) ? entries : []
  return rows
    .map(entry => project(agents, entry, withPosition ? entry : undefined))
    .filter(entry => entry !== undefined)
}

/**
 * Register `list_agents`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'list_agents',
    description:
      '列出你启动过的 subagent：名字（name）、id、label 与状态。name 就是 send_message / interrupt_agent '
      + '要用的地址 —— 多层子级是 `父名/子名` 这样的路径名，没有名字的子级回落到它的 id。'
      + 'running 表示它正在工作，inactive 表示当前没在工作。'
      + 'subagent 结束时你会收到通知，不需要反复轮询。继续对话用 send_message。',
    parameters: {
      scope: {
        type: 'string',
        enum: ['children', 'descendants'],
        description: 'children（默认）列出直接子级，任何状态都可以 send_message；'
          + 'descendants 列出整棵子树，每项带 parent session id 与 depth，深度大于 1 的只能 interrupt_agent。',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['child'] },
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                label: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['running', 'inactive'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['diagnostic'] },
                id: { type: 'string', required: true },
                reason: {
                  type: 'string',
                  required: true,
                  enum: ['corrupt', 'unsupported', 'unavailable'],
                },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
          ],
        },
      },
      render: (args, entries) => {
        const request = resolveRequest(args)
        const rows = Array.isArray(entries) ? entries : []
        return [{
          type: 'text',
          text: rows.length === 0 ? '(no subagents)' : rows.map(entry => {
            const at = request.scope === 'descendants'
              ? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
              : ''
            return entry.kind === 'child'
              ? `${entry.name} (${entry.id}) [${entry.status}]${at} — ${entry.label}`
              : `${entry.id} [diagnostic: ${entry.reason}]${at}`
          }).join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('list_agents requires a calling agent (exec.agent was undefined)')
      const request = resolveRequest(args)
      // Both readers live in lib/subagent-compat.js: rc.2 answers a subtree
      // natively, 0.2.1 rebuilds it from the direct-child catalog.
      if (request.scope === 'descendants') {
        const entries = await listDescendantsOf(ctx, parent.id, exec.signal)
        return projectAll(ctx.agents, entries, true)
      }
      const entries = await listChildrenOf(ctx, parent.id, exec.signal)
      return projectAll(ctx.agents, entries, false)
    },
  }))
}
