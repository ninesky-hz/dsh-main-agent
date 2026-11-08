/**
 * 占位符契约：md 里的 `{{name}}` 必须在生成物里一个不少、一个不多。
 *
 * 为什么值得一条独立测试：宿主在 prompt 装配时才替换占位符，也就是**在**这条生成
 * 链的下游。生成链一旦把 `{{model}}` 吃掉（少一个 `}`、被当成模板渲染、被转义成
 * `\{\{model\}\}`），跑起来不会有任何报错 —— 顶上那句话要么显示成一个字面量
 * `{{model}}`，要么整个模型名变空，而测试全绿。这类故障只有「源里有几个、生成物
 * 里也必须同样几个」能抓。
 *
 * 与 `tests/prompts.test.mjs` 的分工：那边钉的是「md 与 YAML 块标量逐字节相等」
 * （写回正确性）；这边钉的是「占位符这个**语义**没在往返里丢」（契约），以及对
 * `presets/main-agent.patch.yml` 这个**下游产物**的核对（真正被装进宿主的那个文件）。
 *
 * 校验对象刻意是**块标量正文**，不是整份 patch：patch 第 39 行附近有一句注释写着
 * `{{cwd}}`（用来说明「别把装配变量当 model 用」），扫整份文件会把它读成一个凭空
 * 多出来的占位符。最后一条 test 把这件事本身钉住，免得后来人「顺手」改成全文件扫。
 */

import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  extractBlock,
  placeholdersOf,
  placeholderDrift,
  syncPrompts,
} from '../scripts/sync-prompts.mjs'

const ROOT = process.cwd()
const PATCH = join(ROOT, 'presets', 'main-agent.patch.yml')
const YAML_REL = join('agent-presets', 'main-agent', 'agent.cordis.yml')

/** 生成物（patch）里的块标量头被 `sync-preset-patch` 前置了 10 个空格，所以锚点只能 trim 后比。 */
const GENERATED_BLOCKS = [
  { key: 'main-agent', file: join('prompts', 'main-agent.md'), anchor: /^\s*prefix: \|-\s*$/, label: '主 Agent 人格' },
  { key: 'worker', file: join('prompts', 'worker.md'), anchor: /^\s*persona: \|\s*$/, label: 'worker 人格' },
]

const read = path => readFileSync(path, 'utf8')

/** 一次拷出运行 `syncPrompts` 所需的最小 fixture（系统临时目录被拒时退回仓库内）。 */
function fixture() {
  let root
  try {
    root = mkdtempSync(join(tmpdir(), 'prompt-contract-'))
  } catch {
    root = mkdtempSync(join(process.cwd(), '.test-tmp', 'prompt-contract-'))
  }
  for (const rel of [YAML_REL, join('presets', 'main-agent.patch.yml'), ...GENERATED_BLOCKS.map(spec => spec.file)]) {
    const target = join(root, rel)
    cpSync(join(ROOT, rel), target, { recursive: true })
  }
  return root
}

test('placeholdersOf: 抓名字、去重、稳定排序', () => {
  assert.deepEqual(placeholdersOf('你是 Main Agent：一个由 {{model}} 驱动的常驻监督者。'), ['model'])
  assert.deepEqual(placeholdersOf('{{zulu}} {{alpha}} {{mike}} {{alpha}}'), ['alpha', 'mike', 'zulu'])
  assert.deepEqual(placeholdersOf('{{a.b-c_d2}}'), ['a.b-c_d2'], '名字允许点、横线、下划线、数字')
  assert.deepEqual(placeholdersOf('没有占位符的一段话'), [])
  assert.deepEqual(placeholdersOf(''), [])
  assert.deepEqual(placeholdersOf(null), [])

  // 带空格的 `{{ model }}` 不算占位符：宿主到底认不认这种写法没有契约，
  // 所以这里宁可漏抓，也不要把「像占位符但不是」的东西放进核对口径。
  assert.deepEqual(placeholdersOf('{{ model }} {{}}'), [])
})

test('placeholderDrift: missing / extra / 相等 三态', () => {
  assert.deepEqual(placeholderDrift('由 {{model}} 驱动', '由 {{model}} 驱动'), { missing: [], extra: [] })
  assert.deepEqual(placeholderDrift('由 {{model}} 驱动', '由 驱动'), { missing: ['model'], extra: [] })
  assert.deepEqual(placeholderDrift('由 驱动', '由 {{model}} 驱动'), { missing: [], extra: ['model'] })
  assert.deepEqual(placeholderDrift('{{beta}} {{alpha}} 在前', '{{zulu}} 在后'), {
    missing: ['alpha', 'beta'],
    extra: ['zulu'],
  })
  // 两边都排序，报错信息才稳定，不随文档里出现的先后顺序抖动。
  assert.deepEqual(placeholderDrift('{{b}} {{a}}', ''), { missing: ['a', 'b'], extra: [] })
})

test('patch: 每份 md 的占位符集合与对应块标量正文相等', () => {
  const patch = read(PATCH)
  for (const spec of GENERATED_BLOCKS) {
    const markdown = read(join(ROOT, spec.file))
    const generated = extractBlock(patch, spec).content
    assert.deepEqual(
      placeholdersOf(generated),
      placeholdersOf(markdown),
      `${spec.label}：(${spec.file}) 的占位符与 ${'presets/main-agent.patch.yml'} 里的不一致`,
    )
    const drift = placeholderDrift(markdown, generated)
    assert.deepEqual(drift, { missing: [], extra: [] }, `${spec.label} 占位符漂移：${JSON.stringify(drift)}`)
  }
})

test('patch: {{model}} 至少活着一次（没被吃掉、没被转义、没被拆开）', () => {
  const generated = extractBlock(read(PATCH), GENERATED_BLOCKS[0]).content
  const occurrences = generated.split('{{model}}').length - 1
  assert.ok(occurrences >= 1, 'patch 的主 Agent 人格里已经找不到 {{model}} —— 宿主拿到的是一个死占位符')
  assert.equal(placeholdersOf(generated).includes('model'), true)
  for (const escape of ['\\{\\{', '{{ model }}', '{{model} }', '{ {model}}']) {
    assert.equal(generated.includes(escape), false, `patch 里出现了被转义/拆开的占位符：${escape}`)
  }
})

test('patch: 五段结构锚点仍在（占位符之外的骨架也没丢）', () => {
  const generated = extractBlock(read(PATCH), GENERATED_BLOCKS[0]).content
  for (const anchor of ['GROUNDING（', 'PERSISTENCE（', 'STATE（', 'THE LOOP（', 'QUESTIONS（']) {
    assert.ok(generated.includes(anchor), `patch 里缺结构锚点 ${anchor}`)
  }

  const worker = extractBlock(read(PATCH), GENERATED_BLOCKS[1]).content
  assert.ok(worker.includes('Dev Agent'), 'worker 人格的锚点也丢了')
})

test('整份 patch 扫占位符会误报：{{cwd}} 只活在注释里，不在块标量正文里', () => {
  const patch = read(PATCH)
  // 这条断言是给「校验对象为什么是块标量正文」留的物证：注释里的装配变量
  // 不是占位符，把它算进来就会让守卫每次都对着一句注释报错。
  assert.ok(patch.includes('{{cwd}}'), '注释里的 {{cwd}} 不见了，这条测试的前提变了')
  assert.deepEqual(placeholdersOf(patch), ['cwd', 'model'])
  for (const spec of GENERATED_BLOCKS) {
    assert.equal(placeholdersOf(extractBlock(patch, spec).content).includes('cwd'), false)
  }
})

test('写盘前的占位符守卫不会误报：真跑一次 sync，占位符原样落进 YAML', () => {
  const root = fixture()
  const before = read(join(root, YAML_REL))
  const result = syncPrompts({ root, log: () => {} })
  const after = read(join(root, YAML_REL))

  assert.deepEqual(result.revisions !== undefined, true)
  // fixture 是从仓库原样拷的，所以这一跑必须**判定为已是最新**：一旦它开始改写，
  // 说明仓库里的 YAML 已经和 md 不同步了，那是另一条测试（prompts.test.mjs）的事。
  assert.equal(after, before, '仓库里的 agent.cordis.yml 与 prompts/*.md 已经不同步')
  for (const spec of GENERATED_BLOCKS) {
    assert.deepEqual(placeholdersOf(extractBlock(after, spec).content), placeholdersOf(read(join(root, spec.file))))
  }
})
