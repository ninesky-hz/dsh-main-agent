/**
 * agents-compat — 跨代读「顶层 agent 列表」。
 *
 * dsh 0.2.2-rc.2 及更早，`ctx.agents` 是带 `roots()` 的 AgentRegistry；rc.3 起
 * 公开面只剩 `get(id)` / `list()` —— 见 @deepseek-ai/dsh-agent
 * `lib/types/index.d.ts:199` 的 `AgentRegistry`，方法集合里已经没有 roots。
 *
 * 本插件用这个判断做三件事：`humanMessages`（哪些消息算人类直发）、派生的
 * 「人的消息」预留槽、以及 grounding 记账。旧代码直接写 `ctx.agents.roots()`：
 * 在 rc.3 上 `tools/pre-execute` 的监听器每次工具调用都抛
 * `ctx.agents.roots is not a function`，整条工具链在到达工具之前就断了 ——
 * 一个布尔判断不该有这么大的杀伤半径，所以这里把两代读法收进一处。
 *
 * 取法顺序：
 *   1. `roots()` 是函数就用它（旧宿主语义原样保留，包括返回空数组）；
 *   2. 否则用 `list()` 过滤顶层 agent；
 *   3. 两个都拿不到就返回 `[]`，永不抛。
 *
 * fail-open 的方向是「不认作顶层」——保守：不会把子 agent 的消息当人类消息，
 * 也不会因为读不到注册表就多放行一个派生。
 */

/**
 * 顶层 agent = 不是 subagent 来源、委派深度为 0（缺席即 0）。
 *
 * `meta.origin` 是产品分类，`meta.delegationDepth` 是持久化的递归预算深度；
 * 普通 fork 会带 `parentSession` 但两者都不带，仍然是顶层，这与旧 `roots()`
 * 的语义一致。
 */
export function isRootAgent(agent) {
  const meta = agent?.session?.meta
  if (meta === undefined || meta === null) return false
  if (meta.origin === 'subagent') return false
  const depth = meta.delegationDepth
  return depth === undefined || depth === null || depth === 0
}

/** 当前存活的所有顶层 agent；读不到就是空数组，不抛。 */
export function listRootAgents(ctx) {
  const agents = ctx?.agents
  if (agents === undefined || agents === null) return []
  if (typeof agents.roots === 'function') {
    try {
      const roots = agents.roots()
      if (Array.isArray(roots)) return roots
    } catch {
      // 旧宿主上 roots() 也可能因为初始化没完成而抛：继续走 list()，
      // 两个读法都试过才认「读不到」这个结论。
    }
  }
  if (typeof agents.list === 'function') {
    try {
      const live = agents.list()
      if (Array.isArray(live)) return live.filter(isRootAgent)
    } catch {
      // 落到最后的 []：宁可当没有顶层，也不把异常抛进工具链。
    }
  }
  return []
}

/** 这次工具调用的发起方是不是一个活的顶层 agent。 */
export function isRootExecution(ctx, agent) {
  if (agent === undefined || agent === null) return false
  return listRootAgents(ctx).includes(agent)
}
