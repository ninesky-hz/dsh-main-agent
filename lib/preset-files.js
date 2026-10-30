/**
 * Supervisor layer for presets that have no loader entry.
 *
 * `standard` / `minimal` / `ptc` / `cordis` are declared by patch rows, so the
 * settings card rewrites their `plugins` array inside the running loader —
 * instant, no restart. Presets handed to `agentPresets.register()` directly
 * (dsh-purge-community registers `redteam` / `unrestricted` this way) own no
 * entry at all: their composition only exists as
 * `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`, and the registry exposes no
 * way to read or replace those plugins from outside.
 *
 * So for those the switch edits the file instead. The untouched original stays
 * beside it as `.supervisor.bak`, which makes "uncheck" a byte-exact restore and
 * doubles as the "you have an edit waiting for a restart" flag. The declaring
 * plugin re-reads the file on next start, so the change lands then.
 *
 * Rewriting goes through the `yaml` Document API rather than a text splice:
 * measured on the real redteam composition, `parseDocument` + `stringify`
 * round-trips 389 lines to 389 lines, keeps every comment, and reproduces all
 * four `!!js` tagged nodes byte for byte. The only drift is indentation inside
 * a block scalar and before a comment, which changes no value.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  composeSupervisorPersona,
  DEV_AGENT_PERSONA,
  hasSupervisorPersona,
  SUPERVISOR_ANCHOR_IDS,
  supervisorAnchorReport,
  SUPERVISOR_NAME_ROWS,
  SUPERVISOR_PERSONA,
} from './supervise.js'

export const BACKUP_SUFFIX = '.supervisor.bak'

const SCHEDULE_ID = 'tool-schedule'
const SCHEDULE_NAME = '@deepseek-ai/dsh-tool-schedule'
const SPAWN_ID = 'tool-subagent'
const SPAWN_NAME = 'dsh-main-agent/spawn'

/** Loaded lazily: a profile without `yaml` must still load this plugin. */
let yamlModule = null

async function yaml() {
  if (yamlModule === null) {
    const mod = await import('yaml')
    yamlModule = mod.default ?? mod
  }
  return yamlModule
}

export function presetHome(home) {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function presetFile(id, home) {
  return join(presetHome(home), '.agent-presets', id, 'agent.cordis.yml')
}

/** True when a `.supervisor.bak` exists, i.e. the file carries an edit that
 * only a restart will load. */
export function hasSupervisorBackup(id, home) {
  return existsSync(presetFile(id, home) + BACKUP_SUFFIX)
}

function rowId(node) {
  return node !== null && typeof node?.get === 'function' ? node.get('id') : undefined
}

function findRow(nodes, id) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (rowId(node) === id) return node
  }
  return undefined
}

/** Rows of a `cordis:group` row — its `config` is an array of child rows. */
function groupChildren(row) {
  const config = row !== null && typeof row?.get === 'function' ? row.get('config', true) : undefined
  return Array.isArray(config?.items) ? config.items : []
}

/** Every row of the composition, group children flattened in. */
function allRows(rows) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    out.push(row)
    for (const child of groupChildren(row)) out.push(child)
  }
  return out
}

/**
 * How many of the three supervisor tool rows the composition already carries.
 * Persona is excluded on purpose: a preset may legitimately have appended the
 * persona without the tools, and the caller uses this to decide what is left.
 */
export function countSupervisorNodes(rows) {
  let count = 0
  for (const row of allRows(rows)) {
    const id = rowId(row)
    if (id === SPAWN_ID) {
      // Only our own spawn row counts: the stock tool-subagent also lives here.
      if (row.get('name') === SPAWN_NAME) count += 1
    } else if (id !== undefined && Object.hasOwn(SUPERVISOR_NAME_ROWS, id)) {
      if (row.get('name') === SUPERVISOR_NAME_ROWS[id]) count += 1
    }
  }
  return Math.min(count, 3)
}

/**
 * Flatten one parsed composition row into the plain `{ id, disabled, config }`
 * shape `supervisorAnchorReport` reads, so the file path and the live-loader
 * path share one definition of "can carry the layer" instead of two copies that
 * drift apart. Group children stay nested under `config` because
 * `tool-subagent` only counts inside a `delegation` group.
 *
 * A `!!js` tagged `disabled` decodes to a node, not `true`, so it reads as
 * enabled — the conservative choice: the live path cannot evaluate it either.
 */
function plainRow(row) {
  const id = rowId(row)
  if (id === undefined) return null
  const out = { id, disabled: row.get('disabled') === true }
  const children = groupChildren(row).map(plainRow).filter(child => child !== null)
  if (children.length > 0) out.config = children
  return out
}

/**
 * Can this file-backed preset carry the supervisor layer? Same rule as the
 * live path, applied to the composition on disk.
 *
 * Read errors are reported as "cannot carry" rather than thrown: a file this
 * plugin cannot parse is one `applySupervisorToFile` would also bail on, so
 * claiming it is stackable would only produce a toggle that silently does
 * nothing.
 *
 * @returns {Promise<{ ok: boolean, missing: string[], reason?: string }>}
 */
export async function supervisorFileAnchorReport(id, home) {
  const file = presetFile(id, home)
  if (!existsSync(file)) {
    return { ok: false, missing: [...SUPERVISOR_ANCHOR_IDS], reason: 'missing' }
  }
  try {
    const Y = await yaml()
    const doc = Y.parseDocument(readFileSync(file, 'utf8'))
    if (doc.errors.length > 0 || !Y.isSeq(doc.contents)) {
      return { ok: false, missing: [...SUPERVISOR_ANCHOR_IDS], reason: 'parse' }
    }
    const report = supervisorAnchorReport(doc.contents.items.map(plainRow).filter(row => row !== null))
    return { ...report, reason: report.ok ? undefined : 'anchors' }
  } catch {
    return { ok: false, missing: [...SUPERVISOR_ANCHOR_IDS], reason: 'read' }
  }
}

function ensureConfig(doc, row) {
  let config = row.get('config', true)
  if (config === null || typeof config?.set !== 'function') {
    config = doc.createNode({})
    row.set('config', config)
  }
  return config
}

/**
 * Write the supervisor layer into one preset's composition file.
 *
 * Every mutation below is idempotent, so a second call on an already-supervised
 * file produces identical bytes and writes nothing. The backup is taken only
 * when the serialized result actually differs from what is on disk — that way
 * a no-op call never leaves a stale `.supervisor.bak` behind.
 *
 * @returns {Promise<{id: string, ok: boolean, changed: boolean, reason?: string}>}
 */
export async function applySupervisorToFile(id, home) {
  const file = presetFile(id, home)
  if (!existsSync(file)) return { id, ok: false, changed: false, reason: 'missing' }

  const text = readFileSync(file, 'utf8')
  const Y = await yaml()
  const doc = Y.parseDocument(text)
  if (doc.errors.length > 0) return { id, ok: false, changed: false, reason: 'parse' }
  const rows = doc.contents?.items
  // A composition is a top-level sequence. A map would hand back Pair objects
  // here, which have no `get` — stringify then throws instead of reporting.
  if (!Y.isSeq(doc.contents) || !Array.isArray(rows)) {
    return { id, ok: false, changed: false, reason: 'shape' }
  }

  // 判断「已经叠过」和「怎么叠」都交给 supervise.js 的同一套函数：磁盘与
  // 运行时热注入必须产出逐字节相同的人格，否则同一份 preset 两处写法不一致。

  // Bail out before touching anything when the layer is already in place.
  //
  // This cannot be "stringify and compare": `yaml` reflows block scalars and
  // comment indentation on every round trip, so a second serialization of an
  // already-rewritten file never matches the bytes on disk. Comparing the
  // semantic state instead keeps a saved file byte-stable.
  const existing = findRow(rows, 'persona')
  const existingPrefix = existing === undefined
    ? ''
    : (() => {
        const config = existing.get('config', true)
        const value = typeof config?.get === 'function' ? config.get('prefix') : undefined
        return typeof value === 'string' ? value : ''
      })()
  if (
    countSupervisorNodes(rows) === 3
    && hasSupervisorPersona(existingPrefix)
    && findRow(rows, SCHEDULE_ID) !== undefined
  ) {
    return { id, ok: true, changed: false }
  }

  // A composition missing the anchor rows cannot carry the layer: writing the
  // persona alone would leave a supervisor that owns none of its tools. Report
  // it instead of producing that half state on disk.
  const anchors = supervisorAnchorReport(rows.map(plainRow).filter(row => row !== null))
  if (!anchors.ok) {
    return { id, ok: false, changed: false, reason: `anchors:${anchors.missing.join(',')}` }
  }

  const persona = findRow(rows, 'persona')
  if (persona === undefined) {
    rows.unshift(doc.createNode({
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: SUPERVISOR_PERSONA },
    }))
  } else {
    const config = ensureConfig(doc, persona)
    const current = typeof config.get('prefix') === 'string' ? config.get('prefix') : ''
    const composed = composeSupervisorPersona(current)
    if (composed !== current) config.set('prefix', composed)
  }

  for (const [rowKey, name] of Object.entries(SUPERVISOR_NAME_ROWS)) {
    const row = findRow(rows, rowKey)
    if (row !== undefined) row.set('name', name)
  }
  // Same rows again, this time inside the `delegation` group.
  for (const row of allRows(rows)) {
    const rowKey = rowId(row)
    if (rowKey !== undefined && Object.hasOwn(SUPERVISOR_NAME_ROWS, rowKey)) {
      row.set('name', SUPERVISOR_NAME_ROWS[rowKey])
    }
  }

  const spawn = findRow(allRows(rows), SPAWN_ID)
  if (spawn !== undefined) {
    // The name is what actually swaps the implementation; the config alone
    // would leave the stock tool in place with fields it ignores.
    spawn.set('name', SPAWN_NAME)
    const config = ensureConfig(doc, spawn)
    if (!config.has('provider')) config.set('provider', 'spawn')
    if (!config.has('toolName')) config.set('toolName', 'subagent')
    if (!config.has('persona')) config.set('persona', DEV_AGENT_PERSONA)
    // Mirror the live path: promote a retired `toolFilter.deny` into the native
    // `deny` field. The old key is left in place — the official schema that
    // rejected it no longer applies, and `stripSupervisorFromFile` restores from
    // `.supervisor.bak`, so no reverse transform is needed here.
    const legacy = config.get('toolFilter', true)
    const legacyDeny = typeof legacy?.get === 'function' ? legacy.get('deny', true) : undefined
    const names = Array.isArray(legacyDeny?.items)
      ? legacyDeny.items.map(item => item?.value).filter(value => typeof value === 'string' && value.length > 0)
      : []
    if (names.length > 0) {
      const existing = config.get('deny', true)
      const current = Array.isArray(existing?.items)
        ? existing.items.map(item => item?.value).filter(value => typeof value === 'string')
        : []
      config.set('deny', doc.createNode([...new Set([...current, ...names])]))
    }
  }

  // The wake-up branch of the loop needs the schedule tools, which the
  // red-team composition does not ship at all.
  if (findRow(rows, SCHEDULE_ID) === undefined) {
    rows.push(doc.createNode({ id: SCHEDULE_ID, name: SCHEDULE_NAME }))
  }

  const next = Y.stringify(doc)
  if (next === text) return { id, ok: true, changed: false }

  const backup = file + BACKUP_SUFFIX
  if (!existsSync(backup)) copyFileSync(file, backup)
  writeFileSync(file, next, 'utf8')
  return { id, ok: true, changed: true }
}

/**
 * Restore the original composition and drop the backup.
 *
 * The backup is the authority here, not a reverse transform: the user may have
 * edited the file themselves in between, and "uncheck" means "put back what was
 * there before this plugin touched it".
 *
 * @returns {Promise<{id: string, ok: boolean, changed: boolean}>}
 */
export async function stripSupervisorFromFile(id, home) {
  const file = presetFile(id, home)
  const backup = file + BACKUP_SUFFIX
  if (!existsSync(backup)) return { id, ok: true, changed: false }
  copyFileSync(backup, file)
  rmSync(backup, { force: true })
  return { id, ok: true, changed: true }
}
