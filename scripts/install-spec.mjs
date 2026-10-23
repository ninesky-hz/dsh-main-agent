#!/usr/bin/env node
/**
 * install-spec — 把「从浏览器地址栏复制的仓库地址」规范成 pnpm 认得的安装 spec，
 * 并把 `ERR_PNPM_TARBALL_EXTRACT` 那类报错翻译成人话。
 *
 * 为什么需要它：pnpm 用 npm-package-arg 判定 spec 的类型，只有下面几种才算
 * **git 依赖**（走 git clone）：
 *   - 以 `.git` 结尾的 URL    https://gitee.com/n-sky/dsh-main-agent.git
 *   - `git+…` / `git:` 前缀    git+https://…、git+ssh://…
 *   - `github:` / `gitlab:` / `bitbucket:` / `gitea:` 简写
 *   - scp 形式                git@host:owner/repo
 * 其余任何 http(s) URL 都被当成 **远程 tarball**（type: remote），pnpm 直接 GET。
 * 而 gitee / github 的仓库页返回的是 HTML 或仓库说明文本，不是 tar 流，于是：
 *
 *   [ERR_PNPM_TARBALL_EXTRACT] Failed to add tarball from
 *     "https://gitee.com/n-sky/dsh-main-agent" to store:
 *     Invalid checksum for TAR header at offset 0. Expected NaN, got 47706
 *
 * 报错里的 URL **就是缺 `.git` 的那个**——这是唯一线索：`Expected NaN` 说明 tar
 * 解析器在偏移 0 拿到的不是 512 字节 tar 头（gitee 返回 200 text/plain，内容以
 * `# dsh-main-agent` 开头），pnpm 把它当包，就永远装不上。
 *
 * 用法：
 *   node scripts/install-spec.mjs https://gitee.com/n-sky/dsh-main-agent
 *     → https://gitee.com/n-sky/dsh-main-agent.git
 *   node scripts/install-spec.mjs --profile web https://gitee.com/n-sky/dsh-main-agent
 *     → dsh plugin --profile web add https://gitee.com/n-sky/dsh-main-agent.git
 *   node scripts/install-spec.mjs --diagnose pnpm.log
 *     → 从安装日志里认出这条错，并给出该用的 spec
 *   node scripts/install-spec.mjs --json <spec>
 *
 * 只做字符串规整，不联网、不执行 pnpm、不写任何文件。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-main-agent'
/** 官方安装地址 —— 永远带 `.git`，见文件头。 */
export const INSTALL_URL = 'https://gitee.com/n-sky/dsh-main-agent.git'

/** 这些 host 上「前两段路径」就是仓库本体，后面的 /tree/… /blob/… 都是页面噪声。 */
const REPO_HOSTS = new Set([
  'gitee.com',
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'git.sr.ht',
])

/** 已经是 tarball 的 spec：这些扩展名 pnpm 会走 remote 分支，是正确的。 */
const TARBALL_RE = /\.(?:tgz|tar\.gz|tar)$/i
/** 已经是别种依赖（含本地路径、workspace 别名）的 spec，一律不碰。 */
const OTHER_SCHEME_RE = /^(?:npm|jsr|workspace|link|portal|file):/i
/** 托管站简写：pnpm 直接当 git 依赖，和 `.git` 结尾的 URL 等价。 */
const HOST_SHORTHAND_RE = /^(?:github|gitlab|bitbucket|gitea):/i

/**
 * 判定一个 spec 会被 pnpm 当什么。
 * @returns {'git'|'tarball'|'local'|'alias'|'unknown'}
 */
export function classifyInstallSpec(input) {
  if (typeof input !== 'string') return 'unknown'
  const raw = input.trim()
  if (raw === '') return 'unknown'
  if (/^file:/i.test(raw)) return 'local'
  if (/^(?:git\+|git:|ssh:\/\/|git@)/i.test(raw)) return 'git'
  if (HOST_SHORTHAND_RE.test(raw)) return 'git'
  if (OTHER_SCHEME_RE.test(raw)) return 'alias'
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^[.~][\\/]/.test(raw) || raw.startsWith('/') || raw === '.' || raw === '..') return 'local'
  if (TARBALL_RE.test(raw.split(/[?#]/)[0])) return 'tarball'
  if (/^https?:\/\//i.test(raw)) {
    // 只有 `.git` 结尾的 http(s) URL 才会被 pnpm 当 git 依赖；其余一律是 remote tarball。
    const pathOnly = raw.split(/[?#]/)[0].replace(/\/+$/, '')
    return /\.git$/i.test(pathOnly) ? 'git' : 'git-url-missing-suffix'
  }
  return 'unknown'
}

/**
 * 规范化安装地址：截图/地址栏里那串 URL → pnpm 能当 git 依赖的 spec。
 * @returns {{ spec: string, kind: string, changed: boolean, note?: string }}
 */
export function normalizeInstallSpec(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('安装地址为空：需要仓库 URL、本地路径，或 file:<path>')
  }
  const raw = input.trim()
  const kind = classifyInstallSpec(raw)

  if (kind === 'local') {
    // 本地路径原样交给 pnpm；`file:` 前缀只有相对/绝对路径不带时才补。
    const spec = /^file:/i.test(raw) ? raw : `file:${raw}`
    return { spec, kind: 'local', changed: spec !== raw }
  }
  if (kind === 'alias' || kind === 'git') {
    // 已经是对的 git spec，只把 http(s) 尾部多余的 `/` 去掉（`….git/` 不是合法仓库地址）。
    const spec = /^https?:\/\//i.test(raw) ? raw.replace(/^(https?:\/\/[^?#]*?)\/+([?#].*)?$/i, '$1$2') : raw
    return { spec, kind, changed: spec !== raw }
  }
  if (kind === 'tarball') {
    return { spec: raw, kind: 'tarball', changed: false, note: '这是 tarball 地址，pnpm 会直接下载解包' }
  }
  if (kind !== 'git-url-missing-suffix') {
    return { spec: raw, kind: 'unknown', changed: false, note: '认不出这是仓库地址，也没有改动它' }
  }

  // 到这里一定是 http(s) 且会被 pnpm 误判成 tarball 的仓库地址。
  const parsed = new URL(raw)
  const repoPath = repoPathOf(parsed)
  const withSuffix = repoPath.endsWith('.git') ? repoPath : `${repoPath}.git`
  const spec = `${parsed.origin}${withSuffix}${parsed.search}${parsed.hash}`
  const note = spec === raw
    ? undefined
    : `补上 .git：pnpm 只有见到以 .git 结尾的 URL 才走 git 分支，否则当 tarball 下载（仓库页返回 HTML → ERR_PNPM_TARBALL_EXTRACT）`
  return { spec, kind: 'git', changed: spec !== raw, note }
}

/**
 * 已知 host 上截到前两段（owner/repo），丢掉 /tree/<branch>/<file> 之类的页面尾巴。
 * 未知 host 只去尾斜杠，不动路径结构。
 */
function repoPathOf(parsed) {
  const segments = parsed.pathname.split('/').filter(Boolean)
  let parts = segments
  if (REPO_HOSTS.has(parsed.hostname.toLowerCase())) {
    if (segments.length >= 2) parts = segments.slice(0, 2)
  }
  if (parts.length === 0) return parsed.pathname
  const joined = `/${parts.join('/')}`
  return joined
}

const TARBALL_HEADER_RE = /Invalid checksum for TAR header/i
const TARBALL_SOURCE_RE = /Failed to add tarball from\s+"([^"]+)"/i

/**
 * 从一段 pnpm 日志里认出「仓库地址被当成 tarball」这条错，并给出该用的 spec。
 * @returns {null | { code: string, url: string, suggestion: string, message: string }}
 */
export function diagnosePnpmLog(text) {
  if (typeof text !== 'string' || text === '') return null
  const isTarball = /ERR_PNPM_TARBALL_EXTRACT/.test(text) || TARBALL_HEADER_RE.test(text)
  if (!isTarball) return null
  const source = TARBALL_SOURCE_RE.exec(text)
  const url = source ? source[1].trim() : ''
  let suggestion = ''
  let message
  if (url === '') {
    message = 'pnpm 把某个依赖当成 tarball 下载并解包失败；请检查 package.json 里所有非 npm 依赖是否都以 .git 结尾。'
  } else {
    try {
      suggestion = normalizeInstallSpec(url).spec
    } catch {
      suggestion = ''
    }
    if (suggestion !== '' && suggestion !== url) {
      message = `pnpm 把 "${url}" 当成 tarball 下载了（该地址返回的是仓库页面，不是 tar 流）。改用 "${suggestion}"。`
    } else {
      message = `pnpm 把 "${url}" 当成 tarball 下载并解包失败。该地址需要指向真正的 .tgz/.tar.gz，或改写成以 .git 结尾的仓库地址。`
    }
  }
  return { code: 'ERR_PNPM_TARBALL_EXTRACT', url, suggestion, message }
}

/** 把 spec 包成一条可直接执行的安装命令。 */
export function installCommand(spec, { profile = 'web', cli = 'dsh' } = {}) {
  return `${cli} plugin --profile ${profile} add ${spec}`
}

const USAGE = `用法：
  node scripts/install-spec.mjs <仓库地址>                 规范化并打印 spec
  node scripts/install-spec.mjs --profile <name> <地址>    打印完整安装命令
  node scripts/install-spec.mjs --diagnose <日志文件|->     诊断 pnpm 安装日志
  node scripts/install-spec.mjs --json <地址>              输出 JSON

例：
  node scripts/install-spec.mjs https://gitee.com/n-sky/dsh-main-agent
  → https://gitee.com/n-sky/dsh-main-agent.git
`

function main(argv) {
  const args = argv.slice(2)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')

  const diagIndex = rest.indexOf('--diagnose')
  if (diagIndex !== -1) {
    const source = rest[diagIndex + 1]
    if (!source) {
      process.stderr.write('--diagnose 需要一个日志文件路径（或 - 表示 stdin）\n')
      return 2
    }
    const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
    const found = diagnosePnpmLog(text)
    if (!found) {
      process.stdout.write('没有在这段日志里找到 ERR_PNPM_TARBALL_EXTRACT。\n')
      return 1
    }
    process.stdout.write(json ? `${JSON.stringify(found, null, 2)}\n` : `${found.message}\n`)
    return 0
  }

  let profile = null
  const profileIndex = rest.indexOf('--profile')
  if (profileIndex !== -1) {
    profile = rest[profileIndex + 1]
    if (!profile) {
      process.stderr.write('--profile 需要一个 profile 名字\n')
      return 2
    }
    rest.splice(profileIndex, 2)
  }

  const input = rest[0]
  if (!input) {
    process.stderr.write(USAGE)
    return 2
  }
  const result = normalizeInstallSpec(input)
  if (json) {
    const payload = profile ? { ...result, command: installCommand(result.spec, { profile }) } : result
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  if (profile) {
    process.stdout.write(`${installCommand(result.spec, { profile })}\n`)
  } else {
    process.stdout.write(`${result.spec}\n`)
  }
  if (result.note) process.stderr.write(`# ${result.note}\n`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv)
}
