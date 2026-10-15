import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionEvents, sessionInheritedEventCount } from '../lib/session-events.js'

function event(type, time = 0, data = {}) {
  return { type, time, data }
}

/**
 * Mirror of the declared dsh Session surface
 * (`@deepseek-ai/dsh-api-session-controller` typert `class Session`): the log is
 * reachable only through `snapshotEvents()` / `eventAt()` / `ownEvents()`, and
 * there is no `events` field at all.
 */
function declaredSession(log, inheritedEventCount = 0) {
  return {
    header: { version: 4, id: 's-1', createdAt: 0, isSeeded: false },
    inheritedEventCount,
    firstLiveSeq: inheritedEventCount,
    firstLifecycleSeq: inheritedEventCount,
    get seq() { return log.length },
    eventAt(seq) { return log[seq] },
    snapshotEvents(fromSeq = 0, toSeqExclusive = log.length) {
      return Object.freeze(log.slice(fromSeq, toSeqExclusive))
    },
    ownEvents() { return this.snapshotEvents(this.inheritedEventCount) },
  }
}

test('the declared Session surface is read through snapshotEvents', () => {
  const log = [event('turn/start'), event('agent/inbox/spliced', 30)]
  const session = declaredSession(log, 1)

  assert.deepEqual(sessionEvents(session), log)
  assert.equal(sessionEvents(session).length, 2)
  assert.equal(sessionInheritedEventCount(session), 1)
})

test('a Session without any event log reads as empty instead of throwing', () => {
  // The regression: dsh dropped `session.events`, so `session.events.length`
  // is a TypeError that fails the whole turn carrying a settlement notice.
  for (const session of [undefined, null, {}, { header: {} }, { header: { agentPreset: 'cordis' } }]) {
    assert.deepEqual(sessionEvents(session), [], `events of ${JSON.stringify(session)}`)
    assert.equal(sessionInheritedEventCount(session), 0, `count of ${JSON.stringify(session)}`)
  }
  assert.equal(sessionEvents([]).length, 0)
  assert.equal(sessionEvents('session').length, 0)
})

test('an unavailable or unusable snapshotEvents stays fail-open', () => {
  const throwing = { snapshotEvents() { throw new Error('log unavailable') } }
  assert.deepEqual(sessionEvents(throwing), [])

  const notALog = { snapshotEvents() { return undefined } }
  assert.deepEqual(sessionEvents(notALog), [])

  // A throwing reader must not hide a legacy log that is still present.
  const legacyBacked = {
    events: [event('turn/start')],
    snapshotEvents() { throw new Error('log unavailable') },
  }
  assert.equal(sessionEvents(legacyBacked).length, 1)
})

test('a legacy plain events array is still honored', () => {
  const log = [event('agent-preset/selected', 1, { agentPreset: 'minimal' })]
  assert.deepEqual(sessionEvents({ events: log }), log)
  assert.deepEqual(sessionEvents({ events: 'not a log' }), [])
})

test('the fork offset prefers inheritedEventCount and falls back to seedLength', () => {
  const log = [event('turn/start'), event('turn/end')]
  assert.equal(sessionInheritedEventCount({ inheritedEventCount: 2 }), 2)
  assert.equal(sessionInheritedEventCount({ inheritedEventCount: 2, header: { seedLength: 9 } }), 2)
  assert.equal(sessionInheritedEventCount({ header: { seedLength: 3 } }), 3)
  assert.equal(sessionInheritedEventCount({ header: { seedLength: 0 } }), 0)
  assert.equal(sessionInheritedEventCount({ header: {} }), 0)
  assert.equal(sessionInheritedEventCount({ inheritedEventCount: 0, header: { seedLength: 3 } }), 0)

  // foldScheduleEvents rejects anything outside `0..events.length`.
  for (const bad of [-1, 1.5, NaN, Infinity, '2', null, undefined]) {
    assert.equal(sessionInheritedEventCount({ inheritedEventCount: bad }), 0, `count ${String(bad)}`)
    assert.equal(sessionInheritedEventCount({ header: { seedLength: bad } }), 0, `seed ${String(bad)}`)
  }
  assert.equal(sessionInheritedEventCount({ inheritedEventCount: 1 }), 1)
  assert.deepEqual(log.length, 2)
})
