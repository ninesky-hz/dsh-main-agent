/**
 * Tool-level coverage for the guarded `subagent` frontend — the layer that
 * actually broke on dsh-subagent 0.2.x.
 *
 * The 0.1 service exposed `startContinuable()` / `start()`; 0.2.1 exposes
 * `startActivation({…, delivery})`. The plugin called the removed names, so
 * every real delegation died with
 * `TypeError: ctx.subagents.startContinuable is not a function` while the rest
 * of the suite stayed green. This test registers the tool against a fake 0.2.x
 * host and drives `execute()` down both paths, including the hard cap.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/spawn.js')

const PARENT = 'root-supervisor-session'

/** A 0.2.x host that records every activation. */
function host({
  running = () => undefined,
  children = [],
  settings = { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 3 },
  providerReady = true,
} = {}) {
  const activations = []
  const registered = []
  const service = {
    startActivation: async spec => {
      activations.push(spec)
      return { childId: spec.childId ?? 'child-internal', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
    drainChildren: async () => {},
    listChildren: async () => children,
    sendMessage: async () => {},
    interrupt: async () => {},
    getProvider: () => (providerReady ? { name: 'spawn' } : undefined),
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    subagents: service,
    agents: { get: id => running(id) },
    effect: callback => callback(),
    on: () => () => {},
    root: { on: () => () => {} },
    get: name => (name === 'supervisorSettings' ? { current: () => settings, subscribe: () => () => {} } : undefined),
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    llm: {
      listProviders: () => [{ provider: 'deepseek-official' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({
        inputModalities: ['text'],
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      }),
    },
    systemPrompt: { section: () => () => {} },
  }
  return { ctx, activations, registered, service }
}

/** Wait for the tool to be mounted (catalog refresh is async). */
async function mountedSystem(options) {
  const system = host(options)
  await apply(system.ctx, {})
  // apply() kicks off reconcile via a promise chain; give it a turn.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const tool = system.registered.at(-1)
  assert.ok(tool !== undefined, 'the subagent tool must be registered on a compatible host')
  return { ...system, tool }
}

function executeContext() {
  return {
    signal: undefined,
    agent: {
      id: PARENT,
      session: {
        header: { id: PARENT },
        // The exact route captured for this turn; runtime/current refuses to
        // fall back to creation-time defaults.
        requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      },
    },
  }
}

async function call(tool, args, exec = executeContext()) {
  return tool.execute(args, exec)
}

test('a background spawn goes through startActivation with delivery "parent"', async () => {
  const { tool, activations } = await mountedSystem()
  const result = await call(tool, { description: 'audit', prompt: 'do the thing', model: 'runtime/current' })

  assert.equal(activations.length, 1)
  const spec = activations[0]
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.label, 'audit')
  assert.equal(spec.request.prompt[0].text, 'do the thing')
  assert.equal(spec.request.parent.id, PARENT)
  assert.deepEqual(spec.request.toolFilter, { deny: ['ask_user_question'] })
  assert.equal(result.kind, 'continuable')
  assert.match(result.subagentId, /^[0-9a-f-]{36}$/)
})

test('a foreground spawn awaits and disposes the activation', async () => {
  const { tool, activations } = await mountedSystem()
  const result = await call(tool, {
    description: 'audit', prompt: 'inline', model: 'runtime/current', run_in_background: false,
  })

  assert.equal(activations[0].delivery, 'caller')
  assert.equal(activations[0].childId, undefined, 'the service allocates a foreground child id')
  assert.equal(result.kind, 'foreground')
})

test('the hard cap refuses the spawn that would exceed it', async () => {
  // One worker is running; the cap is 1, so the next spawn is rejected.
  const { tool, activations } = await mountedSystem({
    running: id => (id === 'busy-child' ? { status: 'running' } : undefined),
    children: [{ id: 'busy-child', mode: 'continuable' }],
    settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 1 },
  })
  await assert.rejects(
    () => call(tool, { description: 'second', prompt: 'x', model: 'runtime/current' }),
    /并行 worker 上限|上限/,
  )
  assert.equal(activations.length, 0, 'nothing may be started past the cap')
})

test('a rejected spawn leaves no ledger entry behind', async () => {
  const { tool, activations } = await mountedSystem({
    children: [{ id: 'busy-child', mode: 'continuable' }],
    running: id => (id === 'busy-child' ? { status: 'running' } : undefined),
    settings: { workerModels: ['runtime/current'], workerEfforts: {}, maxParallelWorkers: 1 },
  })
  // First call is refused by the cap…
  await assert.rejects(() => call(tool, { description: 'a', prompt: 'x', model: 'runtime/current' }))
  // …and repeated calls keep being refused instead of leaking slots.
  await assert.rejects(() => call(tool, { description: 'b', prompt: 'x', model: 'runtime/current' }))
  assert.equal(activations.length, 0)
})

test('an empty allowlist registers no tool at all', async () => {
  const system = host({ settings: { workerModels: [], workerEfforts: {}, maxParallelWorkers: 3 } })
  await apply(system.ctx, {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(system.registered.length, 0, 'no model may be chosen, so there is no spawn tool')
})
