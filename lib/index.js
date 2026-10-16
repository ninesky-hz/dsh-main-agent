/**
 * dsh-main-agent — host half.
 *
 * Responsibilities, one package (3–4 live on the nested web plugin):
 *
 * 1. PRESET INSTALL. The supervisor's core is an AGENT PRESET
 *    (agent-presets/main-agent in this package), and presets live in the user
 *    preset root, not in the plugin tree. At mount this plugin installs the
 *    bundled preset into `${DSH_HOME:-~/.dsh}/.agent-presets/main-agent` so
 *    the package works out of the box after `dsh plugin add`.
 *    Non-destructive: an existing preset directory is NEVER overwritten unless
 *    config says `syncPreset: 'always'` — user edits are user property.
 *
 * 2. FEED ROUTE. `GET /supervisor/feed?ws=<workspace>` serves the workspace's
 *    `.agi/` state (goal, progress, questions, changelog, notes, mission
 *    report, worker outcomes) as one JSON document. The browser half (the
 *    "Feed" view tab registered into the shipped `conversation.view` ring —
 *    see lib/client.js) polls it. Registered through a NESTED plugin injecting
 *    `webServer`, so the preset install never waits on the web stack and the
 *    package still mounts in profiles that have no web server at all.
 *
 * 3. FULL STOP. `GET /supervisor/stop?session=…` reports durable armed state;
 *    `POST` aborts the active turn, recursively releases continuable worker
 *    branches, and deletes every schedule reminder inside an exclusive
 *    maintenance window (the native stop only aborts one turn).
 *
 * 4. MODELS CATALOG. `GET /supervisor/models` for the settings card dropdown.
 *
 * (The Shots tab lives in its own package, dsh-shots — it is generic browser-
 * daemon tooling, not supervisor logic.)
 *
 * Config (all optional):
 *   syncPreset: 'if-absent' (default) | 'always' | 'never'
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { fullStopAgent, sessionAgentPreset } from './full-stop.js'
import { sessionEvents, sessionInheritedEventCount } from './session-events.js'
import {
  RUNTIME_MODEL_KEY,
  WORKER_EFFORT_PROVIDER_DEFAULT,
  workerReasoningInfo,
} from './worker-model-policy.js'

export const name = 'dsh-main-agent'
export const inject = []

/** The supervisor's meta-config namespace. On dsh 0.2 the host derives the
 * editable settings form from this plugin's exported `Config` and keys it by
 * the profile row id — `agi-supervisor-setup`, as inserted by this package's
 * cordis.patch.yml — so the namespace IS that id. Live values reach the spawn
 * tool (lib/spawn.js) through the `supervisorSettings` service. */
export const SETTINGS_NS = 'agi-supervisor-setup'

/** Fields declared `.volatile()` are the editable settings surface: the host
 * commits them in place without remounting this plugin, so `config.<field>` is
 * a stable live reference (read it with `.get()`) and edits apply mid-session
 * with no restart. `syncPreset` is mount-time only. */
export const Config = z.object({
  /** Bundled-preset sync policy at mount (not editable from the web UI). */
  syncPreset: z.union([
    z.const('if-absent'),
    z.const('always'),
    z.const('never'),
  ]).default('if-absent'),
  /** Complete worker-model allowlist (`provider/model-id` or the explicit
   * runtime/current sentinel). Empty disables the guarded `subagent` tool. */
  workerModels: z.array(z.string()).default([RUNTIME_MODEL_KEY]).volatile(),
  /** Settings-owned effort by allowlisted route. Missing routes use genuine
   * provider default; fixed ids must be advertised by the selected model. */
  workerEfforts: z.dict(z.string()).default({
    [RUNTIME_MODEL_KEY]: WORKER_EFFORT_PROVIDER_DEFAULT,
  }).volatile(),
  /** Max simultaneously ACTIVE workers per supervisor; 0 = unlimited.
   * Enforced by the spawn tool at call time. */
  maxParallelWorkers: z.number().step(1).min(0).default(3).volatile(),
  /** How often the supervisor wakes to inspect running workers (minutes).
   * Arms a recurring schedule reminder; harness floor is 5. */
  wakeMinutes: z.number().step(1).min(5).default(5).volatile(),
  /** How long the supervisor waits for an answer to a question (minutes)
   * before recording an assumption and continuing. */
  questionWaitMinutes: z.number().step(1).min(1).default(2).volatile(),
})

const SETTINGS_DEFAULTS = {
  workerModels: [RUNTIME_MODEL_KEY],
  workerEfforts: { [RUNTIME_MODEL_KEY]: WORKER_EFFORT_PROVIDER_DEFAULT },
  maxParallelWorkers: 3,
  wakeMinutes: 5,
  questionWaitMinutes: 2,
}

/** Read one meta-config field: a live `.volatile()` reference on dsh 0.2, a
 * plain value on hosts that predate it, falling back to the default when a
 * reference is absent or empty. */
const live = (value, fallback) => {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return raw === undefined || raw === null ? fallback : raw
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_ID = 'main-agent'

/** Cap for raw text files in the feed payload (the UI shows a tail anyway). */
const TEXT_CAP = 64 * 1024
/** Cap for JSONL entries per file (newest kept). */
const JSONL_CAP = 300

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ syncPreset?: 'if-absent' | 'always' | 'never' }} [config]
 */
export function apply(ctx, config) {
  // Cordis contexts carry a logger; console remains the fallback for odd hosts.
  const log = ctx?.logger ?? console
  installPreset(log, config)

  // Meta-config: publish the live `.volatile()` config as the
  // `supervisorSettings` service (spawn.js reads it at every tool call and in
  // its live prompt section, so edits apply mid-session with no restart).
  // The host owns the settings document and commits volatile edits in place;
  // only consumers that cache derived state (the spawn tool's model allowlist)
  // need the change signal below.
  const watchers = new Set()
  let notifyQueued = false
  const notify = () => {
    for (const listener of watchers) {
      try {
        listener()
      } catch (error) {
        log.warn(`dsh-main-agent: 设置监听器执行失败：${error?.message ?? error}`)
      }
    }
  }
  const scheduleNotify = () => {
    // A commit can surface on this fiber and, on some hosts, on the root too:
    // coalesce everything into a single fan-out per microtask.
    if (notifyQueued) return
    notifyQueued = true
    queueMicrotask(() => {
      notifyQueued = false
      notify()
    })
  }
  const follow = (target, event) => {
    try {
      ctx.effect(() => {
        target.on(event, scheduleNotify)
        return () => target.off(event, scheduleNotify)
      })
    } catch (error) {
      // A host without this signal still reads live values; the tool's cached
      // allowlist simply refreshes at the next remount instead.
      log.warn(`dsh-main-agent: 无法订阅 ${event}：${error?.message ?? error}`)
    }
  }
  // The loader announces in-place volatile commits on the plugin's own fiber;
  // the settings service also announces document updates from the root.
  follow(ctx, 'loader/volatile-update')
  if (ctx.root !== undefined && ctx.root !== ctx) follow(ctx.root, 'settings/document-updated')
  ctx.provide('supervisorSettings', {
    current: () => ({
      workerModels: live(config?.workerModels, SETTINGS_DEFAULTS.workerModels),
      workerEfforts: live(config?.workerEfforts, SETTINGS_DEFAULTS.workerEfforts),
      maxParallelWorkers: live(config?.maxParallelWorkers, SETTINGS_DEFAULTS.maxParallelWorkers),
      wakeMinutes: live(config?.wakeMinutes, SETTINGS_DEFAULTS.wakeMinutes),
      questionWaitMinutes: live(config?.questionWaitMinutes, SETTINGS_DEFAULTS.questionWaitMinutes),
    }),
    subscribe: (listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  })

  // Nested fiber: waits for `webServer` on web profiles, never mounts elsewhere.
  ctx.plugin({
    name: 'dsh-main-agent-feed',
    inject: ['webServer', 'llm', 'agents', 'sessions', 'subagents'],
    apply: (feedCtx) => {
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/feed',
        handler: feedHandler,
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/models',
        handler: (req, res) => modelsHandler(feedCtx, req, res),
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/stop',
        handler: (req, res) => stopHandler(feedCtx, req, res),
      }))
      log.info('dsh-main-agent: 已在 /supervisor/feed、/supervisor/models、/supervisor/stop 注册路由')
    },
  })
}

/**
 * `GET /supervisor/models` — the explicit runtime/current choice followed by
 * the harness model catalog (provider/model-id + native input modalities and
 * reasoning capability) for the settings card's model and effort dropdowns.
 */
async function modelsHandler(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const models = [{
    provider: 'runtime',
    id: 'current',
    name: 'Current runtime model',
    modalities: [],
    dynamic: true,
  }]
  for (const provider of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(provider.id)) {
        if (`${model.provider}/${model.id}` === RUNTIME_MODEL_KEY) continue
        // listModels intentionally returns only the lightweight catalog shape;
        // exact-route reasoning capability lives on resolveModelInfo.
        let resolved = model
        try {
          resolved = await ctx.llm.resolveModelInfo(model.provider, model.id)
        } catch {
          // Keep the route selectable when capability enrichment alone fails.
        }
        models.push({
          provider: model.provider,
          id: model.id,
          name: model.name,
          modalities: resolved.inputModalities ?? model.inputModalities ?? ['text'],
          ...resolved.reasoning === undefined ? {} : { reasoning: workerReasoningInfo(resolved.reasoning) },
        })
      }
    } catch {
      // One adapter failing to enumerate must not empty the whole dropdown.
    }
  }
  const payload = JSON.stringify({ models })
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : payload)
}

/**
 * Install the bundled preset into the user preset root (idempotent, a
 * filesystem fact — an installed preset outliving the plugin is the point).
 */
function installPreset(log, config) {
  const mode = config?.syncPreset ?? 'if-absent'
  if (mode === 'never') return
  const source = join(PACKAGE_ROOT, 'agent-presets', PRESET_ID)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const target = join(home, '.agent-presets', PRESET_ID)
  try {
    if (!existsSync(join(source, 'agent.cordis.yml'))) {
      log.warn(`dsh-main-agent: 随包 preset 在 ${source} 处缺失 —— 安装已损坏`)
      return
    }
    if (existsSync(target) && mode !== 'always') {
      log.info(`dsh-main-agent: preset "${PRESET_ID}" 已存在于 ${target} —— 保持原样、不予改动（要覆盖请设 syncPreset: 'always'）`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true })
    log.info(`dsh-main-agent: 已安装 preset "${PRESET_ID}" -> ${target}`)
  } catch (error) {
    // Never fail the boot over preset sync; the manual path (README) remains.
    log.warn(`dsh-main-agent: preset 安装失败：${error?.message ?? error}`)
  }
}

/** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} */
function feedHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const ws = url.searchParams.get('ws')
  const send = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : payload)
  }
  if (ws === null || ws === '') return send(400, { error: '缺少 ?ws=<workspace path> 参数' })
  const root = resolve(ws)
  const agi = join(root, '.agi')
  let stats
  try {
    stats = statSync(agi)
  } catch {
    return send(404, { error: `${root} 下没有 .agi 目录` })
  }
  if (!stats.isDirectory()) return send(404, { error: `${agi} 不是一个目录` })
  try {
    send(200, collectFeed(root, agi))
  } catch (error) {
    send(500, { error: String(error?.message ?? error) })
  }
}

/**
 * `GET /supervisor/stop?session=<sessionId>` reports whether a supervisor is
 * idle with no active reminders, including from a cold persisted Session.
 * `POST` FULL-stops one supervisor: aborts the active turn (clearing queued
 * work) and deletes every active schedule reminder, so nothing re-wakes the
 * agent later. It also releases every resident continuable worker branch
 * child-first. Without this, the native stop square only aborts the current
 * turn — the recurring check-in reminder (`wakeMinutes`, floor 5 min) fires
 * again and the agent resumes.
 *
 * Safety: schedule deletes MUST NOT race the agent's own schedule operations —
 * a delete event targeting an id that is no longer active permanently poisons
 * the session's schedule fold (`ScheduleLogError` on every future replay).
 * The agent mutates schedules only from inside its own activity (tool calls
 * during turns; the schedule runtime dispatches inside `runMaintenance`), so
 * this handler cancels, waits for idle, and performs the fold + deletes inside
 * its own exclusive `runMaintenance` window — the same discipline the shipped
 * schedule runtime uses.
 *
 * The browser resolves a worker view to its root supervisor and resumes a cold
 * supervisor without sending a prompt before calling this route. Direct calls
 * against cold or non-supervisor sessions fail instead of reporting a false
 * success.
 */
async function stopHandler(ctx, req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sessionId = url.searchParams.get('session')
  if (sessionId === null || sessionId === '') return send(400, { error: '缺少 ?session=<sessionId> 参数' })

  let foldScheduleEvents
  try {
    ({ foldScheduleEvents } = await import('@deepseek-ai/dsh-schedule'))
  } catch {
    return send(500, { error: '当前 profile 中不可用 schedule 包' })
  }

  const agent = ctx.agents.get(sessionId)
  if (req.method === 'GET') {
    let session
    let events
    if (agent !== undefined) {
      try {
        await ctx.sessions.flush(agent.session)
      } catch {
        return send(503, { error: '无法建立持久的 schedule 状态' })
      }
      session = agent.session
      // dsh 0.2 Sessions expose the log only through `snapshotEvents()`.
      events = sessionEvents(session)
    } else {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return send(503, { error: 'session 持久化不可用' })
      try {
        const inspected = await persistence.inspect(sessionId)
        session = { header: inspected.meta, events: inspected.events }
        events = sessionEvents(session)
      } catch {
        return send(404, { error: '未找到该 session' })
      }
    }
    if (session.header.origin === 'subagent' || sessionAgentPreset(session) !== PRESET_ID) {
      return send(409, { error: '该 session 不是根 main-agent supervisor' })
    }
    let folded
    try {
      folded = foldScheduleEvents(events, sessionInheritedEventCount(session))
    } catch {
      return send(500, { error: '无法 fold schedule 日志' })
    }
    const reminders = folded.active.map(record => record.id)
    const running = agent?.status === 'running'
    let runningWorkers
    try {
      const children = await ctx.subagents.listChildren(sessionId)
      runningWorkers = children
        .filter(entry => entry.kind === 'child'
          && entry.mode === 'continuable'
          && entry.activity === 'running')
        .map(entry => entry.id)
    } catch {
      return send(503, { error: '无法建立 worker 状态' })
    }
    return send(200, {
      stopped: !running && reminders.length === 0 && runningWorkers.length === 0,
      running,
      reminders,
      runningWorkers,
    })
  }

  if (agent === undefined) {
    return send(409, { error: 'session 未存活；请先恢复 supervisor 再重试' })
  }
  if (agent.session.header.origin === 'subagent'
    || sessionAgentPreset(agent.session) !== PRESET_ID) {
    return send(409, { error: '该 session 不是根 main-agent supervisor' })
  }

  const outcome = await fullStopAgent(
    agent,
    session => ctx.sessions.flush(session),
    foldScheduleEvents,
    {
      stopChildren: async (parent) => {
        const children = await ctx.subagents.listChildren(parent.id)
        const continuableIds = children
          .filter(entry => entry.kind === 'child' && entry.mode === 'continuable')
          .map(entry => entry.id)
        const runningIds = children
          .filter(entry => entry.kind === 'child'
            && entry.mode === 'continuable'
            && entry.activity === 'running')
          .map(entry => entry.id)
        await ctx.subagents.drainContinuableChildren(parent, continuableIds)
        return runningIds
      },
    },
  )
  if (outcome.kind === 'stopped') {
    return send(200, {
      live: true,
      cancelled: true,
      durable: true,
      remindersDeleted: outcome.ids.length,
      ids: outcome.ids,
      workersStopped: outcome.workerIds.length,
      workerIds: outcome.workerIds,
    })
  }
  if (outcome.kind === 'postflight-failed') {
    return send(200, {
      live: true,
      cancelled: true,
      durable: false,
      remindersDeleted: outcome.ids.length,
      ids: outcome.ids,
      workersStopped: outcome.workerIds.length,
      workerIds: outcome.workerIds,
      note: 'flush 结果不确定 —— 删除仅应用于内存',
    })
  }
  if (outcome.kind === 'idle-timeout') {
    return send(504, { error: 'agent 未能在 15 秒内进入 idle；提醒未被改动 —— 请重试' })
  }
  if (outcome.kind === 'worker-stop-failed') {
    return send(503, { error: '无法停止委派的 worker；提醒未被改动 —— 请重试' })
  }
  if (outcome.kind === 'preflight-failed') {
    return send(503, { error: '无法建立持久的 schedule 状态；提醒未被改动 —— 请重试' })
  }
  if (outcome.kind === 'fold-failed') {
    return send(500, { error: '无法 fold schedule 日志；提醒未被改动' })
  }
  if (outcome.kind === 'append-failed') {
    return send(500, {
      error: '无法追加全部提醒删除记录；请重试',
      remindersDeleted: outcome.ids.length,
      ids: outcome.ids,
    })
  }
  if (outcome.kind === 'busy') {
    return send(503, { error: 'agent 一直处于忙状态；提醒未被改动 —— 请重试' })
  }
  return send(500, { error: 'full-stop 维护失败；请重试' })
}


/** Assemble the whole feed document from the workspace's .agi tree. */
function collectFeed(root, agi) {
  return {
    ws: root,
    generatedAt: Date.now(),
    goal: text(join(agi, 'GOAL.md')),
    amendments: text(join(agi, 'GOAL_AMENDMENTS.md')),
    notes: text(join(agi, 'NOTES.md')),
    missionReport: text(join(agi, 'MISSION_REPORT.md')),
    config: jsonFile(join(agi, 'config.json')),
    progress: jsonl(join(agi, 'progress.jsonl')),
    questions: jsonl(join(agi, 'questions.jsonl')),
    changelog: jsonl(join(agi, 'CHANGELOG.jsonl')),
    subagents: subagentDirs(join(agi, 'subagents')),
  }
}

/** Text file as { text, mtime } (tail-capped), or null when absent. */
function text(path) {
  try {
    const stat = statSync(path)
    let value = readFileSync(path, 'utf8')
    if (value.length > TEXT_CAP) value = value.slice(-TEXT_CAP)
    return { text: value, mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

/** Parsed JSON file, or null when absent/malformed. */
function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** JSONL entries (newest JSONL_CAP kept; malformed lines skipped), or []. */
function jsonl(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // A half-written trailing line during an append is normal; skip it.
    }
  }
  return entries.slice(-JSONL_CAP)
}

/** Per-worker artifact inventory: outcome.md content and extra file names. */
function subagentDirs(path) {
  let names
  try {
    names = readdirSync(path)
  } catch {
    return []
  }
  const out = []
  for (const dirName of names) {
    const dir = join(path, dirName)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let files = []
    try {
      files = readdirSync(dir)
    } catch { /* unreadable worker dir: report it empty */ }
    out.push({
      name: dirName,
      outcome: text(join(dir, 'outcome.md')),
      files,
    })
  }
  return out
}
