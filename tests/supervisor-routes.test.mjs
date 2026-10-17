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

register('./harness-stub-loader.js', import.meta.url)

const { healthHandler, workersHandler } = await import('../lib/index.js')

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
