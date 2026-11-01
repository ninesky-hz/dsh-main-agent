#!/usr/bin/env node
/**
 * sync-profile — 把仓库里的插件文件同步到「宿主真正执行的那几份」。
 *
 * 为什么需要这个脚本：本插件的代码在运行时会存在**三份**，改仓库只动了第一份。
 *
 *   1. 仓库                 D:\...\dsh-main-agent\            （你编辑的地方）
 *   2. profile 副本         $DSH_HOME/profiles/<p>/node_modules/dsh-main-agent/
 *                           （宿主 require 这份 —— 不同步等于没改）
 *   3. 用户 preset 根        $DSH_HOME/.agent-presets/main-agent/
 *                           （宿主读的是这份 agent.cordis.yml；由
 *                            lib/index.js 的 installPreset 在启动时安装，
 *                            但默认 syncPreset: 'if-absent' ——
 *                            目标已存在就**永不覆盖**，所以它是最容易
 *                            停在上一个版本的那一份）
 *
 * 还有第四条路径常被忽略：`presets/main-agent.patch.yml` 是 patch 层，
 * 由 `npm run sync-preset` 从 `agent-presets/` 生成，它会随第 2 份一起被
 * require，所以也在同步清单里。
 *
 * 用法：
 *   node scripts/sync-profile.mjs              # 只诊断：逐文件比对 sha256
 *   node scripts/sync-profile.mjs --apply      # 同步（先整目录备份）
 *   node scripts/sync-profile.mjs --apply --dry-run
 *   node scripts/sync-profile.mjs --apply --keep 5   # 同步后保留最近 5 份备份（默认 3）
 *   node scripts/sync-profile.mjs --apply --keep 0   # 同步但一份旧备份也不清理
 *   node scripts/sync-profile.mjs --home /path/to/.dsh
 *   node scripts/sync-profile.mjs --json
 *
 * 退出码：0 = 一致（或已同步）；1 = 诊断模式下发现不一致；2 = 出错。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_KEEP_BACKUPS, pruneBackups } from './backup-retention.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PACKAGE_NAME = 'dsh-main-agent'
const PRESET_ID = 'main-agent'

/** 仓库里「需要被同步出去」的路径，相对仓库根。顺序无关，目录会递归。 */
const SYNC_PATHS = [
  'lib',
  'scripts',
  'prompts',
  'presets',
  'agent-presets',
  'docs',
  'cordis.patch.yml',
  'package.json',
  'README.md',
]

/** 用户 preset 根只放 preset 自己的内容，不要把 lib/ 之类塞进去。 */
const PRESET_ROOT_PATHS = ['agent-presets/main-agent', 'prompts']

function parseArgs(argv) {
  const out = { apply: false, dryRun: false, json: false, home: undefined, keep: DEFAULT_KEEP_BACKUPS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a === '--home') out.home = argv[++i]
    else if (a === '--keep') out.keep = parseKeep(argv[++i])
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

/**
 * 解析 `--keep <n>`。
 *
 * 非法值（缺参数、负数、非整数）**退回默认 3 并继续**，而不是直接报错退出：
 * 清理是同步的旁路，一个写错的保留参数不该让「把代码同步到宿主」这件事停下。
 * 特别注意 `--keep 0` 是合法值（本次不清理），不能被当成「缺省」吃掉。
 */
function parseKeep(raw) {
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 0) return n
  console.warn(`忽略了非法的 --keep 值「${raw}」，按默认 ${DEFAULT_KEEP_BACKUPS} 份保留`)
  return DEFAULT_KEEP_BACKUPS
}

function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

/** 递归收集文件，返回相对 `root` 的 posix 风格路径数组。 */
function walk(root, dir, acc = []) {
  const base = dir === '.' ? '' : dir
  const abs = base ? join(root, base) : root
  if (!existsSync(abs)) return acc
  const st = statSync(abs)
  if (st.isFile()) {
    acc.push(base)
    return acc
  }
  if (!st.isDirectory()) return acc
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git') continue
    walk(root, base ? `${base}/${name}` : name, acc)
  }
  return acc
}

function buildManifest(root, paths) {
  const files = []
  for (const p of paths) {
    if (!existsSync(join(root, p))) continue
    for (const rel of walk(root, p)) files.push(rel)
  }
  return files.sort()
}

/**
 * 比较源与目标，返回 { same, missing, differing, extra }。
 * `extra` 只在目标是「独占目录」（如 ~/.dsh/.agent-presets/main-agent）时才有意义。
 */
function compare(sourceRoot, targetRoot, files, { reportExtra = false } = {}) {
  const same = []
  const missing = []
  const differing = []
  for (const rel of files) {
    const src = join(sourceRoot, rel)
    const dst = join(targetRoot, rel)
    if (!existsSync(dst)) {
      missing.push(rel)
      continue
    }
    try {
      if (sha256(src) === sha256(dst)) same.push(rel)
      else differing.push(rel)
    } catch {
      differing.push(rel)
    }
  }
  let extra = []
  if (reportExtra && existsSync(targetRoot)) {
    const known = new Set(files)
    extra = buildManifest(targetRoot, ['.']).filter((rel) => !known.has(rel))
  }
  return { same, missing, differing, extra }
}

function copyFiles(sourceRoot, targetRoot, files) {
  let copied = 0
  for (const rel of files) {
    const src = join(sourceRoot, rel)
    const dst = join(targetRoot, rel)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { force: true })
    copied++
  }
  return copied
}

function resolveHome(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

function listProfiles(home) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => {
      const p = join(dir, name)
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return 0
  }

  const home = resolveHome(args.home)
  const targets = []
  const problems = []

  const manifest = buildManifest(REPO_ROOT, SYNC_PATHS)
  if (manifest.length === 0) {
    problems.push(`仓库 ${REPO_ROOT} 里没有找到任何可同步文件`)
  }

  for (const name of listProfiles(home)) {
    const installed = join(home, 'profiles', name, 'node_modules', PACKAGE_NAME)
    if (!existsSync(installed)) continue
    targets.push({
      kind: 'profile',
      label: `profile:${name}`,
      root: installed,
      files: manifest,
      reportExtra: false,
    })
  }

  const presetRoot = join(home, '.agent-presets', PRESET_ID)
  if (existsSync(presetRoot)) {
    targets.push({
      kind: 'preset',
      label: `preset-root:${PRESET_ID}`,
      root: presetRoot,
      files: buildManifest(REPO_ROOT, PRESET_ROOT_PATHS).map((rel) =>
        rel.startsWith('agent-presets/main-agent/') ? rel.slice('agent-presets/main-agent/'.length) : rel,
      ),
      // preset 根的相对路径基准不同，需要用「从 agent-presets/main-agent 起算」的映射
      sourceRoot: join(REPO_ROOT, 'agent-presets', PRESET_ID),
      reportExtra: true,
    })
  }

  if (targets.length === 0) {
    problems.push(`在 ${home} 下没有找到任何已安装的 ${PACKAGE_NAME}（既无 profiles/*/node_modules，也无 .agent-presets/${PRESET_ID}）`)
  }

  const report = { home, repo: REPO_ROOT, apply: args.apply && !args.dryRun, targets: [], problems }

  for (const target of targets) {
    const sourceRoot = target.sourceRoot ?? REPO_ROOT
    // preset 根的文件清单里可能混进 prompts/（它不属于 preset 目录），单独剔掉
    const files = target.kind === 'preset'
      ? target.files.filter((rel) => !rel.startsWith('../'))
      : target.files
    const filesSafe = target.kind === 'preset'
      ? buildManifest(sourceRoot, ['agent.cordis.yml', 'preset.yml'])
      : files
    const diff = compare(sourceRoot, target.root, filesSafe, { reportExtra: target.reportExtra })

    let copied = 0
    let backup = null
    if (report.apply && (diff.missing.length || diff.differing.length)) {
      backup = join(home, `dsh-main-agent-backup-${stamp()}`, target.label.replace(':', '-'))
      mkdirSync(dirname(backup), { recursive: true })
      if (existsSync(target.root)) cpSync(target.root, backup, { recursive: true })
      copied = copyFiles(sourceRoot, target.root, [...diff.missing, ...diff.differing])
    }

    report.targets.push({
      label: target.label,
      root: target.root,
      same: diff.same.length,
      missing: diff.missing,
      differing: diff.differing,
      extra: diff.extra,
      copied,
      backup,
    })
  }

  // 备份保留：每次同步都整目录拷一份，永不清理的话 `$DSH_HOME` 下会稳定长草。
  // 只在真正动过文件（`report.apply`）时清理 —— 诊断模式绝不能删任何东西。
  const backups = report.apply
    ? pruneBackups(home, args.keep)
    : { removed: [], kept: [] }
  report.backups = { keep: args.keep, removed: backups.removed, kept: backups.kept }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {    console.log(`仓库   ${report.repo}`)
    console.log(`DSH_HOME ${report.home}`)
    if (report.apply) console.log('模式   同步（--apply）')
    else console.log('模式   只诊断（加 --apply 才动文件）')
    for (const p of report.problems) console.log(`\n[问题] ${p}`)
    for (const t of report.targets) {
      console.log(`\n── ${t.label}`)
      console.log(`   ${t.root}`)
      console.log(`   一致 ${t.same} / 缺失 ${t.missing.length} / 不一致 ${t.differing.length}`)
      for (const rel of t.missing.slice(0, 12)) console.log(`     + ${rel}`)
      if (t.missing.length > 12) console.log(`     … 另有 ${t.missing.length - 12} 个缺失`)
      for (const rel of t.differing.slice(0, 12)) console.log(`     ~ ${rel}`)
      if (t.differing.length > 12) console.log(`     … 另有 ${t.differing.length - 12} 个不一致`)
      if (t.extra.length) console.log(`   目标里多出 ${t.extra.length} 个文件（不会被删）`)
      if (t.copied) console.log(`   已同步 ${t.copied} 个文件；备份在 ${t.backup}`)
    }
    if (report.apply) {
      if (backups.removed.length) {
        console.log(`\n已清理旧备份 ${backups.removed.length} 份（保留 ${args.keep}）`)
        for (const abs of backups.removed) console.log(`   - ${abs}`)
      } else if (args.keep > 0 && backups.kept.length > args.keep) {
        // 理论上不会到这里（超过 keep 就该有可删的），留作自检。
        console.log(`\n旧备份都没能删掉（${backups.kept.length} 份仍在），请手动检查 ${home}`)
      }
    }
    if (report.targets.length && report.targets.every((t) => !t.missing.length && !t.differing.length)) {
      console.log('\n全部一致。')
    }
  }

  if (problems.length) return 2
  const dirty = report.targets.some((t) => t.missing.length || t.differing.length)
  if (!report.apply && dirty) return 1
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`sync-profile 失败：${error?.stack ?? error}`)
  process.exitCode = 2
}
