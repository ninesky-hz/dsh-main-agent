/**
 * Route-level coverage for the two host routes that exist BECAUSE the 0.2.x
 * host stopped reporting worker activity:
 *
 * - `GET /supervisor/health` — the compatibility probe (A5). Before it, a
 *   renamed `ctx.subagents` API stayed invisible until the first spawn threw.
 * - `GET /supervisor/workers` — the Feed's only worker source (A3). The
 *   `subagent.list` RPC it replaced does not exist in 0.2.x, and the catalog
 *   projection has no `activity` field (A2), so liveness must come from the
 *   live agent registry.
 *
 * The handlers are exercised directly with a fake ctx/req/res, so these tests
 * pin the response contract without booting a host.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./harness-stub-loader.js', import.meta.url)

const { feedHandler, healthHandler, stopHandler, workersHandler } = await import('../lib/index.js')

/** A 0.2.x-shaped `ctx.subagents` service. */
function compatibleService(children = []) {
  return {
    startActivation: async spec => ({ childId: spec.childId ?? 'c', result: Promise.resolve(), dispose: async () => {} }),
    drainChildren: async () => {},
    listChildren: async () => children,
    sendMessage: async () => {},
    interrupt: async () => {},
    getProvider: () => ({ name: 'spawn' }),
  }
}

/** Capture a handler's status, headers and JSON body. */
function recorder(method = 'GET') {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body
      return this
    },
  }
  return {
    req: { method, url: '/' },
    res,
    read() {
      return {
        status: res.status,
        body: res.body === undefined ? undefined : JSON.parse(res.body),
      }
    },
  }
}

test('health reports a compatible host as ok', () => {
  const { req, res, read } = recorder()
  healthHandler({ subagents: compatibleService() }, req, res)
  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.package, 'dsh-main-agent')
  assert.deepEqual(body.subagents.missing, [])
  assert.equal(body.subagents.message, undefined)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('health names every missing method on a drifted host', () => {
  const { req, res, read } = recorder()
  // dsh-subagent 0.1 exported none of these three.
  const drifted = compatibleService()
  delete drifted.startActivation
  delete drifted.drainChildren
  delete drifted.listChildren
  healthHandler({ subagents: drifted }, req, res)

  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.deepEqual(body.subagents.missing, ['startActivation', 'drainChildren', 'listChildren'])
  assert.match(body.subagents.message, /startActivation/)
  assert.match(body.subagents.message, /0\.2\.x/)
})

test('health is a diagnostic route, so a missing service still answers 200', () => {
  const { req, res, read } = recorder()
  healthHandler({}, req, res)
  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.ok(body.subagents.missing.length > 0)
})

test('health rejects non-GET methods with 405 + Allow', () => {
  const { req, res } = recorder('POST')
  healthHandler({ subagents: compatibleService() }, req, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
  assert.equal(res.body, undefined)
})

test('workers merges the durable catalog with live agent state', async () => {
  const children = [
    { id: 'running-child', createdAt: 1_700_000_000_000, mode: 'continuable', label: 'auditing' },
    { id: 'settled-child', createdAt: 1_700_000_000_100, mode: 'continuable' },
    { id: 'external-child', createdAt: 1_700_000_000_200, mode: 'external' },
    { id: 'ghost', createdAt: 1_700_000_000_300, mode: 'continuable' },
  ]
  const ctx = {
    subagents: compatibleService(children),
    agents: {
      get: id => (id === 'running-child' ? { status: 'running' } : id === 'settled-child' ? { status: 'idle' } : undefined),
    },
  }
  const { req, res, read } = recorder()
  req.url = '/supervisor/workers?session=root-session'
  await workersHandler(ctx, req, res)

  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.session, 'root-session')
  assert.equal(body.compatible, true)
  assert.equal(body.total, 3, 'external children are not workers')
  assert.equal(body.running, 1)
  assert.deepEqual(body.workers.map(worker => [worker.id, worker.running]), [
    ['running-child', true],
    ['settled-child', false],
    ['ghost', false],
  ])
  assert.equal(body.workers[0].label, 'auditing')
  assert.equal(body.workers[1].label, undefined, 'absent labels are omitted, not nulled')
})

test('workers requires ?session and refuses a drifted host', async () => {
  const missing = recorder()
  missing.req.url = '/supervisor/workers'
  await workersHandler({ subagents: compatibleService() }, missing.req, missing.res)
  assert.equal(missing.res.status, 400)

  const drifted = compatibleService()
  delete drifted.listChildren
  const broken = recorder()
  broken.req.url = '/supervisor/workers?session=root'
  await workersHandler({ subagents: drifted }, broken.req, broken.res)
  const { status, body } = broken.read()
  assert.equal(status, 503)
  assert.match(body.error, /listChildren/)
})

test('workers reports an empty inventory after a Full stop', async () => {
  const { req, res, read } = recorder()
  req.url = '/supervisor/workers?session=root'
  await workersHandler({ subagents: compatibleService([]), agents: { get: () => undefined } }, req, res)
  const { body } = read()
  assert.deepEqual(body.workers, [])
  assert.equal(body.running, 0)
  assert.equal(body.total, 0)
})

test('workers separates "session never existed" (404) from "service down" (503)', async () => {
  // A durable catalog lookup for an unknown id is a client error. Reporting it
  // as 503 told the Feed to render a stale inventory as a host outage.
  const unknown = compatibleService()
  unknown.listChildren = async () => { throw new Error('session "ghost" not found') }
  const missing = recorder()
  missing.req.url = '/supervisor/workers?session=ghost'
  await workersHandler({ subagents: unknown }, missing.req, missing.res)
  const notFound = missing.read()
  assert.equal(notFound.status, 404)
  assert.match(notFound.body.error, /未找到该 session/)

  const outage = compatibleService()
  outage.listChildren = async () => { throw new Error('persistence offline') }
  const broken = recorder()
  broken.req.url = '/supervisor/workers?session=root'
  await workersHandler({ subagents: outage }, broken.req, broken.res)
  const failed = broken.read()
  assert.equal(failed.status, 503)
  assert.match(failed.body.error, /persistence offline/)
})

test('Full stop refuses a POST a foreign page initiated', async () => {
  // Plugin routes sit on the raw web server and bypass the host token gate, so
  // the destructive route needs its own cross-site check.
  const crossSite = recorder('POST')
  crossSite.req.url = '/supervisor/stop?session=root'
  crossSite.req.headers = { origin: 'https://evil.example', host: '127.0.0.1:54677' }
  await stopHandler({}, crossSite.req, crossSite.res)
  const refused = crossSite.read()
  assert.equal(refused.status, 403)
  assert.match(refused.body.error, /跨站/)

  // Same origin (and the no-Origin CLI case) stays allowed; it then fails at
  // the liveness check instead of at the CSRF gate.
  const sameOrigin = recorder('POST')
  sameOrigin.req.url = '/supervisor/stop?session=root'
  sameOrigin.req.headers = { origin: 'http://127.0.0.1:54677', host: '127.0.0.1:54677' }
  await stopHandler({ agents: { get: () => undefined } }, sameOrigin.req, sameOrigin.res)
  const allowed = sameOrigin.read()
  // The test host has no schedule stub, so it stops at that gate (500); what
  // matters is that the CSRF gate did NOT reject it.
  assert.notEqual(allowed.status, 403)

  const cli = recorder('POST')
  cli.req.url = '/supervisor/stop?session=root'
  cli.req.headers = {}
  await stopHandler({ agents: { get: () => undefined } }, cli.req, cli.res)
  assert.notEqual(cli.read().status, 403)
})

test('Full stop cold-resumes a supervisor through the host controller', async () => {
  // The bug this pins: the browser half used to cold-resume with an RPC whose
  // endpoint shape no longer existed, so the button reported
  // "无法恢复监督者" and no stop transaction ever ran. Resume now belongs to the
  // host, whose `sessionController` owns preset composition and writer claims.
  const calls = []
  const agent = {
    session: {
      header: { id: 'root', origin: 'root', agentPreset: 'main-agent' },
      inheritedEventCount: 0,
      snapshotEvents: () => [],
      append() {},
    },
    status: 'idle',
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(),
  }
  const ctx = {
    agents: { get: () => undefined },
    sessions: { flush: async () => {} },
    subagents: compatibleService([]),
    get(name) {
      if (name !== 'sessionController') return undefined
      return {
        async resolveAgent(sessionId) {
          calls.push(sessionId)
          return { agent }
        },
      }
    },
  }
  const { req, res, read } = recorder('POST')
  req.url = '/supervisor/stop?session=root'
  req.headers = {}
  await stopHandler(ctx, req, res)

  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.live, true)
  assert.equal(body.durable, true)
  assert.equal(body.remindersDeleted, 0)
  assert.equal(body.workersStopped, 0)
  assert.deepEqual(calls, ['root'])
})

test('Full stop reports 409 when neither a live agent nor a controller exists', async () => {
  const { req, res, read } = recorder('POST')
  req.url = '/supervisor/stop?session=root'
  req.headers = {}
  await stopHandler({ agents: { get: () => undefined } }, req, res)
  const { status, body } = read()
  assert.equal(status, 409)
  assert.match(body.error, /无法恢复 supervisor/)
  assert.match(body.error, /sessionController/)
})

test('Full stop does not resume an agent that is already live', async () => {
  const agent = {
    session: {
      header: { id: 'root', origin: 'root', agentPreset: 'main-agent' },
      inheritedEventCount: 0,
      snapshotEvents: () => [],
      append() {},
    },
    status: 'idle',
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(),
  }
  let resumed = 0
  const ctx = {
    agents: { get: id => (id === 'root' ? agent : undefined) },
    sessions: { flush: async () => {} },
    subagents: compatibleService([]),
    get: () => ({ resolveAgent: async () => { resumed += 1; return { agent } } }),
  }
  const { req, res, read } = recorder('POST')
  req.url = '/supervisor/stop?session=root'
  req.headers = {}
  await stopHandler(ctx, req, res)
  assert.equal(read().status, 200)
  assert.equal(resumed, 0, 'a published agent must not be resumed again')
})

test('feed reports what the poller truncated instead of silently dropping it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-feed-'))
  const agi = join(root, '.agi')
  mkdirSync(agi)
  // Over the 64KB text cap.
  writeFileSync(join(agi, 'GOAL.md'), 'g'.repeat(64 * 1024 + 100))
  // Over the 300-entry JSONL cap.
  writeFileSync(join(agi, 'progress.jsonl'), Array.from({ length: 350 }, (_, index) =>
    JSON.stringify({ ts: `t${index}`, text: `step ${index}` })).join('\n'))
  // Over the 20-directory worker cap, each holding a small outcome.
  const subagents = join(agi, 'subagents')
  mkdirSync(subagents)
  for (let index = 0; index < 25; index += 1) {
    const dir = join(subagents, `w${index}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'outcome.md'), `outcome ${index}`)
    // Deterministic recency: w24 is newest.
    const stamp = new Date(Date.now() - (25 - index) * 60_000)
    utimesSync(dir, stamp, stamp)
  }

  const { req, res, read } = recorder()
  req.url = `/supervisor/feed?ws=${encodeURIComponent(root)}`
  feedHandler(req, res)
  const { status, body } = read()
  assert.equal(status, 200)
  assert.equal(body.goal.truncated, true)
  assert.equal(body.goal.text.length, 64 * 1024, 'the tail is kept, not the head')
  assert.equal(body.progress.length, 300)
  assert.deepEqual(body.truncated, {
    text: ['goal'],
    jsonl: { progress: 50 },
    workers: 5,
  })
  assert.equal(body.subagents.length, 20)
  assert.equal(body.subagents[0].name, 'w24', 'newest worker artifacts come first')
  assert.equal(body.subagents[0].outcome.text, 'outcome 24')

  // A workspace with no state stays a plain 404, not a "truncated" document.
  const empty = recorder()
  empty.req.url = `/supervisor/feed?ws=${encodeURIComponent(join(root, 'nope'))}`
  feedHandler(empty.req, empty.res)
  assert.equal(empty.read().status, 404)
})
