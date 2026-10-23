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

/** Capture a handler's status, headers and JSON body. `headers` (optional)
 * become the request's headers, which conditional refresh reads. */
function recorder(method = 'GET', headers = undefined) {
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
    req: { method, url: '/', headers: headers ?? {} },
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

test('health publishes which presets count as a supervisor', () => {
  // The Feed tab decides who is a supervisor from this list, so it has to
  // agree with whatever the Settings card switched on — and the built-in id
  // is never absent, even before the user has saved anything.
  const fresh = recorder()
  healthHandler({ subagents: compatibleService() }, fresh.req, fresh.res)
  assert.deepEqual(fresh.read().body.supervisorPresets, ['main-agent'])

  const switched = recorder()
  healthHandler({ subagents: compatibleService() }, switched.req, switched.res, {
    config: { supervisedPresets: ['unrestricted', 'standard'] },
  })
  assert.deepEqual(switched.read().body.supervisorPresets, ['main-agent', 'unrestricted', 'standard'])

  // Saving 'main-agent' explicitly must not duplicate it.
  const deduped = recorder()
  healthHandler({ subagents: compatibleService() }, deduped.req, deduped.res, {
    config: { supervisedPresets: ['main-agent'] },
  })
  assert.deepEqual(deduped.read().body.supervisorPresets, ['main-agent'])
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

test('stop status projects each reminder as a record, not a bare id', async () => {
  // The Feed's loop card has to say WHICH reminder wakes the supervisor and
  // WHEN it fires. Bare ids forced it to render an unreadable list, so the
  // route now projects { id, kind, title?, everySeconds?, scheduledAt? }, with
  // the durable ISO instant converted to epoch milliseconds.
  const events = [
    { type: 'schedule/change', data: { version: 1, operation: 'create', schedule: {
      id: 'wake-1', kind: 'every', title: '监督者巡检', prompt: 'wake',
      everySeconds: 300, scheduledAt: '2026-01-01T00:00:00.000Z',
    } } },
    { type: 'schedule/change', data: { version: 1, operation: 'create', schedule: {
      id: 'wait-1', kind: 'at', prompt: 'ask', scheduledAt: '2026-01-01T00:05:00.000Z',
    } } },
    // A record without a usable instant must simply omit the field.
    { type: 'schedule/change', data: { version: 1, operation: 'create', schedule: {
      id: 'cron-1', kind: 'cron', title: '每日总结', prompt: 'summarize',
      expression: '0 9 * * *', timeZone: 'Asia/Shanghai', scheduledAt: 'not-an-instant',
    } } },
    { type: 'message', data: {} },
  ]
  const agent = {
    session: {
      header: { id: 'root', origin: 'root', agentPreset: 'main-agent' },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
    },
    status: 'idle',
  }
  const ctx = {
    agents: {
      get: id => (id === 'root' ? agent : id === 'worker-1' ? { status: 'running' } : undefined),
    },
    sessions: { flush: async () => {} },
    subagents: compatibleService([{ id: 'worker-1', mode: 'continuable', label: 'auditing' }]),
  }
  const { req, res, read } = recorder()
  req.url = '/supervisor/stop?session=root'
  await stopHandler(ctx, req, res)

  const { status, body } = read()
  assert.equal(status, 200)
  assert.deepEqual(body.reminders, [
    {
      id: 'wake-1', kind: 'every', title: '监督者巡检', everySeconds: 300,
      scheduledAt: Date.parse('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'wait-1', kind: 'at',
      scheduledAt: Date.parse('2026-01-01T00:05:00.000Z'),
    },
    { id: 'cron-1', kind: 'cron', title: '每日总结' },
  ])
  assert.deepEqual(body.runningWorkers, ['worker-1'])
  assert.equal(body.running, false)
  assert.equal(body.stopped, false, 'an armed reminder or a running worker is not stopped')
})

test('stop status stays "stopped" only with no reminder and no running worker', async () => {
  const agent = {
    session: {
      header: { id: 'root', origin: 'root', agentPreset: 'main-agent' },
      inheritedEventCount: 0,
      snapshotEvents: () => [],
    },
    status: 'idle',
  }
  const ctx = {
    agents: { get: id => (id === 'root' ? agent : undefined) },
    sessions: { flush: async () => {} },
    subagents: compatibleService([{ id: 'worker-1', mode: 'continuable' }]),
  }
  const { req, res, read } = recorder()
  req.url = '/supervisor/stop?session=root'
  await stopHandler(ctx, req, res)
  const { body } = read()
  assert.deepEqual(body.reminders, [])
  assert.deepEqual(body.runningWorkers, [])
  assert.equal(body.stopped, true)
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

/** One worker artifact directory under `.agi/subagents/`. */
function workerArtifact(agi, dirName, outcome) {
  const dir = join(agi, 'subagents', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'outcome.md'), outcome)
  return dir
}

/**
 * Outcome ownership (0.10.9). A worker's artifact directory is normally named
 * after its session id, but a hand-named one (`ui-polish-0107`) only carries the
 * id in the machine-readable header of its outcome.md — so the host parses that
 * header into `workerId` and the Feed can attach the result to its own row.
 * `name` (the directory) stays the primary key.
 */
test('an outcome header declares its worker id, for either accepted form', () => {
  const { root, agi } = feedWorkspace()
  workerArtifact(agi, 'ui-polish-0107', '<!-- worker: abc-123 -->\n# report\n')
  workerArtifact(agi, 'plain-header', 'worker: abc-123\n# report\n')
  workerArtifact(agi, 'quoted', '  <!-- WORKER: `abc-123` -->  \n')
  workerArtifact(agi, 'line-four', 'l1\nl2\nl3\nworker: abc-123\n')
  workerArtifact(agi, 'sentence', '<!-- worker: not an id -->\n')
  workerArtifact(agi, 'empty-id', '<!-- worker: -->\n')
  workerArtifact(agi, 'no-header', '# report\nno header here\n')

  const { status, body } = readFeed(root)
  assert.equal(status, 200)
  const byName = new Map(body.subagents.map(sub => [sub.name, sub]))
  assert.deepEqual([...byName.keys()].sort(), [
    'empty-id', 'line-four', 'no-header', 'plain-header', 'quoted', 'sentence', 'ui-polish-0107',
  ])

  assert.equal(byName.get('ui-polish-0107').workerId, 'abc-123', 'the html-comment form is read')
  assert.equal(byName.get('plain-header').workerId, 'abc-123', 'the bare form is read too')
  assert.equal(byName.get('quoted').workerId, 'abc-123', 'key case, quotes and padding are tolerated')
  assert.equal(byName.get('line-four').workerId, null, 'the header must sit on the first 3 lines')
  assert.equal(byName.get('sentence').workerId, null, 'a prose payload is not an id')
  assert.equal(byName.get('empty-id').workerId, null, 'an empty id is not an id')

  const bare = byName.get('no-header')
  assert.equal(bare.workerId, null)
  assert.equal(bare.name, 'no-header', 'the directory name is never rewritten')
  assert.equal(bare.outcome.text, '# report\nno header here\n')
})

test('a huge outcome keeps only its tail but still declares its worker', () => {
  const { root, agi } = feedWorkspace()
  // The header lives on line 1, exactly the part a 64KB tail cap throws away.
  workerArtifact(agi, 'label-named-big', `<!-- worker: big-1 -->\n${'x'.repeat(64 * 1024 + 100)}`)

  const { status, body } = readFeed(root)
  assert.equal(status, 200)
  const big = body.subagents.find(sub => sub.name === 'label-named-big')
  assert.ok(big, 'the artifact must be in the payload')
  assert.equal(big.workerId, 'big-1', 'the header is read from the head of the file')
  assert.equal(big.outcome.text.length, 64 * 1024, 'the body view stays tail-capped')
  assert.doesNotMatch(big.outcome.text, /worker: big-1/, 'the header is gone from the tail-capped body')
  assert.equal(big.outcome.truncated, true)
})

/**
 * Conditional refresh (0.10.8). The Feed polls every 5 seconds and almost
 * always sees the same `GOAL.md`/`NOTES.md`/`progress.jsonl`, so the route
 * answers a strong ETag and lets the client revalidate: a 304 skips both the
 * document assembly and the transfer, while every 200 keeps its byte-identical
 * JSON shape.
 */
function feedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-etag-'))
  const agi = join(root, '.agi')
  mkdirSync(agi)
  writeFileSync(join(agi, 'GOAL.md'), '# goal\n')
  writeFileSync(join(agi, 'progress.jsonl'), `${JSON.stringify({ ts: 't0', text: 'step' })}\n`)
  return { root, agi }
}

function readFeed(root, method = 'GET', headers = undefined) {
  const { req, res, read } = recorder(method, headers)
  req.url = `/supervisor/feed?ws=${encodeURIComponent(root)}`
  feedHandler(req, res)
  return { res, ...read() }
}

test('feed sends a quoted strong etag, stable while nothing changes', async () => {
  const { root } = feedWorkspace()
  const first = readFeed(root)
  assert.equal(first.status, 200)
  // A quoted string is a STRONG validator; an unquoted one would be ignored.
  assert.match(first.res.headers.etag, /^"[^"]+"$/)
  assert.equal(first.res.headers['cache-control'], 'no-store', 'revalidation must not license caching')

  // Two reads inside the same millisecond would carry the SAME `generatedAt`,
  // which made this assertion fail about once in 40 runs on a fast machine.
  await new Promise(resolve => setTimeout(resolve, 2))
  const second = readFeed(root)
  assert.equal(second.res.headers.etag, first.res.headers.etag, 'an untouched workspace keeps its etag')
  // `generatedAt` is the wall clock of the read, so it moves on every call; the
  // validator must not, or nothing would ever revalidate.
  assert.notEqual(second.body.generatedAt, first.body.generatedAt)
  const strip = body => ({ ...body, generatedAt: 0 })
  assert.deepEqual(strip(second.body), strip(first.body), 'the document itself is unchanged')
})

test('feed etag changes when a watched artifact changes', () => {
  const { root, agi } = feedWorkspace()
  const before = readFeed(root).res.headers.etag

  writeFileSync(join(agi, 'GOAL.md'), '# goal changed\n')
  const afterText = readFeed(root).res.headers.etag
  assert.notEqual(afterText, before, 'GOAL.md content must invalidate the feed')

  // A new worker artifact invalidates it too: those are part of the document.
  const dir = join(agi, 'subagents', 'w1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'outcome.md'), 'done')
  const afterWorker = readFeed(root).res.headers.etag
  assert.notEqual(afterWorker, afterText, 'a new outcome.md must invalidate the feed')

  // A stat-only fingerprint: same size, newer mtime still counts.
  const stamp = new Date(Date.now() + 5_000)
  utimesSync(join(agi, 'GOAL.md'), stamp, stamp)
  assert.notEqual(readFeed(root).res.headers.etag, afterWorker)
})

test('a matching if-none-match answers 304 with the etag and no body', () => {
  const { root } = feedWorkspace()
  const etag = readFeed(root).res.headers.etag
  const revalidated = readFeed(root, 'GET', { 'if-none-match': etag })
  assert.equal(revalidated.status, 304)
  assert.equal(revalidated.res.headers.etag, etag)
  assert.equal(revalidated.res.headers['cache-control'], 'no-store')
  assert.equal(revalidated.res.body, undefined, 'a 304 carries no document')
})

test('a stale or unrelated if-none-match still gets the document', () => {
  const { root } = feedWorkspace()
  const stale = readFeed(root, 'GET', { 'if-none-match': '"not-the-etag"' })
  assert.equal(stale.status, 200)
  assert.ok(stale.body.goal?.text != null)
})

test('if-none-match parsing tolerates weak and comma-list forms', () => {
  const { root } = feedWorkspace()
  const etag = readFeed(root).res.headers.etag
  for (const header of [
    `W/${etag}`,
    [`"other"`, etag],
    `"a", ${etag}`,
    `  ${etag}  `,
  ]) {
    assert.equal(readFeed(root, 'GET', { 'if-none-match': header }).status, 304,
      `must revalidate for ${JSON.stringify(header)}`)
  }
})

test('HEAD stays 200 + etag + no body', () => {
  const { root } = feedWorkspace()
  const etag = readFeed(root).res.headers.etag
  const head = readFeed(root, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.res.headers.etag, etag, 'HEAD is a probe: same validator, no document')
  assert.equal(head.res.body, undefined, 'HEAD never carries the body')

  // A conditional HEAD is still revalidation (RFC 9110 §13.1.3), so it answers
  // 304 like a GET — with the validator and no body.
  const conditional = readFeed(root, 'HEAD', { 'if-none-match': etag })
  assert.equal(conditional.status, 304)
  assert.equal(conditional.res.headers.etag, etag)
  assert.equal(conditional.res.body, undefined)
})

test('a workspace without .agi is still 404 and carries no etag', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-etag-empty-'))
  const missing = readFeed(root)
  assert.equal(missing.status, 404)
  assert.equal(missing.res.headers.etag, undefined)
})

