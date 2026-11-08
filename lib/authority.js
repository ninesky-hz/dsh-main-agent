/**
 * dsh-main-agent — 派生的权威凭证。
 *
 * 为什么需要这一层：监督者的每一次派生都要能回答「凭什么」。此前 `proactive`
 * 只表达「派不派」，表达不了「这一派是谁授权的」—— 于是一条由 `rule` 授权自动
 * 派出的 worker，和一条人类刚开口后派出的 worker，在 `CHANGELOG.jsonl` 里长得
 * 一模一样，事后无法区分「模型自己想的」与「人让做的」。
 *
 * 三档，且只描述来源，不描述强弱以外的任何东西：
 *
 *   human-direct  本回合存在直接人类消息（`hasDirectHumanMessage` 为真）
 *   rule          设置里的 `proactive` 档位授权（observe / auto）
 *   assumed       没有任何可用凭证。它**不允许**派生 —— 只应该出现在
 *                 「档位关掉了、人也没说话」这种空档上
 *
 * 判据只有一份：调用方把 `human` 与 `proactive` 传进来，这里不读 ctx、不碰
 * 磁盘，于是它可以被单测，也不会和 `lib/spawn.js` 的判定漂移。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 三种权威，顺序即「越靠前越强」。 */
export const AUTHORITY_KINDS = ['human-direct', 'rule', 'assumed']

/**
 * 推导一次派生的权威凭证。
 *
 * 优先级刻意是「人 > 规则 > 无」：人类这一轮开了口，就不该被一条自动派生的
 * 设置档位盖掉 —— 事后追责时「有人当面要求」永远比「配置允许」更重要。
 *
 * @param {object} [input]
 * @param {boolean} [input.human] 本回合是否存在直接人类消息
 * @param {string} [input.proactive] `configuredProactive()` 的结果（off/observe/auto）
 * @returns {{ kind: 'human-direct' } | { kind: 'rule', id: string } | { kind: 'assumed' }}
 */
export function deriveAuthority({ human, proactive } = {}) {
  if (human === true) return { kind: 'human-direct' }
  if (proactive === 'observe') return { kind: 'rule', id: 'proactive-observe' }
  if (proactive === 'auto') return { kind: 'rule', id: 'proactive-auto' }
  return { kind: 'assumed' }
}

/**
 * 这份权威能不能自己派生一个 worker。
 *
 * `assumed` 是唯一被拒的一档：没有人的话，也没有规则授权，那么这次派生就只是
 * 模型自己的念头 —— 而「模型自己想派就派」正是并行上限与 observe 档要防的东西。
 *
 * @param {{ kind?: string } | null | undefined} authority
 * @returns {boolean}
 */
export function allowsAutoDerive(authority) {
  if (authority === null || typeof authority !== 'object') return false
  return authority.kind === 'human-direct' || authority.kind === 'rule'
}

/**
 * 人读的一行标签，写进工具结果与 CHANGELOG 摘要。
 *
 * @param {{ kind?: string, id?: string } | null | undefined} authority
 * @returns {string}
 */
export function authorityLabel(authority) {
  if (authority === null || typeof authority !== 'object') return 'unknown（没有权威凭证）'
  if (!AUTHORITY_KINDS.includes(authority.kind)) return 'unknown（没有权威凭证）'
  if (authority.kind === 'human-direct') return 'human-direct（人本回合开口）'
  if (authority.kind === 'rule') return `rule:${authority.id ?? 'unknown'}`
  return 'assumed（仅 observe）'
}

/**
 * 一次派生的凭证依据（写进 `proposals.jsonl` 的 `basis`）。
 *
 * 形状是 `{ authority, rules, humanDirect }`，`rules` 每条都带一句**证据**而不是
 * 结论：事后读提案的人要能自己判断这条依据当时是否成立，而不是相信一个
 * `{ id: 'human-request' }` 的空标签。
 *
 * @param {{ kind?: string, id?: string } | null | undefined} authority `deriveAuthority` 的结果
 * @returns {{ authority: object, rules: Array<{ id: string, evidence: string }>, humanDirect: boolean }}
 */
export function authorityBasis(authority) {
  const rules = []
  if (authority?.kind === 'human-direct') {
    rules.push({ id: 'human-request', evidence: '本回合有直接人类消息' })
  } else if (authority?.kind === 'rule' && authority.id === 'proactive-observe') {
    rules.push({ id: 'proactive-observe', evidence: 'meta.proactive=observe' })
  } else if (authority?.kind === 'rule' && authority.id === 'proactive-auto') {
    rules.push({ id: 'proactive-auto', evidence: 'meta.proactive=auto（默认）' })
  }
  return {
    authority: authority ?? { kind: 'assumed' },
    rules,
    humanDirect: authority?.kind === 'human-direct',
  }
}

/**
 * 把一次带权威凭证的动作追加到 `.agi/CHANGELOG.jsonl`。
 *
 * 绝不抛：写日志是旁路，不能因为它自己失败而让一次成功的派生看起来失败。失败
 * 只返回 `{ ok: false, error }`，由调用方决定是否提示 —— 静默改成「没带凭证的
 * 记录」才是真正的契约违反，所以这里宁可什么都不写。
 *
 * @param {string} cwd 会话工作区（绝对路径）
 * @param {object} entry 至少含 `action` 与 `summary`；`authority` 放在记录靠前位置
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function recordAuthority(cwd, entry) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { ok: false, error: '没有可用的工作区路径，未记录权威凭证' }
  }
  const { authority, ...rest } = entry !== null && typeof entry === 'object' ? entry : {}
  if (authority === undefined) {
    return { ok: false, error: '缺少 authority，拒绝写一条没有凭证的记录' }
  }
  const dir = join(cwd, '.agi')
  const path = join(dir, 'CHANGELOG.jsonl')
  try {
    mkdirSync(dir, { recursive: true })
    const record = {
      ts: new Date().toISOString(),
      actor: 'main-agent',
      authority,
      ...rest,
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: `写 CHANGELOG.jsonl 失败：${error?.message ?? error}` }
  }
}
