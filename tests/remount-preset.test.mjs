/**
 * `remountPreset` 决定「改完磁盘文件后能不能立刻生效」。
 *
 * 它守住一个容易被忽略的事实：registry 的 `activate()` **自己 catch 掉挂载
 * 失败**，只把错误写进 `record.broken` 就正常返回。所以「activate 没抛错」
 * 不等于「新版本挂上了」—— 少了 broken 检查，卡片会说「立即生效」，而实际
 * 服务旧版本的仍是老 generation，用户永远不知道要重启。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { remountPreset } from '../lib/supervise.js'

const OLD_PLUGINS = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'old' } }]
const NEW_PLUGINS = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'new' } }]

/**
 * A registry stand-in that mirrors the real `activate()` contract: it throws
 * only for the pre-mount guards, and records mount failures on `record.broken`.
 */
function fakeRegistry({ throwOnActivate = false, failMount = false, broken = undefined } = {}) {
  const previousGeneration = { retired: false, users: 0, revision: 'old' }
  const record = {
    config: { id: 'poja', plugins: OLD_PLUGINS },
    generation: previousGeneration,
    broken,
  }
  const collected = []
  const registry = {
    definitions: new Map([['poja', record]]),
    record,
    previousGeneration,
    collected,
    async activate(target) {
      if (throwOnActivate) throw new Error('boom')
      if (failMount) {
        target.broken = 'mount failed: row unusable'
        return
      }
      target.generation = { retired: false, users: 0, revision: 'new' }
    },
    async collect(generation) {
      collected.push(generation)
    },
  }
  return registry
}

test('挂载成功：返回 true，config 换新，旧 generation 被 retire 并 collect', async () => {
  const registry = fakeRegistry()
  const mounted = await remountPreset(registry, 'poja', NEW_PLUGINS)

  assert.equal(mounted, true)
  assert.deepEqual(registry.record.config.plugins, NEW_PLUGINS)
  assert.equal(registry.record.generation.revision, 'new')
  assert.equal(registry.previousGeneration.retired, true)
  assert.deepEqual(registry.collected, [registry.previousGeneration])
})

test('activate 抛错：返回 false，config 与 generation 都回滚', async () => {
  const registry = fakeRegistry({ throwOnActivate: true })
  const mounted = await remountPreset(registry, 'poja', NEW_PLUGINS)

  assert.equal(mounted, false)
  assert.deepEqual(registry.record.config.plugins, OLD_PLUGINS, 'config 必须回滚')
  assert.equal(registry.record.generation, registry.previousGeneration, 'generation 必须回滚')
  assert.deepEqual(registry.collected, [], '没挂上就不该 collect 旧 generation')
})

test('activate 内部挂载失败（只设 broken）：也必须返回 false 并回滚', async () => {
  const registry = fakeRegistry({ failMount: true })
  const mounted = await remountPreset(registry, 'poja', NEW_PLUGINS)

  assert.equal(mounted, false, 'activate 没抛错不代表挂载成功')
  assert.deepEqual(registry.record.config.plugins, OLD_PLUGINS)
  assert.equal(registry.record.generation, registry.previousGeneration)
  assert.equal(registry.record.broken, undefined, 'broken 要恢复成 remount 之前的值')
  assert.deepEqual(registry.collected, [])
})

test('本来就有 broken 的 record：remount 成功不该被历史诊断挡住', async () => {
  const registry = fakeRegistry({ broken: 'stale diagnostic from an older revision' })
  const mounted = await remountPreset(registry, 'poja', NEW_PLUGINS)

  assert.equal(mounted, true)
  assert.equal(registry.record.broken, 'stale diagnostic from an older revision', '历史 broken 原样保留')
})

test('没有 generation 的新 record：不发 collect，仍然返回 true', async () => {
  const registry = fakeRegistry()
  registry.record.generation = undefined
  const mounted = await remountPreset(registry, 'poja', NEW_PLUGINS)

  assert.equal(mounted, true)
  assert.deepEqual(registry.collected, [])
})

test('前提不成立时一律 false，绝不抛错', async () => {
  const cases = [
    [undefined, 'poja', NEW_PLUGINS],
    [null, 'poja', NEW_PLUGINS],
    [{}, 'poja', NEW_PLUGINS],
    [{ definitions: new Map() }, 'missing', NEW_PLUGINS],
    [{ definitions: new Map([['poja', { config: {} }]]) }, 'poja', NEW_PLUGINS], // 没有 activate
    [fakeRegistry(), 'poja', undefined],
    [fakeRegistry(), 'poja', 'not-an-array'],
  ]
  for (const [registry, id, plugins] of cases) {
    assert.equal(await remountPreset(registry, id, plugins), false)
  }
})
