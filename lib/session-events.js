/**
 * Read a live Harness Session's event log across dsh Session API revisions.
 *
 * dsh exposes the complete synchronous log through `Session.snapshotEvents()`;
 * the plain `session.events` field that older revisions carried no longer
 * exists, so reading it yields `undefined` and the first `.length` takes the
 * surrounding turn down. Every reader here is fail-open: an unrecognizable
 * Session yields an empty log instead of throwing, because the callers are
 * pre-step hooks and stop transactions that must stay alive.
 *
 * Kept free of Harness imports so the readers can be exercised directly.
 */

const NO_EVENTS = Object.freeze([])

/** The Session's full event log, or an empty log when it cannot be read. */
export function sessionEvents(session) {
  if (session === null || typeof session !== 'object') return NO_EVENTS
  if (typeof session.snapshotEvents === 'function') {
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      events = undefined
    }
    if (Array.isArray(events)) return events
  }
  return Array.isArray(session.events) ? session.events : NO_EVENTS
}

/**
 * How many leading events a forked Session inherited from its parent.
 * `foldScheduleEvents` must fold only the events the Session owns, so it
 * rejects any count that is missing, negative, or beyond the supplied log.
 * Older sessions carried the same value as `header.seedLength`.
 */
export function sessionInheritedEventCount(session) {
  const count = session?.inheritedEventCount
  if (Number.isSafeInteger(count) && count >= 0) return count
  const legacy = session?.header?.seedLength
  return Number.isSafeInteger(legacy) && legacy >= 0 ? legacy : 0
}
