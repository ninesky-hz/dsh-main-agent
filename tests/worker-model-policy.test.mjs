import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  currentRuntimeModel,
  hostUsesModelSelection,
  pinWorkerEffort,
  resolveWorkerEffort,
  RUNTIME_MODEL_KEY,
  selectWorkerModel,
  WORKER_EFFORT_PROVIDER_DEFAULT,
  WORKER_DENIED_TOOLS,
  workerToolFilter,
  workerModelKey,
  workerModelLabel,
} from '../lib/worker-model-policy.js'

const allowed = [
  {
    provider: 'antigravity', id: 'gemini-3.7-flash', modalities: ['text', 'image'],
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
  },
  { provider: 'zai', id: 'glm-5.3', modalities: ['text'] },
]

test('an exact settings-approved route produces explicit child agent options', () => {
  assert.equal(workerModelKey(allowed[0]), 'antigravity/gemini-3.7-flash')
  assert.equal(workerModelLabel(allowed[0]), 'antigravity/gemini-3.7-flash  [text,image; effort low/medium/high]')
  assert.deepEqual(selectWorkerModel('antigravity/gemini-3.7-flash', allowed), {
    key: 'antigravity/gemini-3.7-flash',
    provider: 'antigravity',
    model: 'gemini-3.7-flash',
    modalities: ['text', 'image'],
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
  })
})

test('omission and bare ids cannot fall through to parent-model inheritance', () => {
  assert.throws(() => selectWorkerModel(undefined, allowed), /必须指定 model/)
  assert.throws(() => selectWorkerModel('', allowed), /必须指定 model/)
  assert.throws(
    () => selectWorkerModel('gemini-3.7-flash', allowed),
    /不在用户的 worker 白名单中/,
  )
})

test('a removed or otherwise unapproved route is rejected with only current choices', () => {
  assert.throws(
    () => selectWorkerModel('zai123/glm-5.3', [allowed[0]]),
    error => {
      assert.match(error.message, /zai123\/glm-5\.3.*不在用户的 worker 白名单中/s)
      assert.match(error.message, /antigravity\/gemini-3\.7-flash  \[text,image; effort low\/medium\/high\]/)
      assert.doesNotMatch(error.message, /zai\/glm-5\.3/)
      return true
    },
  )
})

test('an empty settings allowlist disables worker selection', () => {
  assert.throws(
    () => selectWorkerModel('antigravity/gemini-3.7-flash', []),
    /用户未允许任何 worker 模型/,
  )
})

test('runtime/current is an explicit allowlist choice resolved from the current request header', () => {
  const runtime = {
    provider: 'runtime',
    id: 'current',
    modalities: [],
    runtime: true,
  }
  assert.equal(RUNTIME_MODEL_KEY, 'runtime/current')
  assert.equal(
    workerModelLabel(runtime),
    'runtime/current  [current turn: model and capabilities resolved at call time]',
  )
  assert.deepEqual(selectWorkerModel(RUNTIME_MODEL_KEY, [runtime]), {
    key: RUNTIME_MODEL_KEY,
    runtime: true,
  })
  assert.deepEqual(currentRuntimeModel({
    options: { provider: 'stale', model: 'creation-model' },
    session: {
      requestHeader: () => ({
        config: { provider: 'antigravity', model: 'gemini-3.1-pro' },
      }),
    },
  }), {
    provider: 'antigravity',
    model: 'gemini-3.1-pro',
  })
})

test('worker effort supports only settings-owned provider default and fixed values', () => {
  const selected = selectWorkerModel('antigravity/gemini-3.7-flash', allowed)
  assert.equal(WORKER_EFFORT_PROVIDER_DEFAULT, 'provider/default')
  assert.deepEqual(resolveWorkerEffort(undefined, selected), {
    policy: WORKER_EFFORT_PROVIDER_DEFAULT,
    label: 'provider/default',
  })
  assert.deepEqual(resolveWorkerEffort(WORKER_EFFORT_PROVIDER_DEFAULT, selected), {
    policy: WORKER_EFFORT_PROVIDER_DEFAULT,
    label: 'provider/default',
  })
  assert.deepEqual(resolveWorkerEffort('medium', selected), {
    policy: 'medium',
    label: 'medium',
    reasoningEffort: 'medium',
  })
})

test('worker effort fails closed when the exact selected model does not advertise it', () => {
  const selected = selectWorkerModel('antigravity/gemini-3.7-flash', allowed)
  assert.throws(
    () => resolveWorkerEffort('max', selected),
    /推理强度 "max".*不被.*支持.*可用值：low, medium, high/,
  )
  const noReasoning = selectWorkerModel('zai/glm-5.3', allowed)
  assert.throws(
    () => resolveWorkerEffort('high', noReasoning),
    /未公布任何可选的推理强度；请使用 provider\/default/,
  )
})

test('current runtime route deliberately ignores the main request effort', () => {
  assert.deepEqual(currentRuntimeModel({
    session: { requestHeader: () => ({ config: {
      provider: 'antigravity', model: 'gemini-3.7-flash', reasoningEffort: 'high',
    } }) },
  }), {
    provider: 'antigravity', model: 'gemini-3.7-flash',
  })
})

test('runtime/current fails closed instead of using stale agent options', () => {
  assert.throws(
    () => currentRuntimeModel({
      options: { provider: 'zai123', model: 'glm-5.3' },
      session: { requestHeader: () => undefined },
    }),
    /绝不回退到会话创建时的模型/,
  )
})

test('fresh-install settings and catalog include runtime/current by default', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /workerModels: \[RUNTIME_MODEL_KEY\]/)
  assert.match(source, /workerEfforts: \{ \[RUNTIME_MODEL_KEY\]: WORKER_EFFORT_PROVIDER_DEFAULT \}/)
  assert.doesNotMatch(source, /workerEffort:/)
  assert.match(source, /name: 'Current runtime model'/)
  assert.match(source, /dynamic: true/)
  assert.match(source, /resolveModelInfo\(model.provider, model.id\)/)
  assert.match(source, /reasoning: workerReasoningInfo\(resolved.reasoning\)/)
})

test('workers cannot open a child-local user question that the supervisor cannot observe', async () => {
  assert.deepEqual(WORKER_DENIED_TOOLS, ['ask_user_question'])
  assert.deepEqual(workerToolFilter(), { deny: ['ask_user_question'] })

  // Return a fresh request payload: the native descriptor snapshots this
  // restriction for cold resume, so callers must not share mutable state.
  const first = workerToolFilter()
  const second = workerToolFilter()
  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.deny, second.deny)

  const spawnSource = await readFile(new URL('../lib/spawn.js', import.meta.url), 'utf8')
  // The child restriction must always be built by `workerToolFilter`, never a
  // hand-written literal. Preset-specific denials join it as an argument, so a
  // preset narrowed by the retired `toolFilter.deny` spelling keeps its list.
  assert.match(spawnSource, /toolFilter: workerToolFilter\(workerDeniedTools\(config\)\)/)
  assert.match(spawnSource, /ctx\.root\.on\('agent\/created'/)
  assert.match(spawnSource, /ctx\.root\.on\('agent\/request'/)
  assert.match(spawnSource, /ctx\.root\.on\('session\/event'/)
  assert.match(spawnSource, /event\.type === 'request\/header'/)
  assert.match(spawnSource, /pendingEfforts\.set\(childId, effort\.reasoningEffort\)/)
  assert.match(spawnSource, /childId,\n\s+request,/)
  assert.match(spawnSource, /effort: effort\.label/)
  assert.match(spawnSource, /`list_agents` 的 `running` 状态只能证明驱动还开着，不能证明有实际进展在发生/)
  assert.match(spawnSource, /绝不重复一句空洞的「仍在运行 \/ 继续监控」结论/)
  assert.match(spawnSource, /若探针之后的下一次巡检仍然毫无变化，就 `interrupt_agent`/)

  // The main-facing schema may choose only an allowed route. Effort appears in
  // the result for observability, but never in the input parameter block.
  const parameterBlock = spawnSource.slice(
    spawnSource.indexOf('parameters: {'),
    spawnSource.indexOf('\n      output: {'),
  )
  assert.doesNotMatch(parameterBlock, /\beffort\s*:/)
  assert.match(spawnSource, /本工具不暴露任何推理强度参数/)
  assert.doesNotMatch(spawnSource, /reasoningEffort === 'string'/)
})

/** A stand-in for the dsh 0.2.2+ Agent: selections are recorded durably. */
function agentWithSelection(initial = { provider: 'antigravity', model: 'gemini-3.7-flash' }) {
  let selection = { ...initial }
  return {
    id: 'child-1',
    model: {
      current: () => ({ ...selection }),
      select(next) {
        selection = {
          provider: next.provider,
          model: next.model,
          ...next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort },
        }
      },
    },
    selection: () => ({ ...selection }),
  }
}

test('a dsh 0.2.2+ host records the worker effort through agent.model.select', () => {
  const agent = agentWithSelection()
  assert.equal(hostUsesModelSelection(agent), true)
  assert.equal(pinWorkerEffort(agent, 'high'), true)
  assert.deepEqual(agent.selection(), {
    provider: 'antigravity',
    model: 'gemini-3.7-flash',
    reasoningEffort: 'high',
  })

  // Only the effort is ours: the route the request already resolved survives.
  const other = agentWithSelection({ provider: 'zai', model: 'glm-5.3' })
  assert.equal(pinWorkerEffort(other, 'medium'), true)
  assert.deepEqual(other.selection(), {
    provider: 'zai',
    model: 'glm-5.3',
    reasoningEffort: 'medium',
  })
})

test('provider/default records nothing so the adapter keeps deciding', () => {
  const agent = agentWithSelection()
  assert.equal(pinWorkerEffort(agent, undefined), false)
  assert.equal(pinWorkerEffort(agent, ''), false)
  assert.equal(agent.selection().reasoningEffort, undefined)
})

test('a dsh 0.2.1 host keeps the legacy agent/request bridge', () => {
  // 0.2.1 exposed no `agent.model` at all, so the pin declines and the request
  // listener remains the only seam (rewriting is legal there).
  const legacy = { id: 'child-1', options: { provider: 'zai', model: 'glm-5.3' } }
  assert.equal(hostUsesModelSelection(legacy), false)
  assert.equal(pinWorkerEffort(legacy, 'high'), false)
})

test('an agent without a resolvable route is left alone instead of half-pinned', () => {
  const refuse = () => { throw new Error('select must not be called') }
  assert.equal(pinWorkerEffort(
    { id: 'child-1', model: { current: () => undefined, select: refuse } },
    'high',
  ), false)
  assert.equal(pinWorkerEffort(
    { id: 'child-1', model: { current: () => ({ provider: 'zai' }), select: refuse } },
    'high',
  ), false)
})

test('the legacy bridge is exactly what 0.2.2 rejects, and pinning is the fix', () => {
  // Mirrors dsh-agent-loop 0.2.2 `preStep` + the `agent/request` waterfall: the
  // selection is read first, so a listener that returns a different effort is a
  // hard error, not a preference.
  const reject = (selection, proposed) => {
    if (proposed.reasoningEffort !== selection.reasoningEffort) {
      throw new Error('agent/request proposed reasoning effort after step preparation; use agent.model.select() before step preparation')
    }
  }

  const unpinned = agentWithSelection()
  const selection = unpinned.model.current()
  assert.throws(
    () => reject(selection, { ...selection, reasoningEffort: 'high' }),
    /use agent\.model\.select\(\) before step preparation/,
  )

  // Pinning on agent/created moves the value into the selection itself, so the
  // very same request shape passes.
  const pinned = agentWithSelection()
  assert.equal(pinWorkerEffort(pinned, 'high'), true)
  const after = pinned.model.current()
  assert.equal(after.reasoningEffort, 'high')
  reject(after, { ...after })
})

test('spawn pins effort before the first step and never rewrites a 0.2.2 request', async () => {
  const source = await readFile(new URL('../lib/spawn.js', import.meta.url), 'utf8')

  // 0.2.2+: the durable selection edge fires on agent/created, before the first
  // preStep reads it, and the value is no longer carried to any request.
  assert.match(source, /if \(pinWorkerEffort\(agent, effort\)\) \{\s+pendingEfforts\.delete\(agent\.id\)/)

  // ≤0.2.1: the request listener stays the seam, but only for hosts without
  // `agent.model` — from 0.2.2 on a differing reasoningEffort throws after step
  // preparation.
  assert.match(source, /ctx\.root\.on\('agent\/request'/)
  const listener = source.slice(
    source.indexOf("ctx.root.on('agent/request'"),
    source.indexOf("ctx.root.on('session/event'"),
  )
  assert.match(listener, /if \(hostUsesModelSelection\(agent\)\) return next\(\)/)
  assert.ok(
    listener.indexOf('hostUsesModelSelection(agent)') < listener.indexOf('const request = await next()'),
    'the host guard has to run before any request is produced',
  )
})

test('the bundled preset has one guarded spawn frontend and no native fallback row', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )

  assert.match(preset, /- id: tool-subagent\n\s+name: dsh-main-agent\/spawn/)
  assert.match(preset, /name: dsh-main-agent\/spawn\n\s+config:\n\s+provider: spawn\n\s+toolName: subagent/)
  assert.doesNotMatch(
    preset,
    /name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider: spawn\n\s+toolName: subagent/,
  )
  assert.doesNotMatch(
    preset,
    /name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider: fork/,
  )
  assert.doesNotMatch(preset, /toolName: subagent_fork/)
  assert.doesNotMatch(preset, /toolName: spawn_dev_agent/)
  assert.doesNotMatch(preset, /\n\s+models:\n/)
  assert.match(preset, /你没有直接向用户提问的渠道/)
  assert.match(preset, /report 工具就是你向监督者提问的渠道/)
  assert.match(preset, /调用 report 并给出准确的问题/)
  assert.match(preset, /`list_agents` 的状态 `running` 只能证明驱动还开着，\n\s+不能证明有实际进展在发生/)
  assert.match(preset, /绝不重复一句空洞的\n\s+「仍在运行 \/ 继续监控」结论/)
  assert.match(preset, /探针之后的下一次巡检仍然毫无变化：\n\s+interrupt_agent/)
})
