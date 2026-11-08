/**
 * A1：派生权威凭证的判据、标签与账本。
 *
 * 这一层存在的意义是「一次派生要能回答凭什么」。所以这些用例刻意都在问同一件
 * 事：给定「这一轮有没有人开口」与「设置里的档位」，得出的凭证是不是唯一且可读。
 * `recordAuthority` 是唯一碰盘的地方，它的用例都在临时目录里跑。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  allowsAutoDerive,
  AUTHORITY_KINDS,
  authorityBasis,
  authorityLabel,
  deriveAuthority,
  recordAuthority,
} from '../lib/authority.js'

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authority-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('AUTHORITY_KINDS 从强到弱排列，且只有三档', () => {
  assert.deepEqual(AUTHORITY_KINDS, ['human-direct', 'rule', 'assumed'])
})

test('deriveAuthority：人开口优先于任何档位', () => {
  for (const proactive of ['auto', 'observe', 'off', undefined, 'nonsense']) {
    assert.deepEqual(deriveAuthority({ human: true, proactive }), { kind: 'human-direct' })
  }
  // 只认严格的 true：`undefined` 不能被人当成「人说话了」。
  assert.deepEqual(deriveAuthority({ human: 'yes', proactive: 'auto' }), {
    kind: 'rule',
    id: 'proactive-auto',
  })
})

test('deriveAuthority：observe 与 auto 各有自己的 rule id', () => {
  assert.deepEqual(deriveAuthority({ proactive: 'observe' }), {
    kind: 'rule',
    id: 'proactive-observe',
  })
  assert.deepEqual(deriveAuthority({ proactive: 'auto' }), {
    kind: 'rule',
    id: 'proactive-auto',
  })
})

test('deriveAuthority：没有人的话也没有档位授权时只能是 assumed', () => {
  assert.deepEqual(deriveAuthority({ proactive: 'off' }), { kind: 'assumed' })
  assert.deepEqual(deriveAuthority({}), { kind: 'assumed' })
  assert.deepEqual(deriveAuthority(), { kind: 'assumed' })
})

test('allowsAutoDerive：只有 human-direct 与 rule 放行', () => {
  assert.equal(allowsAutoDerive(deriveAuthority({ human: true })), true)
  assert.equal(allowsAutoDerive(deriveAuthority({ proactive: 'auto' })), true)
  assert.equal(allowsAutoDerive(deriveAuthority({ proactive: 'observe' })), true)
  assert.equal(allowsAutoDerive(deriveAuthority({ proactive: 'off' })), false)
  // 坏输入一律拒 —— 闸的方向是保守的。
  assert.equal(allowsAutoDerive(null), false)
  assert.equal(allowsAutoDerive(undefined), false)
  assert.equal(allowsAutoDerive({ kind: 'made-up' }), false)
  assert.equal(allowsAutoDerive({}), false)
})

test('authorityLabel：三档各有一行中文标签', () => {
  assert.equal(authorityLabel(deriveAuthority({ human: true })), 'human-direct（人本回合开口）')
  assert.equal(authorityLabel(deriveAuthority({ proactive: 'auto' })), 'rule:proactive-auto')
  assert.equal(authorityLabel(deriveAuthority({ proactive: 'observe' })), 'rule:proactive-observe')
  assert.equal(authorityLabel(deriveAuthority({ proactive: 'off' })), 'assumed（仅 observe）')
  assert.match(authorityLabel(undefined), /unknown/)
  assert.match(authorityLabel({ kind: 'nope' }), /unknown/)
})

test('authorityBasis：每条依据都带证据，而不是空标签', () => {
  const human = authorityBasis(deriveAuthority({ human: true }))
  assert.deepEqual(human, {
    authority: { kind: 'human-direct' },
    rules: [{ id: 'human-request', evidence: '本回合有直接人类消息' }],
    humanDirect: true,
  })

  const observe = authorityBasis(deriveAuthority({ proactive: 'observe' }))
  assert.deepEqual(observe.rules, [{ id: 'proactive-observe', evidence: 'meta.proactive=observe' }])
  assert.equal(observe.humanDirect, false)

  const auto = authorityBasis(deriveAuthority({ proactive: 'auto' }))
  assert.deepEqual(auto.rules, [{ id: 'proactive-auto', evidence: 'meta.proactive=auto（默认）' }])
  assert.equal(auto.humanDirect, false)

  // assumed 没有任何「依据」可说 —— 空 rules 正是它的意思。
  const assumed = authorityBasis(deriveAuthority({ proactive: 'off' }))
  assert.deepEqual(assumed.rules, [])
  assert.equal(assumed.humanDirect, false)
})

test('recordAuthority：追加一条带 ts/actor/authority 的账本行', () => {
  const { dir, cleanup } = workspace()
  try {
    const first = recordAuthority(dir, {
      action: 'spawn',
      summary: '派生 worker「recon」',
      authority: { kind: 'rule', id: 'proactive-auto' },
      detail: { model: 'runtime/current', description: 'recon', proactive: 'auto' },
    })
    assert.equal(first.ok, true)
    assert.equal(first.path, join(dir, '.agi', 'CHANGELOG.jsonl'))

    recordAuthority(dir, {
      action: 'spawn',
      summary: '第二条',
      authority: { kind: 'human-direct' },
    })

    const lines = readFileSync(join(dir, '.agi', 'CHANGELOG.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const record = JSON.parse(lines[0])
    assert.equal(typeof record.ts, 'string')
    assert.equal(record.actor, 'main-agent')
    assert.deepEqual(record.authority, { kind: 'rule', id: 'proactive-auto' })
    assert.equal(record.action, 'spawn')
    assert.equal(record.summary, '派生 worker「recon」')
    // authority 在记录里靠前：人读一行就知道凭什么。
    assert.deepEqual(Object.keys(record).slice(0, 3), ['ts', 'actor', 'authority'])
    assert.equal(JSON.parse(lines[1]).summary, '第二条')
  } finally {
    cleanup()
  }
})

test('recordAuthority：缺工作区或缺凭证都不写，只返回失败', () => {
  const { dir, cleanup } = workspace()
  try {
    assert.equal(recordAuthority('', { action: 'spawn', authority: { kind: 'rule' } }).ok, false)
    assert.equal(recordAuthority(undefined, { action: 'spawn', authority: { kind: 'rule' } }).ok, false)

    const missing = recordAuthority(dir, { action: 'spawn', summary: '没有凭证' })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /authority/)
    // 契约违反不许静默落成「没带凭证的记录」—— 宁可不写。
    assert.throws(() => readFileSync(join(dir, '.agi', 'CHANGELOG.jsonl'), 'utf8'), /ENOENT/)
  } finally {
    cleanup()
  }
})

test('recordAuthority：写不进去也只返回失败，不抛', () => {
  const { dir, cleanup } = workspace()
  try {
    // 工作区是个普通文件：`<file>/.agi` 建不出来。
    const notADirectory = join(dir, 'plain.txt')
    writeFileSync(notADirectory, 'x', 'utf8')
    const result = recordAuthority(notADirectory, {
      action: 'spawn',
      summary: 'x',
      authority: { kind: 'rule', id: 'proactive-auto' },
    })
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  } finally {
    cleanup()
  }
})
