// agents-compat：旧宿主用 roots()，rc.3 只有 list()，两边都得给出正确的顶层集合。
//
// 这里刻意只用「宿主真实暴露的形状」造对象：旧代是 { roots() }，新代是
// { list(), get() }。加了别的方法就不算在测真实回归路径了。
import assert from 'node:assert/strict'
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

test('isRootExecution 只认活的顶层 agent，undefined 直接 false', () => {
  const a = root('a')
  const ctx = { agents: { list: () => [a, child('b')] } }
  assert.equal(isRootExecution(ctx, a), true)
  assert.equal(isRootExecution(ctx, child('b')), false)
  assert.equal(isRootExecution(ctx, undefined), false)
  assert.equal(isRootExecution(ctx, null), false)
  assert.equal(isRootExecution(ctx, { id: 'a', session: { meta: {} } }), false, '同 id 不同对象不算')
})
