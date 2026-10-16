#!/usr/bin/env node
/**
 * 从 `agent-presets/main-agent/{preset.yml,agent.cordis.yml}` 生成
 * `presets/main-agent.patch.yml` —— 一份 bundle patch，向 agent-preset 注册表
 * 声明（declare）随包的 `main-agent` preset。
 *
 * 为什么需要它：0.2.x 的注册表**不再扫描** `${DSH_HOME}/.agent-presets/`
 * 目录，preset 只能由 patch 里的声明行（`@deepseek-ai/dsh-agent-preset`）
 * 注册。补丁清单写在 package.json 的 `dsh.bundle.patch`（可以是数组），
 * 本文件就是数组里的第二个 patch。
 *
 * `lib/index.js` 仍然会把 preset 复制到 `${DSH_HOME}/.agent-presets/`——
 * 那条路是给旧版 dsh 的兼容路径，保留不动。
 *
 * 用法：`node scripts/sync-preset-patch.mjs`（改了 preset 之后重跑；
 * `npm test` 会校验生成物与源文件一致）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_ID = 'main-agent'
const ROW_ID = 'preset-main-agent'
const ORDER = 5
const PRESET_DIR = join(ROOT, 'agent-presets', PRESET_ID)
const OUT = join(ROOT, 'presets', `${PRESET_ID}.patch.yml`)

/** 极简 preset.yml 解析：只认 `name:` 与 `description:`（折叠/字面块都接受）。 */
export function parsePresetYml(text) {
  let name = PRESET_ID
  const description = []
  let inDescription = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const nameMatch = /^name:\s*(.*)$/.exec(line)
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
      inDescription = false
      continue
    }
    const descMatch = /^description:\s*(?:[>|][-+]?)?\s*(.*)$/.exec(line)
    if (descMatch) {
      if (descMatch[1].trim() !== '') description.push(descMatch[1].trim())
      inDescription = true
      continue
    }
    if (inDescription && /^\s+\S/.test(line)) description.push(line.trim())
    else inDescription = false
  }
  return { name, description: description.join(' ') }
}

/** YAML 单引号标量：内部单引号翻倍。 */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`

export function renderPresetPatch({ name, description, composition }) {
  const body = composition
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `          ${line}`))
    .join('\n')
  return `# 本文件由 scripts/sync-preset-patch.mjs 生成 —— 请勿手工编辑；改
# agent-presets/${PRESET_ID}/ 下的源文件后重跑该脚本。
#
# 它声明随包的 \`${PRESET_ID}\` preset。0.2.x 的注册表不读取
# \${DSH_HOME}/.agent-presets/ 目录，只认这里这样的声明行。
- insert:
    - id: ${ROW_ID}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${PRESET_ID}
        name: ${quote(name)}
        description: ${quote(description)}
        order: ${ORDER}
        plugins:
${body}
`
}

function main() {
  const { name, description } = parsePresetYml(readFileSync(join(PRESET_DIR, 'preset.yml'), 'utf8'))
  const composition = readFileSync(join(PRESET_DIR, 'agent.cordis.yml'), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\n+$/, '')
  const rendered = renderPresetPatch({ name, description, composition })
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, rendered, 'utf8')
  process.stdout.write(`dsh-supervisor: 已生成 ${OUT}（${rendered.split('\n').length} 行）\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
