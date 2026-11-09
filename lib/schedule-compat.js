/**
 * 宿主 `schedule` 服务的两代接口适配层。
 *
 * 这个文件的存在是因为一次真实的静默失效：兜底提醒的 `create` 一直按旧签名
 * `create(sessionId, request)` 调用，而新版宿主换成了
 * `create(request, actorSessionId, signal)`，`delete({ sessionId, id })` 整
 * 个方法被 `edit({ id, action: 'delete' })` 取代，`list({ sessionId })` 变成
 * 只认分页、不认会话。三个调用全都在 `try/catch` 里，于是兜底**一次都没建
 * 成过**，而日志里只有一行「补兜底提醒失败」——循环停下来时没有任何东西
 * 会报告这件事。
 *
 * 适配原则：按能力探测，不按版本号猜。探测不到的一侧就当不存在，绝不让
 * 「兼容」本身成为新的静默失败点：每次调用只尝试与探测结果一致的签名，
 * 真失败就原样抛出去，由调用方决定是保留旧提醒还是记账。
 */

/** 单个提醒请求的规范形。 */
/**
 * @typedef {object} ReminderRequest
 * @property {string} title 提醒标题
 * @property {string} prompt 投递时发给会话的正文
 * @property {number} afterSeconds 多少秒后投递（计时器一次性的语义）
 */

/**
 * 读一条已排程提醒的最小投影。
 *
 * @typedef {object} ReminderRecord
 * @property {string} id 宿主侧任务 id
 * @property {string} title 标题
 * @property {number} scheduledAt 下一次投递时刻（epoch ms，未知则 NaN）
 */

/**
 * 判断这代接口是否用「请求对象 + 目标」的新形态。
 *
 * 新版把目标写进 `request.target`，旧版把 `sessionId` 放在第一个位置参数；
 * `catalog` / `edit` 是新版独有的，用它比猜 `create.length` 可靠 —— 后者在
 * 被装饰器或转译包过一层之后并不可信。
 *
 * @param {object} schedule 宿主 schedule 服务
 * @returns {boolean} true 表示按新签名调用
 */
function detectScheduleApi(schedule) {
  if (schedule === undefined || schedule === null) return false
  if (typeof schedule.edit === 'function') return true
  if (typeof schedule.catalog === 'function') return true
  return false
}

/**
 * 把宿主返回的任意一条任务记录归一成 {@link ReminderRecord}。
 *
 * @param {object} task 宿主任务记录
 * @returns {ReminderRecord} 归一后的投影
 */
function toReminder(task) {
  const at = task?.scheduledAt
  return {
    id: typeof task?.id === 'string' ? task.id : '',
    title: typeof task?.title === 'string' ? task.title : '',
    scheduledAt: typeof at === 'string' ? Date.parse(at) : (typeof at === 'number' ? at : Number.NaN),
  }
}

/**
 * 一条任务是否属于这个会话。
 *
 * 新版 `target.kind === 'session'` 直指会话；`new_once` / `new` 这类「每次
 * 开新会话」的任务不算 —— 它们不是本会话的兜底，撤掉它们等于替别人关提醒。
 *
 * @param {object} task 宿主任务记录
 * @param {string} sessionId 目标会话 id
 * @returns {boolean} 归属判定
 */
function belongsTo(task, sessionId) {
  const target = task?.target
  if (target !== undefined && target !== null) {
    if (target.kind !== 'session') return false
    return target.sessionId === sessionId
  }
  // 老宿主没有 target，只有 involvedSessionIds。
  const involved = task?.involvedSessionIds
  return Array.isArray(involved) && involved.includes(sessionId)
}

/**
 * 在指定会话上排一条一次性提醒。
 *
 * @param {object} schedule 宿主 schedule 服务
 * @param {string} sessionId 目标会话 id
 * @param {ReminderRequest} request 标题、正文与延迟秒数
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<{ id: string } | undefined>} 新任务身份（宿主未返回 id 时 undefined）
 */
export async function ensureReminder(schedule, sessionId, request, signal) {
  const afterSeconds = Math.max(1, Math.round(Number(request?.afterSeconds) || 0))
  const title = String(request?.title ?? '')
  const prompt = String(request?.prompt ?? '')
  if (detectScheduleApi(schedule)) {
    const task = await schedule.create({
      title,
      prompt,
      timing: { after_seconds: afterSeconds },
      target: { kind: 'session', sessionId },
    }, sessionId, signal)
    return task === undefined || task === null ? undefined : { id: String(task.id ?? '') }
  }
  const task = await schedule.create(sessionId, {
    title,
    prompt,
    after_seconds: afterSeconds,
  }, signal)
  return task === undefined || task === null ? undefined : { id: String(task.id ?? '') }
}

/**
 * 列出某个会话当前还在的提醒。
 *
 * 新版 `list` 只认分页、没有会话过滤，必须拉全表再按 `target` 归并；`catalog`
 * 是同一张表的无分页形式，优先用它 —— 分页拉全表还得循环，反而多一次读。
 *
 * @param {object} schedule 宿主 schedule 服务
 * @param {string} sessionId 目标会话 id
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<ReminderRecord[]>} 该会话的活跃提醒；接口不支持时返回空数组
 */
export async function listSessionReminders(schedule, sessionId, signal) {
  if (schedule === undefined || schedule === null) return []
  if (detectScheduleApi(schedule)) {
    const rows = typeof schedule.catalog === 'function'
      ? await schedule.catalog(signal)
      : (await schedule.list({ active: true }, signal))?.items
    const items = Array.isArray(rows) ? rows : []
    return items
      .filter(task => (task?.status === undefined || task.status === 'active') && belongsTo(task, sessionId))
      .map(toReminder)
  }
  if (typeof schedule.list !== 'function') return []
  const active = await schedule.list({ sessionId }, signal)
  if (!Array.isArray(active)) return []
  return active.map(toReminder)
}

/**
 * 撤掉一条提醒。
 *
 * @param {object} schedule 宿主 schedule 服务
 * @param {string} sessionId 目标会话 id
 * @param {string} id 任务 id
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<void>} 撤除完成
 */
export async function ensureReminderRemoved(schedule, sessionId, id, signal) {
  if (detectScheduleApi(schedule)) {
    await schedule.edit({ id, action: 'delete' }, sessionId, signal)
    return
  }
  await schedule.delete({ sessionId, id }, signal)
}
