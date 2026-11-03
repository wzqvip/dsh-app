/**
 * Item → iCalendar (.ics)（纯函数，零授权）。
 *
 * 用途：万一 Google 服务账号那条路走不通（租户策略、配额、密钥丢失），
 * 用 ICS 订阅是**零授权兜底** —— 任何日历 App 都能订阅。
 *
 * 实现要点：
 *   · 时间统一用 **UTC（Z）** 输出，避免 VTIMEZONE 的复杂度（对截止时间足够）
 *   · `UID` 用 item.id 派生 —— **稳定 UID 是"改期就更新而不是新增"的关键**
 *   · `SEQUENCE` = item.revision，客户端据此判断是否需要更新
 *   · 文本转义 + 75 字节折行（RFC 5545），否则中文和长标题会把某些客户端弄坏
 */

import { localDateOf, nextDate } from './event.js';

const CRLF = '\r\n';

/** RFC 5545 TEXT 转义 */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 折行：每行不超过 75 字节，续行以空格开头（按 UTF-8 字节切，不切坏中文） */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out = [];
  let start = 0;
  while (start < bytes.length) {
    // 第一行 75 字节，续行 74 字节（因为要加一个前导空格）
    const limit = start === 0 ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // 不要把一个多字节字符切成两半：回退到 UTF-8 边界
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((start === 0 ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return out.join(CRLF);
}

/** UTC 时间戳：`20261109T045900Z` */
export function toUtcStamp(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

/** `YYYY-MM-DD` → `YYYYMMDD` */
function dateStamp(dateStr) {
  return dateStr.replace(/-/g, '');
}

/**
 * 生成整份日历。
 *
 * @param {object[]} items
 * @param {object} [options]
 * @param {string} [options.calendarName]
 * @param {string} [options.timeZone] 仅用于全天事项换算本地日期
 * @param {Date} [options.now] DTSTAMP
 * @returns {string} .ics 文本
 */
export function toIcs(items, {
  calendarName = 'dsh-assistant',
  timeZone = 'UTC',
  now = new Date(),
} = {}) {
  const dtstamp = toUtcStamp(now.toISOString()) ?? '19700101T000000Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dsh-assistant//DSH Assistant//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];

  for (const item of items ?? []) {
    if (!item || !item.dueAt || item.status === 'dropped') continue;
    const dueMs = Date.parse(item.dueAt);
    if (!Number.isFinite(dueMs)) continue;

    const summary = `${item.course ? `[${item.course}] ` : ''}${item.title}`;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeText(item.id)}@dsh-assistant`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SEQUENCE:${Number(item.revision) || 1}`);

    if (item.allDay) {
      const date = localDateOf(item.dueAt, timeZone);
      if (!date) continue;
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(date)}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(nextDate(date))}`);
    } else {
      lines.push(`DTSTART:${toUtcStamp(item.dueAt)}`);
      lines.push(`DTEND:${toUtcStamp(new Date(dueMs + 15 * 60_000).toISOString())}`);
    }

    lines.push(`SUMMARY:${escapeText(item.status === 'done' ? `✅ ${summary}` : summary)}`);
    const description = [
      item.course ? `课程：${item.course}` : null,
      item.url ? `来源：${item.url}` : null,
      `dsh-assistant item: ${item.id}`,
    ]
      .filter(Boolean)
      .join('\n');
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    if (item.url) lines.push(`URL:${escapeText(item.url)}`);
    lines.push(`TRANSP:${item.status === 'done' ? 'TRANSPARENT' : 'OPAQUE'}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
