/**
 * 把截止事项写进 Google 日历的 **OSU** 子日历；并支持先备份现有内容。
 *
 * 用法（容器内）：
 *   node scripts/google-sync.mjs --backup
 *   node scripts/google-sync.mjs --sync [--limit 50] [--dry]
 *
 * 凭据：/data/google.json = {clientId, clientSecret, refreshToken}
 *
 * 维护者的硬要求（2026-11-04）：
 *   · 日历里有个叫 **OSU** 的分类（子日历），课程都在里面
 *   · DDL 也放进这个 OSU 里，**不要弄乱**（→ 绝不写 primary，找不到 OSU 就报错退出）
 *   · **先备份现有内容**
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createEvent, findCalendarsByName, findEventByDshItemId, listCalendars, listEvents, patchEvent } from '../src/calendar/google.js';
import { needsUpdate, toGoogleEvent } from '../src/calendar/event.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const dataDir = dirname(arg('state', '/data/state.json'));
const tokenPath = arg('google-config', join(dataDir, 'google.json'));
const targetName = arg('calendar-name', 'OSU');
const timeZone = arg('tz', 'America/New_York');
const limit = Number(arg('limit', 50));

if (!existsSync(tokenPath)) {
  console.error(`[google] 找不到凭据：${tokenPath}`);
  process.exit(2);
}
const creds = JSON.parse(readFileSync(tokenPath, 'utf8'));
if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
  console.error('[google] 凭据缺字段（需要 clientId / clientSecret / refreshToken）');
  process.exit(2);
}

// ---------------- 解析目标日历（必须确定性） ----------------
// 教训（2026-11-04）：账号下有 3 个同名「OSU」，calendarList 顺序不稳定，
// 结果两次同步写进了两个不同的日历，看起来像"幂等失效"。
// 现在的规则：显式 id > 上次确认过的 id（calendar.json）> 名字唯一匹配；否则报错。
const pinnedPath = arg('calendar-config', join(dataDir, 'calendar.json'));
const calendars = await listCalendars(creds);
const explicitId = arg('calendar-id', null);

let target = null;

if (explicitId) {
  target = calendars.find((cal) => cal.id === explicitId) ?? null;
  if (!target) {
    console.error(`[google] ❌ 指定的 --calendar-id 不在可访问列表里：${explicitId}`);
    process.exit(3);
  }
  // 显式指定过就固化下来，之后不用再带参数（否则每次都要手写一长串 id）
  writeFileSync(
    pinnedPath,
    JSON.stringify({ calendarId: target.id, summary: target.summary, pinnedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`[google] 已固化目标日历 → ${pinnedPath}`);
} else if (existsSync(pinnedPath)) {
  const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8'));
  target = calendars.find((cal) => cal.id === pinned.calendarId) ?? null;
  if (target) {
    console.log(`[google] 使用上次确认过的日历（${pinnedPath}）`);
  } else {
    console.error(`[google] ⚠️ 固定 ID 已不可访问：${pinned.calendarId}，回退到按名字解析`);
  }
}

if (!target) {
  const matches = findCalendarsByName(calendars, targetName);
  if (matches.length !== 1) {
    console.error(`[google] ❌ 名为「${targetName}」的日历有 ${matches.length} 个，无法确定写哪个：`);
    for (const cal of matches) {
      console.error(`   · ${cal.summary}  id=${cal.id}  权限=${cal.accessRole}`);
    }
    console.error('[google] 请用 --calendar-id <id> 明确指定一次，确认后会记到 calendar.json。');
    console.error('[google] （绝不会自己挑一个，也不会退回到 primary）');
    process.exit(4);
  }
  target = matches[0];
  writeFileSync(
    pinnedPath,
    JSON.stringify({ calendarId: target.id, summary: target.summary, pinnedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`[google] 已固定目标日历 → ${pinnedPath}`);
}

console.log(`[google] 目标日历：${target.summary}  id=${target.id}  权限=${target.accessRole}`);

if (!String(target.accessRole ?? '').includes('owner') && !String(target.accessRole ?? '').includes('writer')) {
  console.error(`[google] ❌ 该日历没有写权限（accessRole=${target.accessRole}），退出。`);
  process.exit(3);
}

// ---------------- 备份 ----------------
if (has('backup')) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(dataDir, `calendar-backup-${stamp}.json`);
  // 备份范围放宽：过去 1 年 ~ 未来 2 年（避免把 2017 年的僵尸数据全拉下来）
  const now = Date.now();
  const events = await listEvents({
    ...creds,
    calendarId: target.id,
    timeMin: new Date(now - 365 * 24 * 3600 * 1000).toISOString(),
    timeMax: new Date(now + 730 * 24 * 3600 * 1000).toISOString(),
  });

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        calendar: { id: target.id, summary: target.summary, timeZone: target.timeZone },
        backedUpAt: new Date().toISOString(),
        count: events.length,
        events,
      },
      null,
      2,
    ),
  );
  console.log(`[google] ✅ 已备份 ${events.length} 个事件 → ${outPath}`);

  // 再给一份人可读的清单，便于"别弄乱"的人工核对
  const lines = events.map((e) => {
    const when = e.start?.dateTime ?? e.start?.date ?? '?';
    return `${when}\t${e.summary ?? '(无标题)'}`;
  });
  const txtPath = join(dataDir, `calendar-backup-${stamp}.txt`);
  writeFileSync(txtPath, lines.join('\n') + '\n');
  console.log(`[google] ✅ 清单 → ${txtPath}`);
}

// ---------------- 同步 ----------------
if (has('sync')) {
  const state = JSON.parse(readFileSync(arg('state', '/data/state.json'), 'utf8'));
  const now = Date.now();
  const items = (state.items ?? [])
    .filter((item) => item.status === 'open' && item.dueAt && Date.parse(item.dueAt) > now)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .slice(0, limit);

  console.log(`[google] 待同步 ${items.length} 条（未完成 + 未到期，上限 ${limit}）`);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const body = toGoogleEvent(item, { timeZone });
    if (!body) {
      skipped += 1;
      continue;
    }
    if (has('dry')) {
      console.log(`  [dry] ${body.summary}  ${body.start.dateTime ?? body.start.date}`);
      continue;
    }

    const existing = await findEventByDshItemId({ ...creds, calendarId: target.id, dshItemId: item.id });
    if (!existing) {
      const createdEvent = await createEvent({ ...creds, calendarId: target.id, event: body });
      created += 1;
      console.log(`  + ${body.summary}  ${body.start.dateTime ?? body.start.date}  (${createdEvent.id})`);
    } else if (needsUpdate(existing, body)) {
      await patchEvent({ ...creds, calendarId: target.id, eventId: existing.id, patch: body });
      updated += 1;
      console.log(`  ~ ${body.summary}  ${body.start.dateTime ?? body.start.date}`);
    } else {
      skipped += 1;
    }
  }

  console.log(`[google] 完成：新增 ${created}，更新 ${updated}，未变 ${skipped}`);
}
