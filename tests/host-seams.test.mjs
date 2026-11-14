/**
 * Keeps `scripts/probe-host-seams.mjs` honest about what it claims to check.
 *
 * The probe asks the host "is every slot I register still declared there?", but
 * the slot list it feeds that question is a literal in the script — so a new
 * registration in `lib/client.js` would silently go unprobed. Same for the
 * host-module list: the probe derives it by scanning `lib/*.js`, and that scan
 * is only worth anything if `lib/client.js` really carries no host runtime
 * import (it runs in the browser, where `@deepseek-ai/*` does not exist).
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { REGISTERED_SLOTS } from '../scripts/probe-host-seams.mjs'

const libUrl = new URL('../lib/', import.meta.url)

const client = await readFile(new URL('client.js', libUrl), 'utf8')

/** Every `{ name: '<slot>', … }` registration in the browser bundle. */
const registered = [...client.matchAll(/\bname: '([a-z][\w-]*(?:\.[\w-]+)+|main)'/g)].map(match => match[1])

test('probe slot list equals the slots lib/client.js actually registers', () => {
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...REGISTERED_SLOTS].sort(),
    '脚本的 REGISTERED_SLOTS 与 lib/client.js 里注册的槽集合不一致',
  )
})

test('the sidebar row and the keyed main panel still share one id', () => {
  const panellist = /name: 'sidebar\.panellist',\s*id: (\w+)/.exec(client)
  const main = /name: 'main',\s*key: (\w+)/.exec(client)
  assert.ok(panellist, '没有找到 sidebar.panellist 注册')
  assert.ok(main, '没有找到 main 注册')
  assert.equal(panellist[1], main[1], '侧栏行与主面板必须使用同一个 PANEL_ID，否则点击才报错')
})

test('lib/client.js imports no host package', () => {
  const hostRefs = [
    ...client.matchAll(/(?:require\(|from )['"](@deepseek-ai\/[^'"]+)['"]/g),
  ].map(match => match[1])
  assert.deepEqual([...new Set(hostRefs)], [], '浏览器 bundle 不能依赖宿主包，它只在浏览器里跑')
})

test('every import in lib/ names a package the plugin declares as a peer', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}))
  const specs = new Set()
  for (const file of await readdir(libUrl)) {
    if (!file.endsWith('.js') || file === 'client.js') continue
    const text = await readFile(new URL(file, libUrl), 'utf8')
    for (const match of text.matchAll(/^import\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      if (match[1].startsWith('@deepseek-ai/') || match[1] === 'schemastery') specs.add(match[1])
    }
  }
  assert.deepEqual([...specs].filter(spec => !peers.has(spec)), [], '有宿主导入没有写进 peerDependencies')
})
