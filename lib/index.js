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

import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { fullStopAgent, sessionAgentPreset } from './full-stop.js'
import { sessionEvents, sessionInheritedEventCount } from './session-events.js'
import {
  childIsRunning,
  continuableChildIds,
  drainWorkers,
  missingSubagentMethods,
  REQUIRED_METHODS,
  runningChildIds,
  subagentCompatible,
  subagentIncompatibilityMessage,
} from './subagent-compat.js'
import {
  applySupervisorToFile,
  hasSupervisorBackup,
  presetFile,
  stripSupervisorFromFile,
} from './preset-files.js'
import {
  applySupervisorLayer,
  countSupervisorRows,
  isSupervised,
  stripSupervisorLayer,
  syncSupervisedLayer,
} from './supervise.js'
import {
  RUNTIME_MODEL_KEY,
  WORKER_EFFORT_PROVIDER_DEFAULT,
  workerReasoningInfo,
} from './worker-model-policy.js'
import { WATCHDOG_TITLE, describeWake } from './loop-policy.js'
import { lastDispatchAt, listReminders, loopSnapshot } from './watchdog.js'

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
  /** Lifetime worker budget per supervisor session; 0 = unlimited. Counts every
   * continuable child ever started, so a long mission cannot spawn forever. */
  maxSpawnTotal: z.number().step(1).min(0).default(0).volatile(),
  /** Minutes a running worker may go without any log activity before the
   * watchdog interrupts it; 0 disables the reaper. */
  workerDeadlineMinutes: z.number().step(1).min(0).default(0).volatile(),
  /** Server-side wake-up guarantee: keep exactly one fallback reminder armed
   * whenever a goal is active and the model left none. */
  watchdogEnabled: z.boolean().default(true).volatile(),
  /** How often the supervisor wakes to inspect running workers (minutes).
   * The idle baseline — the adaptive policy may fire sooner (worker running)
   * or back off further (no new evidence). Harness floor is 60 seconds. */
  wakeMinutes: z.number().step(1).min(1).default(5).volatile(),
  /** How long the supervisor waits for an answer to a question (minutes)
   * before recording an assumption and continuing. */
  questionWaitMinutes: z.number().step(1).min(1).default(2).volatile(),
  /** Preset ids whose sessions should run the supervisor loop. Each toggle
   * rewrites that preset's loader entry in place, so it applies to the NEXT
   * session of that mode with no restart. `main-agent` is always supervised
   * and is intentionally never listed here. */
  supervisedPresets: z.array(z.string()).default([]).volatile(),
})

const SETTINGS_DEFAULTS = {
  workerModels: [RUNTIME_MODEL_KEY],
  workerEfforts: { [RUNTIME_MODEL_KEY]: WORKER_EFFORT_PROVIDER_DEFAULT },
  maxParallelWorkers: 3,
  maxSpawnTotal: 0,
  workerDeadlineMinutes: 0,
  watchdogEnabled: true,
  wakeMinutes: 5,
  questionWaitMinutes: 2,
  supervisedPresets: [],
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

/** The loader entry name every agent preset registers under. */
const PRESET_ENTRY_NAME = '@deepseek-ai/dsh-agent-preset'

/** Pristine `config.plugins` per preset id, captured the first time this
 * process touches a preset. Toggling supervision off restores exactly this
 * array, so a round trip is byte-identical even if the official preset later
 * gains or loses rows we never looked at. */
const presetBaselines = new Map()

/**
 * Every live agent-preset loader entry, as `{ entry, id, plugins }`.
 *
 * Presets do NOT come from `${DSH_HOME}/.agent-presets/` on dsh 0.2 — that
 * directory is legacy. They are ordinary loader rows declared by bundle
 * patches (`preset-main-agent` in this package, `preset-standard` in
 * `@deepseek-ai/dsh-web-app`, …). Being loader rows is what makes hot editing
 * possible: `Entry.update` restarts only that row's fiber, the preset's
 * `Service.init` generator drops its old registry entry on dispose and
 * registers the new one, and the registry never sees a duplicate id.
 */
export function presetEntries(ctx) {
  const out = []
  const loader = ctx?.loader
  if (loader === undefined || typeof loader.entries !== 'function') return out
  for (const entry of loader.entries()) {
    if (entry?.options?.name !== PRESET_ENTRY_NAME) continue
    const id = entry.options.config?.id
    if (typeof id !== 'string' || id.length === 0) continue
    out.push({ entry, id, plugins: entry.options.config.plugins })
  }
  return out
}

/**
 * Re-mount a preset that was registered straight into the registry.
 *
 * Those declarations never pass through the loader, so `entry.update` has
 * nothing to touch. The registry does keep the whole record on a plain
 * `definitions` field and `activate()` is a prototype method, so swapping
 * `config.plugins` and re-activating hands the new revision to every session
 * created from now on. Sessions already bound keep the retired generation until
 * they unbind — `collect` only disposes at `users === 0`.
 *
 * Both members are undocumented, so every failure degrades to `false` rather
 * than throwing: the caller then reports "written to disk, effective after a
 * restart" instead of claiming a live switch that did not happen.
 *
 * @returns {Promise<boolean>} whether the new revision is mounted right now
 */
async function remountPreset(registry, id, plugins) {
  if (registry === undefined || registry === null) return false
  const record = registry.definitions?.get?.(id)
  if (record === undefined || record === null) return false
  if (typeof registry.activate !== 'function') return false
  if (!Array.isArray(plugins)) return false

  const previousConfig = record.config
  const previousGeneration = record.generation
  try {
    record.config = { ...previousConfig, plugins }
    await registry.activate(record)
  } catch (error) {
    record.config = previousConfig
    record.generation = previousGeneration
    return false
  }
  if (previousGeneration !== undefined) {
    previousGeneration.retired = true
    try {
      await registry.collect?.(previousGeneration)
    } catch {
      // Retiring is enough: the last unbind collects it.
    }
  }
  return true
}

/**
 * Apply the saved `supervisedPresets` selection to the live loader.
 *
 * Idempotent and safe to call any number of times: a preset already in the
 * wanted state never triggers `entry.update`, so no fiber is restarted for
 * nothing. `main-agent` is skipped — it is supervised by construction.
 *
 * @returns {Promise<{ changed: Array<{id: string, supervised: boolean}>, errors: Array<{id: string, error: string}> }>}
 */
export async function syncSupervisedPresets(ctx, config, log, override) {
  const raw = override ?? live(config?.supervisedPresets, SETTINGS_DEFAULTS.supervisedPresets)
  const wanted = Array.isArray(raw)
    ? raw.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  // `main-agent` is supervised by construction; never rewrite its own row.
  const entries = presetEntries(ctx).filter((item) => item.id !== PRESET_ID)
  const result = await syncSupervisedLayer({ entries, wanted, baselines: presetBaselines, log })

  // Presets registered outside the loader (`redteam`, `unrestricted`, …) own no
  // `plugins` array to rewrite, so their layer goes to the composition file
  // instead. The declaring plugin reads that file back on the next start.
  const loaderIds = new Set(entries.map((item) => item.id))
  const desired = new Set(wanted)
  const registry = ctx?.get?.('agentPresets')
  let registered = []
  try {
    const catalog = registry === undefined ? [] : await registry.list()
    registered = Array.isArray(catalog) ? catalog : []
  } catch {
    registered = []
  }
  for (const preset of registered) {
    const id = preset?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (id === PRESET_ID || loaderIds.has(id) || preset.broken === true) continue
    const want = desired.has(id)
    try {
      const outcome = want
        ? await applySupervisorToFile(id)
        : await stripSupervisorFromFile(id)
      if (outcome.ok !== true) {
        log?.warn?.(`dsh-main-agent: preset ${id} 没有可改写的 composition 文件`)
        continue
      }

      // The disk write is the durable half. The mount is the instant half: it
      // can fail on a harness that renamed those registry members, and then the
      // change simply waits for the next start.
      const record = registry?.definitions?.get?.(id)
      const current = record?.config?.plugins
      // Snapshot the pristine declaration on first sight so "uncheck" returns to
      // the preset's own persona rather than an empty one.
      if (Array.isArray(current) && !presetBaselines.has(id)) {
        presetBaselines.set(id, structuredClone(current))
      }
      const base = presetBaselines.get(id) ?? current
      const mounted = Array.isArray(base)
        ? await remountPreset(registry, id, want ? applySupervisorLayer(base) : stripSupervisorLayer(base))
        : false

      if (outcome.changed || mounted) {
        result.changed.push({ id, supervised: want, file: true, mounted })
      }
    } catch (error) {
      result.errors.push({ id, error: error?.message ?? String(error) })
      log?.warn?.(`dsh-main-agent: 改写 preset ${id} 的 composition 失败：${error?.message ?? error}`)
    }
  }

  if (result.changed.length > 0) {
    log?.info?.(`dsh-main-agent: 监督循环已同步 ${result.changed.length} 个 preset`)
  }
  return result
}

/**
 * `GET /supervisor/presets` — every registered preset with its current
 * supervision state, for the settings card's multi-select.
 * `POST /supervisor/presets` — `{ supervised: string[] }`, persisted to config
 * by the host and applied to the loader immediately.
 */
async function presetsHandler(ctx, req, res, options = {}) {
  const send = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  const config = options.config
  const log = options.log

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.method === 'HEAD') {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    const registry = ctx.get?.('agentPresets')
    let catalog = []
    try {
      catalog = registry === undefined ? [] : await registry.list()
    } catch (error) {
      return send(500, { error: `读取 preset 列表失败：${error?.message ?? error}` })
    }

    const liveById = new Map(presetEntries(ctx).map((item) => [item.id, item.plugins]))
    const saved = live(config?.supervisedPresets, SETTINGS_DEFAULTS.supervisedPresets)
    const selected = new Set(Array.isArray(saved) ? saved : [])

    const items = []
    for (const preset of catalog) {
      const id = preset?.id
      if (typeof id !== 'string' || id.length === 0) continue
      const plugins = liveById.get(id)
      const rows = countSupervisorRows(plugins)
      items.push({
        id,
        name: typeof preset.name === 'string' && preset.name.length > 0 ? preset.name : id,
        description: typeof preset.description === 'string' ? preset.description : '',
        order: typeof preset.order === 'number' ? preset.order : 0,
        broken: preset.broken === true,
        // `builtin`: supervised by construction (main-agent) — shown, not toggleable.
        builtin: id === PRESET_ID,
        // Selected in settings AND actually present in this process.
        supervised: id === PRESET_ID ? true : selected.has(id),
        // How many of the three supervisor rows this preset currently carries.
        rows,
        // False when the preset has no loader row in this process (e.g. a preset
        // registered by something other than a loader patch). Those stay
        // toggleable — the layer goes to their composition file instead.
        live: plugins !== undefined,
        // Whether the switch has somewhere to write when there is no loader
        // row: the preset's own composition file. A preset registered from a
        // generator (the unrestricted child) has neither, and cannot be
        // switched at all.
        fileBacked: plugins === undefined && existsSync(presetFile(id)),
        // True when a `.supervisor.bak` sits next to that file: the edit is
        // already written to disk.
        pendingRestart: plugins === undefined && hasSupervisorBackup(id),
        // For file-backed presets: is the declaration mounted right now already
        // supervised? Undefined when there is no record to read.
        mounted: plugins === undefined
          ? (() => {
              const current = registry?.definitions?.get?.(id)?.config?.plugins
              return Array.isArray(current) ? isSupervised(current) : undefined
            })()
          : undefined,
      })
    }
    items.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))

    return send(200, {
      presets: items,
      // `main-agent` is always supervised; list it for symmetry in the UI.
      alwaysOn: [PRESET_ID],
    })
  }

  if (req.method !== 'POST') return send(405, { error: '只支持 GET / POST' })

  let body = ''
  const MAX = 64 * 1024
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX) {
      req.destroy()
      return send(413, { error: '请求体过大' })
    }
  }

  let parsed
  try {
    parsed = body.trim().length === 0 ? {} : JSON.parse(body)
  } catch {
    return send(400, { error: '请求体不是合法 JSON' })
  }

  const list = parsed?.supervised
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
    return send(400, { error: '`supervised` 必须是字符串数组' })
  }

  const known = new Set(presetEntries(ctx).map((item) => item.id))
  // A preset without a loader row is still switchable through its composition
  // file, so the membership test has to be the registry rather than the loader.
  try {
    const registry = ctx.get?.('agentPresets')
    const catalog = registry === undefined ? [] : await registry.list()
    for (const preset of Array.isArray(catalog) ? catalog : []) {
      if (typeof preset?.id === 'string' && preset.id.length > 0) known.add(preset.id)
    }
  } catch {
    // A dead registry leaves the loader set as the only authority.
  }
  const requested = [...new Set(list.filter((id) => id.length > 0 && id !== PRESET_ID))]
  const unknown = requested.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    return send(400, { error: `以下 preset 既没有 loader 行，也没有 composition 文件：${unknown.join(', ')}` })
  }

  // Snapshot before the settings write: that write can restart this plugin's
  // own fiber, so anything recorded during it may land on a disposed context.
  const before = new Map(presetEntries(ctx).map((item) => [item.id, countSupervisorRows(item.plugins)]))

  const store = options.store
  if (typeof store === 'function') {
    try {
      await store(requested)
    } catch (error) {
      return send(500, { error: `保存设置失败：${error?.message ?? error}` })
    }
  } else {
    // Persist through the host settings service. `main-agent` is dropped above,
    // so the stored list only ever names presets the user actually toggled.
    // A write failure is reported but does not abort: the selection is already
    // applied to this process, and the next mount re-reads whatever did persist.
    const settings = options.settings ?? ctx.get?.('settings')
    if (settings !== undefined && typeof settings.update === 'function') {
      try {
        await settings.update(SETTINGS_NS, { supervisedPresets: requested })
      } catch (error) {
        log?.warn?.(`dsh-main-agent: 保存监督模式勾选失败（本次已生效）：${error?.message ?? error}`)
      }
    }
  }

  const result = await syncSupervisedPresets(ctx, config, log, requested)
  // Report the observed end state rather than whichever call happened to record
  // it: the apply-time reconciliation races the explicit sync above whenever
  // the settings write restarts the fiber.
  const after = new Map(presetEntries(ctx).map((item) => [item.id, countSupervisorRows(item.plugins)]))
  const recorded = new Map(result.changed.map((item) => [item.id, item]))
  const changed = [...new Set([...after.keys(), ...recorded.keys()])]
    .filter((id) => (before.get(id) ?? 0) !== (after.get(id) ?? 0) || recorded.has(id))
    // File-backed presets never appear in `after` (they have no loader row), so
    // their state comes from the sync result and is flagged as needing a restart.
    .map((id) => recorded.get(id)?.file === true
      ? { id, supervised: recorded.get(id).supervised === true, restartRequired: true }
      : { id, supervised: (after.get(id) ?? 0) > 0 })

  return send(200, {
    supervised: requested,
    changed,
    errors: result.errors,
  })
}

/** Cap for raw text files in the feed payload (the UI shows a tail anyway). */
const TEXT_CAP = 64 * 1024

/** Cap for worker artifact directories in one feed payload, newest first. */
const SUBAGENT_CAP = 20

/** Bytes read from the HEAD of an outcome.md to find its worker header. */
const HEADER_CAP = 512
/** The header must sit on one of the first N lines of outcome.md. */
const HEADER_LINES = 3

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
  // Fire-and-forget re-application of the saved selection. Declared before the
  // settings listener below so that listener can call it.
  const reapply = () => { void syncSupervisedPresets(ctx, config, log) }
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
  // The two mount-time passes below can run before the settings document has
  // hydrated `config` — on a fresh start that left the saved selection
  // unapplied until someone opened the card and saved again. This signal fires
  // once the document lands, which is the earliest point `config` is truthful.
  if (ctx.root !== undefined && ctx.root !== ctx) {
    try {
      ctx.effect(() => {
        const onDocument = () => reapply()
        ctx.root.on('settings/document-updated', onDocument)
        return () => ctx.root.off('settings/document-updated', onDocument)
      })
    } catch (error) {
      log.warn(`dsh-main-agent: 无法订阅 settings/document-updated：${error?.message ?? error}`)
    }
  }
  ctx.provide('supervisorSettings', {
    current: () => ({
      workerModels: live(config?.workerModels, SETTINGS_DEFAULTS.workerModels),
      workerEfforts: live(config?.workerEfforts, SETTINGS_DEFAULTS.workerEfforts),
      maxParallelWorkers: live(config?.maxParallelWorkers, SETTINGS_DEFAULTS.maxParallelWorkers),
      maxSpawnTotal: live(config?.maxSpawnTotal, SETTINGS_DEFAULTS.maxSpawnTotal),
      workerDeadlineMinutes: live(config?.workerDeadlineMinutes, SETTINGS_DEFAULTS.workerDeadlineMinutes),
      watchdogEnabled: live(config?.watchdogEnabled, SETTINGS_DEFAULTS.watchdogEnabled),
      wakeMinutes: live(config?.wakeMinutes, SETTINGS_DEFAULTS.wakeMinutes),
      questionWaitMinutes: live(config?.questionWaitMinutes, SETTINGS_DEFAULTS.questionWaitMinutes),
      supervisedPresets: live(config?.supervisedPresets, SETTINGS_DEFAULTS.supervisedPresets),
    }),
    subscribe: (listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  })

  // Re-apply the saved selection on every mount: the loader edit lives in
  // memory only, so the persisted config is what makes the choice survive a
  // restart. Two idempotent passes because bundle layers finish expanding
  // around the time this plugin mounts.
  const reapplyTimers = [setTimeout(reapply, 0), setTimeout(reapply, 2000)]
  ctx.effect?.(() => () => { for (const timer of reapplyTimers) clearTimeout(timer) })

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
        handler: (req, res) => stopHandler(feedCtx, req, res, { config }),
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/workers',
        handler: (req, res) => workersHandler(feedCtx, req, res),
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/health',
        handler: (req, res) => healthHandler(feedCtx, req, res, { config }),
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/presets',
        handler: (req, res) => presetsHandler(feedCtx, req, res, { config, log }),
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/loop',
        handler: (req, res) => loopHandler(feedCtx, req, res, { config }),
      }))
      log.info('dsh-main-agent: 已在 /supervisor/feed、/supervisor/models、/supervisor/stop、/supervisor/workers、/supervisor/health、/supervisor/presets、/supervisor/loop 注册路由')
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
 * `GET /supervisor/workers?session=<sessionId>` — the supervisor's child
 * inventory WITH live activity. The 0.2.1 catalog is a durable projection
 * without an activity field, and the browser RPC the card used to call
 * (`subagent.list`) no longer exists, so this route is the card's only source:
 * `mode`/`label`/`createdAt` from the catalog descriptor, `running` from the
 * live agent registry.
 */
export async function workersHandler(ctx, req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body))
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sessionId = url.searchParams.get('session')
  if (sessionId === null || sessionId === '') return send(400, { error: '缺少 ?session=<sessionId> 参数' })
  if (typeof ctx.subagents?.listChildren !== 'function') {
    return send(503, { error: subagentIncompatibilityMessage(ctx) ?? 'subagent 服务不可用' })
  }
  let children
  try {
    children = await ctx.subagents.listChildren(sessionId)
  } catch (error) {
    const message = String(error?.message ?? error)
    // A durable catalog lookup for an id that was never persisted is a client
    // error, not a service outage; the UI shows the two very differently.
    if (/not found|未找到|no such|ENOENT/i.test(message)) {
      return send(404, { error: `未找到该 session：${sessionId}` })
    }
    return send(503, { error: `无法读取 worker 目录：${message}` })
  }
  const workers = (Array.isArray(children) ? children : [])
    .filter(entry => entry !== null && typeof entry === 'object' && entry.mode === 'continuable')
    .map(entry => ({
      id: entry.id,
      ...typeof entry.label === 'string' && entry.label !== '' ? { label: entry.label } : {},
      ...typeof entry.createdAt === 'number' ? { createdAt: entry.createdAt } : {},
      running: childIsRunning(ctx, entry.id),
    }))
  return send(200, {
    session: sessionId,
    compatible: subagentCompatible(ctx),
    workers,
    running: workers.filter(worker => worker.running).length,
    total: workers.length,
  })
}

/**
 * Whether a session's preset may act as a supervisor. The built-in preset
 * always may; everything else has to be switched on in Settings.
 *
 * One predicate for every route that needs the answer: the Feed tab reads it
 * from /supervisor/health, and the stop + loop routes use this. They used to
 * each hardcode `=== 'main-agent'`, which made a switched-on preset report
 * 409 on stop/loop while the Settings card said it was enabled.
 *
 * @param {unknown} config
 * @param {string | undefined} presetId
 */
function countsAsSupervisor(config, presetId) {
  if (presetId === PRESET_ID) return true
  if (typeof presetId !== 'string' || presetId.length === 0) return false
  const switchedOn = live(config?.supervisedPresets, SETTINGS_DEFAULTS.supervisedPresets)
  return Array.isArray(switchedOn) && switchedOn.includes(presetId)
}

/**
 * `GET /supervisor/health` — boot-time compatibility report. A host that
 * renamed the delegation API used to stay silent until the first spawn threw a
 * bare TypeError; the Feed banner and this route surface it up front.
 */
export function healthHandler(ctx, req, res, options = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const missing = missingSubagentMethods(ctx)
  let version
  try {
    version = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
  } catch {
    version = undefined
  }
  // Which presets the browser may treat as a supervisor. The built-in one is
  // always included; everything else is whatever the user switched on, so the
  // Feed tab and the Settings card cannot disagree about who is a supervisor.
  const switchedOn = live(options.config?.supervisedPresets, SETTINGS_DEFAULTS.supervisedPresets)
  const supervisorPresets = [PRESET_ID, ...switchedOn.filter(id => id !== PRESET_ID)]
  // The watchdog is the only thing that keeps the loop alive when the model
  // forgets to re-arm its own reminder, and it needs the schedule service. That
  // service comes from the host plane (dsh-web-app's `- id: schedule` row), not
  // from this bundle — so "is it actually here?" is a question the plugin's own
  // component list cannot answer. Report it.
  const schedule = ctx.get?.('schedule')
  const scheduleReady = schedule !== undefined && typeof schedule.create === 'function'
  const payload = JSON.stringify({
    package: 'dsh-main-agent',
    ...version === undefined ? {} : { version },
    ok: missing.length === 0,
    supervisorPresets,
    schedule: {
      available: scheduleReady,
      hint: scheduleReady
        ? undefined
        : 'schedule 服务未注册：监督循环失去定时兜底，模型漏排提醒就会静默停机。它由 dsh-web-app 的 host 层提供，检查该 profile 是否挂了 dsh-web-app。',
    },
    subagents: {
      required: [...REQUIRED_METHODS],
      missing,
      message: subagentIncompatibilityMessage(ctx),
    },
  })
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

/** `collectFeed` reads exactly these `.agi/` artifacts; the fingerprint stats
 * them and nothing else, so the two lists must stay in sync. */
const FINGERPRINT_FILES = [
  'GOAL.md',
  'GOAL_AMENDMENTS.md',
  'NOTES.md',
  'MISSION_REPORT.md',
  'progress.jsonl',
  'questions.jsonl',
  'CHANGELOG.jsonl',
  'config.json',
]

/**
 * Strong ETag for the feed: a SHA-1 over `${name}:${mtimeMs}:${size}` of every
 * artifact `collectFeed` reads, plus every `subagents/<id>/outcome.md`.
 *
 * `stat` only — never `read` — so a conditional poll costs the same handful of
 * metadata calls whether the artifacts are 1KB or 64KB, and a missing file
 * contributes a stable `name:-` instead of changing the hash on its own.
 * Directory order is sorted so the same state always hashes the same way.
 */
export function feedFingerprint(root, agi) {
  const parts = [`ws:${root}`]
  const stamp = (name, path) => {
    try {
      const stat = statSync(path)
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${name}:-`)
    }
  }
  for (const name of FINGERPRINT_FILES) stamp(name, join(agi, name))
  const subagents = join(agi, 'subagents')
  let dirs = []
  try {
    dirs = readdirSync(subagents).sort()
  } catch {
    dirs = []
  }
  for (const dir of dirs) stamp(`subagents/${dir}/outcome.md`, join(subagents, dir, 'outcome.md'))
  return `"${createHash('sha1').update(parts.join('\n')).digest('base64url')}"`
}

/**
 * Does an `If-None-Match` header select `etag`? Handles the header arriving as
 * a string or a string[] (Node's own shape for a repeated field), strips the
 * optional `W/` weak prefix, and splits comma lists — a browser may send
 * several candidates.
 */
function etagMatches(header, etag) {
  if (header == null || etag == null) return false
  const raw = Array.isArray(header) ? header.join(',') : String(header)
  return raw.split(',').some(part => {
    let value = part.trim()
    if (value.startsWith('W/')) value = value.slice(2).trim()
    return value === etag
  })
}

/** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} */
export function feedHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const ws = url.searchParams.get('ws')
  const send = (status, body, extra) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
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
  // Conditional refresh: the Feed polls every 5s, and most polls see no change.
  // A 304 keeps the client's document and skips JSON assembly entirely; the
  // fingerprint is stat-only, so the cheap path is genuinely cheap.
  let etag
  try {
    etag = feedFingerprint(root, agi)
  } catch {
    etag = undefined
  }
  if (etag !== undefined && etagMatches(req.headers?.['if-none-match'], etag)) {
    res.writeHead(304, { etag, 'cache-control': 'no-store' }).end()
    return
  }
  try {
    send(200, collectFeed(root, agi), etag === undefined ? undefined : { etag })
  } catch (error) {
    send(500, { error: String(error?.message ?? error) })
  }
}

/**
 * Resolve the live Agent for `sessionId`, cold-resuming it through the host's
 * own session controller when the Session is not published.
 *
 * The controller owns preset composition, blank-session rules, writer claims
 * and cwd checks, so the plugin must never re-implement resume semantics (a
 * hand-rolled resume is how the browser half once tried to use a dead RPC).
 * A missing controller is not an error: the caller reports the honest 409.
 */
async function resumeSupervisorAgent(ctx, sessionId) {
  let controller
  try {
    controller = ctx.get?.('sessionController')
  } catch {
    controller = undefined
  }
  if (typeof controller?.resolveAgent !== 'function') return { agent: undefined }
  try {
    const found = await controller.resolveAgent(sessionId)
    return found?.agent === undefined
      ? { agent: undefined, reason: found?.error?.message }
      : { agent: found.agent }
  } catch (error) {
    return { agent: undefined, reason: error instanceof Error ? error.message : String(error) }
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
 * POST cold-resumes the supervisor itself (see `resumeSupervisorAgent`) so the
 * action works from any view of the Feed, not only while the agent happens to
 * be published in this process. Direct calls against non-supervisor Sessions
 * still fail instead of reporting a false success.
 */
export async function stopHandler(ctx, req, res, options = {}) {
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

  // The route is unauthenticated (raw web-server registration) and the action is
  // destructive: refuse a POST a foreign page initiated.
  if (req.method === 'POST' && isCrossSiteWrite(req)) {
    return send(403, { error: '拒绝跨站停止请求' })
  }

  let foldScheduleEvents
  try {
    ({ foldScheduleEvents } = await import('@deepseek-ai/dsh-schedule'))
  } catch {
    return send(500, { error: '当前 profile 中不可用 schedule 包' })
  }

  let agent = ctx.agents.get(sessionId)
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
    if (session.header.origin === 'subagent' || !countsAsSupervisor(options.config, sessionAgentPreset(session))) {
      return send(409, { error: '该 session 未开启监督循环' })
    }
    let folded
    try {
      folded = foldScheduleEvents(events, sessionInheritedEventCount(session))
    } catch {
      return send(500, { error: '无法 fold schedule 日志' })
    }
    // The Feed's loop card needs more than "an id exists": which kind of
    // reminder wakes the supervisor, what it is called, and when it fires next.
    // `scheduledAt` is a canonical ISO-8601 instant in the durable record, so it
    // is converted to epoch milliseconds here (and omitted when the record
    // carries no usable instant). `stopped` below keeps its meaning: nothing
    // running, no reminder, no running worker.
    const reminders = folded.active.map(record => {
      const entry = { id: record?.id, kind: record?.kind }
      if (record?.title !== undefined) entry.title = record.title
      if (typeof record?.everySeconds === 'number') entry.everySeconds = record.everySeconds
      const at = typeof record?.scheduledAt === 'string'
        ? Date.parse(record.scheduledAt)
        : typeof record?.scheduledAt === 'number' ? record.scheduledAt : Number.NaN
      if (Number.isFinite(at)) entry.scheduledAt = at
      return entry
    })
    const running = agent?.status === 'running'
    let runningWorkers
    try {
      // The 0.2.1 catalog is a durable projection without an activity field,
      // so liveness comes from the live agent registry (lib/subagent-compat.js).
      const children = await ctx.subagents.listChildren(sessionId)
      runningWorkers = runningChildIds(ctx, children)
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
    // Cold Session: resume through the host controller so the stop transaction
    // runs against a real Agent. The browser used to attempt this itself with a
    // dead `session.create` RPC, which failed silently and made the button
    // report "无法恢复监督者" while the supervisor kept waking up.
    const resumed = await resumeSupervisorAgent(ctx, sessionId)
    agent = resumed.agent
    if (agent === undefined) {
      return send(409, {
        error: 'session 未存活，且无法恢复 supervisor'
          + (resumed.reason === undefined ? '（宿主未提供 sessionController）' : `：${resumed.reason}`),
      })
    }
  }
  if (agent.session.header.origin === 'subagent'
    || !countsAsSupervisor(options.config, sessionAgentPreset(agent.session))) {
    return send(409, { error: '该 session 未开启监督循环' })
  }

  const outcome = await fullStopAgent(
    agent,
    session => ctx.sessions.flush(session),
    foldScheduleEvents,
    {
      stopChildren: async (parent) => {
        const children = await ctx.subagents.listChildren(parent.id)
        const continuableIds = continuableChildIds(children)
        const runningIds = runningChildIds(ctx, children)
        // drainChildren releases resident activations; non-resident catalog
        // rows are skipped by the service (never an error).
        await drainWorkers(ctx, parent, continuableIds)
        return runningIds
      },
      // The host's `tasks` table is authoritative; the session log is only a
      // projection, so a full stop has to delete through the service.
      deleteReminder: (sessionId, id) => ctx.get('schedule')?.delete({ sessionId, id }),
      // …and it has to learn the ids from the same place: service-created
      // reminders (our own watchdog included) never appended a log event.
      listReminderIds: async (target) => (await listReminders(ctx, target.session)).map(reminder => reminder.id),
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
  if (outcome.kind === 'reminder-delete-failed') {
    return send(503, {
      error: '部分提醒未能从权威存储中删除；循环可能仍被唤醒',
      remindersDeleted: 0,
      ids: outcome.ids,
      stillArmed: outcome.stillArmed,
    })
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

/**
 * `GET /supervisor/loop` — the adaptive wake-up decision, read-only.
 *
 * 为什么要有这条路由：`wakeMinutes` 只是一个死间隔，而真正该睡多久取决于
 * 现在在等什么（worker 在跑 / 等用户回答 / 连续几轮没进展）。把判定留在服务端
 * 的好处是它与 watchdog 用的是同一份策略（lib/loop-policy.js），模型和设置页
 * 读到的永远是同一个数。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function loopHandler(ctx, req, res, options = {}) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  let sessionId
  try {
    sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId')
  } catch {
    sessionId = null
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return send(400, { error: '缺少 ?sessionId=<id> 参数' })
  }

  let foldScheduleEvents
  try {
    ({ foldScheduleEvents } = await import('@deepseek-ai/dsh-schedule'))
  } catch {
    return send(500, { error: '当前 profile 中不可用 schedule 包' })
  }

  const agent = ctx.agents.get(sessionId)
  const settings = ctx.get('supervisorSettings')?.current() ?? {}
  if (agent === undefined) {
    return send(200, {
      sessionId,
      live: false,
      watchdog: { enabled: settings.watchdogEnabled !== false, armed: false, note: '会话未存活，无法判定' },
    })
  }
  if (agent.session.header.origin === 'subagent' || !countsAsSupervisor(options.config, sessionAgentPreset(agent.session))) {
    return send(409, { error: '该 session 未开启监督循环' })
  }

  let runningWorkers = []
  try {
    const children = await ctx.subagents.listChildren(sessionId)
    runningWorkers = runningChildIds(ctx, children)
  } catch {
    runningWorkers = []
  }
  const snapshot = loopSnapshot(ctx, agent, {
    lastDeliveryAt: lastDispatchAt(agent.session),
    runningWorkers: runningWorkers.length,
  })
  let reminders = []
  try {
    // Authoritative: the session log misses reminders created through the
    // service (see listReminders), which would report an armed watchdog as
    // unarmed.
    reminders = (await listReminders(ctx, agent.session)).map(reminder => ({
      id: reminder.id,
      title: reminder.title,
      scheduledAt: Number.isFinite(reminder.scheduledAt) ? reminder.scheduledAt : undefined,
    }))
  } catch {
    return send(500, { error: '无法读取提醒列表' })
  }
  const goal = ctx.get('goals')?.get(agent)
  return send(200, {
    sessionId,
    live: true,
    goal: goal === undefined
      ? null
      : { id: goal.id, revision: goal.revision, phase: goal.phase, roundsStarted: goal.roundsStarted },
    runningWorkers,
    reminders,
    recommend: {
      seconds: snapshot.wake.seconds,
      band: snapshot.wake.band,
      label: snapshot.wake.label,
      reason: snapshot.wake.reason,
      description: snapshot.description,
    },
    staleWake: snapshot.stale,
    pendingQuestions: snapshot.pendingQuestions,
    lastProgressAt: snapshot.lastProgressAt ?? null,
    watchdog: {
      enabled: settings.watchdogEnabled !== false,
      armed: reminders.some(reminder => reminder.title === WATCHDOG_TITLE),
      ownedElsewhere: reminders.some(reminder => reminder.title !== WATCHDOG_TITLE),
    },
    workerDeadlineMinutes: settings.workerDeadlineMinutes ?? 0,
    maxSpawnTotal: settings.maxSpawnTotal ?? 0,
  })
}


/**
 * Reject a state-changing request a DIFFERENT page initiated. Plugin routes are
 * registered on the raw web server, so they bypass the host's token gate; a
 * cross-site POST is refused unless it carries no Origin (curl, scripts) or an
 * Origin whose host matches this server.
 */
function isCrossSiteWrite(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

/** Assemble the whole feed document from the workspace's .agi tree. */
function collectFeed(root, agi) {
  const texts = {
    goal: text(join(agi, 'GOAL.md')),
    amendments: text(join(agi, 'GOAL_AMENDMENTS.md')),
    notes: text(join(agi, 'NOTES.md')),
    missionReport: text(join(agi, 'MISSION_REPORT.md')),
  }
  const lists = {
    progress: jsonl(join(agi, 'progress.jsonl')),
    questions: jsonl(join(agi, 'questions.jsonl')),
    changelog: jsonl(join(agi, 'CHANGELOG.jsonl')),
  }
  const workers = subagentDirs(join(agi, 'subagents'))
  // Silent truncation is indistinguishable from "nothing more happened": the
  // poller refetches every 5s, so a capped view must SAY it is capped.
  const cutText = Object.keys(texts).filter(key => texts[key]?.truncated === true)
  const cutJsonl = {}
  for (const [key, value] of Object.entries(lists)) {
    if (value.dropped > 0) cutJsonl[key] = value.dropped
  }
  const truncated = {}
  if (cutText.length > 0) truncated.text = cutText
  if (Object.keys(cutJsonl).length > 0) truncated.jsonl = cutJsonl
  if (workers.omitted > 0) truncated.workers = workers.omitted
  return {
    ws: root,
    generatedAt: Date.now(),
    ...texts,
    config: jsonFile(join(agi, 'config.json')),
    progress: lists.progress.entries,
    questions: lists.questions.entries,
    changelog: lists.changelog.entries,
    subagents: workers.entries,
    ...Object.keys(truncated).length === 0 ? {} : { truncated },
  }
}

/** Text file as { text, mtime, truncated? } (tail-capped), or null. */
function text(path) {
  try {
    const stat = statSync(path)
    let value = readFileSync(path, 'utf8')
    const truncated = value.length > TEXT_CAP
    if (truncated) value = value.slice(-TEXT_CAP)
    return { text: value, mtime: stat.mtimeMs, ...truncated ? { truncated } : {} }
  } catch {
    return null
  }
}

/**
 * The worker session id declared by the machine-readable header on the FIRST
 * THREE lines of an `outcome.md`, or null.
 *
 * The header is read from the HEAD of the file on purpose: `text()` above keeps
 * only the LAST TEXT_CAP bytes, so on a large report the very line the prompt
 * asks for is exactly the one the body view no longer holds. Only HEADER_CAP
 * bytes are read, never the whole file.
 *
 * Accepted, case-insensitive on the key, tolerant of surrounding whitespace and
 * of quotes/backticks around the id:
 *   <!-- worker: <sessionId> -->
 *   worker: <sessionId>
 * The payload must be a session-id-shaped token, so a sentence that merely
 * starts with `worker:` does not silently become an id.
 */
function workerIdOf(path) {
  let raw
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_CAP)
      const read = readSync(fd, buffer, 0, HEADER_CAP, 0)
      raw = buffer.toString('utf8', 0, read)
      // A head chunk can cut its last line in half: never parse the remainder
      // as an id when the buffer filled up mid-line.
      if (read === HEADER_CAP && !raw.endsWith('\n')) raw = raw.slice(0, raw.lastIndexOf('\n') + 1)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  for (const line of raw.split('\n').slice(0, HEADER_LINES)) {
    const match = /^\s*(?:<!--\s*)?worker\s*:\s*(["'`]?)([A-Za-z0-9._:-]+)\1\s*(?:-->)?\s*$/i.exec(line)
    if (match != null) return match[2]
  }
  return null
}

/** Parsed JSON file, or null when absent/malformed. */
function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * JSONL entries as `{ entries, dropped }`: the newest JSONL_CAP are kept,
 * malformed lines skipped, and `dropped` counts how many older entries the cap
 * removed so the UI can say so.
 */
function jsonl(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { entries: [], dropped: 0 }
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
  return {
    entries: entries.slice(-JSONL_CAP),
    dropped: Math.max(0, entries.length - JSONL_CAP),
  }
}

/**
 * Per-worker artifact inventory, NEWEST FIRST and capped: the feed is polled
 * every few seconds, so an unbounded number of 64KB outcome files would grow
 * the payload with every worker ever spawned.
 */
function subagentDirs(path) {
  let names
  try {
    names = readdirSync(path)
  } catch {
    return { entries: [], omitted: 0 }
  }
  const dirs = []
  for (const dirName of names) {
    const dir = join(path, dirName)
    try {
      const stat = statSync(dir)
      if (!stat.isDirectory()) continue
      dirs.push({ dirName, dir, mtime: stat.mtimeMs })
    } catch {
      continue
    }
  }
  dirs.sort((left, right) => right.mtime - left.mtime)
  const kept = dirs.slice(0, SUBAGENT_CAP)
  const entries = kept.map(({ dirName, dir }) => {
    let files = []
    try {
      files = readdirSync(dir)
    } catch { /* unreadable worker dir: report it empty */ }
    const outcomePath = join(dir, 'outcome.md')
    return {
      // The DIRECTORY name stays the primary key (that is the artifact folder a
      // human sees); `workerId` is the secondary match for label-named dirs.
      name: dirName,
      workerId: workerIdOf(outcomePath),
      outcome: text(outcomePath),
      files,
    }
  })
  return { entries, omitted: Math.max(0, dirs.length - kept.length) }
}
