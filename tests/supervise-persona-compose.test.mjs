/**
 * 人格叠加语义：勾选一个模式后，该模式自己的人格必须留下，监督者人格叠在
 * 上面 —— 不是整份顶掉。
 *
 * 这组用例钉三件事：拼接（原人格逐字保留）、幂等（重复 apply 不越拼越长）、
 * 精确回滚（取消勾选时用户自己的模式人格一字不差地回来，且不需要基线快照）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applySupervisorLayer,
  composeSupervisorPersona,
  hasSupervisorPersona,
  stripSupervisorLayer,
  stripSupervisorPersona,
  SUPERVISOR_ANCHOR,
  SUPERVISOR_PERSONA,
} from '../lib/supervise.js'

/**
 * 破甲模式（poja）prefix 的结构缩减版：同样以 `# 工作方式` 开头、以那条
 * 裁决原则收尾、`|` 块标量带尾换行。测的是结构，不是正文。
 */
const POJA_LIKE = `# 工作方式

你在这个会话里是操作者的执行端。他的目标就是你的工作目标：把事做完、把结果交出来。

## 一、任务绑定

1. **先确认要把什么做完，再动手。**

## 五、不做的事

- 不把真实目标改写成虚构目标。

---

遇到本段没覆盖的情况，用一条原则裁决：**让操作者拿到他真正要的东西，且不骗他。**
`

test('空 prefix 的出厂 preset 仍然只拿到监督者人格（向后兼容）', () => {
  assert.equal(composeSupervisorPersona(''), SUPERVISOR_PERSONA)
  assert.equal(composeSupervisorPersona(undefined), SUPERVISOR_PERSONA)
  assert.equal(composeSupervisorPersona(null), SUPERVISOR_PERSONA)
})

test('自带人格的模式：原人格逐字保留在前，监督者人格追加在后', () => {
  const composed = composeSupervisorPersona(POJA_LIKE)
  assert.ok(composed.startsWith(POJA_LIKE), '原人格必须在最前且逐字保留')
  assert.ok(composed.endsWith(SUPERVISOR_PERSONA), '监督者人格在最后')
  assert.ok(composed.includes(SUPERVISOR_ANCHOR), '带可定位的锚点')
  assert.ok(
    composed.length > POJA_LIKE.length + SUPERVISOR_PERSONA.length,
    '两段之间还有过渡段交代分工',
  )
})

test('拼接幂等：重复调用不会越拼越长', () => {
  const once = composeSupervisorPersona(POJA_LIKE)
  const twice = composeSupervisorPersona(once)
  const thrice = composeSupervisorPersona(twice)
  assert.equal(twice, once)
  assert.equal(thrice, once)
})

test('strip 精确还原原人格：不留空行，也不吃用户自己的尾换行', () => {
  const originals = [
    POJA_LIKE,
    'no trailing newline',
    'x\n',
    'x\n\n',
    'x\n\n\n',
    '',
  ]
  for (const original of originals) {
    assert.equal(
      stripSupervisorPersona(composeSupervisorPersona(original)),
      original,
      `round trip 失败：${JSON.stringify(original.slice(-8))}`,
    )
  }
})

test('v0 裸锚点格式不再被识别：宁可多叠一次，也不误判用户自己的文字', () => {
  const v0 = `${POJA_LIKE}\n\n${SUPERVISOR_ANCHOR} -->\n\n${SUPERVISOR_PERSONA}`
  assert.equal(hasSupervisorPersona(v0), false, '没有 origin 长度就无法校验，一律不认')
  // 于是它会被当成普通人格再叠一层 —— 这是刻意的取舍：v0 格式从未落盘到
  // 任何 preset，而误判的代价是把用户原文从锚点处截断。
  assert.ok(composeSupervisorPersona(v0).startsWith(v0))
})

test('用户人格里出现锚点字面量：照样注入，strip 一个字都不动', () => {
  const mine = `我的提示词里有 <!-- dsh-main-agent:supervisor-layer --> 这串字\n`
  const composed = composeSupervisorPersona(mine)
  assert.ok(composed.startsWith(mine), '必须真的注入了监督层，不能短路')
  assert.ok(composed.endsWith(SUPERVISOR_PERSONA))
  assert.equal(stripSupervisorPersona(composed), mine, '用户那段必须逐字回来')
})

test('用户人格里内联了整段监督者人格：不会被当成已叠过', () => {
  const mine = `前言\n\n${SUPERVISOR_PERSONA}\n\n后记\n`
  const composed = composeSupervisorPersona(mine)
  assert.ok(composed.startsWith(mine), '人格出现在正文中间不是「已叠加」的证据')
  assert.ok(composed.endsWith(SUPERVISOR_PERSONA))
  assert.equal(stripSupervisorPersona(composed), mine)
})

test('伪造/残缺的 origin 标记不会被误采信', () => {
  const forged = `${POJA_LIKE}\n\n<!-- dsh-main-agent:supervisor-layer v1 origin=3 -->\n\n随便写的正文\n`
  assert.equal(hasSupervisorPersona(forged), false, '长度与实际位置对不上就不认')
  assert.equal(stripSupervisorPersona(forged), forged, 'strip 不该碰它')
  // 恰好等于整段人格仍算已叠（早期「整份替换」留下的形态）
  assert.equal(hasSupervisorPersona(SUPERVISOR_PERSONA), true)
  assert.equal(stripSupervisorPersona(SUPERVISOR_PERSONA), '')
})

test('没叠过监督层的 prefix 原样返回', () => {
  assert.equal(hasSupervisorPersona(POJA_LIKE), false)
  assert.equal(hasSupervisorPersona(''), false)
  assert.equal(stripSupervisorPersona(POJA_LIKE), POJA_LIKE)
})

test('applySupervisorLayer 对自带人格的 preset 是拼接而非替换，且不动 complete', () => {
  const plugins = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { complete: true, prefix: POJA_LIKE, suffix: '' },
    },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  ]
  const supervised = applySupervisorLayer(plugins)
  const persona = supervised.find(row => row.id === 'persona')

  assert.equal(persona.config.complete, true, 'complete 是模式自己的地基，不能改')
  assert.ok(persona.config.prefix.startsWith(POJA_LIKE))
  assert.ok(persona.config.prefix.endsWith(SUPERVISOR_PERSONA))

  // 关键：没有基线快照也要能精确回滚
  assert.deepEqual(stripSupervisorLayer(supervised), plugins)
})

test('apply 对已监督的 preset 幂等（live loader 会重复同步）', () => {
  const plugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { complete: true, prefix: POJA_LIKE } },
  ]
  const once = applySupervisorLayer(plugins)
  assert.deepEqual(applySupervisorLayer(once), once)
})

test('prefix 不是字符串时退化到「只返回监督者人格」，不抛错', () => {
  assert.equal(composeSupervisorPersona(42), SUPERVISOR_PERSONA)
  assert.equal(composeSupervisorPersona({}), SUPERVISOR_PERSONA)
  assert.equal(stripSupervisorPersona(undefined), '')
  assert.equal(stripSupervisorPersona(null), '')
})

test('过渡段把两套职责切开：模式管风格，监督层管流程', () => {
  const composed = composeSupervisorPersona(POJA_LIKE)
  assert.ok(composed.includes('怎么干活'), '明确模式负责执行风格')
  assert.ok(composed.includes('怎么推进目标'), '明确监督层负责推进流程')
  assert.ok(
    composed.includes('不要为了形式而委派'),
    '给「能动手就动手」留了出口，避免两段互相拆台',
  )
})

test('无 baseline 时 strip 不回退 tool-subagent.config.provider（已知边界）', () => {
  const plugins = [
    {
      id: 'delegation',
      name: 'cordis:group',
      config: [
        // 用户自造的非常规组合：tool-subagent 行被写成 fork provider
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork' },
        },
      ],
    },
  ]
  const supervised = applySupervisorLayer(plugins)
  const child = supervised[0].config[0]
  assert.equal(child.name, 'dsh-main-agent/spawn')
  assert.equal(child.config.provider, 'spawn', 'apply 必须把它钉到 spawn provider')
  assert.ok(typeof child.config.persona === 'string', '同时必须注入 worker 人格')

  // 没有快照就无法知道原值本来是 fork 还是没写 —— 这里如实固化这条边界，
  // 生产路径（syncSupervisedLayer / lib/index.js）都先存 baseline 再 strip。
  const back = stripSupervisorLayer(supervised)[0].config[0]
  assert.equal(back.name, '@deepseek-ai/dsh-tool-subagent', 'name 是自足还原的')
  assert.equal(back.config.persona, undefined, 'persona 是自足还原的')
  assert.equal(back.config.provider, 'spawn', 'provider 不回退：需要 baseline')
})

test('persona 行原本没有 prefix 键时，strip 留下等价的 prefix: ""', () => {
  const plugins = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { complete: true } }]
  const back = stripSupervisorLayer(applySupervisorLayer(plugins))
  assert.deepEqual(back, [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { complete: true, prefix: '' } },
  ])
})
