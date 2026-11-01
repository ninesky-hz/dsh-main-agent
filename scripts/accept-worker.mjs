#!/usr/bin/env node
/**
 * dsh-main-agent — 给一个已核验过的 worker 盖「验收通过」章。
 *
 *   npm run accept -- <sessionId 或目录名> [备注...]
 *
 * 为什么需要这条命令：worker 会在 `outcome.md` 里自述 `<!-- report: ready -->`
 * —— 意思是「我做完了，等人验收」。它无从知道 Lead 验收了没有，于是六态里永远
 * 停在 `ready`，BRIEF 就永久挂一条「person/review → 等用户验收」去误导主 Agent。
 * 归档是**验收方**写下的事实，落在 `.agi/subagents/<id>/archived.json`：
 * `{"ts":"…","by":"lead","note":"…"}`。`lib/stage.js` 见到它一律判 `ended/archived`。
 *
 * 幂等：同一份备注重复跑不会重写文件，也不会把首次的 `ts` 刷成现在。
 */

import { archiveWorker, ARCHIVE_FILE, shortWorkerId } from '../lib/report.js'

const USAGE = '用法：npm run accept -- <sessionId 或目录名> [备注...]'

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error(USAGE)
  process.exit(2)
}

const [sessionId, ...rest] = argv
const note = rest.join(' ').trim()

// 备注缺省也写一句 —— 空 note 会让「为什么归档」这条信息永久丢失。
const result = archiveWorker(process.cwd(), sessionId, note.length > 0 ? note : 'Lead 已核验')

if (!result.ok) {
  console.error(`✗ 归档失败：${result.error}`)
  console.error(`  （BRIEF 里显示为 \`${shortWorkerId(sessionId)}\`；目录必须已存在于 .agi/subagents/ 下）`)
  process.exit(1)
}

const { written, path, record } = result
console.log(`${written ? '✓ 已归档' : '• 已是最新（未重写）'} ${shortWorkerId(sessionId)}`)
console.log(`  文件：${path}`)
console.log(`  内容：${JSON.stringify(record)}（${ARCHIVE_FILE}：ts / by / note）`)
console.log('  下次 watchdog 醒来时 BRIEF 里这一行会变成 ended/archived → 已验收归档，无需处理。')
