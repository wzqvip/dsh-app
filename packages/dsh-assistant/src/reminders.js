/**
 * 提醒计划：把 `Item` 变成"什么时候该提醒"的清单。
 *
 * 纯函数。真正的"发送"由调度层负责（见 docs/ASSISTANT.md §5：
 * 调度器必须独立于聊天会话，否则会话一停提醒就没了）。
 *
 * 三条规则（都有单测锁住）：
 *   1. 只对 `status === 'open'` 且 `dueAt` 有效的事项生成
 *   2. 已经过去的时间点**不补发**（否则一上线就刷一堆过期提醒）
 *   3. 键 `${itemId}#${offsetMs}` 一旦发过就不再发（重启不重发）
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * 默认递减提醒：3 天前 / 1 天前 / 4 小时前。
 *
 * 为什么不是"到点响一次"：作业这类东西的价值在于**提前**，
 * 到点才提醒等于没提醒（那时人已经睡了或来不及了）。
 */
export const DEFAULT_OFFSETS = Object.freeze([3 * DAY, 1 * DAY, 4 * HOUR]);

/** 提醒唯一键 */
export function reminderKey(itemId, offsetMs) {
  return `${itemId}#${offsetMs}`;
}

/** 人类可读的偏移（用于消息文案） */
export function offsetLabel(offsetMs) {
  if (offsetMs % DAY === 0) return `${offsetMs / DAY} 天前`;
  if (offsetMs % HOUR === 0) return `${offsetMs / HOUR} 小时前`;
  return `${Math.round(offsetMs / MINUTE)} 分钟前`;
}

/**
 * 计算提醒计划。
 *
 * @param {object[]} items 事项集合
 * @param {object} [options]
 * @param {Date|string|number} [options.now] 当前时间（注入，便于测试）
 * @param {number[]} [options.offsets] 提前量，默认 DEFAULT_OFFSETS
 * @param {Set<string>} [options.sent] 已发送的提醒键
 * @returns {Array<{key:string,itemId:string,title:string,offsetMs:number,offsetLabel:string,at:string,dueAt:string,tzUncertain:boolean}>}
 */
export function planReminders(
  items,
  { now = new Date(), offsets = DEFAULT_OFFSETS, sent = new Set() } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('planReminders: invalid `now`');

  const plan = [];
  for (const item of items ?? []) {
    if (!item || item.status !== 'open') continue;
    if (!item.dueAt) continue;

    const dueMs = Date.parse(item.dueAt);
    if (!Number.isFinite(dueMs)) continue;

    for (const offsetMs of offsets) {
      const atMs = dueMs - offsetMs;
      // 规则 2：过去的点不补发
      if (atMs <= nowMs) continue;
      const key = reminderKey(item.id, offsetMs);
      // 规则 3：发过就不发
      if (sent.has(key)) continue;

      plan.push({
        key,
        itemId: item.id,
        title: item.title,
        offsetMs,
        offsetLabel: offsetLabel(offsetMs),
        at: new Date(atMs).toISOString(),
        dueAt: item.dueAt,
        // 时间不确定时，文案里要带提示（解析层 unknown TZID 会置 true）
        tzUncertain: item.tzUncertain === true,
      });
    }
  }

  return plan.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.itemId.localeCompare(b.itemId),
  );
}

/**
 * 生成一条提醒的文案。
 * `tzUncertain` 时**明确告警**，而不是让用户以为时间准 —— 见 docs §6②。
 */
export function reminderText(entry) {
  const due = new Date(entry.dueAt);
  const dueText = Number.isNaN(due.getTime())
    ? '时间未知'
    : due.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const warn = entry.tzUncertain ? '（⚠️ 时区未能确认，请核对时间）' : '';
  return `⏰ ${entry.title} — ${entry.offsetLabel}到期\n截止：${dueText}${warn}`;
}

/**
 * 取出"现在就该发"的提醒（已到点、未发送、且不是太久以前）。
 *
 * ⚠️ `maxAgeMs` 是**防刷屏**的关键：守护进程第一次启动、或停机几天后重启时，
 * 计划里会积压大量"早已到点"的提醒。若全补发，用户会被几十条消息淹没。
 * 默认只补发 12 小时内到点的（再早的视为错过，不再打扰）。
 *
 * @param {object[]} plan
 * @param {Date|string|number} [now]
 * @param {Set<string>} [sent]
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] 允许补发的最大延迟，默认 12 小时
 */
export function dueReminders(
  plan,
  now = new Date(),
  sent = new Set(),
  { maxAgeMs = 12 * HOUR } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return (plan ?? []).filter((entry) => {
    if (sent.has(entry.key)) return false;
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs)) return false;
    if (atMs > nowMs) return false;
    return nowMs - atMs <= maxAgeMs;
  });
}
