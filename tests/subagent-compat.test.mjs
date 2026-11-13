/**
 * Host-API contract coverage for the delegation seam.
 *
 * WHY: `@deepseek-ai/dsh-subagent` 0.2.1-rc.2 removed `start()`,
 * `startContinuable()`, and `drainContinuableChildren()` and dropped the
 * `kind`/`activity` fields from its child catalog. The plugin still called the
 * old names, so delegation, the parallel-worker cap, and Full stop failed at
 * call time — after a clean load — with a bare `TypeError: ... is not a
 * function`. The rest of the suite passed, because every other module is
 * covered through fakes that never touched `ctx.subagents`.
 *
 * These tests pin the 0.2.x contract the plugin now speaks, and the capability
 * probe that makes a future drift visible instead of silent.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  CATALOG_METHODS,
  CORE_METHODS,
  DRAIN_METHODS,
  LEDGER_STALE_MS,
  REQUIRED_METHODS,
  childIsRunning,
  continuableChildIds,
  drainWorkers,
  hasCatalog,
  listChildrenOf,
  listDescendantsOf,
  missingSubagentMethods,
  openWorkerCount,
  resolveSubagentGeneration,
  runningChildIds,
  startWorker,
  subagentCompatible,
  subagentIncompatibilityMessage,
} from '../lib/subagent-compat.js'

/** A service that speaks the 0.2.x contract. */
function hostService(overrides = {}) {
  const calls = []
  const service = {
    startActivation: async spec => {
      calls.push(['startActivation', spec])
      return {
        childId: spec.childId ?? 'child-generated',
        result: Promise.resolve({ ok: true }),
        dispose: async () => {},
      }
    },
    drainChildren: async (parent, ids) => {
      calls.push(['drainChildren', parent, ids])
    },
    listChildren: async () => [],
    sendMessage: async () => {},
    interrupt: async () => {},
    getProvider: () => ({ name: 'spawn' }),
    ...overrides,
  }
  return { ctx: { subagents: service }, calls }
}

/**
 * A service that speaks the 0.2.2 contract (dsh 0.2.2-rc.2): the activation
 * spec is flat, the catalog reads descendants, and release takes parents.
 */
function rc2Service(overrides = {}) {
  const calls = []
  const service = {
    startActivation: async spec => {
      calls.push(['startActivation', spec])
      return {
        childId: spec.childId ?? 'child-2',
        name: 'agent-2',
        result: Promise.resolve({ ok: true }),
        dispose: async () => {},
      }
    },
    drainDescendants: async parents => {
      calls.push(['drainDescendants', parents])
    },
    listDescendants: async () => [],
    sendMessage: async () => {},
    interrupt: async () => {},
    getProvider: () => ({ name: 'spawn' }),
    ...overrides,
  }
  return { ctx: { subagents: service }, calls }
}

const REQUEST = { prompt: [{ type: 'text', text: 'do it' }], parent: 'parent-session' }

test('a live 0.2.x service reports no missing methods', () => {
  const { ctx } = hostService()
  assert.deepEqual(missingSubagentMethods(ctx), [])
  assert.equal(subagentCompatible(ctx), true)
  assert.equal(subagentIncompatibilityMessage(ctx), undefined)
})

test('a host with neither catalog nor release API is reported by name, not invoked', () => {
  // Exactly what dsh-subagent 0.1 exposed.
  const { ctx } = hostService({})
  delete ctx.subagents.startActivation
  delete ctx.subagents.drainChildren
  delete ctx.subagents.listChildren
  assert.deepEqual(missingSubagentMethods(ctx), [
    'startActivation',
    'listChildren 或 listDescendants',
    'drainChildren 或 drainDescendants',
  ])

  const message = subagentIncompatibilityMessage(ctx)
  assert.match(message, /startActivation/)
  assert.match(message, /listDescendants/)
  assert.match(message, /0\.2\.x/)
})

test('the alternative groups are what makes one generation enough', () => {
  // A 0.2.2 host has no listChildren/drainChildren at all, yet nothing the
  // plugin calls is missing; a 0.2.1 host that only loses its release API
  // names exactly that capability, not a method.
  assert.deepEqual(CATALOG_METHODS, ['listDescendants', 'listChildren'])
  assert.deepEqual(DRAIN_METHODS, ['drainDescendants', 'drainChildren'])
  assert.deepEqual(CORE_METHODS, ['startActivation', 'sendMessage', 'interrupt', 'getProvider'])
  assert.equal(REQUIRED_METHODS.length, CORE_METHODS.length + CATALOG_METHODS.length + DRAIN_METHODS.length)

  const { ctx } = hostService()
  delete ctx.subagents.drainChildren
  assert.deepEqual(missingSubagentMethods(ctx), ['drainChildren 或 drainDescendants'])
})

test('both host generations are compatible and named by their shape', () => {
  const rc1 = hostService().ctx
  const rc2 = rc2Service().ctx
  assert.equal(resolveSubagentGeneration(rc1), '0.2.1')
  assert.equal(resolveSubagentGeneration(rc2), '0.2.2')
  assert.equal(resolveSubagentGeneration({}), undefined)
  assert.deepEqual(missingSubagentMethods(rc2), [])
  assert.equal(subagentCompatible(rc2), true)
  assert.equal(hasCatalog(rc1), true)
  assert.equal(hasCatalog(rc2), true)
  assert.equal(hasCatalog({}), false)
})

test('a missing service is incompatible rather than fatal at probe time', () => {
  const missing = missingSubagentMethods({})
  assert.deepEqual(missing.slice(0, CORE_METHODS.length), CORE_METHODS)
  assert.ok(missing.includes('listChildren 或 listDescendants'))
  assert.ok(missing.includes('drainChildren 或 drainDescendants'))
  assert.deepEqual(missingSubagentMethods(undefined), missing)
  assert.equal(subagentCompatible({}), false)
})

test('background workers start with delivery "parent" and the caller childId', async () => {
  const { ctx, calls } = hostService()
  const started = await startWorker(ctx, {
    provider: 'spawn',
    label: 'audit the plugin',
    childId: 'fixed-child',
    request: REQUEST,
    signal: undefined,
    mode: 'background',
  })

  assert.equal(calls.length, 1)
  const [method, spec] = calls[0]
  assert.equal(method, 'startActivation')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'audit the plugin')
  assert.equal(spec.childId, 'fixed-child')
  assert.equal(spec.request, REQUEST)
  assert.deepEqual(started, {
    childId: 'fixed-child',
    result: started.result,
    dispose: started.dispose,
  })
  assert.deepEqual(await started.result, { ok: true })
})

test('foreground workers use delivery "caller" and omit an unset childId', async () => {
  const { ctx, calls } = hostService()
  await startWorker(ctx, { provider: 'spawn', label: 'x', request: REQUEST, mode: 'foreground' })

  const spec = calls[0][1]
  assert.equal(spec.delivery, 'caller')
  assert.equal('childId' in spec, false)
})

test('a 0.2.2 host gets the activation spec flat, with no nested request', async () => {
  const { ctx, calls } = rc2Service()
  const started = await startWorker(ctx, {
    provider: 'spawn',
    label: 'audit the plugin',
    name: 'audit-1',
    childId: 'fixed-child',
    request: REQUEST,
    signal: undefined,
    mode: 'background',
  })

  const [method, spec] = calls[0]
  assert.equal(method, 'startActivation')
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'audit the plugin')
  assert.equal(spec.name, 'audit-1')
  assert.equal(spec.childId, 'fixed-child')
  assert.equal(spec.delivery, 'parent')
  // 0.2.2 reads prompt/parent/maxDepth off the spec itself and never looks
  // inside a `request` wrapper, so the wrapper has to be gone.
  assert.deepEqual(spec.prompt, REQUEST.prompt)
  assert.equal(spec.parent, 'parent-session')
  assert.equal('request' in spec, false)
  assert.equal(started.name, 'agent-2')
  assert.equal(started.childId, 'fixed-child')
})

test('a 0.2.2 host never receives the retired name on the wrapper path', async () => {
  const rc1 = hostService()
  await startWorker(rc1.ctx, {
    provider: 'spawn',
    label: 'x',
    name: 'audit-1',
    request: REQUEST,
  })
  const spec = rc1.calls[0][1]
  assert.equal(spec.request, REQUEST)
  assert.equal('name' in spec, false, '0.2.1 has no named members')
  assert.equal('prompt' in spec, false)
})

test('release on a 0.2.2 host stops the parent subtree', async () => {
  const { ctx, calls } = rc2Service()
  const parent = { id: 'parent-session' }
  await drainWorkers(ctx, parent, ['a', 'b'])
  assert.deepEqual(calls, [['drainDescendants', [parent]]])
})

test('direct children are the depth-1 rows of a 0.2.2 subtree', async () => {
  const subtree = [
    { id: 'a', mode: 'continuable', depth: 1, parentId: 'root' },
    { id: 'b', mode: 'continuable', depth: 2, parentId: 'a' },
    { id: 'c', mode: 'one-shot', depth: 1, parentId: 'root' },
  ]
  const rc2 = rc2Service({ listDescendants: async () => subtree })
  assert.deepEqual((await listChildrenOf(rc2.ctx, 'root')).map(entry => entry.id), ['a', 'c'])

  // 0.2.1 answers the same question natively.
  const rc1 = hostService({ listChildren: async () => subtree.slice(0, 1) })
  assert.deepEqual((await listChildrenOf(rc1.ctx, 'root')).map(entry => entry.id), ['a'])
})

test('a 0.2.1 host rebuilds the subtree from its direct-child catalog', async () => {
  const catalog = {
    root: [
      { id: 'a', mode: 'continuable' },
      { id: 'leaf', mode: 'one-shot' },
    ],
    a: [{ id: 'b', mode: 'continuable' }],
    b: [],
  }
  const rc1 = hostService({ listChildren: async id => catalog[id] ?? [] })
  const rows = await listDescendantsOf(rc1.ctx, 'root')
  assert.deepEqual(
    rows.map(row => [row.id, row.depth, row.parentId]),
    [
      ['a', 1, 'root'],
      ['leaf', 1, 'root'],
      ['b', 2, 'a'],
    ],
  )

  const subtree = [{ id: 'a', mode: 'continuable', depth: 1, parentId: 'root' }]
  const rc2 = rc2Service({ listDescendants: async () => subtree })
  assert.deepEqual(await listDescendantsOf(rc2.ctx, 'root'), subtree)
})

test('no host-half module reaches into the subagent catalog directly', () => {
  for (const file of ['spawn.js', 'index.js', 'watchdog.js', 'list-agents.js']) {
    const source = stripComments(readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8'))
    for (const direct of ['subagents.listChildren', 'subagents.drainChildren', 'subagents.listDescendants', 'subagents.drainDescendants']) {
      assert.equal(source.includes(direct), false, `lib/${file} still calls ${direct}`)
    }
  }
})

test('an incompatible host fails loud with an actionable message', async () => {
  const { ctx } = hostService()
  delete ctx.subagents.startActivation
  await assert.rejects(
    () => startWorker(ctx, { provider: 'spawn', label: 'x', request: REQUEST }),
    error => {
      assert.match(error.message, /ctx\.subagents\.startActivation/)
      assert.match(error.message, /dsh-subagent 0\.2\.[12]/)
      assert.doesNotMatch(error.message, /is not a function/)
      return true
    },
  )
})

test('drainWorkers skips an empty flush and otherwise releases ids', async () => {
  const { ctx, calls } = hostService()
  assert.equal(await drainWorkers(ctx, 'parent-session', []), undefined)
  assert.equal(calls.length, 0)

  await drainWorkers(ctx, 'parent-session', ['a', 'b'])
  assert.deepEqual(calls, [['drainChildren', 'parent-session', ['a', 'b']]])
})

test('catalog entries without kind/activity still yield continuable ids', () => {
  // The 0.2.x projection: { id, createdAt, mode, label? } — no kind, no activity.
  const children = [
    { id: 'c1', createdAt: 1, mode: 'continuable', label: 'one' },
    { id: 'c2', createdAt: 2, mode: 'external' },
    { id: 'c3', createdAt: 3, mode: 'continuable' },
    { id: 'unknown', createdAt: 4 },
    null,
  ]
  assert.deepEqual(continuableChildIds(children), ['c1', 'c3'])
  assert.deepEqual(continuableChildIds(undefined), [])
})

test('liveness comes from the live agent, never from the durable catalog', () => {
  const agents = {
    get: id => (id === 'c1' ? { status: 'running' } : id === 'c3' ? { status: 'idle' } : undefined),
  }
  const ctx = { agents }
  const children = [
    { id: 'c1', mode: 'continuable' },
    { id: 'c3', mode: 'continuable' },
    { id: 'gone', mode: 'continuable' },
  ]
  assert.deepEqual(runningChildIds(ctx, children), ['c1'])
  assert.equal(childIsRunning(ctx, 'c1'), true)
  assert.equal(childIsRunning(ctx, 'gone'), false)
  assert.equal(childIsRunning({ agents: { get() { throw new Error('torn down') } } }, 'c1'), false)
  assert.equal(childIsRunning({}, 'c1'), false)
})

/**
 * The parallel-worker cap: two spawns in the same step must not both read zero.
 * On 0.1 the count came from `entry.kind === 'child' && entry.activity ===
 * 'running'`; on 0.2 both fields are gone, so the count is running children
 * plus the fiber's own starting ledger.
 */
test('the cap sees a just-started child that no agent reports yet', () => {
  const ctx = { agents: { get: () => undefined } }
  const ledger = new Map([['fresh', { wasActive: false, startedAt: 1_000 }]])
  // Catalog has the child (id assigned at start), but no live agent yet.
  const children = [{ id: 'fresh', mode: 'continuable' }]
  assert.equal(openWorkerCount(ctx, children, ledger, 1_100), 1)
  // A second same-step spawn therefore sees 1, not 0.
  assert.equal(openWorkerCount({ agents: { get: () => undefined } }, [], new Map()), 0)
})

test('a running child is counted once, not once per source', () => {
  const ctx = { agents: { get: id => (id === 'running' ? { status: 'running' } : undefined) } }
  const ledger = new Map([['running', { wasActive: false, startedAt: 1_000 }]])
  const children = [{ id: 'running', mode: 'continuable' }]
  assert.equal(openWorkerCount(ctx, children, ledger, 1_100), 1)
  assert.equal(ledger.get('running').wasActive, true, 'the ledger marks it as observed running')
})

test('a child that ran and settled frees its slot; one that never ran expires', () => {
  const gone = { get: () => undefined }
  const ledger = new Map([
    ['settled', { wasActive: true, startedAt: 1_000 }],
    ['never-ran', { wasActive: false, startedAt: 1_000 }],
  ])
  // Both are pruned: 'settled' was seen running and is gone; 'never-ran' is stale.
  assert.equal(openWorkerCount(gone, [], ledger, 1_000 + LEDGER_STALE_MS + 1), 0)
  assert.equal(ledger.size, 0)

  // Before the window closes, a never-ran entry still holds its slot…
  const young = new Map([['never-ran', { wasActive: false, startedAt: 1_000 }]])
  assert.equal(openWorkerCount(gone, [], young, 1_000 + 60_000), 1)
  assert.equal(young.size, 1, '…but is not deleted yet')
})

test('non-continuable catalog entries never count toward the cap', () => {
  const ctx = { agents: { get: () => ({ status: 'running' }) } }
  const children = [
    { id: 'ext', mode: 'external' },
    { id: 'cont', mode: 'continuable' },
  ]
  assert.equal(openWorkerCount(ctx, children, new Map()), 1)
})

/**
 * Source guards: the removed 0.1 entry points must not come back. These are
 * cheap greps over the host half — the failure they prevent is a runtime
 * TypeError that no behavioral test in this suite would see.
 */
/** Drop comments so historical prose cannot trip a call-shaped guard. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('no host-half module calls the removed 0.1 subagent API', () => {
  const spawn = stripComments(readFileSync(new URL('../lib/spawn.js', import.meta.url), 'utf8'))
  const index = stripComments(readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'))

  for (const removed of ['startContinuable(', 'drainContinuableChildren(', 'runContinuableChild(']) {
    assert.equal(spawn.includes(removed), false, `lib/spawn.js still calls ${removed}`)
    assert.equal(index.includes(removed), false, `lib/index.js still calls ${removed}`)
  }
  // `ctx.subagents.start(` is the removed 0.1 foreground entry point.
  assert.equal(/subagents\.start\s*\(/.test(spawn), false, 'lib/spawn.js still calls ctx.subagents.start()')

  // Both halves must go through the seam instead.
  assert.match(spawn, /from '\.\/subagent-compat\.js'/)
  assert.match(index, /from '\.\/subagent-compat\.js'/)
})

test('the feed reads workers from the plugin route, not the removed RPC', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(client.includes("'subagent.list'"), false,
    'lib/client.js still asks for the subagent.list RPC, which dsh-subagent 0.2.x does not expose')
  assert.match(client, /\/supervisor\/workers/)
  assert.match(client, /\/supervisor\/health/)
})
