/**
 * dsh-supervisor — `send_message` + `interrupt_agent`.
 *
 * Replaces the shipped `@deepseek-ai/dsh-tool-subagent-control` row in the
 * main-agent preset. Same parent-authority surface, one difference: a message
 * to a RUNNING direct child is steered at its next step (`Agent.steer()`, the
 * same built-in primitive the web UI's queue-steer action uses), so a
 * correction can redirect work already underway instead of waiting for the
 * whole turn to finish. Every other case — idle, waiting, cold-resume, or any
 * authority mismatch — goes through the native `ctx.subagents.sendMessage()`
 * unchanged. The native service itself is never modified, so the shipped
 * `subagent`/fork tools and report flows keep stock behavior.
 *
 * `list_agents` stays on the shipped plugin.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-supervisor-control'
export const inject = ['tools', 'subagents', 'agents']

/**
 * Register `send_message` and `interrupt_agent`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      '按 subagent id 向一个后台 subagent 发送消息，继续同一个对话。若它仍在工作，消息会在其当前回合的下一步汇入，'
      + '因此可以改变已经开展的工作的走向 —— 不要等子级结束，也不要中断，除非当前回合必须立刻停止。'
      + '若它空闲，消息会启动它的下一轮。本次调用不返回 subagent 的任何回答 —— 只返回消息已投递的确认。'
      + '失败意味着消息没有被投递。',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: '启动该后台 subagent 时返回的 subagent id。',
      },
      message: {
        type: 'string',
        required: true,
        description: '要投递给该 subagent 的消息。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `消息已投递给 subagent ${args.subagent_id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('send_message 需要一个调用方 agent（exec.agent 为 undefined）')
      }
      const childId = SessionId(args.subagent_id)
      const content = [{ type: 'text', text: args.message }]
      const source = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }

      // Fast path: the child is live and mid-turn, and this caller is its
      // exact live direct parent — steer into the current turn's next step.
      // The authority predicate mirrors the service's own lineage check
      // (`parentSession === parent.id` + exact live parent); any mismatch or
      // idle/absent child falls through to the native delivery, which owns
      // wake, cold resume, and the authoritative rejection.
      const child = ctx.agents.get(childId)
      if (
        child !== undefined
        && child.status === 'running'
        && ctx.agents.get(parent.id) === parent
        && child.session.header.parentSession === parent.id
      ) {
        exec.signal?.throwIfAborted?.()
        const message = createUserMessage({ content, source })
        child.steer(message)
        // If the child left the registry in the same tick (settlement raced
        // the steer, dispose clears the inbox), re-deliver through the native
        // path so the message is not silently lost.
        if (ctx.agents.get(childId) === child) return { messageId: message.id }
      }

      // `sendMessage` steers a running target at its nearest step, starts a
      // turn for an idle one, and cold-resumes an absent continuable child;
      // attribution is derived from the exact live sender. It requires the
      // signal, so pass the tool's.
      const messageId = await ctx.subagents.sendMessage(parent, childId, content, {
        signal: exec.signal,
      })
      return { messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      '按 agent id 请求取消一个后台 agent 的当前回合。目标可以是你的直接子级，'
      + '也可以是挂在你下面更深层的 agent。只有当前回合会停止：已经排队给该 agent 的消息会一直停泊，'
      + '直到之后再发一次 send_message；它启动的 agent 会继续运行，'
      + '而该 agent 本身仍然可以接受后续消息。本次调用在停止请求被接受后立即返回，'
      + '所以目标可能还会短暂运行；去中断一个已经结束的 agent 属于被接受的无操作。',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: '要中断的那个正在运行的 agent 的 agent id。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `已请求中断 agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        throw new Error('interrupt_agent 需要一个调用方 agent（exec.agent 为 undefined）')
      }
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
