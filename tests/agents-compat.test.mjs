// agents-compat：旧宿主用 roots()，rc.3 只有 list()，两边都得给出正确的顶层集合。
//
// 这里刻意只用「宿主真实暴露的形状」造对象：旧代是 { roots() }，新代是
// { list(), get() }。加了别的方法就不算在测真实回归路径了。
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { isRootAgent, isRootExecution, listRootAgents } from '../lib/agents-compat.js'

const root = (id, meta = {}) => ({ id, session: { id, meta } })
const child = (id, meta = {}) => ({
  id,
  session: { id, meta: { origin: 'subagent', delegationDepth: 1, parentSession: 'root-a', ...meta } },
})

test('旧宿主（有 roots）直接用 roots()，不去问 list()', () => {
  const a = root('a')
  const sub = child('b')
  let listCalls = 0
  const ctx = {
    agents: {
      roots: () => [a],
      list: () => {
        listCalls += 1
        return [a, sub]
      },
    },
  }
  assert.deepEqual(listRootAgents(ctx), [a])
  assert.equal(listCalls, 0, 'roots() 可用时 list() 不该被调用')
})

test('rc.3（只有 list）从 list() 里滤掉 subagent 子代理', () => {
  const a = root('a')
  const b = root('b', { cwd: 'D:/x' })
  const sub = child('c')
  const grandchild = child('d', { delegationDepth: 2 })
  const ctx = { agents: { list: () => [a, b, sub, grandchild], get: () => undefined } }
  assert.deepEqual(listRootAgents(ctx), [a, b])
})

test('委派深度 0 与普通 fork（只带 parentSession）仍算顶层', () => {
  assert.equal(isRootAgent(root('x', { delegationDepth: 0 })), true)
  assert.equal(isRootAgent(root('x', { parentSession: 'root-a' })), true)
  assert.equal(isRootAgent(root('x', { origin: 'subagent' })), false)
  assert.equal(isRootAgent(root('x', { delegationDepth: 1 })), false)
})

test('roots() 抛错时退到 list()，而不是把异常抛进工具链', () => {
  const a = root('a')
  const ctx = {
    agents: {
      roots: () => {
        throw new TypeError('ctx.agents.roots is not a function')
      },
      list: () => [a, child('b')],
    },
  }
  assert.deepEqual(listRootAgents(ctx), [a])
})

test('两个读法都不可用时返回空数组，永不抛', () => {
  assert.deepEqual(listRootAgents({ agents: { get: () => undefined } }), [])
  assert.deepEqual(listRootAgents({ agents: {} }), [])
  assert.deepEqual(listRootAgents({}), [])
  assert.deepEqual(listRootAgents(undefined), [])
  assert.deepEqual(listRootAgents({ agents: null }), [])
})

test('list() 返回非数组或抛错也退化成空数组', () => {
  assert.deepEqual(listRootAgents({ agents: { list: () => undefined } }), [])
  assert.deepEqual(
    listRootAgents({
      agents: {
        list: () => {
          throw new Error('registry torn down')
        },
      },
    }),
    [],
  )
})

// 0.23.3 的根因回归守卫：`ctx.agents.roots()` 只允许出现在 agents-compat.js 内部
// （且必须过了 `typeof … === 'function'`）。规则化的理由不是洁癖 —— goal.js 里
// 那三处直接调用位于 `tools/pre-execute` / `tools/post-execute` 上，rc.3 一启动
// 就是「每次工具调用都抛」，整条工具链在到达工具之前就断，症状看起来像「所有工具
// 一起坏了」，极难反推到一行布尔判断。静态守卫比等下一次线上复现便宜得多。
test('lib/ 里没有绕过 agents-compat 直接调 roots() 的地方', async () => {
  const libUrl = new URL('../lib/', import.meta.url)
  const offenders = []
  for (const file of await readdir(libUrl)) {
    if (!file.endsWith('.js') || file === 'agents-compat.js') continue
    const text = await readFile(new URL(file, libUrl), 'utf8')
    // 只看代码，不看注释/文档：先把 // 与 /* */ 剥掉，注释里提到 roots() 是正常的。
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const match of code.matchAll(/\.roots\s*\(/g)) {
      const line = code.slice(0, match.index).split('\n').length
      offenders.push(`lib/${file}:${line}`)
    }
  }
  assert.deepEqual(offenders, [], '顶层 agent 列表只能经 listRootAgents()/isRootExecution() 读取')
})

test('isRootExecution 只认活的顶层 agent，undefined 直接 false', () => {
  const a = root('a')
  const ctx = { agents: { list: () => [a, child('b')] } }
  assert.equal(isRootExecution(ctx, a), true)
  assert.equal(isRootExecution(ctx, child('b')), false)
  assert.equal(isRootExecution(ctx, undefined), false)
  assert.equal(isRootExecution(ctx, null), false)
  assert.equal(isRootExecution(ctx, { id: 'a', session: { meta: {} } }), false, '同 id 不同对象不算')
})
