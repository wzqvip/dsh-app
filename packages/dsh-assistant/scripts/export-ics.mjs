/**
 * 把状态里的截止事项导出成 .ics（零授权，任何日历 App 都能导入/订阅）。
 *
 * 用法：
 *   node scripts/export-ics.mjs                       # 读 ~/.dsh-assistant/state.json
 *   node scripts/export-ics.mjs --state /data/state.json --out /tmp/a.ics --tz America/New_York
 *
 * 容器里跑（ubuntu）：
 *   docker compose exec -T assistant node scripts/export-ics.mjs --out /data/calendar.ics
 *   # 然后从宿主拷出来导入：
 *   docker cp dsh-assistant:/data/calendar.ics ./calendar.ics
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { toIcs } from '../src/calendar/ics.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const statePath = arg('state', join(homedir(), '.dsh-assistant', 'state.json'));
const outPath = arg('out', join(homedir(), '.dsh-assistant', 'calendar.ics'));
const timeZone = arg('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
const includeDone = arg('include-done', false) === true;
// 默认只导**未来**的截止：日历里塞历史过期项没有意义，还会让人以为没做
const includePast = arg('include-past', false) === true;
const nowMs = Date.now();

if (!existsSync(statePath)) {
  console.error(`[ics] 找不到状态文件：${statePath}`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const items = (state.items ?? []).filter((item) => {
  if (!item?.dueAt) return false;
  if (item.status === 'dropped') return false;
  if (!includeDone && item.status !== 'open') return false;
  if (!includePast) {
    const dueMs = Date.parse(item.dueAt);
    if (!Number.isFinite(dueMs) || dueMs <= nowMs) return false;
  }
  return true;
});

const ics = toIcs(items, {
  calendarName: 'DSH Assistant · 截止',
  timeZone,
  now: new Date(),
});
writeFileSync(outPath, ics);

const bytes = Buffer.byteLength(ics, 'utf8');
console.log(`[ics] 事项 ${items.length} 条（open${includeDone ? '+done' : ''}）`);
console.log(`[ics] 已写入 ${outPath}（${bytes} 字节，时区 ${timeZone}）`);
console.log('[ics] 导入方式：Google 日历 → 设置 → 导入和导出 → 导入这个 .ics');
