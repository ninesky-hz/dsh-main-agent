/**
 * Pure worker-model policy helpers shared by the guarded subagent tool and its
 * dependency-free tests.
 */

/** Settings/tool sentinel for explicitly following the calling turn's route. */
export const RUNTIME_MODEL_KEY = 'runtime/current'

/** Settings sentinel that omits an effort and lets the adapter/provider decide. */
export const WORKER_EFFORT_PROVIDER_DEFAULT = 'provider/default'

/**
 * Global tools that must never enter a supervisor worker's catalog.
 *
 * A child-local ask_user_question waits inside the worker session and emits no
 * subagent-report wakeup. The native continuable `report` tool is registered
 * in child scope after global restrictions, so it remains the sole upward
 * question and progress channel.
 */
export const WORKER_DENIED_TOOLS = Object.freeze([
  'ask_user_question',
])

/** Return a fresh restriction object for the durable SubagentRequest. */
export function workerToolFilter() {
  return { deny: [...WORKER_DENIED_TOOLS] }
}

/** Canonical `provider/model-id` key for one resolved catalog entry. */
export function workerModelKey(entry) {
  return `${entry.provider}/${entry.id}`
}

/** Human-readable route plus native input modalities and optional user policy. */
export function workerModelLabel(entry, configuredEffort) {
  const policyLabel = typeof configuredEffort === 'string'
    ? `; configured effort ${configuredEffort}`
    : ''
  if (entry.runtime === true) {
    return `${RUNTIME_MODEL_KEY}  [current turn: model and capabilities resolved at call time${policyLabel}]`
  }
  const efforts = entry.reasoning?.efforts?.map(effort => effort.id) ?? []
  const effortLabel = efforts.length === 0 ? '' : `; effort ${efforts.join('/')}`
  return `${workerModelKey(entry)}  [${entry.modalities.join(',')}${effortLabel}${policyLabel}]`
}

/**
 * Read the exact route already captured for the request executing this tool.
 * Deliberately do not fall back to `agent.options`: those are creation-time
 * defaults and can be stale after live model selection changes.
 */
export function currentRuntimeModel(agent) {
  const config = agent?.session?.requestHeader?.()?.config
  if (typeof config?.provider !== 'string' || config.provider.length === 0
    || typeof config?.model !== 'string' || config.model.length === 0) {
    throw new Error(
      '当前回合的运行时模型路由不可用 —— runtime/current 绝不回退到会话创建时的模型',
    )
  }
  return {
    provider: config.provider,
    model: config.model,
  }
}

/** Detach native reasoning metadata before it enters a tool schema snapshot. */
export function workerReasoningInfo(reasoning) {
  if (!Array.isArray(reasoning?.efforts)) return undefined
  return {
    efforts: reasoning.efforts
      .filter(effort => typeof effort?.id === 'string' && effort.id.length > 0)
      .map(effort => ({
        id: effort.id,
        name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
        ...typeof effort.description === 'string' && effort.description.length > 0
          ? { description: effort.description }
          : {},
      })),
    ...typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort.length > 0
      ? { defaultEffort: reasoning.defaultEffort }
      : {},
  }
}

/**
 * Resolve and validate the settings-owned effort for one selected worker
 * route. A missing value is provider/default. A fixed value must be advertised
 * by that exact model; omission is the only representation of provider default.
 */
export function resolveWorkerEffort(policy, selected) {
  const configured = typeof policy === 'string' && policy.length > 0
    ? policy
    : WORKER_EFFORT_PROVIDER_DEFAULT
  let effort
  if (configured === WORKER_EFFORT_PROVIDER_DEFAULT) {
    effort = undefined
  } else {
    effort = configured
  }

  if (effort !== undefined) {
    const supported = selected.reasoning?.efforts?.map(entry => entry.id) ?? []
    if (!supported.includes(effort)) {
      throw new Error(
        `worker 推理强度 "${effort}" 不被 ${selected.key} 支持 —— `
        + (supported.length === 0
          ? '该模型未公布任何可选的推理强度；请使用 provider/default'
          : `可用值：${supported.join(', ')}`),
      )
    }
  }

  return {
    policy: configured,
    label: configured,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
}

/**
 * Resolve an exact settings-owned route. Bare ids and implicit inheritance are
 * deliberately unsupported: the tool call must visibly carry the route that
 * the user approved.
 */
export function selectWorkerModel(value, allowlist) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      '必须指定 model —— 请从 Settings -> Plugins -> dsh-main-agent 中选择一个条目',
    )
  }
  const selected = allowlist.find(entry => value === workerModelKey(entry))
  if (selected === undefined) {
    if (allowlist.length === 0) {
      throw new Error(
        '用户未允许任何 worker 模型 —— 请在派生之前于 Settings -> Plugins -> dsh-main-agent 中添加 runtime/current 或一个固定路由',
      )
    }
    throw new Error(
      `model "${value}" 不在用户的 worker 白名单中 —— 允许的模型：\n`
      + allowlist.map(workerModelLabel).join('\n'),
    )
  }
  if (selected.runtime === true) {
    return { key: RUNTIME_MODEL_KEY, runtime: true }
  }
  return {
    key: workerModelKey(selected),
    provider: selected.provider,
    model: selected.id,
    modalities: [...selected.modalities],
    ...selected.reasoning === undefined ? {} : { reasoning: workerReasoningInfo(selected.reasoning) },
  }
}
