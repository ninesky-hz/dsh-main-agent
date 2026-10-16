/**
 * 随包 `main-agent` preset 里的每一行都必须指向宿主 DSH 运行时真正提供的
 * 包或子路径。
 *
 * 这些说明符是裸标识符，由启动期的运行时拦截解析，所以 DSH 里的一次改名或
 * 一次子路径删除不会响亮地失败：那一行只会被报告成
 *   `preset-main-agent (@deepseek-ai/dsh-agent-preset): failed to import`
 * （在 0.2.0-rc.2 上用一条故意的假行实测过 —— 启动照样继续）。
 * 于是 preset 静默地丢掉一项能力。本测试把这些行名钉在随包发布的 DSH 运行时
 * 上，行名直接从 `presets/main-agent.patch.yml`（`dsh.bundle.patch` 里的第二份
 * patch，声明 preset 的那一份）里读出来。
 *
 * 运行时归档按已发布的 `.asar` 索引格式读取
 * （u32@4 = 头部大小，u32@12 = JSON 长度，文件数据在 8 + headerSize +
 * entry.offset），因此这个检查除 Node 之外什么都不需要 —— 不要 Electron、
 * 不要 node_modules。运行时在别处时把 `DSH_APP_ASAR` 指向另一个归档；
 * 没有归档时本套件里依赖运行时的那一半显式 skip。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const PATCH = readFileSync(new URL('../presets/main-agent.patch.yml', import.meta.url), 'utf8')

/** `[id, name, text]` for every row that declares both, nested rows included. */
function declaredRows(text) {
  const lines = text.split('\n')
  const rows = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const id = /^(\s*)- id: (\S+)\s*$/.exec(lines[index])
    if (id === null) continue
    // A row's `name:` sits on the next line, at the `- ` indent or one deeper.
    const name = /^(\s*)name: (.+?)\s*$/.exec(lines[index + 1])
    if (name === null) continue
    if (name[1].length !== id[1].length && name[1].length !== id[1].length + 2) continue
    // The row's own text ends where the next row at the same (or a shallower) indent begins.
    const indent = id[1].length
    let end = index + 1
    while (end < lines.length) {
      const next = /^(\s*)- id: \S+\s*$/.exec(lines[end])
      if (next !== null && next[1].length <= indent) break
      end += 1
    }
    rows.push([
      id[2],
      name[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'),
      lines.slice(index, end).join('\n'),
    ])
  }
  return rows
}

const ROWS = declaredRows(PATCH)
/** Row names that are not loader builtins (`cordis:group`, `cordis:include`, …). */
const SPECIFIERS = ROWS.map(([, name]) => name).filter((name) => !name.startsWith('cordis:'))
const packageOf = (specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
const subpathOf = (specifier) => specifier.split('/').slice(specifier.startsWith('@') ? 2 : 1).join('/')

/**
 * A `disabled: true` 行不会在启动时挂载，因此也不会被解析 —— 它只是留作
 * 记载（本包那条 `workflow-worker-thread` 行就是这样：0.2.x 不发布该包，
 * 实测运行时归档里没有它）。所以运行时解析检查只覆盖真正会挂载的行；
 * 那些被关掉的行由上面第一条用例钉住「必须 disabled」。
 */
const ENABLED_SPECIFIERS = ROWS.filter(([, , text]) => !/^\s*disabled: true\s*$/m.test(text))
  .map(([, name]) => name)
  .filter((name) => !name.startsWith('cordis:'))
/** Specifiers that must come from the installed DSH runtime. */
const RUNTIME_SPECIFIERS = ENABLED_SPECIFIERS.filter((name) => packageOf(name) !== 'dsh-main-agent')
/** Specifiers that must come from this package itself (the profile symlinks it). */
const SELF_SPECIFIERS = SPECIFIERS.filter((name) => packageOf(name) === 'dsh-main-agent')
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function findArchive() {
  return [
    process.env.DSH_APP_ASAR,
    process.env.DSH_RUNTIME_ASAR,
    'D:/DeepSeek Harness/resources/app.asar',
  ].filter((candidate) => candidate !== undefined && existsSync(candidate))[0]
}

const ARCHIVE = findArchive()
const RUNTIME_SKIP =
  ARCHIVE === undefined
    ? 'no DSH runtime archive found; set DSH_APP_ASAR to check row resolution'
    : false

function openArchive(path) {
  const buffer = readFileSync(path)
  const headerSize = buffer.readUInt32LE(4)
  const jsonLength = buffer.readUInt32LE(12)
  return {
    buffer,
    index: JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8')),
    dataOffset: 8 + headerSize,
  }
}

const archive = RUNTIME_SKIP === false ? openArchive(ARCHIVE) : undefined
const RUNTIME_MODULES = ['dsh', 'node_modules', '@deepseek-ai']

/** The asar index entry for a path inside the archive, or undefined. */
function entryAt(parts) {
  let node = archive.index
  for (const part of parts) {
    node = node?.files?.[part]
    if (node === undefined) return undefined
  }
  return node
}

/** A packed file's text, or undefined when the path holds no file. */
function readPacked(parts) {
  const entry = entryAt(parts)
  if (entry === undefined || entry.size === undefined || entry.offset === undefined) return undefined
  const start = archive.dataOffset + Number(entry.offset)
  return archive.buffer.subarray(start, start + entry.size).toString('utf8')
}

const runtimePackages = new Map()
if (RUNTIME_SKIP === false) {
  const directory = entryAt(RUNTIME_MODULES)
  for (const name of Object.keys(directory?.files ?? {})) {
    // Keys inside the archive's `@deepseek-ai` directory are unscoped.
    runtimePackages.set(`@deepseek-ai/${name}`, [...RUNTIME_MODULES, name])
  }
}

/** Does `exports` (or the file tree) reach `./sub`? */
function resolvesSubpath(packageParts, subpath) {
  const manifest = readPacked([...packageParts, 'package.json'])
  if (manifest !== undefined) {
    const { exports } = JSON.parse(manifest)
    const wanted = `./${subpath}`
    if (typeof exports === 'string') return exports === wanted
    if (exports !== undefined && typeof exports === 'object') {
      for (const key of Object.keys(exports)) {
        if (key === wanted) return true
        if (key.includes('*') && new RegExp(`^${key.replaceAll('*', '.*')}$`).test(wanted)) return true
      }
      return false
    }
  }
  // No `exports` map: fall back to the file tree (extension optional).
  return (
    entryAt([...packageParts, ...subpath.split('/')]) !== undefined ||
    entryAt([...packageParts, ...subpath.split('/').slice(0, -1), `${subpath.split('/').at(-1)}.js`]) !==
      undefined
  )
}

test('声明行里的行名都是可解析的说明符，而不是遗留写法', () => {
  assert.ok(ROWS.length > 20, `expected a full composition, found ${ROWS.length} rows`)
  assert.ok(SPECIFIERS.length > 20, `expected a full composition, found ${SPECIFIERS.length} names`)
  assert.ok(
    ROWS.some(([id, name]) => id === 'preset-main-agent' && name === '@deepseek-ai/dsh-agent-preset'),
    'the bundle patch must declare the preset row itself',
  )
  assert.ok(
    ROWS.some(([id, name]) => id === 'persona' && name === '@deepseek-ai/dsh-persona'),
    'the preset must carry the persona row',
  )
  assert.ok(
    ROWS.some(([id, name]) => id === 'workflow-engine' && name === '@deepseek-ai/dsh-workflow-ptc'),
    'the delegation group must carry the workflow-ptc frontend',
  )
  // `@deepseek-ai/dsh-workflow-worker-thread` does not exist on 0.2.x, so the row
  // that still names it must stay switched off (a live row would break the preset).
  const workerThreadRows = ROWS.filter(([, name]) => name.includes('workflow-worker-thread'))
  assert.ok(workerThreadRows.length > 0, 'the worker-thread engine row must stay visible, switched off')
  for (const [id, , text] of workerThreadRows) {
    assert.match(text, /disabled: true/, `${id} 行必须 disabled: true`)
  }
})

test('every preset row resolves against the packaged DSH runtime', { skip: RUNTIME_SKIP }, () => {
  assert.ok(runtimePackages.size > 50, `expected a populated runtime, found ${runtimePackages.size}`)

  const unresolved = []
  for (const specifier of RUNTIME_SPECIFIERS) {
    const packageName = packageOf(specifier)
    const packageParts = runtimePackages.get(packageName)
    if (packageParts === undefined) {
      unresolved.push(`${specifier} (package ${packageName} is not in ${ARCHIVE})`)
      continue
    }
    const subpath = subpathOf(specifier)
    if (subpath !== '' && !resolvesSubpath(packageParts, subpath)) {
      unresolved.push(`${specifier} (${packageName} does not export ./${subpath})`)
    }
  }

  assert.deepEqual(unresolved, [], `rows the runtime cannot resolve:\n  ${unresolved.join('\n  ')}`)
})

test('the rows that import this package resolve through its own `exports`', () => {
  // These rows are what make the supervisor's frontends model-visible; a typo
  // in `exports` degrades them exactly like a missing runtime package.
  assert.ok(SELF_SPECIFIERS.length >= 3, `expected self-importing rows, found ${SELF_SPECIFIERS.length}`)

  const unresolved = []
  for (const specifier of SELF_SPECIFIERS) {
    const subpath = subpathOf(specifier)
    const key = subpath === '' ? '.' : `./${subpath}`
    const target = MANIFEST.exports?.[key]
    if (typeof target !== 'string') {
      unresolved.push(`${specifier} (package.json exports has no ${key})`)
      continue
    }
    if (!existsSync(new URL(`../${target}`, import.meta.url))) {
      unresolved.push(`${specifier} (exports ${key} → ${target} does not exist)`)
    }
  }

  assert.deepEqual(unresolved, [], `self-imports that do not resolve:\n  ${unresolved.join('\n  ')}`)
})

test('the runtime still provides the two packages the preset cannot do without', { skip: RUNTIME_SKIP }, () => {
  // Without the registry package there is no preset to pick; without persona
  // the preset mounts with no system prompt.
  assert.ok(
    runtimePackages.has('@deepseek-ai/dsh-agent-preset'),
    'the runtime must ship @deepseek-ai/dsh-agent-preset',
  )
  assert.ok(runtimePackages.has('@deepseek-ai/dsh-persona'), 'the runtime must ship @deepseek-ai/dsh-persona')
})
