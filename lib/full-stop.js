/**
 * Full-stop transaction for one live supervisor Agent.
 *
 * Kept free of Harness imports so the concurrency and durability ordering can
 * be exercised without booting a web profile.
 */

import { sessionEvents, sessionInheritedEventCount } from './session-events.js'

/** Wait for the whole Agent to become idle, with a bounded caller wait. */
async function waitForIdle(agent, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      agent.whenIdle().then(() => true, () => false),
      new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Resolve the preset a Session actually runs; a logged blank-session switch wins over its creation header. */
export function sessionAgentPreset(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session?.header?.agentPreset
}

/**
 * Cancel one Agent and delete its active reminders inside an exclusive
 * maintenance phase. The first flush establishes the durable fold being
 * mutated; the second makes every appended delete durable before success.
 * Any supplied `stopChildren` hook runs after the supervisor reaches idle and
 * before schedule maintenance, so delegated work cannot race the reminder
 * transaction or wake the supervisor while it is being stopped.
 *
 * `runMaintenance` throws synchronously only when another activity owns the
 * idle phase. Failures after it accepts the task are transaction outcomes and
 * are never retried as if they were lock contention.
 */
export async function fullStopAgent(
  agent,
  flush,
  foldScheduleEvents,
  { idleTimeoutMs = 15000, maintenanceAttempts = 3, stopChildren, deleteReminder, listReminderIds } = {},
) {
  agent.cancel({ kind: 'user' })
  if (!await waitForIdle(agent, idleTimeoutMs)) return { kind: 'idle-timeout' }

  let workerIds
  if (stopChildren !== undefined) {
    try {
      workerIds = await stopChildren(agent)
    } catch (error) {
      return { kind: 'worker-stop-failed', error }
    }
    // A child can publish a final report while its branch is being released.
    // Clear that wake and regain idle before entering schedule maintenance.
    agent.cancel({ kind: 'user' })
    if (!await waitForIdle(agent, idleTimeoutMs)) {
      return { kind: 'idle-timeout', workerIds }
    }
  }

  const withWorkers = outcome => workerIds === undefined ? outcome : { ...outcome, workerIds }

  for (let attempt = 0; attempt < maintenanceAttempts; attempt++) {
    let maintenance
    try {
      maintenance = agent.runMaintenance(async () => {
        try {
          await flush(agent.session)
        } catch (error) {
          return { kind: 'preflight-failed', error }
        }

        let folded
        try {
          folded = foldScheduleEvents(
            sessionEvents(agent.session),
            sessionInheritedEventCount(agent.session),
          )
        } catch (error) {
          return { kind: 'fold-failed', error }
        }

        const ids = [...new Set(
          listReminderIds === undefined
            ? folded.active.map(record => record.id)
            // The log only knows about reminders that appended an event; the
            // authoritative read also sees ones created through the service
            // (which is what this plugin's own watchdog creates).
            : [...folded.active.map(record => record.id), ...await listReminderIds(agent)],
        )].filter(id => typeof id === 'string' && id.length > 0)
        // `schedule/change` is only the Session's LOG projection: the
        // authoritative store is the host's `tasks` table, and nothing
        // reconciles appended deletes back into it. Appending alone therefore
        // left every reminder armed after a "full" stop — the loop could wake
        // itself up minutes later. Delete through the service FIRST, then
        // append so the log still explains what happened.
        const deleted = []
        const stillArmed = []
        if (deleteReminder !== undefined) {
          for (const id of ids) {
            try {
              const result = await deleteReminder(agent.session.id, id)
              if (result === true || result?.deleted === true) deleted.push(id)
              else stillArmed.push(id)
            } catch {
              stillArmed.push(id)
            }
          }
        }
        const appended = []
        try {
          for (const id of ids) {
            agent.session.append('schedule/change', { version: 1, operation: 'delete', id })
            appended.push(id)
          }
        } catch (error) {
          try {
            await flush(agent.session)
          } catch {
            // The response reports the partial in-memory mutation explicitly.
          }
          return { kind: 'append-failed', ids: appended, error }
        }

        try {
          await flush(agent.session)
        } catch (error) {
          return { kind: 'postflight-failed', ids, error }
        }
        if (stillArmed.length > 0) return { kind: 'reminder-delete-failed', ids, stillArmed }
        // Keep the historical outcome shape when no service hook was supplied,
        // so the durable-delete fields only appear for callers that can honour
        // them.
        return deleteReminder === undefined
          ? { kind: 'stopped', ids }
          : { kind: 'stopped', ids, durableDeleted: deleted.length }
      })
    } catch {
      if (!await waitForIdle(agent, idleTimeoutMs)) return { kind: 'idle-timeout' }
      continue
    }

    try {
      return withWorkers(await maintenance)
    } catch (error) {
      return withWorkers({ kind: 'maintenance-failed', error })
    }
  }
  return withWorkers({ kind: 'busy' })
}
