/**
 * `list_agents` 的具名投影。
 *
 * rc.2 之前，`list_agents` 只给 id：模型拿到一个句柄，却拿不到「人话的名字」。
 * rc.2 起名字才是一等地址 —— team 任务的 `owner`、`send_message` 的 `agent`、
 * 多层子级的 `父名/子名` 路径，全都只认名字。所以目录行必须把 `path` 透出来，
 * 并在没有名字时回落到 id（否则那一行就没有可用地址了）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./harness-stub-loader.js', import.meta.url)

const { apply } = await import('../lib/list-agents.js')

const PARENT = 'root-supervisor-session'

function host({ service, running = [] }) {
  const registered = []
  const agents = new Map(running.map(id => [id, { id, status: 'running' }]))
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    subagents: service,
    agents: { get: id => agents.get(id) },
    effect: callback => callback(),
    on: () => () => {},
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered, tool: () => registered.at(-1) }
}

const exec = { agent: { id: PARENT }, signal: undefined }

test('rc.2 的目录行把 path 当作名字透出来', async () => {
  const rows = [
    { id: 'child-a', depth: 1, parentId: PARENT, path: 'reviewer', label: '审代码', mode: 'continuable', activity: 'inactive' },
    { id: 'child-b', depth: 2, parentId: 'child-a', path: 'reviewer/checker', label: '跑验收', mode: 'continuable', activity: 'running' },
  ]
  const system = host({ service: { listDescendants: async () => rows, drainDescendants: async () => {} } })
  apply(system.ctx)

  const projected = await system.tool().execute({ scope: 'descendants' }, exec)

  assert.deepEqual(projected.map(row => row.name), ['reviewer', 'reviewer/checker'])
  assert.equal(projected[1].status, 'running', 'catalog 的 activity 要能报出尚未 materialize 的 running')
})

test('没有名字的子级回落到 id', async () => {
  const rows = [
    { id: 'child-a', depth: 1, parentId: PARENT, label: '匿名', mode: 'continuable' },
  ]
  const system = host({ service: { listDescendants: async () => rows, drainDescendants: async () => {} } })
  apply(system.ctx)

  const projected = await system.tool().execute({}, exec)

  assert.equal(projected[0].name, 'child-a')
  assert.equal(projected[0].status, 'inactive')
})

test('活注册表里的 running 压过目录里的 activity', async () => {
  const rows = [
    { id: 'child-a', depth: 1, parentId: PARENT, path: 'reviewer', label: 'x', mode: 'continuable', activity: 'inactive' },
  ]
  const system = host({
    service: { listDescendants: async () => rows, drainDescendants: async () => {} },
    running: ['child-a'],
  })
  apply(system.ctx)

  const projected = await system.tool().execute({}, exec)

  assert.equal(projected[0].status, 'running')
})

test('0.2.1 的目录行没有 path，名字等于 id', async () => {
  const rows = [{ id: 'child-a', mode: 'continuable', label: 'legacy' }]
  const system = host({ service: { listChildren: async () => rows, drainChildren: async () => {} } })
  apply(system.ctx)

  const projected = await system.tool().execute({}, exec)

  assert.equal(projected.length, 1)
  assert.equal(projected[0].name, 'child-a')
})
