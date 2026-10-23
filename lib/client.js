/**
 * dsh-main-agent — browser half: the "Feed" view tab.
 *
 * Registers one entry into the shipped `conversation.view` ring (the native
 * view-tab slot that already holds Chat and Trajectory), so every session gains
 * a "Feed" tab rendering the supervisor's run at a glance: goal, workers,
 * progress timeline, open questions, action changelog, notes, mission report.
 *
 * Native-first: the goal comes from the host-computed `goal` projection
 * (`useProjection`, the same feed the shipped GoalBar reads); workers come from
 * this package's own `/supervisor/workers` host route (the `subagent.list`
 * RPC it used to call no longer exists in dsh-subagent 0.2.x, and the 0.2.x
 * catalog carries no activity field); the `.agi/` files come from
 * `/supervisor/feed`; host API compatibility comes from `/supervisor/health`
 * (lib/index.js).
 *
 * This file is the loader's lazy-CJS factory artifact, hand-written (the
 * in-repo tsdown preset is not published; docs/cookbook/adding-a-settings-card
 * documents reproducing the format). No JSX — React.createElement only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-main-agent',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------- wire

    /**
     * Four distinct outcomes, because the card must not render a server error
     * as "this workspace has no .agi/": a workspace without state (400/404) is
     * a normal, explainable condition; anything else is a failure to report.
     * `notModified` is the fourth: the host answered 304, meaning the document
     * we already hold is still current — never a failure.
     */
    async function fetchFeed(ws, etag) {
      try {
        const res = await fetch(
          `/supervisor/feed?ws=${encodeURIComponent(ws)}`,
          typeof etag === 'string' && etag !== ''
            ? { headers: { 'if-none-match': etag } }
            : undefined,
        )
        if (res.status === 304) return { notModified: true }
        if (res.status === 400 || res.status === 404) return { missing: true, status: res.status }
        if (!res.ok) return { failed: true, status: res.status }
        const body = await res.json()
        return {
          ok: true,
          body,
          etag: typeof res.headers?.get === 'function' ? res.headers.get('etag') : null,
        }
      } catch {
        return { failed: true, status: 0 }
      }
    }

    /**
     * Supervisor loop status. A failure is carried back as data (not `null`):
     * the loop card has to say "could not read" instead of silently rendering
     * as if nothing were armed.
     */
    async function fetchStopStatus(sessionId) {
      try {
        const res = await fetch(`/supervisor/stop?session=${encodeURIComponent(sessionId)}`)
        if (!res.ok) return { failed: true, status: res.status }
        const body = await res.json().catch(() => null)
        return body ?? { failed: true, status: res.status }
      } catch (error) {
        return { failed: true, error: error?.message ?? '请求失败' }
      }
    }

    /**
     * Live worker inventory. The host route (not a browser RPC) is the only
     * source: dsh-subagent 0.2.1 dropped the `subagent.list` RPC this card used
     * to call, and its catalog carries no activity field.
     */
    async function fetchWorkers(sessionId) {
      try {
        const res = await fetch(`/supervisor/workers?session=${encodeURIComponent(sessionId)}`)
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          return { error: body?.error ?? `HTTP ${res.status}` }
        }
        return await res.json()
      } catch {
        return { error: '请求失败' }
      }
    }

    /**
     * Adaptive wake-up recommendation. Polled with the rest of the Feed so the
     * card can say WHY the next wake is that far out — the number alone reads
     * like a black box, and the whole point of the policy is that it is
     * explained (worker running / waiting on the user / no new evidence).
     */
    async function fetchLoop(sessionId) {
      try {
        const res = await fetch(`/supervisor/loop?sessionId=${encodeURIComponent(sessionId)}`)
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    }

    /** Host compatibility report; `ok: false` means delegation is broken here. */
    async function fetchHealth() {
      try {
        const res = await fetch('/supervisor/health')
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    }

    // ------------------------------------------------------------- bits

    const palette = {
      text: 'var(--dsw-alias-label-primary, #ddd)',
      dim: 'var(--dsw-alias-label-tertiary, #888)',
      border: 'var(--dsw-alias-border-l1, #3333)',
      card: 'var(--dsw-specific-tip, rgba(127,127,127,.06))',
    }

    /**
     * Pill 与正文小字共用的五个语义色。Pill 是白字压在底色上，11px/600 属于
     * 小字，WCAG AA 要求 ≥4.5:1；同一组色还要给卡片里的正文小字（「已停止」、
     * 告警文案、worker 状态点）用，所以卡片底色（6% #7f7f7f 叠在主题背景上，
     * 亮 ≈ #f7f7f7、暗 ≈ #212121，见 palette.card）也必须 ≥3:1。下面每行
     * 括号里是 sRGB 相对亮度公式的实测值：白字 / 亮卡片 / 暗卡片。
     *
     * 满足这两个条件的亮度窗口只有 L ∈ [0.146, 0.183]，原来的 ok/warn/idle/info
     * 都偏亮（白字只有 2.9–4.3:1，达不到 AA），因此统一往深里调了一档，色相与
     * 语义区分（绿=ok、琥珀=warn、红=bad、灰=idle、蓝=info）保持不变。
     */
    const tone = {
      ok: '#22805a', // 4.88:1 / 4.56 / 3.30
      warn: '#9c6914', // 4.73:1 / 4.41 / 3.41
      bad: '#b3494a', // 5.29:1 / 4.94 / 3.04
      idle: '#707070', // 4.95:1 / 4.62 / 3.25
      info: '#4070ad', // 5.07:1 / 4.74 / 3.17
    }

    /**
     * 一套统一的尺寸令牌。之前每个卡片各写各的（gap 12 / padding 12-14 /
     * 字号 11-14 / 圆角 12），排在一起就看得出是拼起来的。数据密集看板的
     * 节奏是 8px 栅格、12px 内边距、12 号正文，这里照此收敛成唯一来源。
     */
    const monoStack = 'ui-monospace, SFMono-Regular, Menlo, monospace'

    const metrics = {
      gap: 8,
      cardPad: '11px 12px',
      radius: 10,
      titleSize: 12,
      bodySize: 12.5,
      metaSize: 11,
      listMax: 280,
      monoFont: `11.5px/1.65 ${monoStack}`,
      tsWidth: 58,
    }

    /** 伪状态（hover / focus-visible / 滚动条 / pulse）没法写成 inline style，
     * 所以注入一份最小的样式表。类名统一 `dsma-` 前缀，避免影响宿主。
     * 注入失败不影响渲染：所有布局都由 inline style 承担，这份只做增强。 */
    // 带版本的名字：ensureStyles 只按 id 判重，改样式表就得换 id，否则已经注入过
    // 旧规则的页面会一直是旧的（HMR 正好会踩到）。
    const STYLE_ID = 'dsh-main-agent-style-v2'
    const STYLE_TEXT = `
.dsma-card { transition: border-color .15s ease, background-color .15s ease; }
.dsma-card:hover { border-color: rgba(127,127,127,.32); }
.dsma-fold:hover { color: var(--dsw-alias-label-secondary, #b4b4b4); }
.dsma-fold:focus-visible { outline: 2px solid var(--dsw-alias-label-secondary, #b4b4b4); outline-offset: 2px; border-radius: 3px; }
.dsma-scroll { scrollbar-width: thin; scrollbar-color: rgba(127,127,127,.35) transparent; }
.dsma-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.dsma-scroll::-webkit-scrollbar-thumb { background: rgba(127,127,127,.30); border-radius: 4px; }
.dsma-scroll::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,.50); }
.dsma-scroll::-webkit-scrollbar-track { background: transparent; }
@keyframes dsma-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.82); } }
.dsma-live { animation: dsma-pulse 2.2s ease-in-out infinite; }
/* 设置页：控件与可选项的伪状态。inline style 拿不到 CSS 变量再混 alpha，
   所以下面几个 rgba 就是把 tone.info / tone.bad 手工混出来的。 */
.dsma-field:focus-visible { outline: 2px solid rgba(64,112,173,.55); outline-offset: 1px; }
.dsma-btn { transition: background-color .12s ease, border-color .12s ease, opacity .12s ease; }
.dsma-btn:hover:not(:disabled) { border-color: rgba(127,127,127,.42); background: rgba(127,127,127,.07); }
.dsma-icon { transition: color .12s ease, background-color .12s ease; }
.dsma-icon:hover:not(:disabled) { color: #b3494a; background: rgba(179,73,74,.12); }
.dsma-choice { transition: background-color .12s ease, border-color .12s ease; }
.dsma-choice:hover { border-color: rgba(127,127,127,.30); }
.dsma-check { accent-color: #4070ad; }
@media (prefers-reduced-motion: reduce) {
  .dsma-live { animation: none; }
  .dsma-card, .dsma-btn, .dsma-icon, .dsma-choice { transition: none; }
}
`

    function ensureStyles() {
      if (typeof document === 'undefined' || document.head == null) return
      if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID) != null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
    }

    function timeAgo(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return ''
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (s < 60) return `${s} 秒前`
      if (s < 3600) return `${Math.round(s / 60)} 分钟前`
      if (s < 86400) return `${Math.round(s / 3600)} 小时前`
      return `${Math.round(s / 86400)} 天前`
    }

    function tsLabel(value) {
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (isFinite(parsed)) return new Date(parsed).toLocaleTimeString()
        return value
      }
      if (typeof value === 'number') return new Date(value).toLocaleTimeString()
      return ''
    }

    /** DSH 0.2.x projects the goal as `{ goal, roundsStarted, updatedAt }`;
     * 0.1 exposed those fields flat. Accept both so the card survives either. */
    function goalValue(projection) {
      if (projection == null || typeof projection !== 'object') return null
      const inner = projection.goal
      if (inner == null) return typeof projection.phase === 'string' ? projection : null
      return {
        ...inner,
        roundsStarted: typeof projection.roundsStarted === 'number'
          ? projection.roundsStarted
          : inner.roundsStarted,
        updatedAt: typeof projection.updatedAt === 'number' ? projection.updatedAt : inner.updatedAt,
      }
    }

    /** A session summary no longer carries `agentPreset` at top level: it is a
     * session projection, read as `projectionValues.agentPreset`. */
    function presetOf(row) {
      const value = row?.agentPreset ?? row?.projectionValues?.agentPreset
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    /** 状态胶囊：中文没有大小写，`uppercase` 只会在中英混排里制造不齐；改成
     * 小字 + 细内边距 + 等宽高度，让它们在任何卡片里都是同一颗「珠子」。 */
    function Pill(props) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', flex: 'none',
          padding: '1px 6px', borderRadius: 999,
          fontSize: 10.5, fontWeight: 600, lineHeight: '15px',
          color: '#fff', background: props.color ?? tone.idle,
          letterSpacing: 0, whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    function Card(props) {
      // 内容按「多个 child」而不是「一个数组 child」交给 section：React 会对
      // 数组形式的 children 逐项要 key，而这些内容是各卡片直接拼的 JSX 片段，
      // 没有、也不该有列表 key。
      const body = Array.isArray(props.children) ? props.children : [props.children]
      return h('section', {
        className: 'dsma-card',
        style: {
          border: `1px solid ${palette.border}`, borderRadius: metrics.radius,
          background: palette.card, padding: metrics.cardPad,
          // 同一行的卡片由 grid 拉到等高（stretch），内容少就留白在下沿 —
          // 参差不齐的下沿是「不协调」最直接的来源。
          minWidth: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          gridColumn: props.wide === true ? '1 / -1' : undefined,
        },
      },
      h('header', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 8, minWidth: 0,
        },
      },
      h('h3', {
        style: {
          margin: 0, fontSize: metrics.titleSize, fontWeight: 600,
          lineHeight: '15px', color: palette.dim, letterSpacing: 0,
        },
      }, props.title),
      // 所有卡片的右上角都是同一种「状态 / 计数」位，不再一半贴标题、一半靠右。
      props.badge == null
        ? null
        : h('span', {
            style: {
              marginLeft: 'auto', flex: 'none', display: 'inline-flex',
              alignItems: 'center', minWidth: 0,
            },
          }, props.badge),
      ),
      // 内容直接作为 section 的 flex item：多包一层 div 会让卡片内的祖先链
      // 多一级（也会让「按文本找卡片某一段」的断言串到整张卡上）。
      ...body)
    }

    function Empty(props) {
      return h('p', {
        style: {
          margin: 0, color: palette.dim, fontSize: metrics.bodySize, lineHeight: 1.6,
        },
      }, props.children)
    }

    function Mono(props) {
      return h('pre', {
        className: 'dsma-scroll',
        style: {
          margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          font: metrics.monoFont, color: palette.text,
          maxHeight: props.max ?? metrics.listMax, overflow: 'auto',
        },
      }, props.children)
    }

    function Details(props) {
      return h('details', { style: { marginTop: 6 } },
        h('summary', {
          // A folded summary may show an abbreviation; `summaryTitle` carries
          // the full value (e.g. a worker session id) as a hover hint.
          title: props.summaryTitle,
          style: {
            cursor: 'pointer', fontSize: metrics.metaSize, lineHeight: 1.6,
            color: palette.dim, userSelect: 'none',
          },
        }, props.summary),
        h('div', { style: { marginTop: 6 } }, props.children))
    }

    /** 「展开/收起」的文字按钮：小字、虚线、不抢主体。用 tertiary 标签色而不是
     * tone.info，因为 11px 小字在 6% 卡底上要 4.5:1，而主题标签色本身就是为
     * 正文级对比度设计的。 */
    const linkButtonStyle = {
      marginTop: 2, padding: 0, background: 'transparent', border: 'none',
      cursor: 'pointer', font: 'inherit', fontSize: metrics.metaSize, lineHeight: 1.6,
      color: palette.dim, textDecoration: 'underline dotted',
      textUnderlineOffset: 3, minWidth: 0,
    }

    /** 工具条按钮：之前三个按钮各写一份尺寸，字号/圆角/内边距都不完全一致。 */
    const toolbarButtonStyle = {
      flex: 'none', alignSelf: 'center', padding: '2px 9px', borderRadius: 7,
      fontSize: metrics.metaSize, lineHeight: '16px', cursor: 'pointer',
      border: `1px solid ${palette.border}`, background: 'transparent',
      color: palette.text, fontFamily: 'inherit',
    }

    /** 页面级提示条（不兼容 / 未识别监督者）：统一的内边距、圆角与字号。 */
    function noticeStyle(color, background) {
      return {
        margin: '0 0 10px', padding: '8px 10px', borderRadius: metrics.radius,
        fontSize: metrics.bodySize, lineHeight: 1.6, color: palette.text,
        border: `1px solid ${color}`, background,
      }
    }

    /**
     * 长文本默认折到 N 行，点「展开」看全文。进度条目、提问、变更摘要里常有
     * 几百字的记录，全铺开会把整页拉成一堵字墙 —— 这是 Feed 视图「太长」的
     * 主要来源。短文本不加控件，避免每条都多一个按钮。
     */
    function FoldText(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text ?? '')
      const lines = props.lines ?? 3
      // 字符数只是「值不值得给控件」的粗判据，不需要精确测量渲染行数。
      const long = props.clamp !== false && text.length > (props.chars ?? 140)
      const clamped = long && !open
      return h('div', { style: { minWidth: 0 } },
        h('div', {
          title: clamped ? text : undefined,
          style: {
            fontSize: props.fontSize ?? metrics.bodySize,
            lineHeight: props.lineHeight ?? 1.62,
            color: props.color ?? palette.text,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            ...(clamped
              ? {
                  display: '-webkit-box', WebkitLineClamp: lines,
                  WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }
              : null),
          },
        }, text),
        long
          ? h('button', {
              type: 'button',
              className: 'dsma-fold',
              onClick: () => setOpen(value => value !== true),
              'aria-expanded': open,
              style: linkButtonStyle,
            }, open ? '收起' : `展开（${text.length} 字）`)
          : null)
    }

    /**
     * 卡片内容区的内部滚动。页面本身只保留一条滚动条，任何一张「进度」式的
     * 长卡片都被钉在固定高度里自己滚，不再把整页撑长。
     */
    function Scroller(props) {
      return h('div', {
        className: 'dsma-scroll',
        style: {
          maxHeight: props.max ?? metrics.listMax,
          overflow: 'auto',
          paddingRight: 4,
          overscrollBehavior: 'contain',
          minHeight: 0,
        },
      }, props.children)
    }

    /** Inline short form of an id: first 8 chars + ellipsis, full value in `title`. */
    function shortId(value) {
      const text = String(value ?? '')
      return text.length > 8 ? `${text.slice(0, 8)}…` : text
    }

    // ------------------------------------------------------------- cards

    function GoalCard(goal) {
      const phaseColor = {
        active: tone.ok, paused: tone.warn, blocked: tone.bad,
        complete: tone.info, completed: tone.info,
      }
      if (goal == null) {
        return h(Card, { title: '目标' },
          h(Empty, null, '没有进行中的目标 —— 目标创建后，聊天输入框上方的 GoalBar 会出现。'))
      }
      return h(Card, { title: '目标', badge: h(Pill, { color: phaseColor[goal.phase] ?? tone.idle }, String(goal.phase ?? 'unknown')) },
        h(FoldText, {
          text: String(goal.objective ?? ''),
          lines: 4, chars: 180, fontSize: 13, lineHeight: 1.55,
        }),
        h('p', { style: { margin: '6px 0 0', fontSize: metrics.metaSize, lineHeight: 1.6, color: palette.dim } },
          `rev ${goal.revision ?? '?'} · 回合 ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? '∞'}`
          + (goal.blockedReason ? ` · 阻塞：${goal.blockedReason}` : '')
          + (typeof goal.updatedAt === 'number' ? ` · ${timeAgo(goal.updatedAt)} 更新` : '')))
    }

    /** foldScheduleEvents 的活动记录把 `scheduledAt` 写成 ISO 字符串；宿主
     * 路由已转成毫秒数，这里两种都接受，缺失则返回 null（记录可能没有它）。 */
    function reminderAt(reminder) {
      const raw = reminder?.scheduledAt
      if (typeof raw === 'number' && isFinite(raw)) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (isFinite(parsed)) return parsed
      }
      return null
    }

    const REMINDER_KINDS = {
      every: '周期提醒', at: '一次性等待', after: '一次性等待',
      daily: '每日提醒', weekly: '每周提醒', cron: 'cron',
    }

    /** 提醒的中文标签：能读出周期就说「每 N 分钟巡检」，读不出退化成通称。 */
    function reminderLabel(reminder) {
      const kind = String(reminder?.kind ?? '')
      if (kind === 'every') {
        const seconds = Number(reminder?.everySeconds)
        return Number.isFinite(seconds) && seconds > 0
          ? `每 ${Math.round(seconds / 60)} 分钟巡检`
          : '周期提醒'
      }
      if (kind === 'daily' || kind === 'weekly') {
        const at = typeof reminder?.time === 'string' ? reminder.time.slice(0, 5) : ''
        return `${kind === 'daily' ? '每日' : '每周'}${at === '' ? '' : ` ${at}`}提醒`
      }
      return REMINDER_KINDS[kind] ?? (kind === '' ? '提醒' : kind)
    }

    function dueLabel(ms) {
      const clock = new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const delta = ms - Date.now()
      if (delta <= 0) return `已到期（${clock}）`
      return `约 ${Math.max(1, Math.round(delta / 60000))} 分钟后（${clock}）`
    }

    /**
     * 监督循环卡片。Feed 每次打开本来就会拉 `/supervisor/stop`，但 `reminders`
     * 与 `runningWorkers` 之前只被存进 state、从未渲染，于是「循环还武装着吗 /
     * 下一次什么时候醒」只能靠点 Full stop 去猜。这张卡片把它们显式化，且复用
     * Feed 已有的 stopStatus —— 不新增轮询。
     */
    function LoopCard(stopStatus, loop) {
      if (stopStatus == null) {
        return h(Card, { title: '监督循环' }, h(Empty, null, '正在读取监督循环状态…'))
      }
      if (stopStatus.failed === true) {
        const detail = stopStatus.error != null
          ? String(stopStatus.error)
          : stopStatus.status ? `HTTP ${stopStatus.status}` : '请求失败'
        return h(Card, { title: '监督循环' },
          h('p', { style: { margin: 0, fontSize: metrics.metaSize, lineHeight: 1.6, color: palette.dim } },
            `无法读取监督循环状态：${detail}`))
      }
      const stopped = stopStatus.stopped === true
      const runningWorkers = (Array.isArray(stopStatus.runningWorkers) ? stopStatus.runningWorkers : [])
        .map(String)
      // Older host payloads carried bare reminder ids; accept both shapes.
      const reminders = (Array.isArray(stopStatus.reminders) ? stopStatus.reminders : [])
        .map(reminder => (typeof reminder === 'string' ? { id: reminder } : reminder ?? {}))
      const timed = reminders
        .map(reminder => ({ reminder, at: reminderAt(reminder) }))
        .filter(item => item.at != null)
        .sort((left, right) => left.at - right.at)
      const nearestAt = timed.length === 0 ? null : timed[0].at
      return h(Card, {
        title: '监督循环',
        badge: h(Pill, { color: stopped ? tone.idle : tone.ok },
          stopped
            ? '已停止'
            : h('span', {
                className: 'dsma-live',
                style: {
                  display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                  background: '#fff', marginRight: 5,
                },
              }),
          stopped ? null : '运行中'),
      },
      h('p', {
        style: {
          margin: 0, fontSize: metrics.bodySize, lineHeight: 1.62, color: palette.text,
        },
      },
        '活动 worker：'
        + (runningWorkers.length === 0
          ? '无'
          : `${runningWorkers.length} 个（${runningWorkers.map(shortId).join('、')}）`)),
      h('p', {
        style: {
          margin: '4px 0 0', fontSize: metrics.metaSize, lineHeight: 1.6, color: palette.dim,
        },
      },
        stopped
          ? '没有已启用的提醒，也没有正在运行的 worker —— 手动发一条提示即可恢复循环。'
          : `${reminders.length} 个已启用的提醒`),
      // 自适应唤醒建议：服务端按「现在在等什么」算下一次该睡多久，并把理由
      // 一起算出来。只显示数字会变成一个黑箱 —— 用户没法判断该不该改设置。
      loop?.recommend == null
        ? null
        : h('p', {
            style: {
              margin: '4px 0 0', fontSize: metrics.metaSize, lineHeight: 1.6,
              color: loop.staleWake?.stale === true ? tone.warn : palette.dim,
            },
          },
          `下次唤醒：约 ${Math.round((loop.recommend.seconds ?? 0) / 60)} 分钟后 · ${loop.recommend.label ?? ''}`
          + (loop.staleWake?.stale === true
            ? `（已滞后 ${Math.round((loop.staleWake.gapSeconds ?? 0) / 60)} 分钟 —— 先对账再推进）`
            : '')),
      loop?.watchdog == null || loop.watchdog.enabled !== false
        ? null
        : h('p', {
            style: { margin: '4px 0 0', fontSize: metrics.metaSize, lineHeight: 1.6, color: tone.warn },
          }, '兜底提醒已关闭：漏排一次提醒，循环就会停在这一轮。'),
      reminders.length === 0
        ? null
        : h('ul', { style: { margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 4 } },
            reminders.map((reminder, index) => {
              const at = reminderAt(reminder)
              const next = at != null && at === nearestAt
              return h('li', {
                key: reminder.id ?? index,
                style: {
                  display: 'flex', alignItems: 'baseline', gap: 6,
                  fontSize: metrics.bodySize, color: palette.text, minWidth: 0,
                },
              },
              h('span', { style: { flex: 'none' } }, reminderLabel(reminder)),
              reminder.title != null
                ? h('span', {
                    style: {
                      minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', fontSize: metrics.metaSize, color: palette.dim,
                    },
                  }, String(reminder.title))
                : null,
              at == null
                ? null
                : h('span', {
                    style: {
                      marginLeft: 'auto', paddingLeft: 8, flex: 'none',
                      fontSize: metrics.metaSize,
                      color: next ? palette.text : palette.dim,
                      fontWeight: next ? 600 : 400,
                    },
                  }, dueLabel(at)))
            })))
    }

    /**
     * `useSessions` hands back `snapshot.byId`, which the installed host ships
     * as a plain id→summary object while other builds expose a Map. Both shapes
     * answer "is this session in the list" here, so the clickable-worker
     * affordance degrades to a label instead of throwing on one of them.
     */
    function sessionInList(byId, id) {
      if (byId == null || id == null) return false
      if (typeof byId.get === 'function') return byId.get(id) != null
      try {
        return byId[id] != null
      } catch {
        return false
      }
    }

    function WorkersCard(workers, feed, openSession, summaries) {
      const entries = Array.isArray(workers?.workers) ? workers.workers : []
      const subagents = Array.isArray(feed?.subagents) ? feed.subagents : []
      // An artifact FRESH from `subagentDirs` is `{name, workerId, outcome,
      // files}`. `name` is the directory name — normally the worker's session
      // id, but a hand-named dir (`ui-polish-0107`) carries the session id only
      // in the machine-readable header of its outcome.md, which the host parses
      // into `workerId`. Match on that declared id FIRST, then on the directory
      // name, and claim each artifact once so one outcome can never render under
      // two rows.
      const claimed = new Set()
      /** The unclaimed artifact for one worker row, or undefined. */
      const claimSub = (entry) => {
        const id = String(entry.id)
        for (const wants of [
          sub => sub?.workerId === id,
          sub => sub?.name === id,
        ]) {
          const found = subagents.find(sub => sub != null && !claimed.has(sub) && wants(sub))
          if (found !== undefined) {
            claimed.add(found)
            return found
          }
        }
        return undefined
      }
      // Resolved up front: the fallback region below must know what the rows
      // already took, and the rows are built after it.
      const matched = new Map(entries.map(entry => [entry, claimSub(entry)]))
      const dot = (running) => h('span', {
        className: running === true ? 'dsma-live' : undefined,
        style: {
          display: 'inline-block', width: 6, height: 6, borderRadius: 3, marginRight: 7,
          background: running === true ? tone.ok : tone.idle, flex: 'none',
        },
      })
      const runningCount = entries.filter(entry => entry.running === true).length
      const row = (entry) => {
        const sub = matched.get(entry)
        // The label doubles as the way INTO that worker's own session: a
        // client plugin navigates through the `uiWorkspace` service, and the
        // `conversation.view` props carry no session switcher. Only offered
        // when the host exposed the service AND the session is in the list —
        // a button that cannot resolve its target would be a dead control.
        const label = String(entry.label ?? entry.id)
        const canOpen = typeof openSession === 'function'
          && sessionInList(summaries, String(entry.id))
        const labelStyle = {
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          minWidth: 0,
        }
        return h('li', {
          key: entry.id,
          style: {
            display: 'grid', gap: 2, fontSize: metrics.bodySize,
            lineHeight: 1.62, color: palette.text, minWidth: 0,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } },
          dot(entry.running),
          canOpen
            ? h('button', {
                type: 'button',
                onClick: event => {
                  // The row itself stays unclickable (its details/outcome stay
                  // selectable); only the label acts.
                  event.stopPropagation()
                  openSession(String(entry.id))
                },
                'aria-label': `在会话中打开 worker 会话 ${label}`,
                title: `在会话中打开 ${label}（${String(entry.id)}）`,
                style: {
                  background: 'transparent', border: 'none', padding: 0,
                  cursor: 'pointer', font: 'inherit', color: palette.text,
                  borderBottom: `1px dashed ${palette.border}`,
                  textAlign: 'left', ...labelStyle,
                },
              }, label)
            : h('span', {
                title: '该 worker 会话不在当前会话列表中，无法直接打开',
                style: labelStyle,
              }, label),
          h('span', {
            title: String(entry.id),
            style: {
              marginLeft: 7, flex: 'none', color: palette.dim,
              font: `${metrics.metaSize}px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace`,
            },
          }, shortId(entry.id)),
          h('span', { style: { marginLeft: 'auto', paddingLeft: 8, fontSize: metrics.metaSize, lineHeight: 1.6, color: palette.dim, flex: 'none' } },
            `${entry.running === true ? '运行中' : '空闲'}`
            + (typeof entry.createdAt === 'number' ? ` · ${timeAgo(entry.createdAt)}` : ''))),
        sub?.outcome != null
          ? h('div', { style: { paddingLeft: 13 } },
              h(Details, {
                summary: '结果',
                // Which artifact folder this outcome came from: a label-named
                // dir no longer looks like a session id, so name it.
                summaryTitle: sub.name == null ? undefined : `artifact 目录：${sub.name}`,
              }, h(Mono, { max: 180 }, sub.outcome.text)))
          : null)
      }
      // Outcomes whose worker is no longer in the catalog (older than
      // SUBAGENT_CAP, or a settled child the projection dropped) still matter:
      // keep them in a fallback block instead of dropping the artifact. What a
      // row already claimed stays out of it, so nothing renders twice.
      const orphans = subagents.filter(sub =>
        sub?.outcome != null && !claimed.has(sub))
      const body = workers?.unavailable != null
        ? h(Empty, null, workers.unavailable)
        : workers?.error != null
          ? h(Empty, null, `无法读取 worker 列表：${workers.error}`)
          : workers == null
            ? h(Empty, null, '正在读取 worker 列表…')
            : entries.length === 0
              ? h(Empty, null, '本会话尚未派生任何 worker。')
              : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
                entries.map(row))
      return h(Card, {
        title: 'Workers',
        badge: h(Pill, { color: runningCount > 0 ? tone.ok : tone.idle }, `${runningCount}/${entries.length}`),
      },
      body,
      orphans.length === 0
        ? null
        : h('div', { style: { marginTop: 10 } },
            h('p', { style: { margin: '0 0 2px', fontSize: 11, color: palette.dim } },
              '历史结果（不在当前 worker 列表里）'),
            orphans.map(sub => h(Details, {
              key: `orphan-${sub.name}`,
              summary: `结果 — ${shortId(sub.name)}`,
              summaryTitle: String(sub.name),
            }, h(Mono, { max: 220 }, sub.outcome.text)))))
    }

    function ProgressCard(progress) {
      const items = Array.isArray(progress) ? progress.slice(-40).reverse() : []
      return h(Card, {
        title: '进度',
        badge: items.length === 0
          ? null
          : h('span', {
              style: {
                marginLeft: 'auto', fontSize: metrics.metaSize,
                lineHeight: 1.6, color: palette.dim,
              },
            }, `${items.length} 条`),
      },
      items.length === 0
        ? h(Empty, null, '目前 .agi/progress.jsonl 中还没有任何内容。')
        : h(Scroller, { max: metrics.listMax },
            h('ol', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid' } },
              items.map((item, index) => h('li', {
                key: index,
                style: {
                  display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0,
                  padding: '5px 0',
                  borderBottom: index === items.length - 1 ? 'none' : `1px solid ${palette.border}`,
                },
              },
              h('span', {
                style: {
                  color: palette.dim, flex: 'none', width: metrics.tsWidth, textAlign: 'right',
                  font: `${metrics.metaSize}px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace`,
                },
              }, tsLabel(item.ts)),
              h(FoldText, {
                text: String(item.text ?? JSON.stringify(item)),
                lines: 2, chars: 120,
              }))))))
    }

    /** `.agi/questions.jsonl` 的 status 取值 → 中文标签与语义色。未知状态原样
     * 显示，避免把宿主的未来取值抹成「待答」。 */
    const QUESTION_STATUS = {
      pending: { label: '待答', color: tone.info },
      assumed: { label: '已假设', color: tone.warn },
      answered: { label: '已回答', color: tone.ok },
      withdrawn: { label: '已撤回', color: tone.idle },
    }

    function QuestionsCard(questions) {
      // 全部保留：卡片靠内部的 Scroller 限高，条目不再需要被截掉。
      const all = Array.isArray(questions) ? questions.slice(-20).reverse() : []
      const items = all
      const meta = (status) => {
        const key = String(status ?? '')
        return QUESTION_STATUS[key]
          ?? { label: key === '' ? '?' : key, color: tone.info }
      }
      return h(Card, {
        title: '提问',
        badge: all.length === 0
          ? null
          : h('span', {
              style: {
                marginLeft: 'auto', fontSize: metrics.metaSize,
                lineHeight: 1.6, color: palette.dim,
              },
            }, `${all.length} 条`),
      },
      items.length === 0
        ? h(Empty, null, '尚未提出任何问题。')
        : h(Scroller, { max: metrics.listMax },
            h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 } },
              items.map((item, index) => {
                const status = meta(item.status)
                return h('li', { key: index, style: { minWidth: 0 } },
                  h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
                    h(Pill, { color: status.color }, status.label),
                    // The durable field is `q`; the rest are tolerated aliases.
                    h(FoldText, {
                      text: String(item.q ?? item.question ?? item.text ?? item.id ?? JSON.stringify(item)),
                      lines: 3, chars: 100,
                    })),
                  item.assumption ?? item.note
                    ? h('div', {
                        style: {
                          marginTop: 3, fontSize: metrics.metaSize,
                          lineHeight: 1.6, color: palette.dim,
                        },
                      }, `假设：${item.assumption ?? item.note}`)
                    : null)
              }))))
    }

    function ChangelogCard(changelog) {
      const items = Array.isArray(changelog) ? changelog.slice(-40).reverse() : []
      const color = (action) => (
        action === 'spawn' ? tone.ok
        : action === 'kill' ? tone.bad
        : action === 'steer' ? tone.warn
        : action === 'verify' || action === 'deliver' ? tone.info
        : tone.idle)
      return h(Card, {
        title: '变更日志',
        badge: items.length === 0
          ? null
          : h('span', {
              style: {
                marginLeft: 'auto', fontSize: metrics.metaSize,
                lineHeight: 1.6, color: palette.dim,
              },
            }, `${items.length} 条`),
      },
      items.length === 0
        ? h(Empty, null, '尚未记录任何有后果的操作。')
        : h(Scroller, { max: metrics.listMax },
            h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid' } },
              items.map((item, index) => h('li', {
                key: index,
                style: {
                  display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0,
                  padding: '5px 0',
                  borderBottom: index === items.length - 1 ? 'none' : `1px solid ${palette.border}`,
                },
              },
              h('span', {
                style: {
                  color: palette.dim, flex: 'none', width: metrics.tsWidth, textAlign: 'right',
                  font: `${metrics.metaSize}px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace`,
                },
              }, tsLabel(item.ts)),
              h(Pill, { color: color(item.action) }, String(item.action ?? '?')),
              h(FoldText, {
                text: String(item.summary ?? JSON.stringify(item)),
                lines: 2, chars: 90,
              }))))))
    }

    function DocumentCard(label, doc) {
      return h(Card, {
        title: label,
        badge: doc
          ? h('span', {
              style: {
                marginLeft: 'auto', fontSize: metrics.metaSize,
                lineHeight: 1.6, color: palette.dim,
              },
            }, timeAgo(doc.mtime))
          : null,
      },
        doc == null
          ? h(Empty, null, `没有 ${label} 文件。`)
          : h(Mono, { max: 240 }, doc.text))
    }

    // ------------------------------------------------------------- view

    function FeedView(props) {
      // 幂等：hover / focus / 细滚动条 / 状态点脉冲这几条伪状态没法写成 inline
      // style，所以在首帧注入一次样式表。失败也只丢增强，不影响布局。
      ensureStyles()
      const goal = goalValue(props.useProjection('goal'))
      const sessionId = props.sessionId
      const summaries = props.useSessions(snapshot => snapshot.byId)
      // Declared before the supervisor lookup below, which needs the allow-list
      // this answers. Fetched once per mount; until it lands the built-in id is
      // the only preset trusted to be a supervisor.
      const [health, setHealth] = React.useState(null)
      let supervisor = summaries[sessionId]
      const visited = new Set()
      while (supervisor?.origin === 'subagent'
        && supervisor.parentId != null
        && !visited.has(supervisor.id)) {
        visited.add(supervisor.id)
        supervisor = summaries[supervisor.parentId]
      }
      // Who counts as a supervisor: the built-in preset always, plus whatever
      // the user switched on in Settings. Reading it from the host keeps the
      // Feed tab and the Settings card on one source of truth — hardcoding
      // 'main-agent' here made a switched-on preset still report "not a
      // supervisor" in this panel.
      const supervisedPresets = Array.isArray(health?.supervisorPresets)
        ? health.supervisorPresets
        : ['main-agent']
      const countsAsSupervisor = id => id != null && supervisedPresets.includes(id)
      if (supervisor?.origin === 'subagent' || !countsAsSupervisor(presetOf(supervisor))) {
        supervisor = null
      }
      const supervisorSessionId = supervisor?.id ?? null
      const cwd = supervisor?.cwd ?? summaries[sessionId]?.cwd ?? null
      // Honest degradation: without a supervisor row the Full stop button and
      // the worker inventory have no session to act on, so say so instead of
      // rendering "正在读取 worker 列表…" forever.
      const unresolved = cwd != null && supervisorSessionId == null
        ? `未识别到监督者会话（preset=${presetOf(summaries[sessionId]) ?? '未记录'}，未开启监督循环）`
          + ' —— Full stop 与 worker 列表在这个会话里不可用。'
        : null
      const [feed, setFeed] = React.useState(null)
      const [feedError, setFeedError] = React.useState(false)
      const [workers, setWorkers] = React.useState(null)
      const [loop, setLoop] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [stopState, setStopState] = React.useState(null)
      const [stopStatus, setStopStatus] = React.useState(null)
      // Auto-refresh control. `paused` stops the timer outright (not just the
      // requests it would have made), and `↻ 刷新` still forces a single fetch.
      const [paused, setPaused] = React.useState(false)
      // When the last poll SETTLED (200 or 304) and whether it was a 304 —
      // `feed.generatedAt` only advances on a 200, so it can no longer answer
      // "how fresh is what I am looking at?" once conditional refresh is on.
      const [checkedAt, setCheckedAt] = React.useState(null)
      const [unchanged, setUnchanged] = React.useState(false)
      const etagRef = React.useRef(null)

      // FULL stop: aborts the turn, releases delegated worker branches, and
      // deletes every schedule reminder, so nothing can re-run the agent.
      const fullStop = async () => {
        if (supervisorSessionId == null || supervisor?.cwd == null) {
          setStopState({ ok: false, message: '根监督者不可用' })
          return
        }
        const warning = '要完全停止监督者吗？\n\n'
          + '这将中止当前回合、停止所有正在运行的已委派 worker（含其后代），'
          + '并删除全部定时提醒。'
        if (!window.confirm(warning)) return
        setStopState('working')
        try {
          // The host route cold-resumes the supervisor itself (its
          // `sessionController` owns preset composition), so the browser does
          // not need an RPC of its own here — the earlier `session.create`
          // attempt went through an endpoint shape that stopped existing and
          // failed silently.
          const res = await fetch(`/supervisor/stop?session=${encodeURIComponent(supervisorSessionId)}`, { method: 'POST' })
          const body = await res.json().catch(() => null)
          if (res.ok && body != null) {
            setStopStatus({ stopped: true, running: false, reminders: [], runningWorkers: [] })
            setStopState({
              ok: true,
              stoppedPromptAt: supervisor.updatedAt ?? 0,
              message: `已停止 · ${body.workersStopped ?? 0} 个 worker 已停止`
                + ` · ${body.remindersDeleted} 个提醒已清除`
                + (body.durable === false ? ' · 持久化状态不确定' : ''),
            })
          } else {
            setStopState({ ok: false, message: body?.error ?? `HTTP ${res.status}` })
          }
        } catch {
          setStopState({ ok: false, message: '请求失败' })
        }
      }

      // A later human prompt is an explicit resume. The session-list
      // updatedAt field advances only for a human-authored prompt, so worker
      // settle reports do not incorrectly clear the stopped indication.
      React.useEffect(() => {
        if (stopState?.ok === true
          && (supervisor?.updatedAt ?? 0) > (stopState.stoppedPromptAt ?? 0)) {
          setStopState(null)
        }
      }, [supervisor?.updatedAt, stopState])

      React.useEffect(() => {
        setStopState(null)
        setStopStatus(null)
      }, [supervisorSessionId])

      // Poll only while the tab is visible: a hidden Feed from yesterday should
      // not keep re-reading .agi/ (and its worker artifacts) every 5 seconds.
      // Pausing removes the timer AND the visibility listener, so returning to
      // the tab while paused does not quietly re-arm polling.
      React.useEffect(() => {
        if (paused === true) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          setTick(value => value + 1)
        }, 5000)
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            setTick(value => value + 1)
          }
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [paused])

      React.useEffect(() => {
        if (cwd == null) return
        let live = true
        fetchFeed(cwd, etagRef.current).then(value => {
          if (!live) return
          setCheckedAt(Date.now())
          if (value?.notModified === true) {
            // 304: the document we hold is still current. Keep `feed` as is,
            // keep the etag, and say so — the label must stay honest.
            setUnchanged(true)
            return
          }
          setUnchanged(false)
          if (value?.ok === true) {
            etagRef.current = typeof value.etag === 'string' && value.etag !== ''
              ? value.etag
              : null
            setFeed(value.body)
            setFeedError(false)
            return
          }
          setFeed(value)
          // A failed poll must drop the ETag. Revalidating is only honest while
          // we actually hold a 200 document: if a stale ETag survived a failure,
          // the next poll would send If-None-Match for a document we no longer
          // have, the host would correctly answer 304 (nothing changed on disk),
          // and the 304 branch would keep the error card on screen until some
          // file's mtime moved — the card would lie about the real state.
          etagRef.current = null
          setFeedError(value == null || value?.failed === true)
        })
        if (supervisorSessionId != null) {
          fetchWorkers(supervisorSessionId).then(value => { if (live) setWorkers(value) })
          fetchLoop(supervisorSessionId).then(value => { if (live) setLoop(value) })
        }
        return () => { live = false }
      }, [cwd, supervisorSessionId, tick])

      // Host API compatibility is a STATIC probe: it does not change between
      // 5-second ticks, so it belongs in its own effect, once per supervisor
      // session, instead of riding the poll.
      React.useEffect(() => {
        let live = true
        fetchHealth().then(value => { if (live) setHealth(value) })
        return () => { live = false }
      }, [supervisorSessionId])

      React.useEffect(() => {
        if (supervisorSessionId == null) return
        let live = true
        fetchStopStatus(supervisorSessionId).then(value => { if (live) setStopStatus(value) })
        return () => { live = false }
      }, [supervisorSessionId, supervisor?.updatedAt, supervisor?.running])

      const unresolvedNotice = unresolved == null
        ? null
        : h('div', {
            role: 'status',
            style: noticeStyle(tone.warn, 'rgba(201,138,27,.10)'),
          }, unresolved)

      const incompatibility = health?.ok === false
        ? h('div', {
            role: 'alert',
            style: noticeStyle(tone.bad, 'rgba(192,80,77,.10)'),
          },
          h('strong', null, '宿主 subagent 服务不兼容：'),
          ` ${String(health?.subagents?.message ?? '缺少必要方法')}。`,
          h('div', { style: { marginTop: 4, color: palette.dim } },
            'worker 派生、并发上限与 Full stop 的 worker 释放都无法工作，直到宿主升级到 dsh-subagent 0.2.x 或插件更新。'),
          )
        : null

      const truncated = feed?.truncated
      const truncatedNote = truncated === undefined
        ? null
        : h('div', {
            style: {
              margin: '0 0 10px', fontSize: metrics.metaSize,
              lineHeight: 1.6, color: tone.warn,
            },
          },
          '部分内容已截断（只显示最新部分）：'
          + [
            ...(truncated.text ?? []),
            ...Object.entries(truncated.jsonl ?? {}).map(([key, dropped]) => `${key}（-${dropped} 条）`),
            ...truncated.workers === undefined ? [] : [`worker 产物（-${truncated.workers} 个）`],
          ].join('、'))

      const body = cwd == null
        ? h(Empty, null, '正在解析会话工作区…')
        : feedError === true
          ? h('div', { style: { display: 'grid', gap: 8, justifyItems: 'start' } },
              h(Empty, null, `无法读取监督动态（${cwd}）—— 本插件的 /supervisor/feed 路由不可用或返回了错误`
                + `${feed?.status === undefined || feed.status === 0 ? '' : `（HTTP ${feed.status}）`}。`),
              h('button', {
                onClick: () => setTick(value => value + 1),
                style: {
                  padding: '4px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
                },
              }, '重试'))
          : feed == null
            ? h(Empty, null, '正在加载监督动态…')
            : feed.missing === true
              ? h(Empty, null, feed.status === 400
                ? '缺少工作区参数 —— 无法定位 .agi/ 目录。'
                : `此工作区没有 .agi/ 目录（${cwd}）—— 监督动态 Feed 仅对监督者工作区生效。`)
              : h(React.Fragment, null,
                truncatedNote,
                // 按信息类型分成三组各自成行：状态概览（3 张短卡）、动态列表（3 张
                // 同高上限的长卡）、文档（2 张）。之前是一个 auto-fit 网格把所有
                // 卡片混排，于是 300px 高的进度卡和 90px 高的目标卡被塞进同一行 ——
                // 无论对齐到 start（下沿锯齿）还是 stretch（短卡里大片空白）都不好看。
                // 分组后每组内部的卡片高度本来就近，等高才真的成立。
                h('div', { style: { display: 'grid', gap: metrics.gap } },
                  h('div', {
                    style: {
                      display: 'grid', gap: metrics.gap,
                      gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                      alignItems: 'stretch',
                    },
                  },
                  GoalCard(goal),
                  supervisorSessionId == null ? null : LoopCard(stopStatus, loop),
                  WorkersCard(unresolved != null
                    ? { unavailable: '未识别到监督者会话 —— 无法读取 worker 列表。' }
                    : workers, feed, props.openSession, summaries),
                  ),
                  h('div', {
                    style: {
                      display: 'grid', gap: metrics.gap,
                      gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                      alignItems: 'stretch',
                    },
                  },
                  ProgressCard(feed.progress),
                  QuestionsCard(feed.questions),
                  ChangelogCard(feed.changelog),
                  ),
                  feed.missionReport == null && feed.notes == null
                    ? null
                    : h('div', {
                        style: {
                          display: 'grid', gap: metrics.gap,
                          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                          alignItems: 'stretch',
                        },
                      },
                      DocumentCard('任务报告', feed.missionReport),
                      DocumentCard('笔记', feed.notes),
                      ),
                ),
                h(Details, { summary: 'GOAL.md（持久声明）' },
                  feed.goal == null ? h(Empty, null, '没有 GOAL.md。') : h(Mono, { max: 400 }, feed.goal.text),
                  feed.amendments != null ? h(Mono, { max: 200 }, feed.amendments.text) : null))

      return h('div', {
        style: {
          height: '100%', overflow: 'auto', padding: '12px 14px 20px',
          boxSizing: 'border-box',
        },
      },
      h('header', {
        style: {
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          margin: '0 0 10px', color: palette.dim, fontSize: metrics.metaSize,
          lineHeight: 1.6,
        },
      },
      h('strong', { style: { fontSize: 12.5, color: palette.text, fontWeight: 600 } }, '监督动态 Feed'),
      cwd != null
        ? h('code', {
            title: cwd,
            style: {
              fontSize: metrics.metaSize,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: 320, color: palette.dim,
            },
          }, cwd)
        : null,
      // Staleness reads from when the last poll SETTLED, not from the
      // document's `generatedAt`: a 304 answer means "still current", and
      // saying so is the whole point of conditional refresh.
      checkedAt == null
        ? h('span', { style: { marginLeft: 'auto' } })
        : h('span', { style: { marginLeft: 'auto' } }, `${timeAgo(checkedAt)} 检查`,
            unchanged === true
              ? h('span', { style: { color: palette.dim } }, ' · 内容无变化')
              : null),
      // Only an explicit pause shows this — a hidden tab is not a pause, it is
      // still polling whenever it becomes visible again.
      paused === true
        ? h('span', { style: { color: palette.dim } }, '已暂停自动刷新')
        : null,
      typeof stopState === 'object' && stopState !== null
        ? h('span', { style: { color: stopState.ok ? tone.ok : tone.bad } }, stopState.message)
        : stopStatus?.stopped === true
          ? h('span', { style: { color: tone.ok } }, '已停止 · 无已启用的提醒')
        : null,
      h('button', {
        onClick: () => setPaused(value => value !== true),
        'aria-pressed': paused === true,
        'aria-label': paused === true ? '恢复 Feed 自动刷新' : '暂停 Feed 自动刷新',
        title: paused === true ? '恢复每 5 秒自动刷新' : '暂停每 5 秒自动刷新（↻ 刷新 仍可手动拉取一次）',
        style: toolbarButtonStyle,
      }, paused === true ? '▶ 继续' : '⏸ 暂停'),
      h('button', {
        onClick: () => { setTick(value => value + 1) },
        'aria-label': '立即刷新监督动态 Feed',
        title: '立即刷新一次（不影响自动刷新开关）',
        style: toolbarButtonStyle,
      }, '↻ 刷新'),
      stopState?.ok === true || stopStatus?.stopped === true || supervisorSessionId == null
        ? null
        : h('button', {
            onClick: () => { void fullStop() },
            disabled: stopState === 'working',
            'aria-label': '完全停止监督者、它委派的 worker 以及全部定时提醒',
            title: '停止监督者、其已委派的 worker 以及全部定时提醒。之后手动发一条提示即可恢复监督者。',
            style: {
              ...toolbarButtonStyle,
              fontWeight: 600,
              border: `1px solid ${tone.bad}`, color: '#fff',
              background: stopState === 'working' ? 'transparent' : tone.bad,
            },
          }, stopState === 'working' ? '正在停止…' : '■ Full stop'),
      ),
      unresolvedNotice,
      incompatibility,
      body)
    }

    // ------------------------------------- settings card (meta-config UI)

    /* 控件令牌：设置页里的输入框 / 下拉 / 按钮原来各写各的 padding 和字号
       （'4px 8px' / '5px 8px' / '5px 14px'，fontSize 12 与 13 混用），并排时
       高度差 1-2px、基线对不齐 —— 一组控件看起来就是拼的。统一成 28px 高、
       8px 圆角、12.5 号字。 */
    const fieldStyle = {
      height: 28, boxSizing: 'border-box', padding: '0 8px', borderRadius: 8,
      fontSize: metrics.bodySize, fontFamily: 'inherit',
      border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
    }
    const offStyle = { opacity: 0.5, cursor: 'not-allowed' }
    const buttonStyle = { ...fieldStyle, padding: '0 12px', cursor: 'pointer' }
    const iconButtonStyle = {
      width: 22, height: 22, flex: 'none', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      borderRadius: 6, border: 'none', background: 'transparent',
      color: palette.dim, fontSize: 12, lineHeight: 1, cursor: 'pointer', fontFamily: 'inherit',
    }
    const hintStyle = { margin: 0, fontSize: 11.5, color: palette.dim, lineHeight: 1.55 }

    /** 一个分区 = 小标题 + 一句说明 + 内容。原来三组之间只隔一条边线，
     * 读起来是一张长表单而不是三段设置。`hint` 可以是一句话，也可以是
     * 一串片段（里面要强调某个词时）；数组在这里展开成多个 child，
     * 免得 React 对数组项索要 key。`divider` 给相邻分区补一条分隔线，
     * 四块（白名单 / 模式 / 节律 / 保存）的线才落在同一个节奏上。 */
    function SettingsSection(props) {
      const body = Array.isArray(props.children) ? props.children : [props.children]
      const hint = Array.isArray(props.hint) ? props.hint : [props.hint]
      return h('section', {
        style: {
          display: 'grid', gap: metrics.gap,
          ...(props.divider === true
            ? { borderTop: `1px solid ${palette.border}`, paddingTop: 16 }
            : null),
        },
      },
      h('header', { style: { display: 'grid', gap: 3 } },
        h('h4', { style: { margin: 0, fontSize: 12.5, fontWeight: 600, color: palette.text } }, props.title),
        props.hint == null ? null : h('p', { style: hintStyle }, ...hint)),
      ...body)
    }

    /** 模式行的状态文案自带前缀符号，颜色跟着符号走：'!' 是不可忽略的偏差，
     * 其余是中性说明。之前整段都用一个灰，状态和描述分不开。 */
    const statusColor = text => text.trimStart().startsWith('!') ? tone.warn : palette.dim

    /** Number input bound to one staged field. 标签与输入框同一行、输入框靠右
     * 对齐成一列；说明跨满整行，可以正常换行而不是挤在框边。 */
    function NumberRow(props) {
      const off = props.disabled === true
      return h('label', {
        style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', alignItems: 'center' },
      },
      h('span', { style: { fontSize: metrics.bodySize, color: palette.text, minWidth: 0 } }, props.label),
      h('input', {
        type: 'number', min: props.min ?? 0, step: 1,
        value: props.value,
        disabled: off,
        onChange: event => props.onChange(event.target.value),
        className: 'dsma-field',
        style: { ...fieldStyle, width: 76, flex: 'none', textAlign: 'right', ...(off ? offStyle : null) },
      }),
      props.hint
        ? h('p', { style: { ...hintStyle, gridColumn: '1 / -1' } }, props.hint)
        : null)
    }

    /**
     * The Supervisor card in Settings → Plugins: worker-model allowlist (rows
     * with remove buttons + an "add" dropdown fed by /supervisor/models, i.e.
     * the harness model catalog with native modalities and reasoning efforts),
     * a settings-owned effort selector on every route, and the three numeric
     * knobs. Edits
     * stage locally; Save writes each changed field through the
     * revision-fenced settings scope. Changes apply live (the guarded
     * `subagent` schema and execution policy both refresh) — no restart, no
     * new session.
     */
    // 官方 preset 注册时 name 就是 id 本身，界面会显示成「standard standard」。
    // 这四个名字照抄官方 Agent 预设选择器的中文文案
    // （@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js 的 preset*Name 键）；
    // main-agent / 红队 / 无限制自带中文名，走 preset.name。
    const PRESET_LABELS = {
      standard: '标准模式',
      minimal: '极简模式',
      ptc: 'PTC 模式',
      cordis: '创造模式',
    }
    // 官方这四个 preset 在注册表里的 description 是空字符串（只有自定义 preset
    // 自带描述），这里补上与官方选择器一致的中文文案。
    const PRESET_DESCRIPTIONS = {
      standard: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
      ptc: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
      minimal: 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。',
      cordis: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
    }
    const presetLabel = preset => PRESET_LABELS[preset.id] ?? preset.name ?? preset.id
    const presetDescription = preset => preset.description || PRESET_DESCRIPTIONS[preset.id] || ''

    function makeSupervisorCard(scope) {
      return function SupervisorCard(props) {
        const snapshot = React.useSyncExternalStore(
          listener => scope.subscribe(listener),
          () => scope.getSnapshot(),
        )
        const value = snapshot.value ?? {}
        const [draft, setDraft] = React.useState(null)
        const [catalog, setCatalog] = React.useState([])
        // Preset list for the supervision multi-select. Kept apart from the
        // model catalog: one can fail without the other.
        const [presets, setPresets] = React.useState([])
        const [presetStatus, setPresetStatus] = React.useState('loading')
        // loading | ready | error — the picker must not claim "no more models"
        // when the catalog simply failed to load.
        const [catalogStatus, setCatalogStatus] = React.useState('loading')
        const [picker, setPicker] = React.useState('')
        const [pickerEffort, setPickerEffort] = React.useState('provider/default')
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)
        // A successful save with host-floor adjustments still needs to SAY so.
        const [notice, setNotice] = React.useState(null)

        const loadCatalog = () => {
          setCatalogStatus('loading')
          fetch('/supervisor/models')
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              return res.json()
            })
            .then(body => {
              setCatalog(Array.isArray(body?.models) ? body.models : [])
              setCatalogStatus('ready')
            })
            .catch(() => setCatalogStatus('error'))
        }

        const loadPresets = () => {
          setPresetStatus('loading')
          fetch('/supervisor/presets')
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              return res.json()
            })
            .then(body => {
              setPresets(Array.isArray(body?.presets) ? body.presets : [])
              setPresetStatus('ready')
            })
            .catch(() => setPresetStatus('error'))
        }

        // Load once on mount; the retry buttons reuse the same functions.
        React.useEffect(() => { loadCatalog(); loadPresets() }, [])

        // The Plugins page renders every item twice: a one-line summary in the
        // detail header and the editable form on the page itself. Every hook
        // above runs in both views.
        if (props?.view === 'summary') {
          return h('p', { style: { margin: 0, fontSize: 13, color: palette.dim } },
            'Worker 模型白名单、按路由的推理强度、循环节律，以及哪些模式启用监督循环。')
        }

        const current = draft ?? {
          workerModels: Array.isArray(value.workerModels) ? value.workerModels : ['runtime/current'],
          workerEfforts: value.workerEfforts !== null && typeof value.workerEfforts === 'object'
            && !Array.isArray(value.workerEfforts) ? value.workerEfforts : { 'runtime/current': 'provider/default' },
          maxParallelWorkers: value.maxParallelWorkers ?? 3,
          maxSpawnTotal: value.maxSpawnTotal ?? 0,
          workerDeadlineMinutes: value.workerDeadlineMinutes ?? 0,
          watchdogEnabled: value.watchdogEnabled !== false,
          wakeMinutes: value.wakeMinutes ?? 5,
          questionWaitMinutes: value.questionWaitMinutes ?? 2,
          supervisedPresets: Array.isArray(value.supervisedPresets) ? value.supervisedPresets : [],
        }
        const edit = patch => { setDraft({ ...current, ...patch }); setFailed(false) }
        const writable = snapshot.writable === true
        const disabled = !writable || saving

        const save = async () => {
          if (draft === null || saving) return
          setSaving(true)
          setFailed(false)
          setNotice(null)
          const notes = []
          const numeric = (raw, fallback) => {
            const parsed = Number(raw)
            return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
          }
          const floor = (label, next, minimum) => {
            if (next < minimum) {
              notes.push(`${label} 按宿主下限由 ${next} 调整为 ${minimum}`)
              return minimum
            }
            return next
          }
          // Write effort ownership before newly allowing its route. The spawn
          // path also defaults every missing legacy entry to provider/default.
          const nextValues = {
            workerEfforts: Object.fromEntries(draft.workerModels.map(route => [
              route,
              draft.workerEfforts[route] ?? 'provider/default',
            ])),
            workerModels: draft.workerModels,
            maxParallelWorkers: numeric(draft.maxParallelWorkers, 3),
            maxSpawnTotal: numeric(draft.maxSpawnTotal, 0),
            workerDeadlineMinutes: numeric(draft.workerDeadlineMinutes, 0),
            watchdogEnabled: draft.watchdogEnabled !== false,
            wakeMinutes: floor('wakeMinutes', numeric(draft.wakeMinutes, 5), 1),
            questionWaitMinutes: floor('questionWaitMinutes', numeric(draft.questionWaitMinutes, 2), 1),
          }
          const applied = []
          // The supervision selection travels a different path: the host has
          // to rewrite each chosen preset's loader row, which no plain
          // settings write can do. Compare as sets — tick order is noise.
          const nextPresets = Array.isArray(draft.supervisedPresets) ? draft.supervisedPresets : []
          const sameSet = (a, b) => {
            const left = new Set(Array.isArray(a) ? a : [])
            const right = new Set(Array.isArray(b) ? b : [])
            if (left.size !== right.size) return false
            for (const item of left) if (!right.has(item)) return false
            return true
          }
          const presetsChanged = !sameSet(nextPresets, value.supervisedPresets)
          try {
            for (const [key, next] of Object.entries(nextValues)) {
              await scope.set(key, next)
              applied.push(key)
            }
            if (presetsChanged) {
              const res = await fetch('/supervisor/presets', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ supervised: nextPresets }),
              })
              if (!res.ok) {
                const detail = await res.json().catch(() => null)
                throw new Error(detail?.error ?? `HTTP ${res.status}`)
              }
            }
            setDraft(null)
            setNotice(notes.length === 0 ? null : `已保存。${notes.join('；')}。`)
            if (presetsChanged) loadPresets()
          } catch {
            // A half-applied settings edit is worse than a rejected one: put
            // back what THIS save already committed, newest first.
            for (const key of applied.reverse()) {
              try {
                await scope.set(key, value[key])
              } catch {
                // A failed rollback leaves the applied value visible — the
                // error message below still says the save did not complete.
              }
            }
            setFailed(true)
          }
          setSaving(false)
        }

        const options = catalog.filter(model =>
          !current.workerModels.includes(`${model.provider}/${model.id}`))
        const catalogEntry = route => catalog.find(model => `${model.provider}/${model.id}` === route)
        const effortOptionsFor = route => {
          const models = route === 'runtime/current'
            ? catalog.filter(model => model.dynamic !== true)
            : [catalogEntry(route)].filter(Boolean)
          const byId = new Map()
          for (const model of models) {
            for (const effort of model.reasoning?.efforts ?? []) {
              if (!byId.has(effort.id)) byId.set(effort.id, effort)
            }
          }
          return [...byId.values()]
        }
        const effortSelect = (route, selected, onChange, extraStyle = {}) => {
          const effortOptions = effortOptionsFor(route)
          const known = effortOptions.some(effort => effort.id === selected)
          // Only a READY catalog can prove "this model does not declare this
          // effort". While it is loading (or failed) a stored value is merely
          // unverified — claiming it will be rejected at spawn time is a false
          // alarm, and it fired on every open of the settings page.
          const unverified = selected !== 'provider/default' && !known
          return h('select', {
            value: selected,
            disabled,
            onChange,
            'aria-label': `推理强度（${route}）`,
            title: `推理强度由插件设置固定，适用于 ${route}`,
            className: 'dsma-field',
            style: {
              // 比主输入框矮 2px：它挂在“行”里，不跟表单字段抢同一基线。
              ...fieldStyle, height: 26, fontSize: 11.5, padding: '0 6px', minWidth: 148,
              ...(disabled ? offStyle : null),
              ...extraStyle,
            },
          },
          h('option', { value: 'provider/default' }, 'Provider default'),
          // A stored effort the model does not advertise would be rejected by
          // the host during provider I/O, i.e. saved successfully and failed
          // later at spawn time. Keep it visible but NOT selectable.
          unverified && catalogStatus === 'ready'
            ? h('option', { value: selected, disabled: true },
                `${selected}（该模型未声明支持 —— 派生时会被拒绝）`)
            // 中性弱提示：既让 <select> 不因值无对应 <option> 而显示空白，
            // 又不下任何「未声明支持」的结论。
            : unverified
              ? h('option', { value: selected, disabled: true },
                  `${selected}（${catalogStatus === 'error' ? '目录读取失败' : '目录读取中'}，暂不校验强度）`)
              : null,
          effortOptions.map(effort => h('option', {
            key: effort.id,
            value: effort.id,
            title: effort.description,
          }, `${effort.name} (${effort.id})`)))
        }
        const capabilityTag = (entry, model) => entry === 'runtime/current' || model?.dynamic === true
          ? '[current turn — resolved at call time]'
          : model
            ? `[${model.modalities.join(',')}${(model.reasoning?.efforts?.length ?? 0) > 0
              ? `; effort ${model.reasoning.efforts.map(effort => effort.id).join('/')}`
              : ''}]`
            : ''

        /** A stored route effort the selected model does not advertise. The
         * host rejects it during provider I/O, i.e. the save succeeds and the
         * spawn fails — worth a visible warning on the row, but ONLY once the
         * catalog is ready: before that we cannot tell "not declared" from
         * "not loaded yet". */
        const effortUnsupported = route => {
          if (catalogStatus !== 'ready') return false
          const selected = current.workerEfforts[route] ?? 'provider/default'
          return selected !== 'provider/default'
            && !effortOptionsFor(route).some(effort => effort.id === selected)
        }

        return h('section', {
          style: {
            border: `1px solid ${palette.border}`, borderRadius: metrics.radius,
            background: palette.card, padding: '12px 14px',
            display: 'grid', gap: 16,
          },
        },
        h('header', { style: { display: 'grid', gap: 4 } },
          h('h3', {
            style: {
              margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              fontSize: 14, fontWeight: 600, color: palette.text,
            },
          },
          '监督者运行时',
          h('code', {
            style: {
              padding: '1px 6px', borderRadius: 999, background: 'rgba(127,127,127,.12)',
              fontSize: 10.5, fontWeight: 400, color: palette.dim, lineHeight: '16px',
            },
          }, 'dsh-main-agent')),
          h('p', { style: hintStyle },
            '子代理只能选用下面列出的路由，并在每次调用时重新校验；改动立即生效，无需重启。')),

        h(SettingsSection, {
          title: 'Worker 模型白名单',
          hint: '每行的强度只作用于该路由。选 Provider default 时不发送显式强度；'
            + '选了具体值，宿主会在写入 provider 前按该模型校验。',
        },
        current.workerModels.length === 0
          ? h('p', { style: hintStyle }, '为空 —— 子代理派生已禁用，不会继承父级或默认模型。')
          : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
              current.workerModels.map(entry => {
                const hit = catalogEntry(entry)
                return h('li', {
                  key: entry,
                  style: {
                    display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
                    padding: '4px 6px 4px 8px', borderRadius: 8,
                    background: 'rgba(127,127,127,.05)',
                  },
                },
                h('code', {
                  style: {
                    flex: '0 1 auto', minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontSize: 12, fontFamily: monoStack, color: palette.text,
                  },
                }, entry),
                h('span', { style: { fontSize: 10.5, color: palette.dim, flex: 'none' } },
                  capabilityTag(entry, hit)),
                effortUnsupported(entry)
                  ? h('span', {
                      role: 'status',
                      title: '该强度未被这个模型声明支持；派生时宿主会拒绝。请改选 Provider default 或一个已声明的强度。',
                      style: { fontSize: 11, color: tone.warn, flex: 'none' },
                    }, '⚠')
                  : null,
                effortSelect(
                  entry,
                  current.workerEfforts[entry] ?? 'provider/default',
                  event => edit({
                    workerEfforts: { ...current.workerEfforts, [entry]: event.target.value },
                  }),
                  { marginLeft: 'auto', flex: 'none' },
                ),
                h('button', {
                  className: 'dsma-icon',
                  disabled,
                  onClick: () => {
                    const workerEfforts = { ...current.workerEfforts }
                    delete workerEfforts[entry]
                    edit({
                      workerModels: current.workerModels.filter(item => item !== entry),
                      workerEfforts,
                    })
                  },
                  'aria-label': `从白名单移除 ${entry}`,
                  title: '移除',
                  style: { ...iconButtonStyle, ...(disabled ? offStyle : null) },
                }, '✕'))
              })),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('select', {
              value: picker,
              disabled: disabled || catalogStatus !== 'ready',
              onChange: event => {
                setPicker(event.target.value)
                setPickerEffort('provider/default')
              },
              'aria-label': '从模型目录添加一个 worker 模型',
              className: 'dsma-field',
              style: {
                ...fieldStyle, flex: 1, minWidth: 200,
                ...(disabled || catalogStatus !== 'ready' ? offStyle : null),
              },
            },
            h('option', { value: '' },
              catalogStatus === 'loading' ? '正在读取模型目录…'
                : catalogStatus === 'error' ? '（模型目录读取失败）'
                : options.length === 0 ? '（模型目录中已无更多模型）'
                : '从模型目录添加一个模型…'),
            options.map(model => h('option', {
              key: `${model.provider}/${model.id}`,
              value: `${model.provider}/${model.id}`,
            }, model.dynamic === true
              ? '当前运行时模型 —— 跟随本次调用回合（runtime/current）'
              : `${model.provider}/${model.id}  ${capabilityTag('', model)}`))),
            picker === '' ? null : effortSelect(
              picker,
              pickerEffort,
              event => setPickerEffort(event.target.value),
            ),
            h('button', {
              className: 'dsma-btn',
              disabled: disabled || picker === '',
              onClick: () => {
                edit({
                  workerModels: [...current.workerModels, picker],
                  workerEfforts: { ...current.workerEfforts, [picker]: pickerEffort },
                })
                setPicker('')
                setPickerEffort('provider/default')
              },
              style: {
                ...buttonStyle, ...(disabled || picker === '' ? offStyle : null),
              },
            }, '添加'),
            catalogStatus === 'error'
              ? h('button', {
                  className: 'dsma-btn',
                  disabled,
                  onClick: loadCatalog,
                  'aria-label': '重新读取模型目录',
                  style: {
                    ...buttonStyle, borderColor: tone.bad, color: tone.bad,
                    ...(disabled ? offStyle : null),
                  },
                }, '重试目录')
              : null)),

        h(SettingsSection, {
          title: '启用监督循环的模式',
          divider: true,
          hint: [
            '勾选后，该模式的下一个',
            h('strong', { style: { color: palette.text, fontWeight: 600 } }, '新会话'),
            '会拿到监督者人格和监督工具（start_goal / 派生 worker / 运行中纠偏 / 定时器唤醒），'
              + '在自己的会话里主动跑循环、往 .agi/ 写状态。有 loader 行的模式立即生效；'
              + '由插件直接注册的模式写盘后即时重挂载，重挂载不成功时等下次重启。'
              + '已经在跑的会话保持原样。Main Agent 入口本身就是监督者，无法关闭。',
          ],
        },
        presetStatus === 'loading'
          ? h('p', { style: hintStyle }, '正在读取 preset 列表…')
          : presetStatus === 'error'
            ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: metrics.bodySize, color: tone.bad } },
                  'preset 列表读取失败 —— 无法确认当前各模式的监督状态。'),
                h('button', {
                  className: 'dsma-btn',
                  disabled,
                  onClick: loadPresets,
                  'aria-label': '重新读取 preset 列表',
                  style: {
                    ...buttonStyle, height: 24, fontSize: metrics.metaSize,
                    borderColor: tone.bad, color: tone.bad, ...(disabled ? offStyle : null),
                  },
                }, '重试'))
            : presets.length === 0
              ? h('p', { style: hintStyle }, '注册表里没有可用的 preset。')
              : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
                  presets.map(preset => {
                    const builtin = preset.builtin === true
                    const checked = builtin || current.supervisedPresets.includes(preset.id)
                    // A preset with no loader row in this process cannot be
                    // rewritten without a restart, so it is shown (the user
                    // should know it exists) but not offered as a toggle.
                    const toggleable = !builtin && preset.broken !== true
                      && (preset.live === true || preset.fileBacked === true)
                    const interactive = toggleable && !disabled
                    const description = builtin ? '' : presetDescription(preset)
                    // 只有偏离「普通 agent」的情况才配一行状态；每行都重复
                    // 「无监督能力」是噪音。
                    // A loader-backed preset flips instantly. One registered
                    // straight into the registry has no entry to rewrite, so the
                    // host writes its composition file and the declaring plugin
                    // picks that up on the next start.
                    const status = builtin
                      ? '✓ 内置监督者，恒为开启'
                      : preset.broken === true
                        ? '! 自身加载失败，无法改写'
                        : preset.live === true
                          ? preset.rows === 3
                            ? '✓ 已启用，监督层完整'
                            : preset.rows > 0
                              ? `! 监督层不完整（${preset.rows}/3），下次保存会补齐`
                              : ''
                          : preset.fileBacked !== true
                            ? '· 由插件在运行时生成，没有可改写的文件'
                            : preset.mounted === true
                              ? '✓ 已启用，立即生效'
                              : preset.pendingRestart === true
                                ? '✓ 已写入磁盘，重启 DSH 后生效'
                                : '· 由插件直接注册，勾选后立即挂载并写入磁盘'
                    return h('li', { key: preset.id },
                      h('label', {
                        // 整行可点（行高 7+7+内容 ≈ 34-40px），比只点 14px 的
                        // 方块好按得多；不可切换的行不给 hover 与手型。
                        className: interactive ? 'dsma-choice' : undefined,
                        style: {
                          display: 'flex', alignItems: 'flex-start', gap: 9,
                          padding: '7px 9px', borderRadius: 8,
                          // 选中的行整块换底色：只靠 14px 的勾选框区分 8 行，
                          // 扫一眼看不出哪几个开着。
                          border: `1px solid ${checked ? 'rgba(64,112,173,.30)' : 'transparent'}`,
                          background: checked ? 'rgba(64,112,173,.08)' : 'rgba(127,127,127,.04)',
                          opacity: builtin || toggleable ? 1 : 0.62,
                          cursor: interactive ? 'pointer' : 'default',
                        },
                      },
                      h('input', {
                        type: 'checkbox',
                        className: 'dsma-check',
                        checked,
                        disabled: disabled || !toggleable,
                        'aria-label': `在 ${presetLabel(preset)} 模式启用监督循环`,
                        onChange: () => {
                          const next = checked
                            ? current.supervisedPresets.filter(id => id !== preset.id)
                            : [...current.supervisedPresets, preset.id]
                          edit({ supervisedPresets: next })
                        },
                        style: { width: 14, height: 14, marginTop: 2, flex: 'none' },
                      }),
                      h('div', { style: { display: 'grid', gap: 2, minWidth: 0 } },
                        h('span', { style: { display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' } },
                          h('span', {
                            style: {
                              fontSize: metrics.bodySize,
                              fontWeight: checked ? 600 : 500,
                              color: palette.text,
                            },
                          }, presetLabel(preset)),
                          h('code', { style: { fontSize: 10.5, fontFamily: monoStack, color: palette.dim } }, preset.id)),
                        description
                          ? h('div', { style: { fontSize: 11.5, color: palette.dim, lineHeight: 1.55 } }, description)
                          : null,
                        status
                          ? h('div', { style: { fontSize: 10.5, color: statusColor(status), lineHeight: 1.45 } }, status)
                          : null)))
                  }))),

        h(SettingsSection, {
          title: '循环节律',
          divider: true,
          hint: '监督者跑循环的参数。改完点保存，立即生效。前两项是上限，后三项决定「多久醒一次」。',
        },
        h('div', { style: { display: 'grid', gap: 12 } },
          h(NumberRow, {
            label: '最大并行 worker 数', min: 0, disabled,
            value: current.maxParallelWorkers,
            onChange: text => edit({ maxParallelWorkers: text }),
            hint: '同时保持打开的 worker 硬上限，0 表示不限。监督者派生时强制执行，超出会被拒绝。',
          }),
          h(NumberRow, {
            label: 'worker 总量预算', min: 0, disabled,
            value: current.maxSpawnTotal,
            onChange: text => edit({ maxSpawnTotal: text }),
            hint: '整个会话累计可派生的 worker 数，0 表示不限。并行上限只约束「同时活着」，这一项防止长目标无限派生。',
          }),
          h(NumberRow, {
            label: 'worker 停滞超时（分钟）', min: 0, disabled,
            value: current.workerDeadlineMinutes,
            onChange: text => edit({ workerDeadlineMinutes: text }),
            hint: 'worker 多久没有任何日志活动就算卡死，由服务端 interrupt 掉并记一次停滞。0 表示不自动中断。',
          }),
          h(NumberRow, {
            label: '唤醒间隔（分钟）', min: 1, disabled,
            value: current.wakeMinutes,
            onChange: text => edit({ wakeMinutes: text }),
            hint: '空闲时的基准间隔。有 worker 在跑会缩到 1–2 分钟，等用户回答会拉长到 5–15 分钟，连续没进展则退避到 30 分钟。',
          }),
          h(NumberRow, {
            label: '问题等待时长（分钟）', min: 1, disabled,
            value: current.questionWaitMinutes,
            onChange: text => edit({ questionWaitMinutes: text }),
            hint: '等用户回答问题的时间；超时后记录一个假设并继续工作。',
          }),
          h('label', {
            style: {
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '7px 9px', borderRadius: 8,
              background: current.watchdogEnabled === false ? 'rgba(127,127,127,.04)' : 'rgba(64,112,173,.08)',
              border: current.watchdogEnabled === false ? '1px solid transparent' : '1px solid rgba(64,112,173,.30)',
              cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
            },
            className: disabled ? undefined : 'dsma-choice',
          },
          h('input', {
            type: 'checkbox',
            checked: current.watchdogEnabled !== false,
            disabled,
            onChange: event => edit({ watchdogEnabled: event.target.checked }),
            style: { width: 14, height: 14, marginTop: 2, flex: 'none' },
            className: 'dsma-check',
          }),
          h('span', { style: { display: 'grid', gap: 2, minWidth: 0 } },
            h('span', { style: { fontSize: metrics.bodySize, fontWeight: 600, color: palette.text } },
              '服务端兜底提醒（watchdog）'),
            h('span', { style: { fontSize: 11.5, color: palette.dim, lineHeight: 1.55 } },
              '每轮开始时检查：目标还在进行、却没有留下任何提醒，就由服务端补一条 —— 模型漏排提醒时循环不会静默停住。'),
            h('span', { style: { fontSize: 10.5, color: palette.dim } },
              current.watchdogEnabled === false ? '已关闭，循环连续性完全依赖模型自己排提醒' : '已启用，和模型自己排的提醒不会重复'))))),

        h('footer', {
          style: {
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            borderTop: `1px solid ${palette.border}`, paddingTop: 14,
          },
        },
        h('button', {
          className: 'dsma-btn',
          disabled: disabled || draft === null,
          onClick: () => { void save() },
          style: {
            ...buttonStyle, height: 30, padding: '0 16px', fontWeight: 600,
            ...(disabled || draft === null
              ? offStyle
              : { background: tone.info, borderColor: tone.info, color: '#fff' }),
          },
        }, saving ? '正在保存…' : '保存'),
        draft !== null
          ? h('button', {
              className: 'dsma-btn',
              disabled: saving,
              onClick: () => { setDraft(null); setFailed(false); setNotice(null) },
              style: { ...buttonStyle, height: 30, ...(saving ? offStyle : null) },
            }, '放弃')
          : null,
        draft !== null && !saving
          ? h('span', { style: { fontSize: metrics.metaSize, color: palette.dim } }, '有未保存的改动')
          : null,
        failed
          ? h('span', { style: { fontSize: metrics.bodySize, color: tone.bad } }, '保存失败 —— 已撤销本次已写入的字段，输入值仍在，请重试。')
          : null,
        notice !== null && failed !== true
          ? h('span', { style: { fontSize: metrics.bodySize, color: tone.warn } }, notice)
          : null,
        !writable ? h('span', { style: { fontSize: metrics.bodySize, color: palette.dim } }, '设置文档为只读。') : null))
      }
    }

    // ------------------------------------------------------------- plugin

    const inject = ['slots', 'configForms']

    /** Settings namespace = this plugin's profile row id (cordis.patch.yml).
     * Spelled here rather than imported: a client package must not depend on a
     * Host package. */
    const SETTINGS_NS = 'agi-supervisor-setup'

    /** Sidebar entry + `main` panel id. The two registrations below must share
     * it: `layout.selectPanel` throws `main panel "<id>" is not registered`
     * when the column lists an id nothing backs. */
    const PANEL_ID = 'supervisor'

    /**
     * The sidebar's glyph. Drawn here rather than taken from
     * `dsh-client-ui-primitives`: cross-plugin value imports are exactly what
     * the client bundle purity gate forbids, and one icon does not justify
     * reaching around it. `{ size, active }` is the contract the sidebar hands
     * `sidebar.panellist` components.
     */
    function SupervisorPanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('circle', { cx: 8, cy: 8, r: 2.15 }),
      h('path', { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2' }),
      h('path', { d: 'M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4' }))
    }

    function apply(ctx) {
      // Session navigation lives on the `uiWorkspace` CLIENT service (the
      // shipped task-board plugin resolves it the same way). It is fetched
      // with `ctx.get` rather than added to `inject` on purpose: a profile
      // without that service must degrade to plain, unclickable worker labels,
      // not block this plugin from loading at all. No caching across `apply`
      // calls — HMR re-runs this function.
      let uiWorkspace
      try {
        uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
      } catch {
        uiWorkspace = undefined
      }
      const openSession = typeof uiWorkspace?.openSession === 'function'
        ? id => uiWorkspace.openSession(id)
        : undefined
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: 'supervisor-feed', order: 50, label: '监督动态' },
        // `conversation.view` receives only explicit props — `openView` is a
        // VIEW-TAB switch, not a session switch — so the capability is threaded
        // through a wrapper instead of being read off its props.
        props => h(FeedView, { ...props, openSession }),
      ))
      // `configForms` binds the Host-served namespace to a revision-fenced
      // scope; the Plugins page owns `plugins.item` and `whileServed` keeps the
      // tab mounted only while that namespace is actually served.
      const scope = ctx.configForms.get(SETTINGS_NS)
      // One component instance for every surface: the settings card, the
      // sidebar page. All of them read the same form, so a save on one page is
      // already visible on the other without a reload.
      const SupervisorCard = makeSupervisorCard(scope)
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject(
        'plugins.item',
        () => ctx.slots.register({
          name: 'plugins.item',
          id: 'supervisor',
          order: 40,
          label: '监督者',
        }, SupervisorCard),
      )))

      // First-level sidebar entry. `main` is a KEYED slot — the shipped Plugins
      // page backs its `sidebar.panellist` row exactly this way — and
      // `sidebar.panellist` is the list the column renders as rows. A page
      // without the row is unreachable; a row without the page throws on click,
      // so both registrations share `whileServed` and appear/disappear together.
      //
      // The page owns its own scroll box and top clearance: `main` paints flush
      // to the frame's top edge, and the frame reserves
      // `--dsh-frame-top-clearance` for the window controls.
      const SupervisorPage = () => h('div', {
        style: {
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          overflow: 'auto',
          padding: 'calc(28px + var(--dsh-frame-top-clearance, 0px)) 24px 40px',
        },
      },
      h('div', { style: { maxWidth: 780, margin: '0 auto' } }, h(SupervisorCard)))

      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject(
        'main',
        () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, label: '监督者' },
          SupervisorPage,
        ),
      )))
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject(
        'sidebar.panellist',
        () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: '监督者' },
          SupervisorPanelIcon,
        ),
      )))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
