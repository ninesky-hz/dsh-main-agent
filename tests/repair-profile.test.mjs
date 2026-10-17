import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  formatReport,
  findPresetRows,
  listProfiles,
  nextSteps,
  repairProfile,
  scanProfile,
  PACKAGE_NAME,
  PRESET_ROW_ID,
} from '../scripts/repair-profile.mjs'

const PATCH = `# profile 级 patch
- id: agi-schedule
  disabled: true
- id: preset-main-agent
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: main-agent
    name: Main Agent
- id: preset-main-agent
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: main-agent
    name: Main Agent
- insert:
    - id: preset-main-agent
      name: '@deepseek-ai/dsh-agent-preset'
`

async function fixture({ patch = PATCH, withInstall = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-repair-'))
  const dir = path.join(home, 'profiles', 'desktop')
  await mkdir(path.join(dir, 'node_modules', PACKAGE_NAME), { recursive: true })
  await writeFile(path.join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.10.0' }))
  const pkg = {
    name: 'dsh-desktop-profile',
    dependencies: { [PACKAGE_NAME]: 'https://gitee.com/n-sky/dsh-main-agent.git' },
    dsh: { profile: { bundles: ['dsh-main-agent', 'other-bundle'] } },
  }
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  if (patch !== null) await writeFile(path.join(dir, 'cordis.patch.yml'), patch)
  await writeFile(path.join(dir, 'cordis.yml'), "- id: preset-main-agent\n  name: '@deepseek-ai/dsh-agent-preset'\n")
  if (!withInstall) await rm(path.join(dir, 'node_modules', PACKAGE_NAME), { recursive: true, force: true })
  return { home, dir }
}

test('findPresetRows 找出所有声明并给出整段删除区间', () => {
  const rows = findPresetRows(PATCH)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((row) => row.line), [4, 9, 15])
  // 第一条 top-level 行：整段删到下一个 `- id:` 之前
  assert.equal(rows[0].indent, 0)
  assert.equal(rows[0].end, 8)
  // 嵌套在 `- insert:` 下的那条：删到文件末尾
  assert.equal(rows[2].indent, 4)
  assert.equal(rows[2].end, 17)
  assert.equal(findPresetRows('').length, 0)
})

test('listProfiles 只收带 package.json 的目录，去重且含 home 自身', async () => {
  const { home } = await fixture()
  await mkdir(path.join(home, 'profiles', 'empty'), { recursive: true })
  await writeFile(path.join(home, 'package.json'), '{"name":"legacy"}\n')
  const profiles = await listProfiles(home)
  assert.equal(profiles.length, 2)
  assert.ok(profiles.some((dir) => dir.endsWith(path.join('profiles', 'desktop'))))
  assert.ok(profiles.includes(home))
  await rm(home, { recursive: true, force: true })
})

test('默认是只读诊断：报告问题但不改文件', async () => {
  const { home, dir } = await fixture()
  const { scan, actions } = await repairProfile(dir)
  assert.equal(actions.length, 0)
  assert.equal(scan.findings.length, 1)
  assert.match(scan.findings[0], /声明了 3 次/)
  assert.match(scan.state, /^已安装/)
  assert.equal(scan.fixable, true)
  assert.equal((await readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')), PATCH)
  assert.equal(scan.installedVersion, '0.10.0')
  assert.equal(scan.dependency, 'https://gitee.com/n-sky/dsh-main-agent.git')
  assert.equal(scan.bundlesListed, true)
  await rm(home, { recursive: true, force: true })
})

test('--apply 只保留第一条 preset 声明，并备份原文件', async () => {
  const { home, dir } = await fixture()
  const { actions, backups } = await repairProfile(dir, { apply: true })
  assert.equal(actions.length, 1)
  const repaired = await readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.equal(findPresetRows(repaired).length, 1)
  assert.equal(findPresetRows(repaired)[0].line, 4)
  assert.match(repaired, /- id: agi-schedule/)
  assert.doesNotMatch(repaired, /- insert:/)
  assert.equal(backups.length, 1)
  assert.equal(await readFile(backups[0], 'utf8'), PATCH)
  const after = await scanProfile(dir)
  assert.equal(after.findings.some((finding) => finding.startsWith('cordis.patch.yml')), false)
  assert.equal(after.state.includes('已安装'), true)
  await rm(home, { recursive: true, force: true })
})

test('--uninstall 清掉依赖、bundles 条目与残留 node_modules', async () => {
  const { home, dir } = await fixture()
  const { actions, backups } = await repairProfile(dir, { apply: true, uninstall: true })
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(PACKAGE_NAME in (pkg.dependencies ?? {}), false)
  assert.deepEqual(pkg.dsh.profile.bundles, ['other-bundle'])
  assert.equal(existsSync(path.join(dir, 'node_modules', PACKAGE_NAME)), false)
  assert.equal(actions.some((action) => action.includes('node_modules')), true)
  assert.equal(backups.length, 2)
  assert.equal((await readFile(path.join(dir, 'package.json'))).includes(PACKAGE_NAME), false)
  const leftovers = await readdir(path.join(home, 'profiles', 'desktop'))
  assert.equal(leftovers.some((name) => name.startsWith('package.json.bak-')), true)
  await rm(home, { recursive: true, force: true })
})

test('报告与下一步提示覆盖两个错误码的处置', async () => {
  const { home, dir } = await fixture()
  const scan = await scanProfile(dir)
  const report = formatReport([{ scan, actions: [], backups: [] }], { home })
  assert.match(report, new RegExp(PRESET_ROW_ID))
  assert.match(report, /声明了 3 次/)
  const steps = nextSteps([{ scan, actions: [], backups: [] }], { applied: false, uninstall: false })
  assert.match(steps.join('\n'), /--apply/)
  await rm(home, { recursive: true, force: true })
})
