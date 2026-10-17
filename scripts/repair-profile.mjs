#!/usr/bin/env node
/**
 * repair-profile — 把被 dsh-main-agent 卡住的 profile 拉回可安装状态。
 *
 * 处理三种已知的「装不上 / 卸不掉」：
 *   1. 同一条 `preset-main-agent` 声明在 profile 的 cordis.patch.yml 里出现多次
 *      （升级时旧副本与新副本的 patch 同时参与组合，插件管理器报
 *      `duplicate loader entry id`）；
 *   2. package.json 里仍留着 `dsh-main-agent` 依赖或 bundles 条目，UI 因此
 *      一直认为「这个包已经安装」；
 *   3. 残留的 node_modules/dsh-main-agent 让新版本无法落盘。
 *
 * 用法：
 *   node scripts/repair-profile.mjs                 # 只诊断
 *   node scripts/repair-profile.mjs --apply         # 删重复的 preset 行（自动备份）
 *   node scripts/repair-profile.mjs --apply --uninstall   # 彻底清干净，回到可安装状态
 *   node scripts/repair-profile.mjs --profile desktop     # 只处理一个 profile
 *   node scripts/repair-profile.mjs --home /path/to/.dsh --json
 *
 * 只写 ${DSH_HOME:-~/.dsh}/profiles/* 下的 package.json 与 cordis.patch.yml，
 * 每次写入前生成 .bak-<时间戳>；cordis.yml 是生成物，只报告、不修改。
 * 跑完后必须先完全退出 DSH 再启动，配置在启动时才重新组合。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir, stat, rm, copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-main-agent'
export const PRESET_ROW_ID = 'preset-main-agent'
export const INSTALL_URL = 'https://gitee.com/n-sky/dsh-main-agent.git'

const ROW_RE = /^\s*-\s+id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:#.*)?$/

export function defaultHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
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

/** 扫描一份 YAML 文本里 `- id: preset-main-agent` 出现的位置与可删除的行区间。 */
export function findPresetRows(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const lines = text.split(/\r?\n/)
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW_RE.exec(lines[index])
    if (!match || match[1] !== PRESET_ROW_ID) continue
    const indent = lines[index].length - lines[index].trimStart().length
    rows.push({ line: index + 1, indent, start: index, end: removalEnd(lines, index, indent) })
  }
  return rows
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

function removeSpans(lines, spans) {
  const drop = new Set()
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) drop.add(index)
  }
  return dropEmptyInserts(lines.filter((_, index) => !drop.has(index)))
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

/** 只读诊断一个 profile 目录。 */
export async function scanProfile(dir) {
  const result = {
    dir,
    name: path.basename(dir),
    packageError: null,
    dependency: null,
    bundlesListed: false,
    installedVersion: null,
    installDir: existsSync(path.join(dir, 'node_modules', PACKAGE_NAME)),
    patch: null,
    generated: null,
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
    if (rows.length > 1) {
      result.findings.push(`cordis.patch.yml 里 ${PRESET_ROW_ID} 声明了 ${rows.length} 次（只应 1 次）`)
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

/** 执行修复。uninstall=true 时连依赖、bundle 条目和 node_modules 一起清掉。 */
export async function repairProfile(dir, { apply = false, uninstall = false } = {}) {
  const scan = await scanProfile(dir)
  const actions = []
  const backups = []
  if (!apply) return { scan, actions, backups }

  const at = stamp()
  const patchFile = path.join(dir, 'cordis.patch.yml')
  const patchText = await readText(patchFile)
  if (patchText !== null) {
    const rows = findPresetRows(patchText)
    if (rows.length > 1) {
      const repaired = removeSpans(patchText.split(/\r?\n/), rows.slice(1))
      const saved = await backup(patchFile, at)
      if (saved) backups.push(saved)
      await writeFile(patchFile, repaired, 'utf8')
      actions.push(`cordis.patch.yml：删除 ${rows.length - 1} 条重复的 ${PRESET_ROW_ID} 声明（保留第 ${rows[0].line} 行那条）`)
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
    actions.push('保留 pnpm-lock.yaml 不动；下次通过插件管理器安装时会重新解析')
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

export function nextSteps(results, { applied, uninstall } = {}) {
  const lines = []
  const anyFinding = results.some(({ scan }) => scan.findings.length > 0)
  const anyFixable = results.some(({ scan }) => scan.fixable)
  if (!applied) {
    if (!anyFinding) {
      lines.push('诊断完成：这些 profile 不需要修复。')
      return lines
    }
    if (anyFixable) lines.push('发现可自动修复的重复声明：加 --apply 执行（会先备份 cordis.patch.yml）。')
    lines.push('若安装界面仍提示「这个包已经安装」或「bundle-in-use」：加 --apply --uninstall 彻底清理。')
    return lines
  }
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
    for (const line of nextSteps(results, { applied: options.apply, uninstall: options.uninstall })) console.log(line)
  }
  if (!options.apply && results.some(({ scan }) => scan.findings.length > 0)) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
