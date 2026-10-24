#!/usr/bin/env node
/**
 * repair-profile — 把被 dsh-main-agent 卡住的 profile 拉回可安装状态。
 *
 * 处理四种已知的「装不上 / 卸不掉」：
 *   1. 同一条 `preset-main-agent` 声明在 profile 的 cordis.patch.yml 里出现多次
 *      （升级时旧副本与新副本的 patch 同时参与组合，插件管理器报
 *      `duplicate loader entry id`）；
 *   2. package.json 里仍留着 `dsh-main-agent` 依赖或 bundles 条目，UI 因此
 *      一直认为「这个包已经安装」；
 *   3. 残留的 node_modules/dsh-main-agent 让新版本无法落盘；
 *   4. 用户层 cordis.patch.yml 里仍有本 bundle 的行（`agi-supervisor-setup` /
 *      `agi-schedule` / `preset-main-agent`）。卸载时 `remove_bundle` 会先撞
 *      `bundle-in-use`（宿主源码 lib/index.js:2148）；此外 package.json 与
 *      pnpm-lock.yaml 一旦漂移，pnpm 的 `minimumReleaseAge` 冷静期会让
 *      `pnpm remove` 抛 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`
 *      （pnpm 11.7.0 的 remove 路径没接策略回调）。脚本只诊断后者，不跑 pnpm。
 *
 * 用法：
 *   node scripts/repair-profile.mjs                 # 只诊断
 *   node scripts/repair-profile.mjs --apply         # 删重复的 preset 行（自动备份）
 *   node scripts/repair-profile.mjs --apply --uninstall   # 彻底清干净，回到可安装状态
 *   node scripts/repair-profile.mjs --profile desktop     # 只处理一个 profile
 *   node scripts/repair-profile.mjs --home /path/to/.dsh --json
 *
 * 只写 ${DSH_HOME:-~/.dsh}/profiles/* 下的 package.json 与 cordis.patch.yml
 * （`--uninstall` 另外把 `<home>/.agent-presets/main-agent` 改名备份），
 * 每次写入前生成 .bak-<时间戳>；cordis.yml 是生成物，只报告、不修改。
 * 跑完后必须先完全退出 DSH 再启动，配置在启动时才重新组合。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir, rm, copyFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-main-agent'
export const PRESET_ROW_ID = 'preset-main-agent'
export const PRESET_ID = 'main-agent'
/** 本 bundle 曾经或正在声明的挂载行（见 cordis.patch.yml、presets/main-agent.patch.yml）。
 * 用户层出现其中任意一条都可能是卸载残留。
 *
 * `agi-schedule` 自 0.13.4 起不再由本包声明（service 归 host 平面），但升级前
 * 的 profile 里可能还留着这条孤儿行，所以仍列入检测范围 —— 命中时只报告、不判
 * fixable，--apply --uninstall 会顺手清掉。 */
export const BUNDLE_ROW_IDS = ['agi-supervisor-setup', 'agi-schedule', PRESET_ROW_ID]
export const INSTALL_URL = 'https://gitee.com/n-sky/dsh-main-agent.git'

const ROW_RE = /^\s*-\s+id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:#.*)?$/
const INSERT_RE = /^-\s+insert:/
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

export function defaultHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
}

/**
 * preset 目录挂在 home 下而不是 profile 下。`--home` 显式传入时听它的；
 * 否则从 `<home>/profiles/<name>` 的形状反推 home，最后才落到 defaultHome()。
 */
function resolveHome(dir, home) {
  if (typeof home === 'string' && home.trim() !== '') return path.resolve(home)
  const absolute = path.resolve(dir)
  const parent = path.dirname(absolute)
  if (path.basename(parent) === 'profiles') return path.dirname(parent)
  return defaultHome()
}

async function readJson(file) {
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')), error: null }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { value: null, error: null }
    return { value: null, error: String(error?.message ?? error) }
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** 列出 `${home}/profiles/*` 下的 profile 目录，外加把 home 自身当作旧版 profile。 */
export async function listProfiles(home = defaultHome()) {
  const found = []
  const candidates = []
  let entries = []
  try {
    entries = await readdir(path.join(home, 'profiles'), { withFileTypes: true })
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(path.join(home, 'profiles', entry.name))
  }
  candidates.push(home)
  for (const dir of new Set(candidates)) {
    if (!existsSync(path.join(dir, 'package.json'))) continue
    found.push(dir)
  }
  return found
}

function indentation(line) {
  return line.length - line.trimStart().length
}

/** 从一条 list item 起找到它的结束行（不含），用于整段删除。 */
function removalEnd(lines, start, indent) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const current = indentation(line)
    const isItem = line.slice(current).startsWith('- ')
    if (current < indent) return index
    if (current === indent && isItem) return index
    if (indent === 0 && current === 0) return index
  }
  return lines.length
}

/**
 * 这条行是顶层 override 还是 `- insert:` 里内嵌的行？
 * 缩进为 0 即顶层；否则向上找最近一层「更浅的列表项」，它就是外层 block。
 */
function rowNesting(lines, index, indent) {
  if (indent === 0) return 'top'
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]
    if (line.trim() === '') continue
    const current = indentation(line)
    if (current >= indent) continue
    const body = line.slice(current)
    if (!body.startsWith('- ')) return 'top'
    return INSERT_RE.test(body) ? 'insert' : 'top'
  }
  return 'top'
}

/**
 * 找出插件行的位置与整段删除区间。
 * ids 省略时按本 bundle 的三条行匹配。
 */
export function findRowSpans(text, ids = BUNDLE_ROW_IDS) {
  if (typeof text !== 'string' || text.length === 0) return []
  const wanted = new Set(ids)
  const lines = text.split(/\r?\n/)
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW_RE.exec(lines[index])
    if (!match || !wanted.has(match[1])) continue
    const indent = indentation(lines[index])
    rows.push({
      id: match[1],
      line: index + 1,
      indent,
      start: index,
      end: removalEnd(lines, index, indent),
      nesting: rowNesting(lines, index, indent),
    })
  }
  return rows
}

/** 扫描一份 YAML 文本里 `- id: preset-main-agent` 出现的位置与可删除的行区间。 */
export function findPresetRows(text) {
  return findRowSpans(text, [PRESET_ROW_ID]).map((row) => ({
    line: row.line,
    indent: row.indent,
    start: row.start,
    end: row.end,
  }))
}

function removeSpans(lines, spans) {
  const drop = new Set()
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) drop.add(index)
  }
  const kept = dropEmptyInserts(lines.filter((_, index) => !drop.has(index)))
  // 删到文件末尾时会连分行符一起吃掉；补回去，别让写出的 yml 少个换行。
  return kept === '' || kept.endsWith('\n') ? kept : `${kept}\n`
}

/** 删掉列表项后，`- insert:` 可能变成空壳；空壳会让 YAML 不合法，一并移除。 */
function dropEmptyInserts(lines) {
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+insert:\s*(?:#.*)?$/.exec(lines[index])
    if (match) {
      let next = index + 1
      while (next < lines.length && lines[next].trim() === '') next += 1
      if (next >= lines.length || indentation(lines[next]) <= match[1].length) continue
    }
    kept.push(lines[index])
  }
  return kept.join('\n')
}

function unquote(raw) {
  const value = String(raw ?? '').trim()
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === "'" || quote === '"') && value.at(-1) === quote) return value.slice(1, -1)
  }
  return value
}

/** YAML 标量：去引号，并且只在引号外砍掉行尾注释。 */
function yamlScalar(raw) {
  const value = String(raw ?? '').trim()
  if (value.startsWith("'") || value.startsWith('"')) {
    const end = value.indexOf(value[0], 1)
    return end === -1 ? value.slice(1) : value.slice(1, end)
  }
  const hash = value.indexOf(' #')
  return (hash === -1 ? value : value.slice(0, hash)).trim()
}

/** lockfile 里的 version 可能带 peer 后缀：`0.72.0(@deepseek-ai/schemastery@3.18.4)`。 */
function normalizeLockedVersion(raw) {
  const value = unquote(raw)
  const paren = value.indexOf('(')
  return (paren === -1 ? value : value.slice(0, paren)).trim()
}

/** 解析 pnpm-lock.yaml 里 `importers → . → dependencies` 段。 */
function parseLockfileDependencies(text) {
  const deps = new Map()
  if (typeof text !== 'string') return deps
  const lines = text.split(/\r?\n/)
  let inImporters = false
  let inDotImporter = false
  let inDependencies = false
  let name = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const indent = indentation(line)
    const trimmed = line.trim()
    if (indent === 0) {
      inImporters = trimmed === 'importers:'
      inDotImporter = false
      inDependencies = false
      name = null
      continue
    }
    if (!inImporters) continue
    if (indent === 2) {
      inDotImporter = unquote(trimmed.replace(/:\s*$/, '')) === '.'
      inDependencies = false
      name = null
      continue
    }
    if (!inDotImporter) continue
    if (indent === 4) {
      inDependencies = unquote(trimmed.replace(/:\s*$/, '')) === 'dependencies'
      name = null
      continue
    }
    if (!inDependencies) continue
    if (indent === 6) {
      name = unquote(trimmed.replace(/:\s*$/, ''))
      deps.set(name, { specifier: null, version: null })
      continue
    }
    if (indent === 8 && name !== null) {
      const match = /^([A-Za-z]+):\s*(.*)$/.exec(trimmed)
      if (!match || (match[1] !== 'specifier' && match[1] !== 'version')) continue
      const value = match[1] === 'version' ? normalizeLockedVersion(match[2]) : unquote(match[2])
      deps.get(name)[match[1]] = value
    }
  }
  return deps
}

/**
 * package.json 里写死的精确版本 vs 锁文件里的版本。
 * `^` / `~` / `http` / `git` / `github:` 之类的非精确写法一律跳过 —— 它们本来就
 * 不参与「清单比锁文件新」的判定。
 */
function detectDrift(manifestDeps, locked) {
  const drift = []
  for (const [name, spec] of Object.entries(manifestDeps ?? {})) {
    if (typeof spec !== 'string') continue
    const manifest = spec.trim()
    if (!EXACT_VERSION_RE.test(manifest)) continue
    const lockedVersion = locked.get(name)?.version ?? null
    if (lockedVersion === manifest) continue
    drift.push({ name, manifest, locked: lockedVersion })
  }
  return drift
}

function parseYamlExcludes(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line))
  if (start === -1) return []
  const excludes = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (!item) break
    const value = yamlScalar(item[1])
    if (value !== '') excludes.push(value)
  }
  return excludes
}

/**
 * 读 pnpm 的供应链策略。两个来源要分开看，不能混成一句「现在生效」：
 *
 * - `pnpm-workspace.yaml` 里的 `minimumReleaseAge` = **当前**配置（`configured`）；
 * - `node_modules/.pnpm-workspace-state-v1.json` 的 `settings` = **上一次安装解析
 *   时** pnpm 实际用过的那份（`state`，带 `stateAt` 时间戳）。它是证据，不是当前
 *   生效值：pnpm 会把当时的设置写进这个缓存，之后即便配置被改掉/删掉，缓存也不变。
 *
 * `minimumReleaseAge` 保留为「两者取其一」的兼容字段（configured 优先），
 * 只有它 > 0 才说明「现在跑 pnpm 会撞冷静期」。
 */
export async function readPolicy(dir) {
  const stateFile = path.join(dir, 'node_modules', '.pnpm-workspace-state-v1.json')
  const stateValue = (await readJson(stateFile)).value
  const settings = stateValue?.settings
  const stateAge = Number.isFinite(Number(settings?.minimumReleaseAge)) ? Number(settings.minimumReleaseAge) : null
  const stateAt = typeof stateValue?.lastValidatedTimestamp === 'number'
    ? new Date(stateValue.lastValidatedTimestamp).toISOString()
    : null
  const stateExcludes = Array.isArray(settings?.minimumReleaseAgeExclude)
    ? settings.minimumReleaseAgeExclude.map((value) => unquote(value)).filter((value) => value !== '')
    : []

  const text = await readText(path.join(dir, 'pnpm-workspace.yaml'))
  const yamlExcludes = text === null ? [] : parseYamlExcludes(text)
  const ageMatch = text === null ? null : /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m.exec(text)
  const configured = ageMatch ? Number(ageMatch[1]) : null

  if (configured === null && stateAge === null && yamlExcludes.length === 0 && stateExcludes.length === 0) return null
  return {
    minimumReleaseAge: configured ?? stateAge,
    configured,
    state: stateAge,
    stateAt,
    excludes: yamlExcludes.length > 0 ? yamlExcludes : stateExcludes,
  }
}

function excludeCovers(rule, name, version) {
  const value = unquote(rule)
  if (value === '') return false
  // 裸包名 = 整包豁免
  if (value === name) return true
  if (!value.startsWith(`${name}@`)) return false
  return value
    .slice(name.length + 1)
    .split('||')
    .some((part) => unquote(part) === version)
}

/**
 * 「漂移包里，manifest 版本没有被 minimumReleaseAgeExclude 覆盖」的条目。
 * 覆盖判定：excludes 里有裸包名（整包豁免），或 `pkg@v1 || v2` 的列表里含
 * manifest 版本。没有白名单时一条都不算覆盖。
 */
export function staleExcludes(policy, drift) {
  const excludes = Array.isArray(policy?.excludes) ? policy.excludes : []
  return (drift ?? []).filter((entry) => !excludes.some((rule) => excludeCovers(rule, entry.name, entry.manifest)))
}

function cooldownOf(policy) {
  const age = Number(policy?.minimumReleaseAge ?? 0)
  return Number.isFinite(age) && age > 0 ? age : 0
}

function describeDrift(entry) {
  return `${entry.name} ${entry.manifest} ≠ ${entry.locked ?? '锁文件里没有这个包'}`
}

/** 只读诊断一个 profile 目录。 */
export async function scanProfile(dir, options = {}) {
  const home = resolveHome(dir, options.home)
  const result = {
    dir,
    name: path.basename(dir),
    home,
    packageError: null,
    dependency: null,
    bundlesListed: false,
    installedVersion: null,
    installDir: existsSync(path.join(dir, 'node_modules', PACKAGE_NAME)),
    patch: null,
    generated: null,
    legacyRows: [],
    drift: [],
    policy: null,
    presetDir: null,
    findings: [],
    state: null,
    fixable: false,
  }
  const pkgFile = path.join(dir, 'package.json')
  const { value: pkg, error } = await readJson(pkgFile)
  result.packageError = error
  if (error) result.findings.push(`package.json 解析失败：${error}`)
  const dependency = pkg?.dependencies?.[PACKAGE_NAME] ?? pkg?.devDependencies?.[PACKAGE_NAME]
  if (typeof dependency === 'string') result.dependency = dependency
  const bundles = pkg?.dsh?.profile?.bundles
  result.bundlesListed = Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)
  const installedPkg = await readJson(path.join(dir, 'node_modules', PACKAGE_NAME, 'package.json'))
  if (installedPkg.value?.version) result.installedVersion = installedPkg.value.version

  const patchFile = path.join(dir, 'cordis.patch.yml')
  const patchText = await readText(patchFile)
  if (patchText !== null) {
    const rows = findPresetRows(patchText)
    result.patch = { file: patchFile, rows }
    result.legacyRows = findRowSpans(patchText, BUNDLE_ROW_IDS)
    if (rows.length > 1) {
      result.findings.push(`cordis.patch.yml 里 ${PRESET_ROW_ID} 声明了 ${rows.length} 次（只应 1 次）`)
      result.fixable = true
    }
    for (const id of BUNDLE_ROW_IDS) {
      const hits = result.legacyRows.filter((row) => row.id === id)
      if (hits.length === 0) continue
      const where = hits.map((row) => `第 ${row.line} 行`).join('、')
      if (id === 'agi-schedule') {
        result.findings.push(`cordis.patch.yml 仍有 ${id} 行（${where}）：卸载后成为孤儿行（无害，--apply --uninstall 会顺手清掉）`)
        continue
      }
      result.findings.push(`cordis.patch.yml 仍有 ${id} 行（${where}）：卸载时它会让 remove_bundle 撞 bundle-in-use（宿主源码 lib/index.js:2148）；--apply --uninstall 会清掉`)
      result.fixable = true
    }
  }
  const generatedFile = path.join(dir, 'cordis.yml')
  const generatedText = await readText(generatedFile)
  if (generatedText !== null) {
    const rows = findPresetRows(generatedText)
    result.generated = { file: generatedFile, rows }
    if (rows.length > 1) {
      result.findings.push(`cordis.yml（生成物）里 ${PRESET_ROW_ID} 出现 ${rows.length} 次；不要手改，重启会重新生成`)
    }
  }

  const lockText = await readText(path.join(dir, 'pnpm-lock.yaml'))
  if (lockText !== null) result.drift = detectDrift(pkg?.dependencies, parseLockfileDependencies(lockText))
  result.policy = await readPolicy(dir)
  const cooldown = cooldownOf(result.policy)
  const configured = result.policy?.configured ?? null
  if (result.drift.length > 0) {
    const stale = cooldown > 0 ? staleExcludes(result.policy, result.drift) : []
    for (const entry of result.drift) {
      if (stale.includes(entry)) {
        if (configured !== null && configured > 0) {
          result.findings.push(`package.json 与 pnpm-lock.yaml 漂移：${describeDrift(entry)}；冷静期 ${cooldown} 分钟当前生效（pnpm 11.7.0）且白名单未覆盖 ${entry.manifest} → 任何 pnpm 解析（含 remove_bundle 内部的 pnpm remove）都会报 ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED，卸载因此卡死`)
        } else {
          const at = result.policy?.stateAt ? `（记于 ${result.policy.stateAt}）` : ''
          result.findings.push(`package.json 与 pnpm-lock.yaml 漂移：${describeDrift(entry)}；白名单未覆盖 ${entry.manifest}，而上一次安装解析时冷静期 ${cooldown} 分钟生效${at}→ remove_bundle 内部的 pnpm remove 当时正是报 ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED 失败；当前 pnpm-workspace.yaml 里没有 minimumReleaseAge，重跑前先按方案 A 显式关掉冷静期`)
        }
        continue
      }
      result.findings.push(`package.json 与 pnpm-lock.yaml 漂移：${describeDrift(entry)}（${cooldown > 0 ? `白名单已覆盖 ${entry.manifest}，pnpm 不会因此报错` : '冷静期未生效，下次 pnpm 解析会重新解析该包'}）`)
    }
  }

  const parts = []
  if (result.dependency) parts.push('package.json 依赖')
  if (result.bundlesListed) parts.push('dsh.profile.bundles 条目')
  if (result.installDir) parts.push(`node_modules/${PACKAGE_NAME} 目录`)
  if (parts.length === 0) {
    result.state = '未安装'
  } else if (parts.length === 3) {
    result.state = `已安装（${result.installedVersion ?? '版本未知'}），依赖 / bundles / node_modules 齐备`
  } else {
    result.state = `安装状态不完整：只有 ${parts.join('、')}`
    result.findings.push(result.state)
  }

  const presetPath = path.join(home, '.agent-presets', PRESET_ID)
  // 只当信息收集：`.agent-presets/main-agent` 是 home 级共享目录，不归某一个
  // profile 所有。按 profile 报「残留」会让同一台机器上别的 profile 误报。
  result.presetDir = { path: presetPath, exists: existsSync(presetPath) }
  return result
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

async function backup(file, at) {
  if (!existsSync(file)) return null
  const target = `${file}.bak-${at}`
  await copyFile(file, target)
  return target
}

/** 同目录内改名（可逆）；目标已存在时加序号，绝不覆盖旧备份。 */
async function renameWithStamp(target, at) {
  const parent = path.dirname(target)
  const base = `${path.basename(target)}.bak-${at}`
  let candidate = path.join(parent, base)
  for (let index = 1; existsSync(candidate); index += 1) candidate = path.join(parent, `${base}-${index}`)
  await rename(target, candidate)
  return candidate
}

/** 执行修复。uninstall=true 时连依赖、bundle 条目、patch 行和 preset 目录一起清掉。 */
export async function repairProfile(dir, { apply = false, uninstall = false, home } = {}) {
  const scan = await scanProfile(dir, { home })
  const actions = []
  const backups = []
  if (!apply) return { scan, actions, backups }

  const at = stamp()
  const patchFile = path.join(dir, 'cordis.patch.yml')
  const patchText = await readText(patchFile)
  if (patchText !== null) {
    const lines = patchText.split(/\r?\n/)
    if (uninstall) {
      // 卸载：本 bundle 的三条行全删（含 `- insert:` 内嵌行），其它行原样保留。
      const rows = findRowSpans(patchText, BUNDLE_ROW_IDS)
      if (rows.length > 0) {
        const repaired = removeSpans(lines, rows)
        const saved = await backup(patchFile, at)
        if (saved) backups.push(saved)
        await writeFile(patchFile, repaired, 'utf8')
        const ids = [...new Set(rows.map((row) => row.id))].join(' / ')
        actions.push(`cordis.patch.yml：删除 ${rows.length} 条本 bundle 的 patch 行（${ids}），其它行原样保留`)
      }
    } else {
      // 只去重：保留第一条 preset 行，绝不删唯一的 legacy 行（保守策略）。
      const rows = findPresetRows(patchText)
      if (rows.length > 1) {
        const repaired = removeSpans(lines, rows.slice(1))
        const saved = await backup(patchFile, at)
        if (saved) backups.push(saved)
        await writeFile(patchFile, repaired, 'utf8')
        actions.push(`cordis.patch.yml：删除 ${rows.length - 1} 条重复的 ${PRESET_ROW_ID} 声明（保留第 ${rows[0].line} 行那条）`)
      }
    }
  }

  if (uninstall) {
    const pkgFile = path.join(dir, 'package.json')
    const { value: pkg, error } = await readJson(pkgFile)
    if (pkg && !error) {
      let changed = false
      for (const key of ['dependencies', 'devDependencies']) {
        if (pkg[key] && PACKAGE_NAME in pkg[key]) {
          delete pkg[key][PACKAGE_NAME]
          changed = true
        }
      }
      const bundles = pkg.dsh?.profile?.bundles
      if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
        pkg.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
        changed = true
      }
      if (changed) {
        const saved = await backup(pkgFile, at)
        if (saved) backups.push(saved)
        await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
        actions.push('package.json：移除依赖与 bundle 条目')
      }
    }
    for (const rel of [path.join('node_modules', PACKAGE_NAME), path.join('node_modules', '.ignored', PACKAGE_NAME)]) {
      const target = path.join(dir, rel)
      if (!existsSync(target)) continue
      await rm(target, { recursive: true, force: true })
      actions.push(`删除 ${rel}`)
    }
    const presetTarget = path.join(resolveHome(dir, home), '.agent-presets', PRESET_ID)
    if (existsSync(presetTarget)) {
      const renamed = await renameWithStamp(presetTarget, at)
      actions.push(`preset 目录：改名备份为 ${renamed}（可逆；确认不需要后自行删除）`)
    }
    // 只在真动了东西时交代 lockfile：纯粹的第二次跑要完全没有动作（幂等）。
    if (actions.length > 0) {
      actions.push('保留 pnpm-lock.yaml 不动；下次通过插件管理器安装时会重新解析（含清单里的漂移版本）')
    }
  }
  return { scan, actions, backups }
}

export function formatReport(results, { home } = {}) {
  const lines = []
  lines.push(`DSH profile 根目录：${home ?? defaultHome()}`)
  if (results.length === 0) {
    lines.push('没有找到任何 profile（目录下没有 package.json）。')
    return lines.join('\n')
  }
  for (const { scan, actions, backups } of results) {
    lines.push('')
    lines.push(`■ ${scan.name}  (${scan.dir})`)
    lines.push(`  状态：${scan.state}`)
    const patchRows = scan.patch?.rows?.length ?? 0
    const generatedRows = scan.generated?.rows?.length ?? 0
    lines.push(`  cordis.patch.yml 中 ${PRESET_ROW_ID} 行数：${patchRows}    cordis.yml 中：${generatedRows}`)
    if (scan.legacyRows?.length) {
      const detail = scan.legacyRows
        .map((row) => `${row.id}（第 ${row.line} 行，${row.nesting === 'insert' ? 'insert 内嵌' : '顶层'}）`)
        .join('、')
      lines.push(`  本 bundle 的 patch 行：${detail}`)
    }
    for (const entry of scan.drift ?? []) lines.push(`  版本漂移：${describeDrift(entry)}`)
    if (scan.policy) {
      const bits = [`配置里 minimumReleaseAge=${scan.policy.configured ?? '未设置'}`]
      if (scan.policy.state !== null && scan.policy.state !== scan.policy.configured) {
        bits.push(`上次解析记录 ${scan.policy.state}${scan.policy.stateAt ? `（${scan.policy.stateAt}）` : ''}`)
      }
      bits.push(`minimumReleaseAgeExclude ${scan.policy.excludes?.length ?? 0} 条`)
      lines.push(`  pnpm 冷静期：${bits.join('；')}`)
    }
    if (scan.presetDir) lines.push(`  preset 目录：${scan.presetDir.path}（${scan.presetDir.exists ? '存在' : '不存在'}）`)
    if (scan.findings.length === 0) {
      lines.push('  没有发现问题。')
    } else {
      for (const finding of scan.findings) lines.push(`  - ${finding}`)
    }
    for (const action of actions) lines.push(`  已修：${action}`)
    for (const file of backups) lines.push(`  备份：${file}`)
  }
  return lines.join('\n')
}

/** 探测 DSH 自带的 node / pnpm —— 插件管理器实际用的那一对，不是 PATH 里的。 */
function runtimeTools(home) {
  const deps = path.join(home ?? defaultHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
  const node = [path.join(deps, 'node', 'bin', 'node.exe'), path.join(deps, 'node', 'bin', 'node')].find((file) => existsSync(file))
  const pnpm = [path.join(deps, 'pnpm', 'bin', 'pnpm.mjs'), path.join(deps, 'pnpm', 'bin', 'pnpm.cjs')].find((file) => existsSync(file))
  return { node: node ?? '<node>', pnpm: pnpm ?? '<pnpm>' }
}

export function nextSteps(results, { applied, uninstall, home } = {}) {
  const lines = []
  const anyFinding = results.some(({ scan }) => scan.findings.length > 0)
  const anyFixable = results.some(({ scan }) => scan.fixable)
  const drift = []
  const stale = []
  for (const { scan } of results) {
    for (const entry of scan.drift ?? []) drift.push(entry)
    if (cooldownOf(scan.policy) === 0) continue
    for (const entry of staleExcludes(scan.policy, scan.drift ?? [])) stale.push(entry)
  }
  if (!applied) {
    if (!anyFinding) {
      lines.push('诊断完成：这些 profile 不需要修复。')
      return lines
    }
    if (anyFixable) {
      lines.push('发现可自动处理的残留：加 --apply 只去重（保留第一条 preset 行）；要清掉本 bundle 的 patch 行、依赖与 preset 目录用 --apply --uninstall（写前先备份）。')
    }
    lines.push('若安装界面仍提示「这个包已经安装」或「bundle-in-use」：加 --apply --uninstall 彻底清理。')
  } else {
    lines.push('全部改动已落盘。接下来：')
    lines.push('1. 完全退出 DSH（不是关窗口，是退出进程）；')
    lines.push('2. 重新启动 DSH —— loader 只在启动时组合 profile；')
    if (uninstall) {
      lines.push('3. 设置 → 插件 → 添加插件，粘贴安装地址重新安装（不要点「更新」）；')
      lines.push(`   ${INSTALL_URL}`)
      lines.push('4. 装好后重启一次，选择器里应出现「Main Agent（监督者）」。')
    } else {
      lines.push('3. 再试一次卸载/安装；仍被拒就回来跑 --apply --uninstall。')
    }
  }
  if (stale.length > 0) {
    lines.push('')
    lines.push('⚠ pnpm 侧还有一道坎（脚本不替你动它）：')
    for (const entry of drift) lines.push(`  package.json 与 pnpm-lock.yaml 漂移：${describeDrift(entry)}`)
    const { node, pnpm } = runtimeTools(home)
    lines.push('')
    lines.push('# 方案 A（不动白名单）：DSH 完全退出后执行')
    lines.push(`"${node}" "${pnpm}" remove ${PACKAGE_NAME} --config.minimumReleaseAge=0`)
    lines.push('# 方案 B（推荐，长期有效）：在 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 里加整包豁免')
    for (const name of new Set(stale.map((entry) => entry.name))) lines.push(`- "${name}"`)
    lines.push('')
    lines.push('（脚本本身不会改 pnpm-workspace.yaml，也不会跑 pnpm；A/B 二选一，手工执行。）')
  } else if (drift.length > 0) {
    lines.push('')
    lines.push('注意：package.json 与 pnpm-lock.yaml 有漂移，但冷静期未生效或已被白名单覆盖，pnpm 解析不会因此报错。')
  }
  return lines
}

async function main() {
  const argv = process.argv.slice(2)
  const options = { home: defaultHome(), profile: null, apply: false, uninstall: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--home') options.home = path.resolve(argv[++index] ?? '')
    else if (arg === '--profile') options.profile = argv[++index] ?? null
    else {
      console.error(`未知参数：${arg}（--help 查看用法）`)
      process.exitCode = 2
      return
    }
  }
  if (options.uninstall) options.apply = true
  if (options.help) {
    console.log('用法：node scripts/repair-profile.mjs [--apply] [--uninstall] [--profile <名字|目录>] [--home <目录>] [--json]')
    return
  }

  let profiles = await listProfiles(options.home)
  if (options.profile) {
    const wanted = options.profile
    const asDir = path.resolve(wanted)
    const match = existsSync(path.join(asDir, 'package.json'))
      ? asDir
      : profiles.find((dir) => path.basename(dir) === wanted)
    if (!match) {
      console.error(`找不到 profile：${wanted}`)
      process.exitCode = 1
      return
    }
    profiles = [match]
  }
  if (profiles.length === 0) {
    console.error(`在 ${options.home} 下没有找到 profile（目录里没有 package.json）。`)
    process.exitCode = 1
    return
  }

  const results = []
  for (const dir of profiles) results.push(await repairProfile(dir, options))
  if (options.json) {
    console.log(JSON.stringify({ home: options.home, applied: options.apply, results }, null, 2))
  } else {
    console.log(formatReport(results, { home: options.home }))
    console.log('')
    for (const line of nextSteps(results, { applied: options.apply, uninstall: options.uninstall, home: options.home })) console.log(line)
  }
  if (!options.apply && results.some(({ scan }) => scan.findings.length > 0)) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
