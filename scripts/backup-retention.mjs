/**
 * dsh-main-agent — 备份保留策略。
 *
 * `sync-profile --apply` 的每一次同步都会先把目标整目录 `cpSync` 成
 * `$DSH_HOME/dsh-main-agent-backup-<ISO 时间戳>/<label>/`。备份本身是对的（同步
 * 改的是宿主真正执行的那份文件，没有备份就等于不可回滚），但它**永不清理**：
 * 实测一个工作区里积了 4 份、117 个文件、1.96 MB，每跑一次再多一份全量拷贝。
 *
 * 这里只做一件事：把「明显不需要了」的旧备份删掉，留下最近几份。三条硬约束
 * 全部来自「删错了不可逆」：
 *
 *  - **只认严格命名的目录**：`dsh-main-agent-backup-<ISO>`。名字里多一个字、少
 *    一个数字都不碰 —— 用户在同一个 home 下可能有自己手工建的 `...-backup-old`，
 *    那不该被这个脚本理解成「过期备份」。
 *  - **必须直接位于 `DSH_HOME` 下**。`dirname(abs) === home` 而不是「在 home 的
 *    某层子树里」，避免把别处的同名目录一起卷进来。
 *  - **只删目录，且逐个 try/catch**。某个目录被占用（Windows 上很常见）就跳过，
 *    绝不因为清理失败让同步本身报错。
 *
 * 名字里的时间戳是 `new Date().toISOString().replace(/[:.]/g, '-')`，即
 * `2024-05-06T07-08-09-012Z` —— 这种格式的**字典序等于时间序**，所以排序不需要
 * 解析日期（解析反而会引入时区与格式兼容问题）。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 备份目录名。时间戳固定为 24 字符的 ISO（毫秒精度，`:`/`.` 换成 `-`）。
 *
 * 刻意写死这个形状而不是「以前缀开头就算」：前缀匹配会把用户手工建的
 * `dsh-main-agent-backup-before-refactor` 也算成备份，然后删掉它。
 */
export const BACKUP_DIR_PATTERN = /^dsh-main-agent-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

/** 默认保留份数。3 份够覆盖「今天改坏了，退回今天早上那一版」。 */
export const DEFAULT_KEEP_BACKUPS = 3

/** @param {string} name @returns {boolean} */
export function isBackupDirName(name) {
  return typeof name === 'string' && BACKUP_DIR_PATTERN.test(name)
}

/**
 * 列出 `home` 下所有**符合命名规则**的备份目录名，按名字（= 时间）升序。
 *
 * 升序是为了让调用方直接 `slice(-keep)` 得到「最近 keep 份」；升序也让人读日志
 * 时自然地从旧到新。
 *
 * @param {string} home `DSH_HOME`
 * @returns {string[]} 目录名（不是绝对路径），升序；`home` 不存在时返回 `[]`
 */
export function listBackups(home) {
  if (typeof home !== 'string' || home.length === 0) return []
  const root = resolve(home)
  let names
  try {
    names = readdirSync(root, { withFileTypes: true })
  } catch {
    // home 不存在 = 还没有任何备份，这不是错误。
    return []
  }
  const out = []
  for (const entry of names) {
    if (!isBackupDirName(entry.name)) continue
    // `withFileTypes` 在部分网络/虚拟文件系统上会给不出类型，回落到 stat。
    const abs = join(root, entry.name)
    if (!entry.isDirectory() && !(existsSync(abs) && statSync(abs).isDirectory())) continue
    // 双保险：解析后必须仍然直接挂在 home 下（挡掉符号链接跳走的情形）。
    if (dirname(abs) !== root) continue
    out.push(entry.name)
  }
  out.sort()
  return out
}

/**
 * 删掉超出保留份数的旧备份。
 *
 * @param {string} home `DSH_HOME`
 * @param {number} [keep] 保留最近几份；`0` 表示一份都不删（不是「全删」）
 * @returns {{ removed: string[], kept: string[] }} 绝对路径
 */
export function pruneBackups(home, keep = DEFAULT_KEEP_BACKUPS) {
  const root = typeof home === 'string' && home.length > 0 ? resolve(home) : undefined
  // 容忍数字字符串：调用方可能直接把 argv 里的原始值递进来（`--keep 5`）。
  const wanted = typeof keep === 'string' && keep.trim() !== '' ? Number(keep) : keep
  const keepCount = Number.isInteger(wanted) && wanted >= 0 ? wanted : DEFAULT_KEEP_BACKUPS
  if (root === undefined) return { removed: [], kept: [] }
  // `--keep 0` 的语义是「这次不清理」，而不是「把备份全删光」—— 让人误以为自己
  // 清空了自己唯一的回滚点时，代价太大了。
  if (keepCount === 0) return { removed: [], kept: listBackups(root).map(name => join(root, name)) }

  const names = listBackups(root)
  const keptNames = names.slice(-keepCount)
  const removable = keepCount >= names.length ? [] : names.slice(0, names.length - keepCount)

  const removed = []
  for (const name of removable) {
    const abs = join(root, name)
    try {
      rmSync(abs, { recursive: true, force: true })
      removed.push(abs)
    } catch {
      // 被占用/权限不足：留到下次，但绝不让同步本身失败。
    }
  }
  return { removed, kept: keptNames.map(name => join(root, name)) }
}
