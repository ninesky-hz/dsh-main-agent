#!/usr/bin/env node
/**
 * probe-host-seams.mjs — check one installed DSH host against the seams this
 * plugin actually consumes, without loading the plugin into that host.
 *
 *   node scripts/probe-host-seams.mjs [hostDir]
 *
 * hostDir is the directory whose node_modules holds @deepseek-ai/*: the
 * desktop install (`<app>/dsh`), a scratch `npm install @deepseek-ai/dsh-*`
 * tree, or a packed-tarball probe. Defaults to $DSH_HOST_DIR.
 *
 * The point of this script is to answer "does this host version still fit?"
 * with observable facts instead of a changelog: it resolves every host import
 * the plugin's lib/ performs, evaluates the subagent generation resolver
 * against the *installed* runtime prototype, reads the startActivation spec
 * fields out of the shipped sources, and confirms every browser slot the
 * plugin registers is still declared somewhere in the host's client bundles.
 *
 * Exit 0 when every check passes, 1 otherwise (each failure is printed).
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolvePath(here, '..')

/** Browser slots this plugin registers, and the package that must declare each. */
export const REGISTERED_SLOTS = ['conversation.view', 'plugins.item', 'main', 'sidebar.panellist']

const checks = []
function record(id, ok, detail, skipped = false) {
  checks.push({ id, ok, detail, skipped })
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function hostDir() {
  const given = process.argv[2] ?? process.env.DSH_HOST_DIR
  if (!given) {
    console.error('usage: node scripts/probe-host-seams.mjs <hostDir>   (or set DSH_HOST_DIR)')
    process.exit(2)
  }
  const dir = resolvePath(given)
  if (!existsSync(dir)) {
    console.error(`host dir not found: ${dir}`)
    process.exit(2)
  }
  return dir
}

/** Resolve bare specifiers the way the host itself would. */
function hostRequire(dir) {
  const anchor = join(dir, 'package.json')
  return existsSync(anchor) ? createRequire(anchor) : createRequire(join(dir, 'index.js'))
}

function packageDirOf(require, spec) {
  try {
    return dirname(require.resolve(`${spec}/package.json`))
  } catch {}
  try {
    const entry = require.resolve(spec)
    let dir = dirname(entry)
    for (let i = 0; i < 4; i += 1) {
      const pkg = join(dir, 'package.json')
      if (existsSync(pkg)) {
        const meta = JSON.parse(readFileSync(pkg, 'utf8'))
        if (meta.name === spec) return dir
      }
      dir = dirname(dir)
    }
  } catch {}
  return undefined
}

/** Every `import … from '<spec>'` the plugin's lib/ performs. */
function pluginImports() {
  const libDir = join(pluginRoot, 'lib')
  const found = new Map()
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith('.js')) continue
    const text = readText(join(libDir, file)) ?? ''
    const re = /^import\s+(?:([\w*\s{},$]+?)\s+from\s+)?['"]([^'"]+)['"]/gm
    for (const match of text.matchAll(re)) {
      const [, clause = '', spec] = match
      if (!spec.startsWith('@deepseek-ai/') && spec !== 'schemastery') continue
      const named = [...clause.matchAll(/\{([^}]*)\}/g)]
        .flatMap(group => group[1].split(','))
        .map(name => name.trim().split(/\s+as\s+/)[0])
        .filter(Boolean)
      const entry = found.get(spec) ?? { files: [], named: new Set() }
      entry.files.push(file)
      for (const name of named) entry.named.add(name)
      found.set(spec, entry)
    }
  }
  return found
}

async function main() {
  const dir = hostDir()
  const require = hostRequire(dir)

  // 1. Host imports: every spec the plugin's lib/ imports must resolve, with
  //    the same named exports it destructures.
  const imports = pluginImports()
  const versions = {}
  const importFailures = []
  for (const [spec, entry] of imports) {
    let url
    try {
      url = pathToFileURL(require.resolve(spec)).href
    } catch (error) {
      importFailures.push(`${spec}: cannot resolve (${error.code ?? error.message}) [${entry.files.join(', ')}]`)
      continue
    }
    const pkgDir = packageDirOf(require, spec)
    versions[spec] = pkgDir ? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version : '?'
    try {
      const mod = await import(url)
      const missing = [...entry.named].filter(name => !(name in mod) && !(name === 'default' && mod.default !== undefined))
      if (missing.length > 0) importFailures.push(`${spec}: missing export(s) ${missing.join(', ')}`)
    } catch (error) {
      importFailures.push(`${spec}: import failed (${error.code ?? error.message})`)
    }
  }
  record(
    'host-imports',
    importFailures.length === 0,
    importFailures.length === 0
      ? `${imports.size} 个宿主模块全部可解析、具名导出齐全：${Object.entries(versions).map(([s, v]) => `${s.replace('@deepseek-ai/', '')}@${v}`).join(', ')}`
      : importFailures.join('；'),
  )

  // 2. Subagent generation: run the plugin's own resolver against the real
  //    runtime prototype, so the verdict is the plugin's, not a replica.
  const compat = await import(pathToFileURL(join(pluginRoot, 'lib', 'subagent-compat.js')).href)
  const subagentSpec = '@deepseek-ai/dsh-subagent'
  let generationDetail = '未找到 @deepseek-ai/dsh-subagent'
  let generationOk = false
  try {
    const mod = await import(pathToFileURL(require.resolve(subagentSpec)).href)
    const runtime = Object.values(mod).find(
      value => typeof value === 'function' && typeof value.prototype?.startActivation === 'function',
    )
    if (!runtime) {
      generationDetail = '宿主没有导出带 startActivation 的 runtime 类'
    } else {
      const live = Object.create(runtime.prototype)
      const generation = compat.resolveSubagentGeneration({ subagents: live })
      const missing = compat.missingSubagentMethods({ subagents: live })
      const own = Object.getOwnPropertyNames(runtime.prototype).filter(name => name !== 'constructor')
      generationOk = generation === '0.2.2' && missing.length === 0
      generationDetail = `resolveSubagentGeneration → ${generation ?? 'undefined'}；missing → ${missing.length === 0 ? '[]' : `[${missing.join(', ')}]`}；prototype ${own.length} 个方法`
    }
  } catch (error) {
    generationDetail = `加载失败：${error.code ?? error.message}`
  }
  record('subagent-generation', generationOk, generationDetail)

  // 3. startActivation still reads a flat spec: prompt/parent/maxDepth on the
  //    spec itself, and no nested `spec.request` anywhere. Only answerable when
  //    the published package still carries readable TypeScript; a bundle-only
  //    package (the desktop install) is skipped rather than guessed at.
  const subagentDir = packageDirOf(require, subagentSpec)
  let specDetail = '未找到 dsh-subagent 包目录'
  if (subagentDir === undefined) {
    record('activation-spec', false, specDetail)
  } else {
    const sources = ['src/index.ts', 'src/manager.ts', 'lib/index.js']
      .map(name => [name, readText(join(subagentDir, name))])
      .filter(([, text]) => text !== undefined)
    const typed = sources.filter(([name]) => name.endsWith('.ts'))
    if (typed.length === 0) {
      record('activation-spec', true, `跳过：该发布包只有 lib bundle（${sources.map(([name]) => name).join(' + ') || '无'}），改由 subagent-generation 与真机探测回答`, true)
    } else {
      const all = typed.map(([, text]) => text).join('\n')
      const anchors = ['spec.parent', 'spec.maxDepth', 'spec.prompt'].filter(field => all.includes(field))
      const nested = all.includes('spec.request')
      const ok = anchors.length === 3 && !nested
      record('activation-spec', ok, `扁平字段命中 ${anchors.join('/') || '无'}；spec.request ${nested ? '存在（需要改 flattenRequest）' : '0 命中'}；扫描 ${typed.map(([name]) => name).join(' + ')}`)
    }
  }

  // 4. Who registers `wait_agent` on this host. The plugin's control row takes
  //    over the host id `tool-subagent-control`, and only registers the tool
  //    when `ctx.tools.get('wait_agent')` is still empty — so this check does
  //    not need to decide safety, it only has to say where the tool lives.
  const installedDirs = existsSync(join(dir, 'node_modules', '@deepseek-ai'))
    ? readdirSync(join(dir, 'node_modules', '@deepseek-ai'))
    : []
  const skipSurface = /^(dsh-client-|dsh-cordis-client|dsh-api-|dsh-web-|dsh-experimental-client)/
  const providers = []
  for (const name of installedDirs) {
    if (skipSurface.test(name)) continue
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', name)
    for (const sub of ['src', 'lib']) {
      const root = join(pkgDir, sub)
      if (!existsSync(root) || !statSync(root).isDirectory()) continue
      for (const file of readdirSync(root, { recursive: true })) {
        if (!/\.(ts|js|mjs)$/.test(file)) continue
        if ((readText(join(root, file)) ?? '').includes('wait_agent')) {
          if (!providers.includes(name)) providers.push(name)
          break
        }
      }
      if (providers.includes(name)) break
    }
  }
  record(
    'wait-agent-providers',
    providers.length > 0 || installedDirs.length === 0,
    installedDirs.length === 0
      ? '宿主树里没有 @deepseek-ai 包'
      : providers.length > 0
        ? `wait_agent 由 ${providers.join('、')} 提供；本插件 control 行接管宿主 id tool-subagent-control，且仅在 ctx.tools.get('wait_agent') 为空时才注册`
        : '宿主里没有任何 wait_agent 实现，本插件 control 行成为唯一提供方（仍需真机加载确认）',
  )

  // 5. Every browser slot the plugin registers still appears in the host's
  //    client surface. Presence is textual — proving the *declaration shape*
  //    is the host's own test job (rc.2/rc.3 assert
  //    `slots.spec('sidebar.panellist') === { kind: 'list', scope: 'root' }`),
  //    and a trimmed host tree cannot answer the question at all, so such a
  //    tree is reported as skipped instead of failed.
  const uiRoot = join(dir, 'node_modules', '@deepseek-ai')
  const installed = existsSync(uiRoot) ? readdirSync(uiRoot) : []
  const completeTree = ['dsh-client-ui-renderer', 'dsh-client-ui-layout'].every(name => installed.includes(name))
  const clientBundles = installed
    .filter(name => name.startsWith('dsh-client-ui-') || name === 'dsh-cordis-client-runner')
    .map(name => [name, readText(join(uiRoot, name, 'lib', 'client.js'))])
    .filter(([, text]) => text !== undefined)
  const where = Object.fromEntries(
    REGISTERED_SLOTS.map(slot => [slot, clientBundles.filter(([, text]) => text.includes(slot)).map(([name]) => name)]),
  )
  const absent = REGISTERED_SLOTS.filter(slot => where[slot].length === 0)
  const slotDetail = REGISTERED_SLOTS.map(slot => {
    const list = where[slot]
    if (list.length === 0) return `${slot} → 无`
    return `${slot} → ${list.slice(0, 2).join('/')}${list.length > 2 ? ` 等 ${list.length} 个 bundle` : ''}`
  }).join('；')
  if (!completeTree) {
    record('registered-slots', true, `宿主树不完整（缺 renderer/layout，仅 ${clientBundles.length} 个 bundle），跳过：${slotDetail}`, true)
  } else {
    record('registered-slots', absent.length === 0, absent.length === 0 ? slotDetail : `未出现：${absent.join(', ')}（${slotDetail}）`)
  }

  // 6. The browser bundle must stay free of host runtime imports.
  const clientText = readText(join(pluginRoot, 'lib', 'client.js')) ?? ''
  const hostRefs = [...clientText.matchAll(/require\(['"](@deepseek-ai\/[^'"]+)['"]\)/g)].map(match => match[1])
  record(
    'client-bundle-self-contained',
    hostRefs.length === 0,
    hostRefs.length === 0 ? 'lib/client.js 无 @deepseek-ai 运行时依赖（唯一 require 为 react）' : `发现 ${[...new Set(hostRefs)].join(', ')}`,
  )

  const failed = checks.filter(check => !check.ok)
  const skipped = checks.filter(check => check.skipped)
  for (const check of checks) {
    const status = check.skipped ? 'SKIP' : check.ok ? 'PASS' : 'FAIL'
    console.log(`${status}  ${check.id.padEnd(28)} ${check.detail}`)
  }
  console.log(`\nhost: ${dir}`)
  console.log(`${checks.length - failed.length - skipped.length}/${checks.length - skipped.length} 项通过${skipped.length > 0 ? `（${skipped.length} 项跳过）` : ''}`)
  if (failed.length > 0) {
    console.log(`\n不兼容接缝：${failed.map(check => check.id).join(', ')}`)
    process.exit(1)
  }
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
