/**
 * dsh-main-agent — `check_outcome` 工具。
 *
 * 只负责把父代理的调用翻译成 `checks.js` 的读取与执行，并渲染结果。纯逻辑
 * 全在 `checks.js`，那个文件不 import 宿主包，测试可以脱离 node_modules 跑。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { describe, readChecks, runChecks } from './checks.js'
import { enqueue } from './outbox.js'

export const name = 'dsh-main-agent-checks'
export const inject = ['tools']

const isNonEmptyString = value => typeof value === 'string' && value.length > 0

/**
 * Register `check_outcome`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'check_outcome',
    description:
      '跑一个 worker 写在 .agi/subagents/<session id>/checks.json 里的验收清单，返回每条断言的通过与失败。'
      + '清单是 worker 自己写的，所以它只是证据来源之一，不能替代你亲自读 outcome.md 与最终消息。'
      + '没有清单、清单读不出来、或某条命令超时，都会如实报告成失败或错误，绝不当成通过。'
      + '人工项（note）一律返回 manual，不参与通过计数 —— 那些必须你自己看。',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'worker 的 session id（派生时返回的那个，同时是 outcome.md 所在目录名）。',
      },
      only: {
        type: 'string',
        description: '可选：只跑这些 id，用逗号分隔。用来先看关键的那几条。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          passed: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          manual: { type: 'number', required: true },
          failedIds: { type: 'array', items: { type: 'string' }, required: true },
          // 逐条断言的明细。历史坑：这个字段一度叫 `render` 并被直接塞进
          // `execute` 的返回值 —— 但 `render` 不在 schema 里，dsh-tools 会
          // 以 `returned invalid output: "value.render" is not a declared
          // property (additionalProperties: false)` 拒收**整个**结果，
          // 于是 check_outcome 每一次调用都失败（0.2.x 实测）。明细必须
          // 作为已声明字段返回，由下面的 render(…) 打印。
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [`验收：${value.total} 条里 ${value.passed} 条通过，${value.failed} 条失败，${value.manual} 条需要你自己看。`]
        if (value.failedIds.length > 0) lines.push(`失败项：${value.failedIds.join(', ')}`)
        if (isNonEmptyString(value.detail)) lines.push(value.detail)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!isNonEmptyString(cwd)) throw new Error('check_outcome 需要调用方的会话工作区')

      const { entries, path, error } = readChecks(cwd, args.session_id)
      if (error !== undefined) {
        // 清单缺失本身不是「失败」，但也不能算通过 —— 用一条显式失败占位，
        // 让父代理在计数里看到「这里没有证据」。
        return {
          total: 1,
          passed: 0,
          failed: 1,
          manual: 0,
          failedIds: ['checks'],
          detail: `${error}（${path}）`,
        }
      }

      const wanted = typeof args.only === 'string'
        ? new Set(args.only.split(',').map(part => part.trim()).filter(part => part.length > 0))
        : undefined
      const selected = wanted === undefined ? entries : entries.filter((entry, index) => {
        const id = isNonEmptyString(entry.id) ? entry.id : `#${index + 1}`
        return wanted.has(id)
      })
      if (selected.length === 0) {
        return {
          total: 0,
          passed: 0,
          failed: 0,
          manual: 0,
          failedIds: [],
          detail: wanted === undefined ? '清单是空的' : '选中的 id 没有对应的检查',
        }
      }

      const results = await runChecks(selected, { cwd, signal: exec.signal })
      const passed = results.filter(result => result.status === 'pass').length
      const failed = results.filter(result => result.status === 'fail' || result.status === 'error').length
      const manual = results.filter(result => result.status === 'manual').length
      const failedIds = results
        .filter(result => result.status === 'fail' || result.status === 'error')
        .map(result => result.id)

      // 验收有失败项是「必须让主 Agent 知道」的事实：它决定了这一轮该返工还是
      // 该收尾。工具结果当然会回给调用方，但如果这一轮随后被打断，那条结果就
      // 只留在被打断的上下文里 —— 落一份到 outbox，下一次 BRIEF 还会说出来。
      // 幂等键带上失败项集合：同一批失败重复查验不会堆出一串重复 entry，而
      // 失败项变了就是一件新事。
      if (failed > 0) {
        const queued = enqueue(cwd, {
          kind: 'check-failed',
          dedupeKey: `${args.session_id}:${failedIds.join(',')}`,
          detail: { sessionId: args.session_id, failedIds },
        })
        if (queued.ok !== true) {
          ctx.logger?.warn?.(`dsh-main-agent: 验收失败入队失败（不影响结果）：${queued.error}`)
        }
      }

      return {
        total: results.length,
        passed,
        failed,
        manual,
        failedIds,
        detail: results.map(describe).join('\n'),
      }
    },
  }))
}
