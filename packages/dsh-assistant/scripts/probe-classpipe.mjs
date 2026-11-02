/**
 * 诊断：从**正在运行的** classpipe 拉一次真实数据，跑通「拉取 → 归一 → 去重 → 排提醒」。
 *
 * 这不是单测的替代 —— 单测用固定 fixture 保证逻辑正确；
 * 这个脚本验证**真实字段**确实能被我们理解（契约没漂）。
 *
 * 用法：
 *   node scripts/probe-classpipe.mjs                  # 默认 http://127.0.0.1:8000
 *   node scripts/probe-classpipe.mjs --base http://127.0.0.1:3000
 *   node scripts/probe-classpipe.mjs --tz America/New_York
 */

import {
  fetchClasspipeTasks,
  formatDue,
  mergeItems,
  planReminders,
} from '../src/index.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const baseUrl = arg('base', 'http://127.0.0.1:8000');
const timeZone = arg('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
const now = new Date();

console.log(`[probe] classpipe = ${baseUrl}   时区 = ${timeZone}`);

let fetched;
try {
  fetched = await fetchClasspipeTasks({ baseUrl });
} catch (error) {
  console.error(`[probe] ❌ 拉取失败：${error.message}`);
  console.error('        classpipe 在跑吗？试试 curl ' + baseUrl + '/health');
  process.exit(1);
}

const { items: raw, counts } = fetched;
console.log(
  `[probe] 上游：作业 ${counts.assignments} / 测验 ${counts.quizzes} / 公告 ${counts.announcements}`,
);
console.log(`[probe] 映射出 ${raw.length} 条原始项`);

// 归一 + 去重（跑两遍，验证幂等）
const first = mergeItems([], raw, now);
const second = mergeItems(first.items, raw, now);
console.log(
  `[probe] 入库 ${first.items.length} 条` +
    `（inserted ${first.result.inserted.length} / rejected ${first.result.rejected.length}）`,
);
console.log(
  `[probe] 幂等复跑：unchanged ${second.result.unchanged.length} / inserted ${second.result.inserted.length}` +
    `${second.result.inserted.length === 0 ? ' ✅' : ' ❌ 幂等被破坏'}`,
);

if (first.result.rejected.length > 0) {
  console.log('[probe] 被拒样例：');
  for (const rejected of first.result.rejected.slice(0, 3)) {
    console.log(`   - ${rejected.error}`);
  }
}

// 按类型统计
const byKind = first.items.reduce((acc, item) => {
  acc[item.kind] = (acc[item.kind] ?? 0) + 1;
  return acc;
}, {});
console.log(`[probe] 类型分布：${JSON.stringify(byKind)}`);

// 有没有截止时间、有多少是未来的
const withDue = first.items.filter((item) => item.dueAt);
const upcoming = withDue
  .filter((item) => Date.parse(item.dueAt) > now.getTime())
  .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
console.log(`[probe] 有截止 ${withDue.length} 条，其中未来 ${upcoming.length} 条`);

console.log('[probe] 最近的 5 个未来截止：');
for (const item of upcoming.slice(0, 5)) {
  console.log(`   · ${formatDue(item.dueAt, timeZone)}  ${item.title}${item.course ? `（${item.course}）` : ''}`);
}

// 提醒计划（只看最近 7 天内会触发的）
const plan = planReminders(upcoming, { now });
const soon = plan.filter((entry) => Date.parse(entry.at) - now.getTime() <= 7 * 24 * 3600 * 1000);
console.log(`[probe] 未来 7 天内将触发的提醒 ${soon.length} 条：`);
for (const entry of soon.slice(0, 5)) {
  console.log(`   · ${formatDue(entry.at, timeZone)}  ${entry.title}（${entry.offsetLabel}）`);
}

console.log('[probe] OK');
