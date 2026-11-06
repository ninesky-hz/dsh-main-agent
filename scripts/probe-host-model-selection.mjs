/**
 * Real-host probe: does this plugin's reasoning-effort pinning work on the
 * installed DeepSeek Harness?
 *
 * Why this exists
 * ---------------
 * dsh 0.2.2-rc.1 froze the model selection during step preparation and made
 * `agent/request` reject any proposal that changes it
 * (dsh-agent-loop/lib/index.js:994-1001):
 *
 *   agent/request proposed reasoning effort "high" after step preparation
 *   fixed "adapter default"; use agent.model.select() before step preparation
 *
 * The plugin therefore pins worker effort through `agent.model.select()` when
 * the host exposes it, and only falls back to the `agent/request` bridge on
 * older hosts. This script proves that against the ACTUAL `AgentModel` class
 * the host ships — not against our own reading of it — and replays the loop's
 * request gate verbatim in both directions.
 *
 * Usage
 * -----
 *   1. Install the host packages you want to probe into a scratch directory:
 *
 *        mkdir %TEMP%\dsh-probe && cd /d %TEMP%\dsh-probe
 *        npm init -y
 *        npm install --legacy-peer-deps \
 *          @deepseek-ai/dsh-agent@0.2.2-rc.1 @deepseek-ai/dsh-session@0.2.2-rc.1 \
 *          @deepseek-ai/cordis@4.1.0 @deepseek-ai/dsh-llm@0.2.2-rc.1 \
 *          @deepseek-ai/dsh-scope@0.2.2-rc.1 \
 *          @deepseek-ai/dsh-session-projection@0.2.2-rc.1 \
 *          @deepseek-ai/dsh-system-prompt@0.2.2-rc.1 \
 *          @deepseek-ai/dsh-typert-protocol@0.2.2-rc.1 \
 *          @deepseek-ai/dsh-util-values@0.2.2-rc.1 \
 *          @deepseek-ai/dsh-workspace@0.2.2-rc.1
 *
 *   2. Point this script at the directory that owns those node_modules:
 *
 *        node scripts/probe-host-model-selection.mjs %TEMP%\dsh-probe
 *
 * Exits 0 with a single OK line when the pin is accepted and the gate passes.
 * A host without `AgentModel` (dsh <= 0.2.1) is reported as such and exits 2 —
 * that is the expected legacy answer, not a failure of the plugin.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { hostUsesModelSelection, pinWorkerEffort } from '../lib/worker-model-policy.js'

const hostRoot = process.argv[2]
if (!hostRoot) {
  console.error('usage: node scripts/probe-host-model-selection.mjs <host-node_modules-owner-dir>')
  process.exit(64)
}

// Resolve through the probed installation, then load as ESM (dsh-agent ships ESM).
const hostRequire = createRequire(path.join(path.resolve(hostRoot), 'package.json'))
let hostAgent
try {
  hostAgent = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-agent')).href)
} catch (error) {
  console.error(`could not load @deepseek-ai/dsh-agent from ${hostRoot}: ${error.message}`)
  process.exit(1)
}

const { AgentModel } = hostAgent
if (typeof AgentModel !== 'function') {
  // dsh <= 0.2.1: no AgentModel, so the loop never freezes the selection and the
  // agent/request bridge remains the only seam. Assert we report that faithfully.
  const legacy = { id: 'legacy', options: { provider: 'antigravity', model: 'gemini-3.7-flash' } }
  assert.equal(hostUsesModelSelection(legacy), false)
  assert.equal(pinWorkerEffort(legacy, 'high'), false)
  console.log('LEGACY: host has no AgentModel (dsh <= 0.2.1); the agent/request bridge stays active')
  process.exit(2)
}

// ── mirrors modelSelectionProjectionDefinition (dsh-agent/lib/index.js:140-174) ──
const makeSession = () => {
  const appended = []
  let state = { lastUsed: null, pending: null }
  const session = {
    append(type, data) {
      appended.push({ type, data })
      if (type === 'model/selection') state = { ...state, pending: data }
    },
  }
  return { session, appended, state: () => state }
}

// ── mirrors dsh-agent-loop preStep:671 — the loop reads current() first ──
const preStepSelection = model => {
  const selection = model.current()
  assert.notEqual(selection, undefined, 'host preStep requires a route')
  return selection
}

// ── dsh-agent-loop/lib/index.js:994-1001, verbatim condition ──
const requestGate = (selection, proposed) => {
  if (proposed.provider !== selection.provider || proposed.model !== selection.model) {
    throw new Error('agent/request proposed a different route after step preparation')
  }
  if (proposed.reasoningEffort !== selection.reasoningEffort) {
    throw new Error('agent/request proposed reasoning effort after step preparation; use agent.model.select() before step preparation')
  }
}

const options = { provider: 'antigravity', model: 'gemini-3.7-flash' }

// ── pinning through the real AgentModel ────────────────────────────────────
{
  const store = makeSession()
  const model = new AgentModel(store.state, store.session, options)
  const agent = { id: 'child-1', model }

  assert.equal(hostUsesModelSelection(agent), true)

  // Unpinned: the adapter default. Rewriting the request instead — what the
  // pre-0.2.2 code did — is exactly what the gate rejects.
  const unpinned = preStepSelection(model)
  assert.equal(unpinned.reasoningEffort, undefined)
  assert.throws(
    () => requestGate(unpinned, { ...unpinned, reasoningEffort: 'high' }),
    /use agent\.model\.select\(\) before step preparation/,
  )

  // Pinned on agent/created: the durable model/selection lands before preStep.
  assert.equal(pinWorkerEffort(agent, 'high'), true)
  assert.deepEqual(store.appended, [{
    type: 'model/selection',
    data: { provider: 'antigravity', model: 'gemini-3.7-flash', reasoningEffort: 'high' },
  }])

  const pinned = preStepSelection(model)
  assert.equal(pinned.reasoningEffort, 'high')
  // The request listener now returns the seed verbatim → the gate passes.
  requestGate(pinned, { ...pinned })
}

// ── the pin preserves the route of an arbitrary resolved model ─────────────
{
  const store = makeSession()
  const model = new AgentModel(store.state, store.session, { provider: 'zai', model: 'glm-5.3' })
  const agent = { id: 'child-2', model }
  assert.equal(pinWorkerEffort(agent, 'medium'), true)
  const selection = preStepSelection(model)
  assert.deepEqual(selection, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'medium' })
  requestGate(selection, { ...selection })
}

// ── provider/default records nothing at all ────────────────────────────────
{
  const store = makeSession()
  const model = new AgentModel(store.state, store.session, options)
  const agent = { id: 'child-3', model }
  assert.equal(pinWorkerEffort(agent, undefined), false)
  assert.deepEqual(store.appended, [])
  assert.equal(model.current().reasoningEffort, undefined)
}

console.log('OK: real host AgentModel accepts the pin and the request gate passes')
