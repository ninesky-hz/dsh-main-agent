/**
 * schedule 的接法：service 归 host 平面，tools 归 preset。
 *
 * `@deepseek-ai/dsh-schedule` 是「每进程只注册一次」的 service。dsh-web-app 的
 * host 层已经有一条 `- id: schedule` 声明它，所以本 bundle 再插一行 `agi-schedule`
 * 必然抛：
 *   service "schedule" has been registered at <ScheduleService>
 * 那条 `!!js` 守卫想「有就让位」，但 patch 求值时的 `ctx.loader` 未必能看到
 * 排在别的 bundle 里的行，拦不住 —— 用户看到的就是插件页上那一行「异常」。
 *
 * 正确的分工（见 dsh-web-app/cordis.patch.yml 的注释）是：
 *   - service 由 host 声明一次；
 *   - 四个工具（create / list / update / remove）由各 preset 在自己的 scope 里声明。
 * main-agent preset 此前把这个工具行整块漏掉了，于是 persona 要求调用
 * `schedule_create` 而工具不存在，服务端 watchdog 也失去了让模型重排提醒的手段。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

test('bundle 不再挂 schedule 层', () => {
  const manifest = JSON.parse(read('package.json'))
  const patch = manifest.dsh?.bundle?.patch ?? []
  assert.ok(
    !patch.some((file) => file.includes('schedule')),
    '重复声明 service 会让这一行变成「异常」，service 只应由 host 提供',
  )
})

test('host 层 patch 不再出现 agi-schedule 行', () => {
  const host = read('cordis.patch.yml')
  // 注释里可以提到这些名字（用来解释为什么不再声明），实际的 YAML 行不能有。
  assert.equal(/^- id: agi-schedule/m.test(host), false)
  assert.equal(/^\s+name: '@deepseek-ai\/dsh-schedule'/m.test(host), false)
})

test('main-agent preset 声明 tool-schedule，与 standard / cordis / ptc 一致', () => {
  const preset = read('agent-presets/main-agent/agent.cordis.yml')
  const rows = preset.split(/^- id: /m).slice(1).map((chunk) => `- id: ${chunk}`)
  const row = rows.find((candidate) => candidate.startsWith('- id: tool-schedule\n'))
  assert.ok(row, 'persona 要求调用 schedule_create，preset 必须真的挂上这个工具')
  assert.match(row, /^\s{2}name: '@deepseek-ai\/dsh-tool-schedule'$/m)
})

test('生成的 preset patch 与源文件同步', () => {
  const generated = read('presets/main-agent.patch.yml')
  assert.match(generated, /- id: tool-schedule\n\s+name: '@deepseek-ai\/dsh-tool-schedule'/)
})
