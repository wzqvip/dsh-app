/**
 * 清理误写入日历的事件（只删**我们写的**，绝不碰原有事件）。
 *
 * 为什么需要：2026-11-04 第一次同步时，账号下有 3 个同名「OSU」日历，
 * `calendarList` 顺序不稳定，导致事件被写进了两个不该写的 OSU 里。
 *
 * 安全边界（这是本脚本最重要的部分）：
 *   · 只删 `extendedProperties.private.dshItemId` 存在的事件
 *     —— 那是我们自己打的标记，原有事件不会有
 *   · `--dry` 默认先看清单
 *   · 必须显式 `--yes` 才真的删除
 *   · 只处理 `--calendar-name` 匹配到的日历（可多个）
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { deleteEvent, findCalendarsByName, listCalendars, listEvents } from '../src/calendar/google.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const dataDir = dirname(arg('state', '/data/state.json'));
const tokenPath = arg('google-config', join(dataDir, 'google.json'));
const targetName = arg('calendar-name', 'OSU');
const confirmed = has('yes');

if (!existsSync(tokenPath)) {
  console.error(`[cleanup] 找不到凭据：${tokenPath}`);
  process.exit(2);
}
const creds = JSON.parse(readFileSync(tokenPath, 'utf8'));

const calendars = await listCalendars(creds);
const matches = findCalendarsByName(calendars, targetName);

if (matches.length === 0) {
  console.error(`[cleanup] 没有叫「${targetName}」的日历，退出`);
  process.exit(3);
}

console.log(`[cleanup] 同名日历 ${matches.length} 个，逐个检查：`);

const now = Date.now();
let total = 0;

for (const calendar of matches) {
  const events = await listEvents({
    ...creds,
    calendarId: calendar.id,
    timeMin: new Date(now - 800 * 86400000).toISOString(),
    timeMax: new Date(now + 800 * 86400000).toISOString(),
  });

  const ours = events.filter((e) => e.extendedProperties?.private?.dshItemId);
  const others = events.length - ours.length;
  console.log(
    `\n  ${calendar.summary}  id=${calendar.id.slice(0, 16)}…  总 ${events.length}（我们的 ${ours.length} / 原有 ${others}）`,
  );

  if (ours.length === 0) continue;

  for (const event of ours) {
    const when = event.start?.dateTime ?? event.start?.date ?? '?';
    if (!confirmed) {
      console.log(`    [dry] 会删：${when.slice(0, 16)}  ${String(event.summary).slice(0, 60)}`);
    } else {
      await deleteEvent({ ...creds, calendarId: calendar.id, eventId: event.id });
      console.log(`    - 已删：${when.slice(0, 16)}  ${String(event.summary).slice(0, 60)}`);
      total += 1;
    }
  }
}

if (!confirmed) {
  console.log('\n[cleanup] 这是预览。确认无误后加 --yes 真的删除。');
} else {
  console.log(`\n[cleanup] 完成：共删除 ${total} 条我们写入的事件（原有事件一条没动）`);
}
