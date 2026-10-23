#!/usr/bin/env node
/**
 * inject-supervisor.mjs — 把「监督循环」注入任意官方 agent preset。
 *
 * 原理
 * ----
 * dsh 的每个 preset 都是一个 `@deepseek-ai/dsh-agent-preset` loader entry，
 * 它的 `config.plugins` 是一份完整的插件行数组。profile 的
 * `cordis.patch.yml` 可以按 **entry id** 覆盖这个 entry —— 官方
 * `standard.patch.yml` 的注释原文：
 *
 *   "Edits saved from the Web editor override this row's `config.plugins`
 *    by id from the profile patch."
 *
 * 也就是说配置层本来就是为这件事留的口子，不需要改 node_modules。
 *
 * 而 standard 与 main-agent 的 delegation group **结构同构**，真正的差别只有：
 *   tool-goal                @deepseek-ai/dsh-tool-goal        → dsh-main-agent/goal
 *   tool-subagent-control    @deepseek-ai/dsh-tool-subagent-control → dsh-main-agent/control
 *   tool-subagent            @deepseek-ai/dsh-tool-subagent     → dsh-main-agent/spawn (+ persona)
 *   persona.config.prefix    ""                                 → 监督者人格
 * standard 反而比 main-agent **多** tool-schedule 和 tool-subagent-fork。
 *
 * 所以本脚本做的是：搬 plugins 数组 → 改 4 处 → 换 persona → 写进 profile patch。
 *
 * 用法
 * ----
 *   node scripts/inject-supervisor.mjs --target standard --dry-run
 *   node scripts/inject-supervisor.mjs --target standard --write
 *   node scripts/inject-supervisor.mjs --target standard --write --revert
 *
 * 生效：改完 profile patch 后重启 DSH（client bundle 与 preset mount 都在启动期）。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// ── 监督者人格（最小集，够跑循环，不搬 main-agent 那 166 行）────────────────

const SUPERVISOR_PERSONA = `你是一名常驻监督者。你的工作是让一个目标持续前进，而不是亲自把它做完。

## 目标
首轮先用 start_goal 锁定一个可验收的目标：终点是什么、怎么算完成、哪些不做。
没有锁定目标之前，不要派生任何 worker。

## 状态
所有持久状态落在工作区的 .agi/ 目录，不要依赖对话记忆：
- .agi/GOAL.md         目标与验收标准（人可读的单一事实源）
- .agi/progress.jsonl  进度事件，一行一条
- .agi/questions.jsonl 只有需要用户拍板才写
- .agi/changelog.md    已完成的变更
- .agi/notes.md        跨回合要记住的判断与教训
每次唤醒先读这些文件，再决定下一步。

## 循环
1. 读 .agi/ 现状，判断距离目标还差什么。
2. 派生子代理执行一个自包含、能一次做完的任务；任务描述必须完整，
   假定 worker 看不到你的对话。
3. 自己休眠，不要轮询。
4. 在 worker 收敛、报告、或定时器触发时唤醒。
5. 检查产出：通过就推进下一步；偏了就用 send_message 纠偏或终止重派；
   目标达成或无法推进就终止并写 mission report。
6. 仍有 worker 在跑，回到第 3 步。

## 定时器
等待期不要空转。用 schedule_create 建一条巡检提醒，唤醒后重排。
目标达成或终止时，删掉所有提醒。

## 边界
- 不替 worker 做它的活；你的产出是决策、任务描述与验收。
- 只有真正需要用户拍板的事才进 questions.jsonl，其余自己决定。
- 每次唤醒都重新验证，不要因为「上次看着对」就跳过检查。`

const DEV_AGENT_PERSONA = `你是一名 Dev Agent：常驻监督者之下的专注 worker。
你的任务随首条消息送达，内容完整、自包含；严格待在其范围内。
- 你没有直接向用户提问的渠道。report 工具就是你向监督者提问的渠道。
  若被只有监督者或用户掌握的信息阻塞，调用 report 给出准确问题，
  然后停止工作，直到答案作为你的下一轮到来。不要在这个子会话里等答案。
- 完成时：在任务指定的路径写 outcome.md（做了什么、验证了什么、还剩什么），
  然后报告一段话的总结。
- 任务进行中收到的监督者消息是纠偏：它们在你的下一步汇入 —— 立即遵从，
  不要先把原计划做完。
- 除非任务允许，不要自己派生 subagent。`

// ── 路径探测 ────────────────────────────────────────────────────────────────

function findDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function findAppRoot(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_APP_ROOT,
    'D:/DeepSeek Harness/resources/app/dsh',
    join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app/dsh'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, 'node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'))) return c
  }
  throw new Error(
    `找不到 dsh 应用目录（含 node_modules/@deepseek-ai/dsh-web-app/presets/）。` +
    `用 --app-root 指定，或设 DSH_APP_ROOT。已尝试：\n  ${candidates.join('\n  ')}`,
  )
}

function findProfilePatch(home) {
  const profiles = join(home, 'profiles')
  const preferred = join(profiles, 'desktop/cordis.patch.yml')
  if (existsSync(preferred)) return preferred
  throw new Error(`找不到 profile patch：${preferred}`)
}

// ── plugins 块提取与改写 ────────────────────────────────────────────────────

const PLUGINS_HEADER = /^ {8}plugins:\s*$/

/** 从官方 preset patch 里取出 `plugins:` 之后、直到文件末尾的整块文本。 */
function extractPluginsBlock(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => PLUGINS_HEADER.test(l))
  if (start < 0) throw new Error('官方 preset 里找不到 8 空格缩进的 `plugins:` 行')
  return lines.slice(start + 1)
}

/** 把官方缩进（plugins 子项 10 空格）降为 profile 缩进（6 空格）。 */
function reindent(lines) {
  return lines.map(l => (l.startsWith('          ') ? l.slice(4) : l))
}

/** 4 处语义替换。以「- id: X」为锚点定位，避免误伤同名字符串。 */
function transform(block, target) {
  const out = []
  let i = 0

  while (i < block.length) {
    const line = block[i]
    const idMatch = /^(\s*)- id: (\S+)\s*$/.exec(line)

    if (!idMatch) { out.push(line); i++; continue }

    const indent = idMatch[1]
    const id = idMatch[2]
    out.push(line)
    i++

    // 收齐这一行的后续（直到下一个同级 "- id:" 或更浅缩进）
    const body = []
    while (i < block.length) {
      const next = block[i]
      if (/^\s*- id: /.test(next) && /^(\s*)/.exec(next)[1].length <= indent.length) break
      if (next.trim() !== '' && /^(\s*)/.exec(next)[1].length < indent.length) break
      body.push(next)
      i++
    }

    // ── persona：空 prefix → 监督者人格 ──
    if (id === 'persona') {
      const at = body.findIndex(l => /^\s*prefix:\s*""\s*$/.test(l))
      if (at >= 0) {
        const pad = /^(\s*)/.exec(body[at])[1] + '  '
        body.splice(at, 1, `${/^(\s*)/.exec(body[at])[1]}prefix: |`, ...SUPERVISOR_PERSONA.split('\n').map(l => (l ? pad + l : '')))
      } else {
        const cfgAt = body.findIndex(l => /^\s*config:\s*$/.test(l))
        if (cfgAt >= 0) {
          const pad = /^(\s*)/.exec(body[cfgAt])[1] + '  '
          body.splice(cfgAt + 1, 0, ...['prefix: |', ...SUPERVISOR_PERSONA.split('\n')].map(l => (l ? pad + l : '')))
        }
      }
    }

    // ── tool-goal：原生 → dsh-main-agent/goal ──
    if (id === 'tool-goal') {
      const at = body.findIndex(l => /name:\s*'@deepseek-ai\/dsh-tool-goal'/.test(l))
      if (at >= 0) body[at] = body[at].replace(/'@deepseek-ai\/dsh-tool-goal'/, 'dsh-main-agent/goal')
    }

    // ── tool-subagent-control：原生 → dsh-main-agent/control ──
    if (id === 'tool-subagent-control') {
      const at = body.findIndex(l => /name:\s*'@deepseek-ai\/dsh-tool-subagent-control'/.test(l))
      if (at >= 0) body[at] = body[at].replace(/'@deepseek-ai\/dsh-tool-subagent-control'/, 'dsh-main-agent/control')
    }

    // ── tool-subagent：原生 spawn → dsh-main-agent/spawn（带 Dev Agent 人格）──
    if (id === 'tool-subagent') {
      const at = body.findIndex(l => /name:\s*'@deepseek-ai\/dsh-tool-subagent'/.test(l))
      if (at >= 0) {
        body[at] = body[at].replace(/'@deepseek-ai\/dsh-tool-subagent'/, 'dsh-main-agent/spawn')
        // 在 config: 块末尾追加 persona
        const cfgAt = body.findIndex(l => /^\s*config:\s*$/.test(l))
        if (cfgAt >= 0) {
          const cfgIndent = /^(\s*)/.exec(body[cfgAt])[1]
          const pad = cfgIndent + '  '
          // 找到 config 块结束位置
          let end = body.length
          for (let k = cfgAt + 1; k < body.length; k++) {
            if (body[k].trim() !== '' && /^(\s*)/.exec(body[k])[1].length <= cfgIndent.length) { end = k; break }
          }
          if (!body.slice(cfgAt, end).some(l => /^\s*persona:/.test(l))) {
            body.splice(end, 0,
              `${pad}persona: |`,
              ...DEV_AGENT_PERSONA.split('\n').map(l => (l ? pad + '  ' + l : '')))
          }
        }
      }
    }

    // group 的 config 是数组（cordis:group），里面还藏着 tool-subagent 等行，
    // 必须递归进去改，否则 delegation 内部的行会被整块吞掉。
    const cfgIdx = body.findIndex(l => /^\s*config:\s*$/.test(l))
    if (cfgIdx >= 0) {
      const cfgIndent = /^(\s*)/.exec(body[cfgIdx])[1].length
      let childStart = -1
      for (let k = cfgIdx + 1; k < body.length; k++) {
        const m = /^(\s*)- id: /.exec(body[k])
        if (m && m[1].length > cfgIndent) { childStart = k; break }
        if (body[k].trim() !== '' && /^(\s*)/.exec(body[k])[1].length <= cfgIndent) break
      }
      if (childStart >= 0) {
        const childLines = body.slice(childStart)
        body.splice(childStart, childLines.length, ...transform(childLines, target))
      }
    }

    out.push(...body)
  }

  return out
}

// ── profile patch 幂等写入 ──────────────────────────────────────────────────

const ENTRY_ID = target => `preset-${target}`

function buildEntry(target, pluginsLines, asNew) {
  if (asNew) {
    // 新增 preset：包在 `- insert:` 下，id 换成 asNew（不能沿用 builtin id，
    // registry 对同 id 重复注册会抛 `Duplicate agent preset`）。
    return [
      `- insert:`,
      `    - id: preset-${asNew}`,
      `      name: '@deepseek-ai/dsh-agent-preset'`,
      `      config:`,
      `        id: ${asNew}`,
      `        order: 5`,
      `        plugins:`,
      ...pluginsLines.map(l => '  ' + l),
    ].join('\n')
  }
  return [
    `- id: ${ENTRY_ID(target)}`,
    `  name: '@deepseek-ai/dsh-agent-preset'`,
    `  config:`,
    `    id: ${target}`,
    `    order: 1`,
    `    plugins:`,
    ...pluginsLines,
  ].join('\n')
}

/** 删掉 profile patch 里已有的同名 entry 块（到下一个顶层 `- ` 为止）。 */
function stripEntry(text, target) {
  const lines = text.split('\n')
  const head = `- id: ${ENTRY_ID(target)}`
  const start = lines.findIndex(l => l.trim() === head)
  if (start < 0) return { text, found: false }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { end = i; break }
  }
  lines.splice(start, end - start)
  return { text: lines.join('\n'), found: true }
}

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { target: 'standard', write: false, revert: false, dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') args.target = argv[++i]
    else if (a === '--write') args.write = true
    else if (a === '--revert') args.revert = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--app-root') args.appRoot = argv[++i]
    else if (a === '--as-new') args.asNew = argv[++i]
    else if (a === '--help' || a === '-h') { console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); process.exit(0) }
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv)
  const home = findDshHome()
  const patchPath = findProfilePatch(home)

  if (args.revert) {
    const before = readFileSync(patchPath, 'utf8')
    const { text, found } = stripEntry(before, args.asNew || args.target)
    if (!found) { console.log(`profile patch 里没有 ${ENTRY_ID(args.asNew || args.target)}，无需回滚`); return }
    if (!args.dryRun) {
      copyFileSync(patchPath, patchPath + '.bak')
      writeFileSync(patchPath, text)
    }
    console.log(`${args.dryRun ? '[dry-run] 将' : ''}移除 ${ENTRY_ID(args.asNew || args.target)} 覆盖块`)
    console.log(`备份：${patchPath}.bak`)
    return
  }

  const appRoot = findAppRoot(args.appRoot)
  const official = join(appRoot, 'node_modules/@deepseek-ai/dsh-web-app/presets', `${args.target}.patch.yml`)
  if (!existsSync(official)) throw new Error(`官方 preset 不存在：${official}`)

  const block = transform(reindent(extractPluginsBlock(readFileSync(official, 'utf8'))), args.target)
  const entry = buildEntry(args.target, block, args.asNew)

  const before = readFileSync(patchPath, 'utf8')
  const { text: stripped } = stripEntry(before, args.asNew || args.target)
  const after = stripped.trimEnd() + '\n\n# ── 注入：监督循环进入 ' + args.target + ' ───────────────────────────\n' + entry + '\n'

  const changedLine = /name:\s*dsh-main-agent\/goal/.test(entry)
  const spawnLine = /name:\s*dsh-main-agent\/spawn/.test(entry)
  const personaLine = /supervisor|监督者/.test(entry)
  console.log(`target      : ${args.target}${args.asNew ? '  (新增为 ' + args.asNew + ')' : ''}`)
  console.log(`官方源      : ${official}`)
  console.log(`profile     : ${patchPath}`)
  console.log(`plugins 行  : ${block.length}`)
  console.log(`注入检查    : goal=${changedLine} spawn=${spawnLine} persona=${personaLine}`)
  if (!changedLine || !spawnLine || !personaLine) {
    console.log('\n──── 生成结果（结构不完整，仅供参考）────\n')
    console.log(entry)
    throw new Error('改写结果不完整 —— 官方 preset 结构可能已变化，请检查上面的三项目标')
  }

  if (args.dryRun || !args.write) {
    console.log('\n──── 生成结果（未写入）────\n')
    console.log(entry)
    console.log('\n加 --write 写入并备份。')
    return
  }

  copyFileSync(patchPath, patchPath + '.bak')
  writeFileSync(patchPath, after)
  console.log(`\n已写入。备份：${patchPath}.bak`)
  console.log('重启 DSH 后生效。')
}

main()
