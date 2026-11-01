/**
 * 备份保留策略的测试。
 *
 * 被测对象是 `scripts/backup-retention.mjs`（纯函数，不碰真 profile）。为什么
 * 单独一个模块：`scripts/sync-profile.mjs` 结尾是 `try { main() }`，**导入即执行**，
 * 测试没法直接 import；把「哪些目录算备份、留几份」抽出来，才可以在临时目录里
 * 造 5 个假备份验证删除行为，而不碰到用户真实的 `$DSH_HOME`。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_KEEP_BACKUPS,
  isBackupDirName,
  listBackups,
  pruneBackups,
} from '../scripts/backup-retention.mjs'

/**
 * 造一个临时 home。
 *
 * 与 `tests/report.test.mjs` 同一套理由：DSH 沙箱可能整个挡掉系统临时目录
 * （本机实测 `EPERM mkdtemp 'C:\\Users\\…\\Temp\\…'`），被拒就退回工作区的
 * `.test-tmp/`，两条路径都用独立的 mkdtemp 名字，并行跑测试也不会互踩。
 */
function mkdtempAnywhere(prefix) {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    const base = join(process.cwd(), '.test-tmp')
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, prefix))
  }
}

/** 备份目录名：ISO 时间戳里的 `:`/`.` 都换成 `-`（与 sync-profile 的 `stamp()` 一致）。 */
const backupName = iso => `dsh-main-agent-backup-${iso.replace(/[:.]/g, '-')}`

/** 造一个「像备份」的目录（里面放个文件，证明整目录递归删干净）。 */
function mkBackup(home, name, body = 'x\n') {
  const dir = join(home, name)
  mkdirSync(join(dir, 'profile-desktop'), { recursive: true })
  writeFileSync(join(dir, 'profile-desktop', 'package.json'), body, 'utf8')
  return dir
}

/** 造 5 个时间递增的备份 + 1 个名字不匹配目录 + 1 个普通文件。 */
function seed(home) {
  const backups = [
    '2024-05-01T00-00-00-000Z',
    '2024-05-02T00-00-00-000Z',
    '2024-05-03T00-00-00-000Z',
    '2024-05-04T00-00-00-000Z',
    '2024-05-05T00-00-00-000Z',
  ].map(iso => mkBackup(home, backupName(iso)))
  // 名字不匹配的三类：手工起的名字、时间戳形状不对、前缀不同。
  const manual = mkBackup(home, 'dsh-main-agent-backup-before-refactor')
  const shortStamp = mkBackup(home, 'dsh-main-agent-backup-2024-05-06')
  const otherPrefix = mkBackup(home, 'other-backup-2024-05-07T00-00-00-000Z')
  const looseFile = join(home, backupName('2024-05-08T00-00-00-000Z'))
  writeFileSync(looseFile, '我不是目录\n', 'utf8')
  return { backups, manual, shortStamp, otherPrefix, looseFile }
}

test('isBackupDirName：只认严格的 ISO 时间戳形状', () => {
  assert.equal(isBackupDirName(backupName('2024-05-06T07-08-09-012Z')), true)
  // 拒绝的六类 —— 这些在真实 home 里都出现过。
  assert.equal(isBackupDirName('dsh-main-agent-backup'), false)
  assert.equal(isBackupDirName('dsh-main-agent-backup-before-refactor'), false)
  assert.equal(isBackupDirName('dsh-main-agent-backup-2024-05-06'), false)
  assert.equal(isBackupDirName('dsh-main-agent-backup-2024-05-06T07-08-09Z'), false, '毫秒位不能省')
  assert.equal(isBackupDirName('dsh-main-agent-backup-2024-05-06T07-08-09-0123Z'), false)
  assert.equal(isBackupDirName('x-dsh-main-agent-backup-2024-05-06T07-08-09-012Z'), false)
  assert.equal(isBackupDirName(undefined), false)
})

test('listBackups：只列匹配的目录，升序（字典序 = 时间序）', () => {
  const home = mkdtempAnywhere('backup-list-')
  try {
    const { backups, manual, shortStamp, otherPrefix, looseFile } = seed(home)
    const listed = listBackups(home)
    assert.deepEqual(listed, backups.map(dir => dir.split(/[\\/]/).pop()))
    // 三个不匹配的目录 + 一个同名文件都不在名单里。
    for (const path of [manual, shortStamp, otherPrefix, looseFile]) {
      assert.equal(listed.includes(path.split(/[\\/]/).pop()), false)
    }
    // home 不存在时给空数组，不抛。
    assert.deepEqual(listBackups(join(home, 'nope')), [])
    assert.deepEqual(listBackups(''), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pruneBackups：保留最近 3 份，删掉更老的，名字不匹配的原样留下', () => {
  const home = mkdtempAnywhere('backup-prune-')
  try {
    const { backups, manual, shortStamp, otherPrefix, looseFile } = seed(home)
    const { removed, kept } = pruneBackups(home, DEFAULT_KEEP_BACKUPS)

    assert.equal(DEFAULT_KEEP_BACKUPS, 3)
    assert.equal(kept.length, 3)
    assert.equal(removed.length, 2)
    // 留下的必须是最近三份（05-03 / 04 / 05）。
    assert.deepEqual(kept.sort(), backups.slice(-3).sort())
    // 删掉的必须是最老两份（05-01 / 02），且整目录递归删干净。
    assert.deepEqual(removed.sort(), backups.slice(0, 2).sort())
    for (const dir of removed) assert.equal(existsSync(dir), false)
    for (const dir of kept) assert.equal(existsSync(join(dir, 'profile-desktop', 'package.json')), true)
    // 关键：不匹配的目录与文件一个都不能少。
    for (const path of [manual, shortStamp, otherPrefix, looseFile]) {
      assert.equal(existsSync(path), true, `${path} 不在清理范围里，必须原样保留`)
    }
    assert.equal(readdirSync(home).length, 7, '3 份备份 + 3 个不匹配目录 + 1 个文件 = 7 项，删了 2 个')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pruneBackups：keep 大于实际份数时一个都不删', () => {
  const home = mkdtempAnywhere('backup-loose-')
  try {
    const { backups } = seed(home)
    const { removed, kept } = pruneBackups(home, 10)
    assert.deepEqual(removed, [])
    assert.equal(kept.length, backups.length)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pruneBackups：--keep 0 的语义是「这次不清理」，不是「全删光」', () => {
  const home = mkdtempAnywhere('backup-keep0-')
  try {
    const { backups } = seed(home)
    const { removed, kept } = pruneBackups(home, 0)
    assert.deepEqual(removed, [], 'keep=0 必须一份都不删（否则用户一次误操作就清掉了回滚点）')
    assert.equal(kept.length, backups.length)
    for (const dir of backups) assert.equal(existsSync(dir), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pruneBackups：非法 keep 退回默认 3 份，绝不退化成「删光」', () => {
  // `undefined` 会命中默认参数、`''` 会退化成默认值 —— 都等价于「正常清理到 3 份」。
  // 这里钉住的是：**非法输入的结果是有界的**（剩 3 份），不是「一份不剩」。
  for (const bad of [Number.NaN, -1, 1.5, 'abc', Infinity, undefined, '']) {
    // 每个取值都用一份全新的 home：清理是幂等的，共用目录会被前一轮的结果污染。
    const home = mkdtempAnywhere('backup-bad-')
    try {
      const { backups } = seed(home)
      const { removed, kept } = pruneBackups(home, bad)
      assert.equal(kept.length, DEFAULT_KEEP_BACKUPS, `keep=${String(bad)} 应退回默认 ${DEFAULT_KEEP_BACKUPS} 份`)
      assert.equal(removed.length, backups.length - DEFAULT_KEEP_BACKUPS)
      // 留下的必须是最近的那几份，而不是随机留下的。
      assert.deepEqual(kept.sort(), backups.slice(-DEFAULT_KEEP_BACKUPS).sort())
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('pruneBackups：数字字符串按数字处理（argv 的原始值可以直接递进来）', () => {
  const home = mkdtempAnywhere('backup-coerce-')
  try {
    const { backups } = seed(home)
    const { removed, kept } = pruneBackups(home, '3')
    assert.equal(kept.length, 3)
    assert.deepEqual(removed.sort(), backups.slice(0, 2).sort())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pruneBackups：home 不存在 / 空值时给空结果，不抛', () => {
  const home = mkdtempAnywhere('backup-none-')
  try {
    assert.deepEqual(pruneBackups(join(home, 'nope'), 3), { removed: [], kept: [] })
    assert.deepEqual(pruneBackups('', 3), { removed: [], kept: [] })
    assert.deepEqual(pruneBackups(undefined, 3), { removed: [], kept: [] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
