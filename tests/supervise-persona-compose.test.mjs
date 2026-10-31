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

/**
 * 无锚点旧形态：本层最早的一版实现只做了 `原文 + '\n\n' + 整段人格`，既没有标记行
 * 也没有过渡段。磁盘上真实的破甲模式 preset 就是这一形态（poja/agent.cordis.yml 的
 * prefix：line 20-68 原人格、line 69-70 空行、line 71 起整段监督者人格）。
 *
 * 只按「有锚点」判已叠过时，它会被判成未叠过而再拼一次 → 两段监督者人格；
 * strip 又会一个字不动 → 取消勾选等于没取消。这组用例把两条都钉住。
 */
test('无锚点旧形态：认得出已叠过，规范化成带锚点的一次性尾巴', () => {
  const legacy = `${POJA_LIKE}\n\n${SUPERVISOR_PERSONA}`
  assert.equal(hasSupervisorPersona(legacy), true, '旧形态必须被认成已叠过，否则会再拼一次')

  const normalized = composeSupervisorPersona(legacy)
  assert.ok(normalized.startsWith(POJA_LIKE), '原人格逐字保留在最前')
  assert.equal(
    normalized.split('你是一名常驻监督者').length - 1,
    1,
    '规范化后监督者人格只能出现一次（这正是双份的成因）',
  )
  assert.ok(normalized.includes(SUPERVISOR_ANCHOR), '规范化后必须带锚点，否则下次还是认不出')
  assert.equal(composeSupervisorPersona(normalized), normalized, '规范化之后再 compose 幂等')
  assert.equal(stripSupervisorPersona(normalized), POJA_LIKE, 'strip 精确回到原人格，逐字一致')
})

test('无锚点旧形态：即使不先 compose，strip 也能干净取消', () => {
  const legacy = `${POJA_LIKE}\n\n${SUPERVISOR_PERSONA}`
  assert.equal(stripSupervisorPersona(legacy), POJA_LIKE)
})

test('无锚点旧形态的换行变体：识别稳定，尾随换行不参与判定', () => {
  // 无锚点形态没有原文长度可校验，人格前面到底几个换行在字节上无法唯一还原
  // （真实 preset 是「内容 + 行尾换行 + 两个空行」，即 `\n\n\n`）。所以这里只
  // 要求：认得出来、剥得干净（尾随换行可能差一两个），并且规范化后会带上精确
  // 锚点，从此不再有歧义。
  for (const sep of ['\n', '\n\n', '\n\n\n']) {
    const legacy = `${POJA_LIKE}${sep}${SUPERVISOR_PERSONA}`
    assert.equal(hasSupervisorPersona(legacy), true, `${JSON.stringify(sep)} 变体必须认得出`)
    assert.equal(
      stripSupervisorPersona(legacy).trimEnd(),
      POJA_LIKE.trimEnd(),
      `${JSON.stringify(sep)} 变体的正文必须逐字回来`,
    )
    const normalized = composeSupervisorPersona(legacy)
    assert.equal(
      stripSupervisorPersona(normalized).trimEnd(),
      POJA_LIKE.trimEnd(),
      '规范化后回滚稳定（精确锚点已写入，此后不再有歧义）',
    )
    assert.equal(composeSupervisorPersona(normalized), normalized, '规范化后幂等')
  }
})

test('applySupervisorLayer 作用在旧形态上：不会长出第二份监督者人格', () => {
  const plugins = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { complete: true, prefix: `${POJA_LIKE}\n\n${SUPERVISOR_PERSONA}`, suffix: '' },
    },
  ]
  const once = applySupervisorLayer(plugins)
  const twice = applySupervisorLayer(structuredClone(once))
  const prefix = twice[0].config.prefix
  assert.equal(prefix.split('你是一名常驻监督者').length - 1, 1, '重复 apply 也只有一份')
  assert.ok(prefix.startsWith(POJA_LIKE), '原人格仍在最前')
  assert.equal(stripSupervisorPersona(prefix), POJA_LIKE, '取消勾选能逐字还原')
})
