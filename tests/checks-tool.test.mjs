/**
 * `check_outcome` 的工具壳覆盖 —— 不测 `checks.js` 的纯逻辑（那在
 * `tests/checks.test.mjs`），只测 `execute()` 的返回值是否满足 dsh-tools 的
 * 输出契约。
 *
 * 历史坑：`execute()` 曾经把逐条明细塞进一个叫 `render` 的字段，而 `render`
 * 不在 `output.schema` 里。dsh-tools 对声明了 `additionalProperties: false`
 * 的返回值做严格校验，于是 **每一次** check_outcome 调用都以
 *   tool "check_outcome" returned invalid output:
 *   "value.render" is not a declared property (additionalProperties: false)
 * 结束 —— 纯逻辑测试全绿，真实会话里却一次都没成功过。所以这里直接拿
 * schema 校验返回值，让同一类错误在 CI 里就断掉。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/checks-tool.js')

/** 拿一个注册好的工具定义（`defineTool` 在 stub 里是恒等函数）。 */
function tool() {
  const registered = []
  apply({ tools: { register: definition => registered.push(definition) } })
  assert.equal(registered.length, 1, 'check_outcome 必须只注册一次')
  return registered[0]
}

const withWorkspace = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-checks-tool-'))
  try {
    return await fn(dir)
  } finally {
    // 刚跑完的命令可能还占着 cwd，Windows 上重试几次再放弃。
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const exec = cwd => ({ agent: { session: { header: { cwd } } }, signal: undefined })

/**
 * dsh-tools 的实际契约：返回值里出现未声明字段，整个结果被拒收；
 * 声明了 `required: true` 的字段必须出现。
 *
 * 嵌套一层也要查：`expects` 这种对象字段自己也是 `additionalProperties: false`，
 * 往里塞一个未声明的键，同样会让整次调用被拒收 —— 历史坑的同一个形状。
 */
function assertSchemaConformant(definition, value) {
  const { schema } = definition.output
  assert.equal(schema.additionalProperties, false, 'schema 必须是严格模式')
  const declared = Object.keys(schema.properties)
  const extra = Object.keys(value).filter(key => !declared.includes(key))
  assert.deepEqual(extra, [], `返回值出现了 schema 未声明的字段：${extra.join(', ')}`)
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.required === true) assert.ok(key in value, `缺少必填字段 ${key}`)
    const nested = property.properties
    if (!nested || !(key in value) || typeof value[key] !== 'object' || value[key] === null) continue
    assert.equal(property.additionalProperties, false, `${key} 的嵌套 schema 也必须是严格模式`)
    const known = Object.keys(nested)
    const loose = Object.keys(value[key]).filter(name => !known.includes(name))
    assert.deepEqual(loose, [], `${key} 里出现了未声明的子字段：${loose.join(', ')}`)
    for (const [name, child] of Object.entries(nested)) {
      if (child.required === true) assert.ok(name in value[key], `${key} 缺少必填子字段 ${name}`)
    }
  }
}

/** 把 render 产出的文本片段拼成一整串。 */
function renderText(definition, value) {
  const rendered = definition.output.render({}, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, 'render 必须产出内容')
  return rendered.filter(part => part.type === 'text').map(part => part.text).join('\n')
}

test('缺清单的分支：返回值只带 schema 声明的字段', () => withWorkspace(async dir => {
  const definition = tool()
  const value = await definition.execute({ session_id: 'ralph' }, exec(dir))
  assertSchemaConformant(definition, value)
  assert.deepEqual(
    { total: value.total, passed: value.passed, failed: value.failed, manual: value.manual },
    { total: 1, passed: 0, failed: 1, manual: 0 },
    '清单缺失必须如实算作一条失败，而不是通过或空结果',
  )
  assert.match(value.detail, /checks\.json/)
}))

test('正常分支：计数、失败 id 与明细都留在已声明字段里', () => withWorkspace(async dir => {
  const target = join(dir, '.agi', 'subagents', 'ralph')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'checks.json'), JSON.stringify([
    { id: 'pass', cmd: 'exit 0' },
    { id: 'fail', cmd: 'exit 1' },
    { id: 'manual', note: '这一条必须由我亲自看' },
  ]), 'utf8')

  const definition = tool()
  const value = await definition.execute({ session_id: 'ralph' }, exec(dir))
  assertSchemaConformant(definition, value)
  assert.equal(value.total, 3)
  assert.equal(value.passed, 1)
  assert.equal(value.failed, 1)
  assert.equal(value.manual, 1)
  assert.deepEqual(value.failedIds, ['fail'])
  assert.match(value.detail, /pass/, '明细里必须能看到每一条断言的结论')

  const rendered = definition.output.render({}, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, 'render 必须产出内容')
  const text = rendered.filter(part => part.type === 'text').map(part => part.text).join('\n')
  assert.match(text, /3 条里 1 条通过/, '渲染结果必须给出通过计数')
  assert.match(text, /失败项：fail/, '渲染结果必须点名失败项')
}))

test('固定目录名不要求真实 session id', () => withWorkspace(async dir => {
  // ralph 的返回结果不含子会话 id，所以验收产物落在固定目录
  // `.agi/subagents/ralph/`；check_outcome 只是按目录名找 checks.json。
  const target = join(dir, '.agi', 'subagents', 'ralph')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'checks.json'), JSON.stringify([{ id: 'only', cmd: 'exit 0' }]), 'utf8')
  const value = await tool().execute({ session_id: 'ralph' }, exec(dir))
  assert.equal(value.passed, 1)
  assert.deepEqual(value.failedIds, [])
}))

test('验收契约：没有 expect.json 就明说只剩 worker 自述', () => withWorkspace(async dir => {
  const target = join(dir, '.agi', 'subagents', 'ralph')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'checks.json'), JSON.stringify([{ id: 'pass', cmd: 'exit 0' }]), 'utf8')

  const definition = tool()
  const value = await definition.execute({ session_id: 'ralph' }, exec(dir))
  assertSchemaConformant(definition, value)
  assert.deepEqual(value.expects, { declared: false, total: 0, covered: 0, uncovered: [] })
  assert.match(renderText(definition, value), /没有验收契约/, '没契约时必须说出来，而不是安静地全绿')
}))

test('验收契约：未覆盖的 eN 必须被点名', () => withWorkspace(async dir => {
  const target = join(dir, '.agi', 'subagents', 'ralph')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'checks.json'), JSON.stringify([
    { id: 'build', cmd: 'exit 0', expect: ['e1'] },
  ]), 'utf8')
  writeFileSync(join(target, 'expect.json'), JSON.stringify({
    worker: 'ralph',
    declaredAt: '2026-11-01T00:00:00.000Z',
    items: [
      { id: 'e1', text: '跑通构建' },
      { id: 'e2', text: '文档存在' },
    ],
  }), 'utf8')

  const definition = tool()
  const value = await definition.execute({ session_id: 'ralph' }, exec(dir))
  assertSchemaConformant(definition, value)
  assert.equal(value.expects.declared, true)
  assert.equal(value.expects.total, 2)
  assert.equal(value.expects.covered, 1)
  assert.deepEqual(value.expects.uncovered, [{ id: 'e2', text: '文档存在' }])

  const text = renderText(definition, value)
  assert.match(text, /1\/2 条被通过的检查覆盖/)
  assert.match(text, /e2: 文档存在（无对应检查）/, '未覆盖的验收必须显式列为「无对应检查」')
}))

test('验收契约：expect.json 坏了要如实报错，不能当成「没声明」', () => withWorkspace(async dir => {
  const target = join(dir, '.agi', 'subagents', 'ralph')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'checks.json'), JSON.stringify([{ id: 'pass', cmd: 'exit 0' }]), 'utf8')
  writeFileSync(join(target, 'expect.json'), '{ oops', 'utf8')

  const definition = tool()
  const value = await definition.execute({ session_id: 'ralph' }, exec(dir))
  assertSchemaConformant(definition, value)
  assert.equal(value.expects.declared, false)
  assert.match(value.expects.error, /不是合法 JSON/)
  assert.match(renderText(definition, value), /验收契约读不出来/)
}))
