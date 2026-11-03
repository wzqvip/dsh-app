/**
 * Item → Google Calendar 事件载荷（纯函数，不需要凭据）。
 *
 * 为什么先做纯逻辑：Google 那边要等服务账号 JSON，但"事件长什么样"是设计决定的，
 * 现在定下来并写死单测，拿到凭据后只需要接一个 `events().insert/patch` 调用。
 *
 * 关键约束（见 docs/ASSISTANT.md 日历设计）：
 *   1. `extendedProperties.private.dshItemId` = item.id —— **幂等 upsert 的唯一依据**，
 *      否则每轮同步都会重复建事件。
 *   2. 日历里**不设提醒**（`reminders.overrides: []`）：提醒统一由 Telegram 推，
 *      因为只有我们能在"未完成"时推。两边都设 = 双重提醒。
 *   3. 全天事项用 `date`（Google 的 end 是**排他**的，所以结束日要 +1 天）。
 */

/** 时间块的默认长度（分钟）：截止不是"会议"，给个短块让它出现在日程里即可 */
export const DEFAULT_EVENT_MINUTES = 15;

/** 取某时刻在指定时区下的 `YYYY-MM-DD`（不依赖进程 TZ） */
export function localDateOf(iso, timeZone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const y = get('year');
  const m = get('month');
  const d = get('day');
  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` 加一天（用于全天事项的排他结束日） */
export function nextDate(dateStr) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 事件标题：课程前缀 + 截止标记 */
export function eventSummary(item) {
  const course = item.course ? `[${item.course}] ` : '';
  return `⏰ ${course}${item.title}`;
}

/**
 * 构造 Google Calendar 事件体。
 *
 * @param {object} item
 * @param {object} [options]
 * @param {string} [options.timeZone] 例 'America/New_York'
 * @param {number} [options.durationMinutes]
 * @returns {object|null} 无截止时间则返回 null（不要建"没有时间"的日历事件）
 */
export function toGoogleEvent(item, { timeZone = 'UTC', durationMinutes = DEFAULT_EVENT_MINUTES } = {}) {
  if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') {
    throw new Error('toGoogleEvent: item with id/title is required');
  }
  if (!item.dueAt) return null;

  const dueMs = Date.parse(item.dueAt);
  if (!Number.isFinite(dueMs)) return null;

  const body = {
    summary: eventSummary(item),
    description: [
      item.course ? `课程：${item.course}` : null,
      item.url ? `来源：${item.url}` : null,
      `dsh-assistant item: ${item.id}`,
    ]
      .filter(Boolean)
      .join('\n'),
    // 幂等键：按 id 找已有事件，改期就 PATCH 而不是新建
    extendedProperties: { private: { dshItemId: item.id } },
    // 提醒只由 Telegram 推（我们能在"未完成"时才推，日历做不到）
    reminders: { useDefault: false, overrides: [] },
    status: item.status === 'dropped' ? 'cancelled' : 'confirmed',
  };

  if (item.allDay) {
    const date = localDateOf(item.dueAt, timeZone);
    if (!date) return null;
    body.start = { date };
    body.end = { date: nextDate(date) }; // Google 的 date 结束是排他的
  } else {
    body.start = { dateTime: new Date(dueMs).toISOString(), timeZone };
    body.end = {
      dateTime: new Date(dueMs + durationMinutes * 60_000).toISOString(),
      timeZone,
    };
  }

  return body;
}

/**
 * 判断某事件是否需要更新（避免每次都 PATCH 触发 Google 的写配额）。
 * 只比较我们关心的字段。
 */
export function needsUpdate(existing, next) {
  if (!existing || !next) return true;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return !(
    same(existing.summary, next.summary) &&
    same(existing.start, next.start) &&
    same(existing.end, next.end) &&
    same(existing.status, next.status)
  );
}
