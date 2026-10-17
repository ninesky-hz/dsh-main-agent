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

    /** POST /api/<method> with the client-request envelope; null on any failure. */
    async function rpc(method, payload) {
      try {
        const res = await fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: `feed-${Math.random().toString(36).slice(2, 10)}`,
            method,
            payload,
          }),
        })
        const body = await res.json()
        return body?.result?.ok === true ? body.result.value : null
      } catch {
        return null
      }
    }

    async function fetchFeed(ws) {
      try {
        const res = await fetch(`/supervisor/feed?ws=${encodeURIComponent(ws)}`)
        if (!res.ok) return { missing: true, status: res.status }
        return await res.json()
      } catch {
        return null
      }
    }

    async function fetchStopStatus(sessionId) {
      try {
        const res = await fetch(`/supervisor/stop?session=${encodeURIComponent(sessionId)}`)
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
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

    const tone = {
      ok: '#2f9e6e', warn: '#c98a1b', bad: '#c0504d', idle: '#7a7a7a', info: '#4a7dbd',
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

    function Pill(props) {
      return h('span', {
        style: {
          display: 'inline-block', padding: '1px 8px', borderRadius: 999,
          fontSize: 11, fontWeight: 600, lineHeight: '16px',
          color: '#fff', background: props.color ?? tone.idle,
          textTransform: 'uppercase', letterSpacing: '.4px',
        },
      }, props.children)
    }

    function Card(props) {
      return h('section', {
        style: {
          border: `1px solid ${palette.border}`, borderRadius: 12,
          background: palette.card, padding: '12px 14px',
          minWidth: 0, gridColumn: props.wide === true ? '1 / -1' : undefined,
        },
      },
      h('header', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8,
        },
      },
      h('h3', {
        style: {
          margin: 0, fontSize: 12, fontWeight: 700, color: palette.dim,
          textTransform: 'uppercase', letterSpacing: '.6px',
        },
      }, props.title),
      props.badge ?? null,
      ),
      props.children)
    }

    function Empty(props) {
      return h('p', { style: { margin: 0, color: palette.dim, fontSize: 13 } },
        props.children)
    }

    function Mono(props) {
      return h('pre', {
        style: {
          margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          font: '12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
          color: palette.text, maxHeight: props.max ?? 260, overflow: 'auto',
        },
      }, props.children)
    }

    function Details(props) {
      return h('details', { style: { marginTop: 6 } },
        h('summary', {
          style: { cursor: 'pointer', fontSize: 12, color: palette.dim, userSelect: 'none' },
        }, props.summary),
        h('div', { style: { marginTop: 6 } }, props.children))
    }

    // ------------------------------------------------------------- cards

    function GoalCard(goal) {
      const phaseColor = { active: tone.ok, paused: tone.warn, blocked: tone.bad, completed: tone.info }
      if (goal == null) {
        return h(Card, { title: '目标' },
          h(Empty, null, '没有进行中的目标 —— 目标创建后，聊天输入框上方的 GoalBar 会出现。'))
      }
      return h(Card, { title: '目标', badge: h(Pill, { color: phaseColor[goal.phase] ?? tone.idle }, String(goal.phase ?? 'unknown')) },
        h('p', { style: { margin: '0 0 6px', fontSize: 14, lineHeight: 1.5, color: palette.text } },
          String(goal.objective ?? '')),
        h('p', { style: { margin: 0, fontSize: 12, color: palette.dim } },
          `rev ${goal.revision ?? '?'} · 回合 ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? '∞'}`
          + (goal.blockedReason ? ` · 阻塞：${goal.blockedReason}` : '')
          + (typeof goal.updatedAt === 'number' ? ` · ${timeAgo(goal.updatedAt)} 更新` : '')))
    }

    function WorkersCard(workers, feed) {
      const entries = Array.isArray(workers?.workers) ? workers.workers : []
      const outcomes = new Map()
      for (const sub of feed?.subagents ?? []) outcomes.set(sub.name, sub)
      const dot = (running) => h('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 8,
          background: running === true ? tone.ok : tone.idle, flex: 'none',
        },
      })
      const runningCount = entries.filter(entry => entry.running === true).length
      const body = workers?.error != null
        ? h(Empty, null, `无法读取 worker 列表：${workers.error}`)
        : workers == null
          ? h(Empty, null, '正在读取 worker 列表…')
          : entries.length === 0
            ? h(Empty, null, '本会话尚未派生任何 worker。')
            : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
                entries.map(entry => h('li', {
                  key: entry.id,
                  style: { display: 'flex', alignItems: 'center', fontSize: 13, color: palette.text, minWidth: 0 },
                },
                dot(entry.running),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  String(entry.label ?? entry.id)),
                h('span', { style: { marginLeft: 'auto', paddingLeft: 8, fontSize: 11, color: palette.dim, flex: 'none' } },
                  `${entry.running === true ? '运行中' : '空闲'}`
                  + (typeof entry.createdAt === 'number' ? ` · ${timeAgo(entry.createdAt)}` : '')))))
      return h(Card, {
        title: 'Workers',
        badge: h(Pill, { color: runningCount > 0 ? tone.ok : tone.idle }, `${runningCount}/${entries.length}`),
      },
      body,
      (feed?.subagents ?? []).filter(sub => sub.outcome != null).map(sub =>
        h(Details, { key: sub.name, summary: `结果 — ${sub.name}` },
          h(Mono, { max: 220 }, sub.outcome.text))))
    }

    function ProgressCard(progress) {
      const items = Array.isArray(progress) ? progress.slice(-30).reverse() : []
      return h(Card, { title: '进度', wide: false },
        items.length === 0
          ? h(Empty, null, '目前 .agi/progress.jsonl 中还没有任何内容。')
          : h('ol', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
              items.map((item, index) => h('li', {
                key: index,
                style: { display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.45, color: palette.text },
              },
              h('span', { style: { color: palette.dim, flex: 'none', font: '11px/1.6 ui-monospace, monospace' } },
                tsLabel(item.ts)),
              h('span', null, String(item.text ?? JSON.stringify(item)))))))
    }

    function QuestionsCard(questions) {
      const items = Array.isArray(questions) ? questions.slice(-20).reverse() : []
      const color = (status) => status === 'answered' ? tone.ok : status === 'assumed' ? tone.warn : tone.info
      return h(Card, { title: '提问' },
        items.length === 0
          ? h(Empty, null, '尚未提出任何问题。')
          : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 } },
              items.map((item, index) => h('li', { key: index, style: { fontSize: 13, color: palette.text } },
                h(Pill, { color: color(item.status) }, String(item.status ?? '?')),
                h('span', { style: { marginLeft: 8 } },
                  String(item.question ?? item.text ?? item.id ?? JSON.stringify(item))),
                item.assumption
                  ? h('div', { style: { marginTop: 2, fontSize: 12, color: palette.dim } }, `假设：${item.assumption}`)
                  : null))))
    }

    function ChangelogCard(changelog) {
      const items = Array.isArray(changelog) ? changelog.slice(-40).reverse() : []
      const color = (action) => (
        action === 'spawn' ? tone.ok
        : action === 'kill' ? tone.bad
        : action === 'steer' ? tone.warn
        : action === 'verify' || action === 'deliver' ? tone.info
        : tone.idle)
      return h(Card, { title: '变更日志', wide: true },
        items.length === 0
          ? h(Empty, null, '尚未记录任何有后果的操作。')
          : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 7 } },
              items.map((item, index) => h('li', {
                key: index,
                style: { display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, color: palette.text },
              },
              h('span', { style: { color: palette.dim, flex: 'none', font: '11px/1.6 ui-monospace, monospace' } },
                tsLabel(item.ts)),
              h(Pill, { color: color(item.action) }, String(item.action ?? '?')),
              h('span', { style: { minWidth: 0 } }, String(item.summary ?? JSON.stringify(item)))))))
    }

    function DocumentCard(label, doc) {
      return h(Card, { title: label, badge: doc ? h('span', { style: { fontSize: 11, color: palette.dim } }, timeAgo(doc.mtime)) : null },
        doc == null
          ? h(Empty, null, `没有 ${label} 文件。`)
          : h(Mono, { max: 340 }, doc.text))
    }

    // ------------------------------------------------------------- view

    function FeedView(props) {
      const goal = props.useProjection('goal')
      const sessionId = props.sessionId
      const summaries = props.useSessions(snapshot => snapshot.byId)
      let supervisor = summaries[sessionId]
      const visited = new Set()
      while (supervisor?.origin === 'subagent'
        && supervisor.parentId != null
        && !visited.has(supervisor.id)) {
        visited.add(supervisor.id)
        supervisor = summaries[supervisor.parentId]
      }
      if (supervisor?.origin === 'subagent' || supervisor?.agentPreset !== 'main-agent') {
        supervisor = null
      }
      const supervisorSessionId = supervisor?.id ?? null
      const cwd = supervisor?.cwd ?? summaries[sessionId]?.cwd ?? null
      const [feed, setFeed] = React.useState(null)
      const [feedError, setFeedError] = React.useState(false)
      const [workers, setWorkers] = React.useState(null)
      const [health, setHealth] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [stopState, setStopState] = React.useState(null)
      const [stopStatus, setStopStatus] = React.useState(null)

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
          // session.create with an existing id is the Harness's ordinary cold-
          // resume path. It publishes the Agent without starting a turn, so
          // the stop route can mutate persisted reminders through the live
          // Agent maintenance seam.
          const resumed = await rpc('session.create', {
            sessionId: supervisorSessionId,
            cwd: supervisor.cwd,
          })
          if (resumed == null) {
            setStopState({ ok: false, message: '无法恢复监督者' })
            return
          }
          const res = await fetch(`/supervisor/stop?session=${encodeURIComponent(supervisorSessionId)}`, { method: 'POST' })
          const body = await res.json().catch(() => null)
          if (res.ok && body != null) {
            setStopStatus({ stopped: true, running: false, reminders: [] })
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

      React.useEffect(() => {
        const timer = setInterval(() => setTick(value => value + 1), 5000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
        if (cwd == null) return
        let live = true
        fetchFeed(cwd).then(value => {
          if (!live) return
          setFeed(value)
          setFeedError(value == null)
        })
        if (supervisorSessionId != null) {
          fetchWorkers(supervisorSessionId).then(value => { if (live) setWorkers(value) })
        }
        // A host that renamed the delegation API must be reported, not masked.
        fetchHealth().then(value => { if (live) setHealth(value) })
        return () => { live = false }
      }, [cwd, supervisorSessionId, tick])

      React.useEffect(() => {
        if (supervisorSessionId == null) return
        let live = true
        fetchStopStatus(supervisorSessionId).then(value => { if (live && value != null) setStopStatus(value) })
        return () => { live = false }
      }, [supervisorSessionId, supervisor?.updatedAt, supervisor?.running])

      const incompatibility = health?.ok === false
        ? h('div', {
            role: 'alert',
            style: {
              margin: '0 0 12px', padding: '8px 12px', borderRadius: 10, fontSize: 12,
              lineHeight: 1.5, color: palette.text,
              border: `1px solid ${tone.bad}`, background: 'rgba(192,80,77,.10)',
            },
          },
          h('strong', null, '宿主 subagent 服务不兼容：'),
          ` ${String(health?.subagents?.message ?? '缺少必要方法')}。`,
          h('div', { style: { marginTop: 4, color: palette.dim } },
            'worker 派生、并发上限与 Full stop 的 worker 释放都无法工作，直到宿主升级到 dsh-subagent 0.2.x 或插件更新。'),
          )
        : null

      const body = cwd == null
        ? h(Empty, null, '正在解析会话工作区…')
        : feed == null && feedError
          ? h('div', { style: { display: 'grid', gap: 8, justifyItems: 'start' } },
              h(Empty, null, `无法读取监督动态（${cwd}）—— 本插件的 /supervisor/feed 路由不可用或返回了错误。`),
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
                h('div', {
                  style: {
                    display: 'grid', gap: 12,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                    alignItems: 'start',
                  },
                },
                GoalCard(goal),
                WorkersCard(workers, feed),
                ProgressCard(feed.progress),
                QuestionsCard(feed.questions),
                ChangelogCard(feed.changelog),
                DocumentCard('任务报告', feed.missionReport),
                DocumentCard('笔记', feed.notes),
                ),
                h(Details, { summary: 'GOAL.md（持久声明）' },
                  feed.goal == null ? h(Empty, null, '没有 GOAL.md。') : h(Mono, { max: 400 }, feed.goal.text),
                  feed.amendments != null ? h(Mono, { max: 200 }, feed.amendments.text) : null))

      return h('div', {
        style: {
          height: '100%', overflow: 'auto', padding: '14px 18px 28px',
          boxSizing: 'border-box',
        },
      },
      h('header', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: 10, margin: '2px 0 14px',
          color: palette.dim, fontSize: 12,
        },
      },
      h('strong', { style: { fontSize: 13, color: palette.text } }, '监督动态 Feed'),
      cwd != null ? h('code', { style: { fontSize: 11 } }, cwd) : null,
      feed?.generatedAt != null
        ? h('span', { style: { marginLeft: 'auto' } }, `${timeAgo(feed.generatedAt)} 更新`)
        : h('span', { style: { marginLeft: 'auto' } }),
      typeof stopState === 'object' && stopState !== null
        ? h('span', { style: { fontSize: 11, color: stopState.ok ? tone.ok : tone.bad, alignSelf: 'center' } }, stopState.message)
        : stopStatus?.stopped === true
          ? h('span', { style: { fontSize: 11, color: tone.ok, alignSelf: 'center' } }, '已停止 · 无已启用的提醒')
        : null,
      stopState?.ok === true || stopStatus?.stopped === true || supervisorSessionId == null
        ? null
        : h('button', {
            onClick: () => { void fullStop() },
            disabled: stopState === 'working',
            'aria-label': '完全停止监督者、它委派的 worker 以及全部定时提醒',
            title: '停止监督者、其已委派的 worker 以及全部定时提醒。之后手动发一条提示即可恢复监督者。',
            style: {
              flex: 'none', alignSelf: 'center', padding: '3px 12px', borderRadius: 8,
              fontSize: 12, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${tone.bad}`, color: '#fff',
              background: stopState === 'working' ? 'transparent' : tone.bad,
            },
          }, stopState === 'working' ? '正在停止…' : '■ Full stop'),
      ),
      incompatibility,
      body)
    }

    // ------------------------------------- settings card (meta-config UI)

    /** Number input bound to one staged field. Hint sits under the row so a
     * real explanation can wrap instead of a one-liner beside the box. */
    function NumberRow(props) {
      return h('label', { style: { display: 'grid', gap: 4 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: palette.text } },
          h('span', { style: { width: 220, flex: 'none' } }, props.label),
          h('input', {
            type: 'number', min: props.min ?? 0, step: 1,
            value: props.value,
            disabled: props.disabled === true,
            onChange: event => props.onChange(event.target.value),
            style: {
              width: 90, padding: '4px 8px', borderRadius: 8, fontSize: 13,
              border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
            },
          })),
        props.hint
          ? h('p', { style: { margin: 0, fontSize: 12, color: palette.dim, lineHeight: 1.45 } }, props.hint)
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
    function makeSupervisorCard(scope) {
      return function SupervisorCard(props) {
        const snapshot = React.useSyncExternalStore(
          listener => scope.subscribe(listener),
          () => scope.getSnapshot(),
        )
        const value = snapshot.value ?? {}
        const [draft, setDraft] = React.useState(null)
        const [catalog, setCatalog] = React.useState([])
        // loading | ready | error — the picker must not claim "no more models"
        // when the catalog simply failed to load.
        const [catalogStatus, setCatalogStatus] = React.useState('loading')
        const [picker, setPicker] = React.useState('')
        const [pickerEffort, setPickerEffort] = React.useState('provider/default')
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)

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

        // Load once on mount; the retry button reuses the same function.
        React.useEffect(() => { loadCatalog() }, [])

        // The Plugins page renders every item twice: a one-line summary in the
        // detail header and the editable form on the page itself. Every hook
        // above runs in both views.
        if (props?.view === 'summary') {
          return h('p', { style: { margin: 0, fontSize: 13, color: palette.dim } },
            '监督者预设的 worker 模型白名单、按路由设定的推理强度，以及唤醒与提问等待时长。')
        }

        const current = draft ?? {
          workerModels: Array.isArray(value.workerModels) ? value.workerModels : ['runtime/current'],
          workerEfforts: value.workerEfforts !== null && typeof value.workerEfforts === 'object'
            && !Array.isArray(value.workerEfforts) ? value.workerEfforts : { 'runtime/current': 'provider/default' },
          maxParallelWorkers: value.maxParallelWorkers ?? 3,
          wakeMinutes: value.wakeMinutes ?? 5,
          questionWaitMinutes: value.questionWaitMinutes ?? 2,
        }
        const edit = patch => { setDraft({ ...current, ...patch }); setFailed(false) }
        const writable = snapshot.writable === true
        const disabled = !writable || saving

        const save = async () => {
          if (draft === null || saving) return
          setSaving(true)
          setFailed(false)
          try {
            const numeric = (raw, fallback) => {
              const parsed = Number(raw)
              return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
            }
            // Write effort ownership before newly allowing its route. The spawn
            // path also defaults every missing legacy entry to provider/default.
            const workerEfforts = Object.fromEntries(draft.workerModels.map(route => [
              route,
              draft.workerEfforts[route] ?? 'provider/default',
            ]))
            await scope.set('workerEfforts', workerEfforts)
            await scope.set('workerModels', draft.workerModels)
            await scope.set('maxParallelWorkers', numeric(draft.maxParallelWorkers, 3))
            await scope.set('wakeMinutes', Math.max(5, numeric(draft.wakeMinutes, 5)))
            await scope.set('questionWaitMinutes', Math.max(1, numeric(draft.questionWaitMinutes, 2)))
            setDraft(null)
          } catch {
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
          return h('select', {
            value: selected,
            disabled,
            onChange,
            'aria-label': `推理强度（${route}）`,
            title: `推理强度由插件设置固定，适用于 ${route}`,
            style: {
              minWidth: 155, padding: '4px 7px', borderRadius: 8, fontSize: 12,
              border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
              ...extraStyle,
            },
          },
          h('option', { value: 'provider/default' }, 'Provider default'),
          // A stored effort the model does not advertise would be rejected by
          // the host during provider I/O, i.e. saved successfully and failed
          // later at spawn time. Keep it visible but NOT selectable.
          selected !== 'provider/default' && !known
            ? h('option', { value: selected, disabled: true },
                `${selected}（该模型未声明支持 —— 派生时会被拒绝）`)
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
         * spawn fails — worth a visible warning on the row. */
        const effortUnsupported = route => {
          const selected = current.workerEfforts[route] ?? 'provider/default'
          return selected !== 'provider/default'
            && !effortOptionsFor(route).some(effort => effort.id === selected)
        }

        return h('section', {
          style: {
            border: `1px solid ${palette.border}`, borderRadius: 12,
            background: palette.card, padding: '14px 16px',
            display: 'grid', gap: 12,
          },
        },
        h('header', null,
          h('h3', { style: { margin: '0 0 2px', fontSize: 14, color: palette.text } }, 'Supervisor（dsh-main-agent）'),
          h('p', { style: { margin: 0, fontSize: 12, color: palette.dim } },
            '立即生效：subagent 只暴露这些 worker 路由，并在每次调用时重新校验 —— 无需重启，也无需新建会话。')),

        h('div', null,
          h('div', { style: { fontSize: 13, color: palette.text, marginBottom: 6 } }, 'worker 模型白名单'),
          current.workerModels.length === 0
            ? h('p', { style: { margin: '0 0 6px', fontSize: 12, color: palette.dim } },
                '为空 —— subagent 派生已禁用。不会继承任何父级/默认模型。')
            : h('ul', { style: { margin: '0 0 6px', padding: 0, listStyle: 'none', display: 'grid', gap: 4 } },
                current.workerModels.map(entry => h('li', {
                  key: entry,
                  style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: palette.text },
                },
                h('code', { style: { fontSize: 12 } }, entry),
                h('span', { style: { fontSize: 11, color: palette.dim } },
                  (() => {
                    const hit = catalogEntry(entry)
                    return capabilityTag(entry, hit)
                  })()),
                effortSelect(
                  entry,
                  current.workerEfforts[entry] ?? 'provider/default',
                  event => edit({
                    workerEfforts: { ...current.workerEfforts, [entry]: event.target.value },
                  }),
                  { marginLeft: 'auto' },
                ),
                effortUnsupported(entry)
                  ? h('span', {
                      role: 'status',
                      title: '该强度未被这个模型声明支持；派生时宿主会拒绝。请改选 Provider default 或一个已声明的强度。',
                      style: { fontSize: 11, color: tone.warn, flex: 'none' },
                    }, '⚠ 强度未声明')
                  : null,
                h('button', {
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
                  style: {
                    border: 'none', background: 'transparent',
                    color: palette.dim, cursor: 'pointer', fontSize: 13,
                  },
                  title: '移除',
                }, '✕')))),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('select', {
              value: picker,
              disabled: disabled || catalogStatus !== 'ready',
              onChange: event => {
                setPicker(event.target.value)
                setPickerEffort('provider/default')
              },
              'aria-label': '从模型目录添加一个 worker 模型',
              style: {
                flex: 1, minWidth: 200, padding: '5px 8px', borderRadius: 8, fontSize: 13,
                border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
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
                padding: '5px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
              },
            }, '添加'),
            catalogStatus === 'error'
              ? h('button', {
                  disabled,
                  onClick: loadCatalog,
                  'aria-label': '重新读取模型目录',
                  style: {
                    padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${tone.bad}`, background: 'transparent', color: tone.bad,
                  },
                }, '重试目录')
              : null)),

        h('p', { style: { margin: 0, fontSize: 12, color: palette.dim, lineHeight: 1.45 } },
          '推理强度属于每个已允许的模型行。主代理可以选用某个已允许的模型，但不获得强度控制权。Provider default 不发送显式强度；固定值会在写入 provider 之前，针对确切的 worker 模型做校验。'),

        h(NumberRow, {
          label: '最大并行 worker 数（0 = 不限）', min: 0, disabled,
          value: current.maxParallelWorkers,
          onChange: text => edit({ maxParallelWorkers: text }),
          hint: '同时保持打开的 worker 数硬上限。在监督者派生时强制执行 —— 超出上限的派生会被拒绝。',
        }),
        h(NumberRow, {
          label: '默认 wakeMinutes', min: 5, disabled,
          value: current.wakeMinutes,
          onChange: text => edit({ wakeMinutes: text }),
          hint: '监督者隔多久醒来检查运行中的 worker（分钟）。这会启用一个周期性定时提醒。最小 5 —— harness 不会以更快的频率触发周期性提醒。',
        }),
        h(NumberRow, {
          label: '默认 questionWaitMinutes', min: 1, disabled,
          value: current.questionWaitMinutes,
          onChange: text => edit({ questionWaitMinutes: text }),
          hint: '监督者等待问题答复的时长（分钟）；超时后记录一个假设并继续工作。',
        }),

        h('footer', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', {
            disabled: disabled || draft === null,
            onClick: () => { void save() },
            style: {
              padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${palette.border}`,
              background: draft === null ? 'transparent' : tone.info, color: draft === null ? palette.dim : '#fff',
            },
          }, saving ? '正在保存…' : '保存'),
          draft !== null ? h('button', {
            disabled: saving,
            onClick: () => { setDraft(null); setFailed(false) },
            style: {
              padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
            },
          }, '放弃') : null,
          failed ? h('span', { style: { fontSize: 12, color: tone.bad } }, '保存失败 —— 已保留输入值，请重试。') : null,
          !writable ? h('span', { style: { fontSize: 12, color: palette.dim } }, '设置文档为只读。') : null))
      }
    }

    // ------------------------------------------------------------- plugin

    const inject = ['slots', 'configForms']

    /** Settings namespace = this plugin's profile row id (cordis.patch.yml).
     * Spelled here rather than imported: a client package must not depend on a
     * Host package. */
    const SETTINGS_NS = 'agi-supervisor-setup'

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: 'supervisor-feed', order: 50, label: '监督动态' },
        FeedView,
      ))
      // `configForms` binds the Host-served namespace to a revision-fenced
      // scope; the Plugins page owns `plugins.item` and `whileServed` keeps the
      // tab mounted only while that namespace is actually served.
      const scope = ctx.configForms.get(SETTINGS_NS)
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject(
        'plugins.item',
        () => ctx.slots.register({
          name: 'plugins.item',
          id: 'supervisor',
          order: 40,
          label: '监督者',
        }, makeSupervisorCard(scope)),
      )))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
