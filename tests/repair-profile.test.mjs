import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const SCRIPT = fileURLToPath(new URL('../scripts/repair-profile.mjs', import.meta.url))
import {
  BUNDLE_ROW_IDS,
  formatReport,
  findPresetRows,
  findRowSpans,
  listProfiles,
  nextSteps,
  readPolicy,
  repairProfile,
  scanProfile,
  staleExcludes,
  PACKAGE_NAME,
  PRESET_ID,
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
  // 顺序固定：重复声明 → 本 bundle 的 legacy 行（agi-schedule 一条提示 + preset 一条）
  assert.equal(scan.findings.length, 3)
  assert.match(scan.findings[0], /声明了 3 次/)
  assert.match(scan.findings[1], /仍有 agi-schedule 行.*孤儿行/)
  assert.match(scan.findings[2], /仍有 preset-main-agent 行.*bundle-in-use.*2148/)
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
  assert.equal(after.findings.some((finding) => /声明了 3 次/.test(finding)), false)
  // 唯一的 legacy 行按设计保留：--apply 只去重，清行要 --apply --uninstall
  assert.equal(after.findings.some((finding) => /仍有 preset-main-agent 行/.test(finding)), true)
  assert.equal(after.findings.some((finding) => /仍有 agi-schedule 行/.test(finding)), true)
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

test('--uninstall 幂等：第二遍不再产生动作，findings 也为空', async () => {
  const { home, dir } = await fixture()
  await repairProfile(dir, { apply: true, uninstall: true, home })
  const after = await scanProfile(dir, { home })
  assert.equal(after.findings.length, 0)
  assert.equal(after.state, '未安装')
  const again = await repairProfile(dir, { apply: true, uninstall: true, home })
  assert.deepEqual(again.actions, [])
  assert.deepEqual(again.backups, [])
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

const BUNDLE_PATCH = `# 用户层 patch
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: true
- id: agi-supervisor-setup
  disabled: false
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
- insert:
    - id: agi-schedule
      name: '@deepseek-ai/dsh-schedule'
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
- id: agi-schedule
  disabled: true
`

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false

importers:

  .:
    dependencies:
      '@michengai/dsh-codex-ui':
        specifier: 1.1.30
        version: 1.1.30
      billion-context:
        specifier: 0.1.198
        version: 0.1.198
      dsh-context:
        specifier: 0.72.0
        version: 0.72.0(@deepseek-ai/schemastery@3.18.4)
      dsh-main-agent:
        specifier: https://gitee.com/n-sky/dsh-main-agent.git
        version: git+https://gitee.com/n-sky/dsh-main-agent.git#abc123(@deepseek-ai/schemastery@3.18.4)
      dshmarket:
        specifier: ^1.66.24
        version: 1.66.24(@deepseek-ai/schemastery@3.18.4)
`

const WORKSPACE_STATE = JSON.stringify({
  lastValidatedTimestamp: 1792247143315,
  settings: {
    minimumReleaseAge: 1440,
    minimumReleaseAgeIgnoreMissingTime: true,
    minimumReleaseAgeExclude: [
      'billion-context@0.1.181 || 0.1.185 || 0.1.187 || 0.1.198',
      'dshmarket@1.66.9 || 1.66.24',
      "'@michengai/dsh-codex-ui@1.1.30'",
    ],
  },
}, null, 2)

const WORKSPACE_YAML = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - billion-context@0.1.181 || 0.1.185 || 0.1.187 || 0.1.198
  - dshmarket@1.66.9 || 1.66.24
  - '@michengai/dsh-codex-ui@1.1.30'
allowBuilds:
  cloudflared: true
`

/** 合成一份「真机同款」的坏 profile：三条 legacy 行 + 漂移 + 冷静期 + preset 目录。 */
async function uninstallFixture({ patch = BUNDLE_PATCH } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-uninstall-'))
  const dir = path.join(home, 'profiles', 'desktop')
  await mkdir(path.join(dir, 'node_modules', PACKAGE_NAME), { recursive: true })
  await writeFile(path.join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.10.10' }))
  await writeFile(path.join(dir, 'node_modules', '.pnpm-workspace-state-v1.json'), WORKSPACE_STATE)
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), WORKSPACE_YAML)
  const pkg = {
    name: 'dsh-desktop-profile',
    dependencies: {
      '@michengai/dsh-codex-ui': '1.1.30',
      'billion-context': '0.1.199',
      'dsh-context': '0.72.0',
      [PACKAGE_NAME]: 'https://gitee.com/n-sky/dsh-main-agent.git',
      dshmarket: '^1.66.24',
    },
    dsh: { profile: { bundles: ['billion-context', PACKAGE_NAME, 'other-bundle'] } },
  }
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(path.join(dir, 'pnpm-lock.yaml'), LOCK)
  await writeFile(path.join(dir, 'cordis.patch.yml'), patch)
  const presetDir = path.join(home, '.agent-presets', PRESET_ID)
  await mkdir(presetDir, { recursive: true })
  await writeFile(path.join(presetDir, 'main-agent.yml'), 'id: main-agent\n')
  return { home, dir, presetDir }
}

test('findRowSpans 认出三条行，并区分顶层与 `- insert:` 内嵌', () => {
  assert.deepEqual(BUNDLE_ROW_IDS, ['agi-supervisor-setup', 'agi-schedule', 'preset-main-agent'])
  assert.equal(PRESET_ID, 'main-agent')
  const rows = findRowSpans(BUNDLE_PATCH, BUNDLE_ROW_IDS)
  assert.deepEqual(rows.map((row) => row.id), [
    'agi-supervisor-setup',
    'preset-main-agent',
    'preset-main-agent',
    'preset-main-agent',
    'agi-schedule',
    'agi-schedule',
  ])
  assert.deepEqual(rows.map((row) => row.line), [6, 8, 13, 19, 22, 26])
  assert.deepEqual(rows.map((row) => row.nesting), ['top', 'top', 'top', 'insert', 'insert', 'top'])
  assert.equal(rows[1].end, 12)
  assert.equal(rows[3].end, 20)
  // findPresetRows 仍是同一实现的薄包装，老字段不变
  const presetRows = findPresetRows(BUNDLE_PATCH)
  assert.deepEqual(presetRows.map((row) => row.line), [8, 13, 19])
  for (const key of ['line', 'indent', 'start', 'end']) assert.equal(key in presetRows[0], true)
})

test('诊断合成坏 profile：legacy 行、漂移、冷静期、preset 目录同时报出', async () => {
  const { home, dir } = await uninstallFixture()
  const before = await readFile(path.join(dir, 'package.json'), 'utf8')
  const scan = await scanProfile(dir, { home })
  assert.equal(await readFile(path.join(dir, 'package.json'), 'utf8'), before)
  assert.equal(scan.legacyRows.length, 6)
  // 只有 billion-context 是精确版本且与 lockfile 不一致；带 peer 后缀与 ^ 的一律不误报
  assert.deepEqual(scan.drift, [{ name: 'billion-context', manifest: '0.1.199', locked: '0.1.198' }])
  assert.equal(scan.policy.minimumReleaseAge, 1440)
  assert.equal(scan.policy.configured, 1440)
  assert.equal(scan.policy.excludes.length, 3)
  assert.equal(scan.presetDir.exists, true)
  assert.equal(scan.presetDir.path, path.join(home, '.agent-presets', PRESET_ID))
  assert.equal(scan.fixable, true)
  const text = scan.findings.join('\n')
  assert.match(text, /仍有 agi-supervisor-setup 行（第 6 行）：卸载时它会让 remove_bundle 撞 bundle-in-use（宿主源码 lib\/index\.js:2148）/)
  assert.match(text, /仍有 preset-main-agent 行（第 8 行、第 13 行、第 19 行）/)
  assert.match(text, /仍有 agi-schedule 行（第 22 行、第 26 行）：卸载后成为孤儿行/)
  assert.match(text, /billion-context 0\.1\.199 ≠ 0\.1\.198/)
  assert.match(text, /冷静期 1440 分钟当前生效（pnpm 11\.7\.0）且白名单未覆盖 0\.1\.199/)
  assert.match(text, /ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED/)
  await rm(home, { recursive: true, force: true })
})

test('readPolicy 分开报「当前配置」与「上次解析记录」，缺一个也能退回另一个', async () => {
  const { home, dir } = await uninstallFixture()
  // 两边都在：configured 取 pnpm-workspace.yaml，state 取 .pnpm-workspace-state 缓存
  assert.deepEqual(await readPolicy(dir), {
    minimumReleaseAge: 1440,
    configured: 1440,
    state: 1440,
    stateAt: '2026-10-17T14:25:43.315Z',
    excludes: [
      'billion-context@0.1.181 || 0.1.185 || 0.1.187 || 0.1.198',
      'dshmarket@1.66.9 || 1.66.24',
      '@michengai/dsh-codex-ui@1.1.30',
    ],
  })
  // 只有 yaml（删掉 state 缓存）
  await rm(path.join(dir, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true })
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), [
    'nodeLinker: hoisted',
    'minimumReleaseAge: 1440',
    'minimumReleaseAgeExclude:',
    '  - billion-context@0.1.181 || 0.1.198',
    "  - '@michengai/dsh-codex-ui@1.1.30'",
    'allowBuilds:',
    '  cloudflared: true',
    '',
  ].join('\n'))
  const fallback = await readPolicy(dir)
  assert.equal(fallback.minimumReleaseAge, 1440)
  assert.equal(fallback.configured, 1440)
  assert.equal(fallback.state, null)
  assert.deepEqual(fallback.excludes, ['billion-context@0.1.181 || 0.1.198', '@michengai/dsh-codex-ui@1.1.30'])
  await rm(home, { recursive: true, force: true })
})

test('真机同款：yaml 里没有 minimumReleaseAge、只有 state 缓存记录 → 报「上次解析时生效」，不说「当前生效」', async () => {
  const { home, dir } = await uninstallFixture()
  // 真机现状：yaml 只有白名单，没有 minimumReleaseAge；state 缓存是 10-17 22:25 那次留下的
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
  - billion-context@0.1.181 || 0.1.185 || 0.1.187 || 0.1.198
allowBuilds:
  cloudflared: true
`)
  const scan = await scanProfile(dir, { home })
  assert.equal(scan.policy.minimumReleaseAge, 1440)
  assert.equal(scan.policy.configured, null)
  assert.equal(scan.policy.state, 1440)
  const text = scan.findings.join('\n')
  assert.match(text, /上一次安装解析时冷静期 1440 分钟生效（记于 2026-10-17T14:25:43\.315Z）/)
  assert.match(text, /当前 pnpm-workspace\.yaml 里没有 minimumReleaseAge/)
  assert.doesNotMatch(text, /冷静期 1440 分钟当前生效/)
  // 报告里也要把「配置」和「上次记录」分开写
  const report = formatReport([{ scan, actions: [], backups: [] }], { home })
  assert.match(report, /配置里 minimumReleaseAge=未设置；上次解析记录 1440（2026-10-17T14:25:43\.315Z）/)
  await rm(home, { recursive: true, force: true })
})

test('白名单改成整包豁免后不再报坎，只报漂移', async () => {
  const { home, dir } = await uninstallFixture()
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), `nodeLinker: hoisted
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - billion-context
allowBuilds:
  cloudflared: true
`)
  const scan = await scanProfile(dir, { home })
  const text = scan.findings.join('\n')
  assert.match(text, /白名单已覆盖 0\.1\.199，pnpm 不会因此报错/)
  assert.doesNotMatch(text, /ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED/)
  const steps = nextSteps([{ scan, actions: [], backups: [] }], { applied: false, uninstall: false, home })
  assert.doesNotMatch(steps.join('\n'), /方案 A/)
  await rm(home, { recursive: true, force: true })
})

test('staleExcludes 只留下白名单没覆盖到 manifest 版本的漂移包', () => {
  const drift = [
    { name: 'billion-context', manifest: '0.1.199', locked: '0.1.198' },
    { name: '@michengai/dsh-codex-ui', manifest: '1.1.31', locked: '1.1.30' },
    { name: 'dsh-context', manifest: '0.72.1', locked: '0.72.0' },
  ]
  // 没有策略 / 没有白名单：一条都不算覆盖
  assert.deepEqual(staleExcludes(null, drift).map((entry) => entry.name), ['billion-context', '@michengai/dsh-codex-ui', 'dsh-context'])
  const policy = {
    minimumReleaseAge: 1440,
    excludes: [
      'billion-context@0.1.181 || 0.1.185 || 0.1.187 || 0.1.198',
      "'@michengai/dsh-codex-ui@1.1.31'",
      'dsh-context@0.65.0 || 0.72.0',
    ],
  }
  assert.deepEqual(staleExcludes(policy, drift).map((entry) => entry.name), ['billion-context', 'dsh-context'])
  // 裸包名 = 整包豁免
  assert.deepEqual(staleExcludes({ minimumReleaseAge: 1440, excludes: ['billion-context'] }, drift).map((entry) => entry.name), ['@michengai/dsh-codex-ui', 'dsh-context'])
})

test('--apply --uninstall 清掉三条行的所有出现，无关行原样保留', async () => {
  const { home, dir, presetDir } = await uninstallFixture()
  const { scan, actions, backups } = await repairProfile(dir, { apply: true, uninstall: true, home })
  assert.equal(scan.legacyRows.length, 6)
  const patch = await readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.endsWith('\n'), true)
  assert.match(patch, /- id: ui-settings\n/)
  assert.match(patch, /- id: ui-chat\n/)
  assert.match(patch, /enabled: true/)
  assert.doesNotMatch(patch, /agi-supervisor-setup|preset-main-agent|agi-schedule|insert:/)
  assert.equal(findRowSpans(patch, BUNDLE_ROW_IDS).length, 0)
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(PACKAGE_NAME in pkg.dependencies, false)
  assert.deepEqual(pkg.dsh.profile.bundles, ['billion-context', 'other-bundle'])
  assert.equal(existsSync(presetDir), false)
  const presets = await readdir(path.join(home, '.agent-presets'))
  assert.equal(presets.length, 1)
  assert.match(presets[0], /^main-agent\.bak-/)
  assert.equal(existsSync(path.join(home, '.agent-presets', presets[0], 'main-agent.yml')), true)
  assert.equal(backups.length, 2)
  assert.equal(backups.some((file) => path.basename(file).startsWith('cordis.patch.yml.bak-')), true)
  assert.equal(backups.some((file) => path.basename(file).startsWith('package.json.bak-')), true)
  // lockfile 不动，但要在 actions 里交代
  assert.match(await readFile(path.join(dir, 'pnpm-lock.yaml'), 'utf8'), /billion-context/)
  assert.equal(actions.some((action) => /pnpm-lock\.yaml/.test(action)), true)
  await rm(home, { recursive: true, force: true })
})

test('漂移 profile 上 --uninstall 幂等：无新动作，漂移仍如实报出', async () => {
  const { home, dir } = await uninstallFixture()
  await repairProfile(dir, { apply: true, uninstall: true, home })
  const after = await scanProfile(dir, { home })
  assert.equal(after.legacyRows.length, 0)
  assert.equal(after.presetDir.exists, false)
  // 剩下唯一 finding 是只读诊断项：脚本刻意不碰 lockfile
  assert.equal(after.findings.length, 1)
  assert.match(after.findings[0], /billion-context 0\.1\.199 ≠ 0\.1\.198/)
  const again = await repairProfile(dir, { apply: true, uninstall: true, home })
  assert.deepEqual(again.actions, [])
  assert.deepEqual(again.backups, [])
  await rm(home, { recursive: true, force: true })
})

test('preset 目录只当信息收集：未安装时不误报（home 级共享）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-preset-'))
  const dir = path.join(home, 'profiles', 'desktop')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-desktop-profile', dsh: { profile: { bundles: [] } } }, null, 2)}\n`)
  const presetDir = path.join(home, '.agent-presets', PRESET_ID)
  await mkdir(presetDir, { recursive: true })
  const scan = await scanProfile(dir, { home })
  assert.equal(scan.state, '未安装')
  assert.equal(scan.presetDir.exists, true)
  assert.equal(scan.presetDir.path, presetDir)
  assert.deepEqual(scan.findings, [])
  // 报告里仍如实显示目录状态
  const report = formatReport([{ scan, actions: [], backups: [] }], { home })
  assert.match(report, /preset 目录：.*\.agent-presets.*main-agent（存在）/)
  await rm(home, { recursive: true, force: true })
})

test('nextSteps 给出可复制的方案 A/B，并点明脚本不动白名单', async () => {
  const { home, dir } = await uninstallFixture()
  const scan = await scanProfile(dir, { home })
  const results = [{ scan, actions: [], backups: [] }]
  const placeholder = nextSteps(results, { applied: true, uninstall: true, home }).join('\n')
  assert.match(placeholder, /# 方案 A（不动白名单）：DSH 完全退出后执行/)
  assert.match(placeholder, /"<node>" "<pnpm>" remove dsh-main-agent --config\.minimumReleaseAge=0/)
  assert.match(placeholder, /# 方案 B（推荐，长期有效）：在 pnpm-workspace\.yaml 的 minimumReleaseAgeExclude 里加整包豁免/)
  assert.match(placeholder, /^- "billion-context"$/m)
  assert.match(placeholder, /脚本本身不会改 pnpm-workspace\.yaml，也不会跑 pnpm/)
  assert.match(placeholder, /设置 → 插件 → 添加插件/)

  const deps = path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
  const node = path.join(deps, 'node', 'bin', 'node.exe')
  const pnpm = path.join(deps, 'pnpm', 'bin', 'pnpm.mjs')
  await mkdir(path.dirname(node), { recursive: true })
  await mkdir(path.dirname(pnpm), { recursive: true })
  await writeFile(node, '')
  await writeFile(pnpm, '')
  const detected = nextSteps(results, { applied: true, uninstall: true, home }).join('\n')
  assert.equal(detected.includes(`"${node}" "${pnpm}" remove dsh-main-agent --config.minimumReleaseAge=0`), true)
  await rm(home, { recursive: true, force: true })
})

test('CLI：只读诊断有 findings 时退出码 1，--apply --uninstall 之后只剩 pnpm 侧的漂移', async () => {
  const { home } = await uninstallFixture()
  const first = spawnSync(process.execPath, [SCRIPT, '--home', home], { encoding: 'utf8' })
  assert.equal(first.status, 1)
  assert.match(first.stdout, /本 bundle 的 patch 行：agi-supervisor-setup（第 6 行，顶层）/)
  assert.match(first.stdout, /billion-context 0\.1\.199 ≠ 0\.1\.198/)
  assert.match(first.stdout, /方案 A/)
  const second = spawnSync(process.execPath, [SCRIPT, '--home', home, '--apply', '--uninstall'], { encoding: 'utf8' })
  assert.equal(second.status, 0)
  const third = spawnSync(process.execPath, [SCRIPT, '--home', home], { encoding: 'utf8' })
  assert.equal(third.status, 1)
  assert.doesNotMatch(third.stdout, /本 bundle 的 patch 行/)
  assert.match(third.stdout, /billion-context 0\.1\.199 ≠ 0\.1\.198/)
  await rm(home, { recursive: true, force: true })
})
