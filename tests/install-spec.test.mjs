import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  classifyInstallSpec,
  diagnosePnpmLog,
  installCommand,
  normalizeInstallSpec,
  INSTALL_URL,
  PACKAGE_NAME,
} from '../scripts/install-spec.mjs'
import { INSTALL_URL as REPAIR_INSTALL_URL } from '../scripts/repair-profile.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/install-spec.mjs', import.meta.url))

const REAL_FAILURE = `
✓ Lockfile passes supply-chain policies (verified 3m ago)
Progress: resolved 13, reused 4, downloaded 0, added 0
[WARN] GET https://gitee.com/n-sky/dsh-main-agent error (ERR_PNPM_TARBALL_EXTRACT). Will retry in 10 seconds. 2 retries left
[ERR_PNPM_TARBALL_EXTRACT] Failed to add tarball from "https://gitee.com/n-sky/dsh-main-agent" to store: Invalid checksum for TAR header at offset 0. Expected NaN, got 47706
`

test('official install url already ends in .git and is classified as git', () => {
  assert.equal(INSTALL_URL, 'https://gitee.com/n-sky/dsh-main-agent.git')
  assert.equal(REPAIR_INSTALL_URL, INSTALL_URL, '两个脚本必须指向同一个安装地址')
  assert.equal(classifyInstallSpec(INSTALL_URL), 'git')
  const result = normalizeInstallSpec(INSTALL_URL)
  assert.equal(result.spec, INSTALL_URL)
  assert.equal(result.changed, false)
})

test('the browser address bar url gains the .git suffix', () => {
  const result = normalizeInstallSpec('https://gitee.com/n-sky/dsh-main-agent')
  assert.equal(result.spec, 'https://gitee.com/n-sky/dsh-main-agent.git')
  assert.equal(result.kind, 'git')
  assert.equal(result.changed, true)
  assert.match(result.note, /\.git/)
})

test('a trailing slash is dropped before the suffix is added', () => {
  assert.equal(normalizeInstallSpec('https://gitee.com/n-sky/dsh-main-agent/').spec, INSTALL_URL)
  assert.equal(normalizeInstallSpec('https://gitee.com/n-sky/dsh-main-agent.git/').spec, INSTALL_URL)
})

test('a page url collapses to owner/repo instead of keeping /tree/<branch>', () => {
  assert.equal(
    normalizeInstallSpec('https://github.com/dat-lequoc/dsh-supervisor/tree/main/lib').spec,
    'https://github.com/dat-lequoc/dsh-supervisor.git',
  )
  assert.equal(
    normalizeInstallSpec('https://gitee.com/n-sky/dsh-main-agent/blob/master/README.md').spec,
    INSTALL_URL,
  )
})

test('a branch or tag fragment survives normalisation', () => {
  const result = normalizeInstallSpec('https://gitee.com/n-sky/dsh-main-agent#v0.12.2')
  assert.equal(result.spec, 'https://gitee.com/n-sky/dsh-main-agent.git#v0.12.2')
})

test('specs that pnpm already treats as git are left untouched', () => {
  for (const spec of [
    'git+https://gitee.com/n-sky/dsh-main-agent.git',
    'git+ssh://git@gitee.com/n-sky/dsh-main-agent.git',
    'git@github.com:dat-lequoc/dsh-supervisor.git',
    'github:dat-lequoc/dsh-supervisor',
    'gitlab:owner/repo',
  ]) {
    assert.equal(classifyInstallSpec(spec), 'git', spec)
    const result = normalizeInstallSpec(spec)
    assert.equal(result.spec, spec)
    assert.equal(result.changed, false)
  }
})

test('alias schemes other than git are not rewritten', () => {
  for (const spec of ['npm:lodash@4', 'workspace:^', 'link:../pkg', 'jsr:@scope/pkg']) {
    assert.equal(classifyInstallSpec(spec), 'alias', spec)
    assert.equal(normalizeInstallSpec(spec).spec, spec)
  }
})

test('local paths keep working and get the file: prefix pnpm expects', () => {
  const cwd = normalizeInstallSpec('.')
  assert.equal(cwd.kind, 'local')
  assert.equal(cwd.spec, 'file:.')

  const absolute = normalizeInstallSpec('/home/u/src/dsh-main-agent')
  assert.equal(absolute.spec, 'file:/home/u/src/dsh-main-agent')

  const windows = normalizeInstallSpec('E:\\Ai-project\\dsh-main-agent')
  assert.equal(windows.kind, 'local')
  assert.equal(windows.spec, 'file:E:\\Ai-project\\dsh-main-agent')

  const already = normalizeInstallSpec('file:/home/u/src/dsh-main-agent')
  assert.equal(already.spec, 'file:/home/u/src/dsh-main-agent')
  assert.equal(already.changed, false)
})

test('a real tarball url is recognised instead of being suffixed', () => {
  for (const spec of [
    'https://example.com/pkgs/dsh-main-agent-0.12.2.tgz',
    'https://example.com/pkgs/dsh-main-agent-0.12.2.tar.gz',
  ]) {
    assert.equal(classifyInstallSpec(spec), 'tarball', spec)
    const result = normalizeInstallSpec(spec)
    assert.equal(result.spec, spec)
    assert.equal(result.kind, 'tarball')
  }
})

test('empty input is rejected with an actionable message', () => {
  assert.throws(() => normalizeInstallSpec(''), /安装地址为空/)
  assert.throws(() => normalizeInstallSpec('   '), /安装地址为空/)
  assert.throws(() => normalizeInstallSpec(null), /安装地址为空/)
})

test('unrecognised schemes are reported, not silently rewritten', () => {
  const result = normalizeInstallSpec('dat-lequoc/dsh-supervisor')
  assert.equal(result.kind, 'unknown')
  assert.equal(result.spec, 'dat-lequoc/dsh-supervisor')
  assert.equal(result.changed, false)
})

test('the reported pnpm failure is diagnosed back to the .git url', () => {
  const found = diagnosePnpmLog(REAL_FAILURE)
  assert.ok(found, '应当认出这条错')
  assert.equal(found.code, 'ERR_PNPM_TARBALL_EXTRACT')
  assert.equal(found.url, 'https://gitee.com/n-sky/dsh-main-agent')
  assert.equal(found.suggestion, INSTALL_URL)
  assert.match(found.message, /tarball/)
  assert.match(found.message, /\.git/)
})

test('a tarball failure that is not a repo url still gets an explanation', () => {
  const found = diagnosePnpmLog(
    'ERR_PNPM_TARBALL_EXTRACT Failed to add tarball from "https://example.com/x.tgz" to store: Invalid checksum for TAR header',
  )
  assert.ok(found)
  assert.equal(found.url, 'https://example.com/x.tgz')
  assert.equal(found.suggestion, 'https://example.com/x.tgz')
  assert.match(found.message, /\.tgz/)
})

test('unrelated logs are not diagnosed', () => {
  assert.equal(diagnosePnpmLog(''), null)
  assert.equal(diagnosePnpmLog('ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile'), null)
  assert.equal(diagnosePnpmLog('Done in 4.6s using pnpm v11.28.5'), null)
  assert.equal(diagnosePnpmLog(undefined), null)
})

test('install command is produced for a profile', () => {
  assert.equal(
    installCommand(INSTALL_URL, { profile: 'desktop' }),
    'dsh plugin --profile desktop add https://gitee.com/n-sky/dsh-main-agent.git',
  )
})

test('cli prints the normalised spec', () => {
  const run = spawnSync(process.execPath, [SCRIPT, 'https://gitee.com/n-sky/dsh-main-agent'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim(), INSTALL_URL)
})

test('cli prints a full install command with --profile', () => {
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--profile', 'desktop', 'https://gitee.com/n-sky/dsh-main-agent'],
    { encoding: 'utf8' },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim(), `dsh plugin --profile desktop add ${INSTALL_URL}`)
})

test('cli --json reports kind, spec and the change flag', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--json', 'https://gitee.com/n-sky/dsh-main-agent'], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  const payload = JSON.parse(run.stdout)
  assert.equal(payload.spec, INSTALL_URL)
  assert.equal(payload.kind, 'git')
  assert.equal(payload.changed, true)
})

test('cli --diagnose reads a log file and prints the fix', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--diagnose', '-'], { input: REAL_FAILURE, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /\.git/)
  assert.match(run.stdout, /gitee\.com\/n-sky\/dsh-main-agent\.git/)
})

test('cli --diagnose exits 1 when the log holds no such failure', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--diagnose', '-'], { input: 'all good\n', encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stdout, /没有在这段日志里找到/)
})

test('package name stays the install identity pnpm keys on', () => {
  assert.equal(PACKAGE_NAME, 'dsh-main-agent')
})
