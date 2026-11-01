/**
 * 守住 prompt 外置的两条底线（它们坏了 YAML 不会报错，只会让整段人格悄悄
 * 变成另一份文本，或者干脆消失）：
 *
 *  1. `prompts/*.md` 是源，`agent-presets/main-agent/agent.cordis.yml` 里的
 *     两个块标量是生成物 —— 两边必须**逐字节相等**。
 *  2. `scripts/sync-prompts.mjs` 只能动那两个块的正文：块标量记号（`|-` / `|`）
 *     与块外每一行都要原样保留，并且连跑两次字节不变。
 *
 * 再钉住「运行中的是哪一版 prompt」的可查性：revision 必须同时出现在
 * `presets/main-agent.patch.yml` 的文件头与 `prompts/CHANGELOG.md` 里。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  PROMPT_BLOCKS,
  applyBlock,
  extractBlock,
  formatRevision,
  normalizeMarkdown,
  revisionOf,
} from '../scripts/sync-prompts.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'sync-prompts.mjs')
const YAML_REL = join('agent-presets', 'main-agent', 'agent.cordis.yml')
const PATCH_REL = join('presets', 'main-agent.patch.yml')
const CHANGELOG_REL = join('prompts', 'CHANGELOG.md')
const STAMP_RE = /^# prompt-revision: main-agent=([0-9a-f]{8}) worker=([0-9a-f]{8})$/

const read = path => readFileSync(path, 'utf8')

/**
 * 造一个临时 fixture 根目录。
 *
 * 不能只信 `os.tmpdir()`：DSH 的沙箱可能把系统临时目录整个挡掉（本机实测
 * `EPERM ... mkdtemp 'C:\\Users\\…\\Temp\\…'`）。先试系统临时目录，被拒就退回
 * 工作区内的 `.test-tmp/`。
 */
function fixtureDir(prefix = 'prompts-') {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    const base = join(process.cwd(), '.test-tmp')
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, prefix))
  }
}

/** 复制真文件的「可写快照」：YAML + 两份 md + 生成物 patch。 */
function fixture() {
  const root = fixtureDir()
  for (const rel of [YAML_REL, PATCH_REL, ...PROMPT_BLOCKS.map(spec => spec.file)]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    cpSync(join(ROOT, rel), join(root, rel))
  }
  return root
}

const withFixture = body => {
  const root = fixture()
  try {
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const runSync = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })

test('YAML 里的两个块与 prompts/*.md 逐字节相等', () => {
  const yaml = read(join(ROOT, YAML_REL))
  for (const spec of PROMPT_BLOCKS) {
    const markdown = read(join(ROOT, spec.file))
    assert.equal(
      extractBlock(yaml, spec).content,
      markdown,
      `${spec.label} 与 ${spec.file} 不一致：两边已经漂移，跑 \`npm run sync-preset\` 对齐`,
    )
    assert.ok(markdown.endsWith('\n'), `${spec.file} 末尾必须有一个换行`)
    assert.ok(!markdown.endsWith('\n\n'), `${spec.file} 末尾只能有一个换行`)
    assert.equal(markdown.includes('\r'), false, `${spec.file} 必须用 LF`)
    assert.notEqual(markdown.codePointAt(0), 0xfeff, `${spec.file} 不能带 BOM`)
  }
})

test('块标量记号保持不变：prefix 仍是 |-，persona 仍是 |', () => {
  const lines = read(join(ROOT, YAML_REL)).split('\n')
  const expected = {
    'main-agent': '    prefix: |-',
    worker: '        persona: |',
  }
  for (const spec of PROMPT_BLOCKS) {
    const { headLine } = extractBlock(lines.join('\n'), spec)
    assert.equal(lines[headLine - 1], expected[spec.key], `${spec.label} 的块标量头被改写了`)
  }
})

test('写回是幂等的：连跑两次 YAML 一个字节都不变', () => {
  withFixture(root => {
    const before = read(join(ROOT, YAML_REL))
    const first = runSync(root)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(read(join(root, YAML_REL)), before, 'md 没改时 sync 不该动 YAML 一个字节')

    const second = runSync(root)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(read(join(root, YAML_REL)), before, '第二次 sync 仍然不该动 YAML')

    // 盖章同样幂等：patch 文件头与 CHANGELOG 都不该再长
    const patch = read(join(root, PATCH_REL))
    const changelog = read(join(root, CHANGELOG_REL))
    const third = runSync(root)
    assert.equal(third.status, 0, third.stderr)
    assert.equal(read(join(root, PATCH_REL)), patch, 'patch 文件头重复盖章了')
    assert.equal(read(join(root, CHANGELOG_REL)), changelog, '同一 revision 被重复记进 CHANGELOG')
    assert.equal(changelog.split('\n').filter(line => line.startsWith('- ')).length, 1)
  })
})

test('改 md 只写进块内：块外每一行原样保留（行级 diff 断言）', () => {
  withFixture(root => {
    const yamlPath = join(root, YAML_REL)
    const before = read(yamlPath)
    const beforeLines = before.split('\n')

    const spec = PROMPT_BLOCKS[0]
    const mdPath = join(root, spec.file)
    const original = read(mdPath)
    const target = 'PERSISTENCE（持久推进：可恢复的分支不是阻塞项）：'
    assert.ok(original.includes(target), '  fixture 断言依赖的行不见了，改这行测试')
    const edited = normalizeMarkdown(
      `${original.replace(target, 'PERSISTENCE（fixture 改写过）：')}- 这是一个只存在于 fixture 里的锚点行 MARKER-FIXTURE-ONLY\n`,
    )
    writeFileSync(mdPath, edited, 'utf8')

    const result = runSync(root)
    assert.equal(result.status, 0, result.stderr)
    const afterLines = read(yamlPath).split('\n')
    const after = afterLines.join('\n')

    const beforeBlock = extractBlock(before, spec)
    const afterBlock = extractBlock(after, spec)

    // 只有第一块变长了一行：块前、块后都必须逐行相同。
    assert.equal(afterBlock.lastLine - afterBlock.firstLine, beforeBlock.lastLine - beforeBlock.firstLine + 1)
    assert.deepEqual(
      afterLines.slice(0, beforeBlock.firstLine - 1),
      beforeLines.slice(0, beforeBlock.firstLine - 1),
      '块之前的行被动了',
    )
    assert.deepEqual(
      afterLines.slice(afterBlock.lastLine),
      beforeLines.slice(beforeBlock.lastLine),
      '块之后的行被动了',
    )

    // 改动确实写进了 YAML，并且按块缩进重新缩进。
    assert.ok(afterBlock.content.includes('MARKER-FIXTURE-ONLY'), '新行没有写进 YAML')
    assert.ok(after.includes(`\n${' '.repeat(afterBlock.indent)}- 这是一个只存在于 fixture 里的锚点行 MARKER-FIXTURE-ONLY\n`))
    assert.ok(afterBlock.content.includes('（fixture 改写过）'), '对已有行的修改没有写进 YAML')
    assert.equal(afterBlock.content, edited, '写回后应当与 md 逐字节相等')

    // 第二块（worker）也因为行号位移而保持内容不变。
    const worker = PROMPT_BLOCKS[1]
    assert.equal(extractBlock(after, worker).content, extractBlock(before, worker).content, 'worker 块被牵连了')
  })
})

test('md 缺失时非 0 退出并说明原因，而不是静默跳过', () => {
  withFixture(root => {
    rmSync(join(root, PROMPT_BLOCKS[1].file))
    const result = runSync(root)
    assert.notEqual(result.status, 0, 'md 缺失时必须以非 0 退出')
    assert.match(result.stderr, /缺少 prompt 源文件/)
    assert.match(result.stderr, /worker\.md/)
    // 拒绝写入：YAML 必须原样留着，不能变成「少了一段人格」。
    assert.equal(read(join(root, YAML_REL)), read(join(ROOT, YAML_REL)))
  })
})

test('关键锚点还在：误删整段应当被抓住', () => {
  const main = read(join(ROOT, 'prompts', 'main-agent.md'))
  for (const anchor of [
    '你是 Main Agent',
    '{{model}}',
    'GROUNDING',
    'PERSISTENCE',
    'STATE',
    'THE LOOP',
    // `report:` 头行协议本身只写在 worker.md（`<!-- report: <state> -->`）里；
    // 主人格这边引用的是「stage 与 report 六态」，所以这里钉住的是这处引用。
    'report 六态',
    'outcome.md',
  ]) {
    assert.ok(main.includes(anchor), `main-agent.md 丢了锚点「${anchor}」`)
  }

  const worker = read(join(ROOT, 'prompts', 'worker.md'))
  for (const anchor of [
    'Dev Agent',
    'report 工具',
    'outcome.md',
    '<!-- report: <state> -->',
    '<!-- question: <一句话的具体问题> -->',
    'progress',
    'blocked',
    'dropped',
  ]) {
    assert.ok(worker.includes(anchor), `worker.md 丢了锚点「${anchor}」`)
  }
})

test('生成物文件头带 prompt-revision，且与两份 md 的 sha256 前 8 位一致', () => {
  const head = read(join(ROOT, PATCH_REL)).split('\n')[0]
  const match = STAMP_RE.exec(head)
  assert.ok(match, `presets/main-agent.patch.yml 文件头应当形如 "# prompt-revision: main-agent=ab12cd34 worker=ef56gh78"，实际是 ${JSON.stringify(head)}`)

  const revisions = {}
  for (const spec of PROMPT_BLOCKS) revisions[spec.key] = revisionOf(readFileSync(join(ROOT, spec.file)))
  assert.equal(match[1], revisions['main-agent'], 'main-agent 的 revision 与 md 当前的 sha256 不符')
  assert.equal(match[2], revisions.worker, 'worker 的 revision 与 md 当前的 sha256 不符')

  const changelog = read(join(ROOT, CHANGELOG_REL))
  assert.ok(
    changelog.includes(formatRevision(revisions)),
    'prompts/CHANGELOG.md 里没有当前 revision —— 忘了跑 `npm run sync-preset`？',
  )
})

test('stamp 模式只盖章：不碰 YAML，且引用的是 md 的真实 revision', () => {
  withFixture(root => {
    const yaml = read(join(root, YAML_REL))
    writeFileSync(join(root, PATCH_REL), '# 别的内容\n- insert: []\n', 'utf8')
    const result = runSync(root, '--stamp')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(read(join(root, YAML_REL)), yaml, '--stamp 不应该碰 YAML')

    const revisions = {}
    for (const spec of PROMPT_BLOCKS) revisions[spec.key] = revisionOf(readFileSync(join(root, spec.file)))
    assert.equal(read(join(root, PATCH_REL)).split('\n')[0], `# prompt-revision: ${formatRevision(revisions)}`)
    // 原有内容一行不丢，只是被顶到注释下面。
    assert.equal(read(join(root, PATCH_REL)).split('\n')[1], '# 别的内容')
  })
})

test('applyBlock 对同一份 md 反复应用是纯函数', () => {
  const yaml = read(join(ROOT, YAML_REL))
  for (const spec of PROMPT_BLOCKS) {
    const markdown = read(join(ROOT, spec.file))
    const once = applyBlock(yaml, spec, markdown)
    const twice = applyBlock(once, spec, markdown)
    assert.equal(once, yaml, `${spec.label}：与原文件不同，说明缩进规则和块缩进对不上`)
    assert.equal(twice, once)
  }
})

test('sync-prompts.mjs 与 CHANGELOG 都在包里（发布时不丢源）', () => {
  const manifest = JSON.parse(read(join(ROOT, 'package.json')))
  assert.match(manifest.scripts['sync-preset'], /^node scripts\/sync-prompts\.mjs && node scripts\/sync-preset-patch\.mjs && node scripts\/sync-prompts\.mjs --stamp$/)
  assert.ok(existsSync(join(ROOT, CHANGELOG_REL)), 'CHANGELOG 是版本可查的一半，必须存在')
  for (const spec of PROMPT_BLOCKS) assert.ok(existsSync(join(ROOT, spec.file)))
  // `files` 里漏一项，发布出去的包里就没有 prompt 源 —— 装到用户机器上时
  // `npm run sync-preset` 会直接失败，而 npm 不会因此报错。
  for (const entry of ['prompts', 'scripts', 'agent-presets']) {
    assert.ok(manifest.files.includes(entry), `package.json 的 files 缺少 "${entry}"，发布时会丢源`)
  }
})

test('生成物里 prompt 文本一个字都没少，也没有多出转义', () => {
  const yaml = read(join(ROOT, YAML_REL))
  const patch = read(join(ROOT, PATCH_REL))
  const patchLines = new Set(patch.split('\n'))

  for (const spec of PROMPT_BLOCKS) {
    const lines = yaml.split('\n')
    const { firstLine, lastLine } = extractBlock(yaml, spec)
    // `sync-preset-patch.mjs` 把 preset 里每行非空行整体再缩进 10 空格。
    const present = lines.slice(firstLine - 1, lastLine).filter(line => line.trim() !== '')
    const missing = present.filter(line => !patchLines.has(`          ${line}`))
    assert.equal(
      missing.length,
      0,
      `${spec.label}：${missing.length}/${present.length} 行没有原样出现在 ${PATCH_REL}，` +
        `第一行缺失样例 = ${JSON.stringify(missing[0])}`,
    )
  }

  // YAML 块标量是 literal，正文里的反斜杠不需要转义；一旦在 patch 里看到
  // `\n` / `\uXXXX` / `\"` 这种序列，说明有人把 prompt 当 JSON 字符串穿了车，
  // 装到用户机器上会原样显示反斜杠。
  for (const escape of ['\\n', '\\u', '\\"', '\\\\']) {
    assert.equal(patch.includes(escape), false, `${PATCH_REL} 里出现了转义序列 ${JSON.stringify(escape)}`)
  }
})

test('CHANGELOG 只留当前 revision 一行，仓库根不留临时脚本', () => {
  const revisions = {}
  for (const spec of PROMPT_BLOCKS) revisions[spec.key] = revisionOf(readFileSync(join(ROOT, spec.file)))
  const entries = read(join(ROOT, CHANGELOG_REL))
    .split('\n')
    .filter(line => line.startsWith('- '))
  assert.equal(entries.length, 1, `CHANGELOG 应该只有当前 revision 一行，实际 ${entries.length} 行`)
  assert.ok(entries[0].endsWith(formatRevision(revisions)), `CHANGELOG 最后一行不是当前 revision：${entries[0]}`)
  assert.match(entries[0], /^- \d{4}-\d{2}-\d{2}T\S+ main-agent=[0-9a-f]{8} worker=[0-9a-f]{8}$/)

  // 任务书要求临时/探测脚本只放在 `.test-tmp/`，别在仓库根留下 try-*.mjs。
  const stray = readdirSync(ROOT).filter(name => /^(try|probe|tmp)[-_].*\.mjs$/.test(name))
  assert.equal(stray.length, 0, `仓库根有临时脚本残留：${stray.join(', ')}`)
})
