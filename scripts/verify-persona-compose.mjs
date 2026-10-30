/**
 * 实证工具：拿一个真实 preset 的 agent.cordis.yml，验证「拼接 / 幂等 / 精确回滚」
 * 在它自己的真实人格上成立。
 *
 * 用法：
 *   node scripts/verify-persona-compose.mjs "C:\Users\<你>\.dsh\.agent-presets\poja\agent.cordis.yml"
 *
 * 不写任何文件，只读 + 断言 + 打印结论。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import YAML from 'yaml'

import {
  composeSupervisorPersona,
  hasSupervisorPersona,
  stripSupervisorPersona,
  SUPERVISOR_ANCHOR,
  SUPERVISOR_PERSONA,
} from '../lib/supervise.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/verify-persona-compose.mjs <preset 的 agent.cordis.yml>')
  process.exit(2)
}

const rows = YAML.parse(readFileSync(file, 'utf8'))
const persona = Array.isArray(rows) ? rows.find(row => row?.id === 'persona') : undefined
if (!persona) {
  console.error(`没有找到 persona 行：${file}`)
  process.exit(2)
}

const original = typeof persona.config?.prefix === 'string' ? persona.config.prefix : ''
const composed = composeSupervisorPersona(original)
const stripped = stripSupervisorPersona(composed)

const report = {
  file,
  complete: persona.config?.complete ?? false,
  originalChars: original.length,
  composedChars: composed.length,
  原人格在前: composed.startsWith(original),
  监督层在后: composed.endsWith(SUPERVISOR_PERSONA),
  带锚点: composed.includes(SUPERVISOR_ANCHOR),
  幂等: composeSupervisorPersona(composed) === composed,
  精确回滚: stripped === original,
  已叠过: hasSupervisorPersona(original),
}

console.log(JSON.stringify(report, null, 2))

assert.equal(report.原人格在前, true, '原人格没保留在最前')
assert.equal(report.监督层在后, true, '监督层没追加在最后')
assert.equal(report.带锚点, true, '缺锚点')
assert.equal(report.幂等, true, '拼接不幂等')
assert.equal(report.精确回滚, true, '回滚不是逐字节还原')
console.log(`\nOK：${file} 的 ${report.originalChars} 字人格 → ${report.composedChars} 字，往返一致。`)
