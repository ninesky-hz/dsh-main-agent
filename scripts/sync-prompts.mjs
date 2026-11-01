#!/usr/bin/env node
/**
 * 把两段长 prompt（主 Agent 人格 / worker 人格）从 34 KB 的
 * `agent-presets/main-agent/agent.cordis.yml` 里外置成独立 Markdown，并让
 * 「当前运行的是哪一版 prompt」可以被 grep 出来。
 *
 * 为什么外置：原型 `_ext/superagent-proto/docs/004-prompts.md` 的做法是 prompt
 * 按 key 分层、带 revision、有更新记录。混在 YAML 里的 300 行块标量既没法
 * diff 也没法审阅 —— 一次缩进失误就等于整段人格静默消失，而 YAML 不会报错。
 *
 * 三件事：
 *   1. 源 → 单向（md 是源，YAML 是生成物）：`prompts/main-agent.md`、
 *      `prompts/worker.md` 的正文写回对应块标量，按块缩进重新缩进；
 *      块标量记号（`|-` / `|`）与块外每一行都保持原样，重复执行字节不变。
 *   2. revision：两份 md 的 sha256 前 8 位，形式
 *      `main-agent=ab12cd34 worker=ef56gh78`。
 *   3. 版本可查：revision 写进 `presets/main-agent.patch.yml` 的文件头注释
 *      （`# prompt-revision: ...`），并追加一行到 `prompts/CHANGELOG.md`
 *      （同一 revision 不重复追加）。
 *
 * 为什么 `npm run sync-preset` 里它出现两次：
 *   `presets/main-agent.patch.yml` 由 `scripts/sync-preset-patch.mjs` 整份重写，
 *   所以 patch 必须由**已经写入新 prompt** 的 agent.cordis.yml 生成，而
 *   revision 只能在生成之后才盖得住。于是链路是
 *   `sync-prompts`（写 YAML）→ `sync-preset-patch`（生成 patch）→
 *   `sync-prompts --stamp`（只盖章，不碰 YAML）。`--stamp` 单独跑也是幂等的。
 *
 * 用法：
 *   node scripts/sync-prompts.mjs                 # 写 YAML + 盖章 + 记 CHANGELOG
 *   node scripts/sync-prompts.mjs --stamp         # 只盖章 + 记 CHANGELOG
 *   node scripts/sync-prompts.mjs --root <dir>    # 换根目录（测试用 fixture）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(HERE, '..')

const YAML_REL = join('agent-presets', 'main-agent', 'agent.cordis.yml')
const PATCH_REL = join('presets', 'main-agent.patch.yml')
const CHANGELOG_REL = join('prompts', 'CHANGELOG.md')

/**
 * 两块 prompt。`anchor` 必须在该 YAML 里**恰好出现一次** —— 定位不到或撞车
 * 都直接抛错，绝不在错误的位置写 300 行文本。
 */
export const PROMPT_BLOCKS = [
  {
    key: 'main-agent',
    file: join('prompts', 'main-agent.md'),
    anchor: /^ {4}prefix: \|-$/,
    label: '主 Agent 人格（persona.prefix）',
  },
  {
    key: 'worker',
    file: join('prompts', 'worker.md'),
    anchor: /^ {8}persona: \|$/,
    label: 'worker 人格（tool-subagent.persona）',
  },
]

const indentOf = (line) => /^ */.exec(line)[0].length
const isBlank = (line) => line.trim() === ''

/** 把 Markdown 文本规范成「LF + 恰好一个结尾换行」。 */
export function normalizeMarkdown(text) {
  const withoutBom = text.replace(/^\uFEFF/, '')
  const lf = withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return lf.replace(/\n+$/, '') + '\n'
}

/** 找到块标量头那一行（0-based），要求恰好一处。 */
function findAnchor(lines, spec) {
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    if (spec.anchor.test(lines[index])) hits.push(index)
  }
  if (hits.length !== 1) {
    throw new Error(
      `${spec.label}: 期望恰好一处块标量头（${spec.anchor}），实际 ${hits.length} 处 —— 拒绝写入`,
    )
  }
  return hits[0]
}

/**
 * 从 YAML 文本里剥出一段块标量的正文（去掉块缩进，空行保持空行）。
 *
 * 返回 `{ content, headLine, firstLine, lastLine, indent }`：
 *  - `content` 带结尾换行，与对应 md 逐字节应当相等；
 *  - 行号全部是 **1-based 文件行号**，方便报错时能直接定位。
 */
export function extractBlock(text, spec) {
  const lines = text.split('\n')
  const head = findAnchor(lines, spec)
  let indent = null
  for (let index = head + 1; index < lines.length; index += 1) {
    if (isBlank(lines[index])) continue
    indent = indentOf(lines[index])
    break
  }
  if (indent === null) throw new Error(`${spec.label}: 块标量头下面没有正文`)

  let last = head
  for (let index = head + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (isBlank(line)) continue
    if (indentOf(line) < indent) break
    last = index
  }
  if (last === head) throw new Error(`${spec.label}: 块标量正文解析为空`)

  const body = lines.slice(head + 1, last + 1).map((line) => (isBlank(line) ? '' : line.slice(indent)))
  return {
    content: body.join('\n') + '\n',
    headLine: head + 1,
    firstLine: head + 2,
    lastLine: last + 1,
    indent,
  }
}

/**
 * 把 md 正文写回对应块标量，返回新的 YAML 文本。
 * 块外每一行按原字节保留（含结尾空行），只替换正文那一段。
 */
export function applyBlock(text, spec, markdown) {
  const lines = text.split('\n')
  const { firstLine, lastLine, indent } = extractBlock(text, spec)
  const body = normalizeMarkdown(markdown).replace(/\n$/, '').split('\n')
  const rendered = body.map((line) => (line === '' ? '' : ' '.repeat(indent) + line))
  const next = [
    ...lines.slice(0, firstLine - 1),
    ...rendered,
    ...lines.slice(lastLine),
  ].join('\n')
  return next
}

/** `ab12cd34` —— 8 位十六进制，够 grep，也不至于把注释撑长。 */
export function revisionOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 8)
}

/** `main-agent=ab12cd34 worker=ef56gh78` */
export function formatRevision(revisions) {
  return PROMPT_BLOCKS.map((spec) => `${spec.key}=${revisions[spec.key]}`).join(' ')
}

/** patch 文件头的那一行。 */
export function revisionComment(revisions) {
  return `# prompt-revision: ${formatRevision(revisions)}`
}

/**
 * 把 revision 注释盖进 patch 文件头：已有就替换，没有就插到第一行。
 * 内容没变时不写盘（保持字节与 mtime 都不动）。
 */
export function stampPatch(root, revisions) {
  const path = join(root, PATCH_REL)
  if (!existsSync(path)) return { path, changed: false, missing: true }
  const text = readFileSync(path, 'utf8')
  const comment = revisionComment(revisions)
  const lines = text.split('\n')
  if (/^# prompt-revision: /.test(lines[0])) {
    if (lines[0] === comment) return { path, changed: false }
    lines[0] = comment
  } else {
    lines.unshift(comment)
  }
  writeFileSync(path, lines.join('\n'), 'utf8')
  return { path, changed: true }
}

const CHANGELOG_HEADER = `# Prompt 版本记录

由 \`npm run sync-preset\` 自动追加。每行是一次 prompt 版本 —— 两份 md 的
sha256 前 8 位；同一版本不会重复追加。运行中的是哪一版，用这里的值去
\`presets/main-agent.patch.yml\` 的文件头 \`# prompt-revision:\` 一行 grep。

`

/**
 * 追加 CHANGELOG 一行。同一 revision（两项都对得上）已经记过就不再追加 ——
 * 否则每次 sync 都会多一行噪音，CHANGELOG 也就没法当「发版记录」看了。
 */
export function appendChangelog(root, revisions, now = () => new Date()) {
  const path = join(root, CHANGELOG_REL)
  const stamp = formatRevision(revisions)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : CHANGELOG_HEADER
  const seen = existing
    .split('\n')
    .some((line) => line.startsWith('- ') && line.includes(stamp))
  if (seen) return { path, appended: false }
  const body = existing.endsWith('\n') ? existing : `${existing}\n`
  const line = `- ${now().toISOString()} ${stamp}\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body + line, 'utf8')
  return { path, appended: true }
}

/** 读两份 md 原文；缺一份就返回缺失路径（由调用方决定退出码）。 */
export function readPromptSources(root) {
  const missing = []
  const sources = []
  for (const spec of PROMPT_BLOCKS) {
    const path = join(root, spec.file)
    if (!existsSync(path)) {
      missing.push(path)
      continue
    }
    sources.push({ spec, path, buffer: readFileSync(path) })
  }
  return { sources, missing }
}

/**
 * 主流程。`stampOnly` 为真时按名字只盖章，不碰 YAML。
 * 抛错即代表本次同步不可信 —— 调用方应当以非 0 退出。
 */
export function syncPrompts({ root = DEFAULT_ROOT, stampOnly = false, log = () => {} } = {}) {
  const { sources, missing } = readPromptSources(root)
  if (missing.length > 0) {
    const inside = missing.map((path) => `  - ${path}`).join('\n')
    throw new Error(
      `缺少 prompt 源文件（md 是源，YAML 是生成物，不能反过来抽）：\n${inside}\n` +
        '先补齐这些 md（内容 = YAML 里对应块去掉块缩进后的正文），再重跑本脚本。',
    )
  }
  const revisions = {}
  for (const { spec, buffer } of sources) revisions[spec.key] = revisionOf(buffer)

  const yamlPath = join(root, YAML_REL)
  const results = []
  if (!stampOnly) {
    const original = readFileSync(yamlPath, 'utf8')
    let next = original
    for (const { spec } of sources) {
      const markdown = readFileSync(join(root, spec.file), 'utf8')
      next = applyBlock(next, spec, markdown)
    }
    if (next !== original) writeFileSync(yamlPath, next, 'utf8')
    // 写完立刻回调校验：抽取 → 与 md 逐字节相等，否则整段人格已经不再是
    // 人写的那份，静默失败比报错贵得多。
    for (const { spec } of sources) {
      const markdown = normalizeMarkdown(readFileSync(join(root, spec.file), 'utf8'))
      const extracted = extractBlock(readFileSync(yamlPath, 'utf8'), spec).content
      if (extracted !== markdown) {
        throw new Error(`${spec.label}: 写回后与 ${spec.file} 不逐字节相等 —— 已中止`)
      }
      results.push({ key: spec.key, changed: next !== original })
    }
    log(
      next === original
        ? `sync-prompts: ${YAML_REL} 已是最新（未改动）`
        : `sync-prompts: 已用 ${sources.length} 份 md 更新 ${YAML_REL}`,
    )
  }

  const patch = stampPatch(root, revisions)
  const changelog = appendChangelog(root, revisions)
  log(`${patch.changed ? 'sync-prompts: 已写入' : 'sync-prompts: 已是'} ${PATCH_REL} 文件头 ${revisionComment(revisions)}`)
  if (patch.missing) log(`sync-prompts: ${PATCH_REL} 还不存在（先跑 sync-preset-patch，再用 --stamp 盖章）`)
  log(`sync-prompts: ${CHANGELOG_REL} ${changelog.appended ? '已追加一行' : '无新版本，未追加'}`)

  return { root, yamlPath, results, revisions, patch, changelog }
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, stampOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--stamp') options.stampOnly = true
    else if (arg === '--root') options.root = resolve(argv[++index] ?? '')
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`sync-prompts: ${error.message}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write('用法：node scripts/sync-prompts.mjs [--stamp] [--root <dir>]\n')
    return
  }
  try {
    syncPrompts({ ...options, log: (line) => process.stdout.write(`${line}\n`) })
  } catch (error) {
    process.stderr.write(`sync-prompts: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main()
