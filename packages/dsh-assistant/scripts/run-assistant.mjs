/**
 * 个人助理守护进程：**定时主动查看 → 推送**。
 *
 * 这是 P3 的可运行入口（还不是 DSH 插件；P2 才做成插件）。
 * 本轮先把闭环跑通，等确认可用再决定要不要搬进 DSH。
 *
 * 用法：
 *   # 只看会推什么，不真的发（安全检查）
 *   node scripts/run-assistant.mjs --dry --once
 *
 *   # 真发（需要先在 DSH 设置里创建投递目标，拿到 targetId）
 *   node scripts/run-assistant.mjs --bot-id telegram_xxx --target-id assistant-ddl
 *
 *   # 常驻，每 45 分钟看一次
 *   node scripts/run-assistant.mjs --bot-id … --target-id … --interval 45
 *
 * 状态默认落在 ~/.dsh-assistant/state.json（可 --state 覆盖）。
 *
 * ⚠️ 设计要点：**通知先进持久队列，发成功才出队**。
 *   否则 Telegram 抖动一次，那条「新截止」就永久丢了（因为下一轮 poll 已把它当 unchanged）。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createPoller,
  dueReminders,
  fetchClasspipeTasks,
  planReminders,
  pollOnce,
  reminderText,
} from '../src/index.js';
import { sendDelivery } from '../src/notify/dsh-im.js';

// ---------------- CLI ----------------

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const classpipeBase = flag('classpipe', 'http://127.0.0.1:8000');
const dshBase = flag('dsh-base', process.env.DSH_ASSISTANT_DSH_BASE ?? 'http://127.0.0.1:3080');
const botId = flag('bot-id', process.env.DSH_ASSISTANT_BOT_ID ?? '');
const targetId = flag('target-id', process.env.DSH_ASSISTANT_TARGET_ID ?? '');
const intervalMin = Number(flag('interval', 45));
const timeZone = flag('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
const statePath = flag('state', join(homedir(), '.dsh-assistant', 'state.json'));
const dry = flag('dry', false) === true;
const once = flag('once', false) === true;
const maxAgeHours = Number(flag('max-age-hours', 12));

if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
  console.error('[assistant] --interval 必须是正数（分钟）');
  process.exit(2);
}
if (!dry && (!botId || !targetId)) {
  console.error('[assistant] 缺少投递配置。');
  console.error('  需先在 DSH 设置 → IM机器人 里「新建投递目标」，拿到 botId 与 targetId，然后：');
  console.error('    node scripts/run-assistant.mjs --bot-id <botId> --target-id <targetId>');
  console.error('  或先用 --dry 看它会推什么（不需要目标）。');
  process.exit(2);
}

// ---------------- 状态持久化 ----------------

const EMPTY_STATE = { version: 1, items: [], pending: [], sentReminders: [], lastTickAt: null, lastError: null };

function loadState() {
  if (!existsSync(statePath)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      ...EMPTY_STATE,
      ...parsed,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      sentReminders: Array.isArray(parsed.sentReminders) ? parsed.sentReminders : [],
    };
  } catch (error) {
    // 状态坏了不能静默清空（会重复推送）；但也不能让守护进程起不来。
    // 策略：备份坏文件，重新开始，并大声说明。
    const backup = `${statePath}.corrupt-${Date.now()}`;
    writeFileSync(backup, readFileSync(statePath));
    console.error(`[assistant] ⚠️ 状态文件无法解析，已备份到 ${backup}，本轮从空状态开始`);
    return { ...EMPTY_STATE };
  }
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath); // 原子替换，避免电报打到一半掉电留下半截 JSON
}

// ---------------- 投递（含队列） ----------------

let state = loadState();

/** 入队（同 key 不重复入队） */
function enqueue(key, text) {
  if (state.pending.some((entry) => entry.key === key)) return;
  state.pending.push({ key, text, queuedAt: new Date().toISOString() });
}

/** 发送一条；dry 模式只打印 */
async function deliver(text) {
  if (dry) {
    console.log(`[dry] 会推送：\n${text.replace(/^/gm, '        ')}`);
    return;
  }
  await sendDelivery({ botId, targetId, baseUrl: dshBase, text });
}

/** 尝试清空队列；遇到失败就停下（别对同一个目标连打） */
async function flushPending() {
  if (state.pending.length === 0) return { sent: 0, failed: 0 };

  const remaining = [];
  let sent = 0;
  let failed = 0;

  for (const entry of state.pending) {
    if (failed > 0) {
      // 已经失败过就别继续打了，留到下一轮
      remaining.push(entry);
      continue;
    }
    try {
      await deliver(entry.text);
      sent += 1;
      if (entry.key.startsWith('reminder:') && !state.sentReminders.includes(entry.key)) {
        state.sentReminders.push(entry.key);
      }
    } catch (error) {
      failed += 1;
      console.error(`[assistant] ❌ 投递失败（保留在队列）：${error.message}`);
      remaining.push(entry);
    }
  }

  state.pending = remaining;
  return { sent, failed };
}

// ---------------- 一轮 ----------------

async function tick() {
  const now = new Date();
  const before = state.items.length;
  // 首次运行 = 播种：把现状静默导入，**不推送**。
  // 否则用户第一次启动就会收到"你这学期全部未到期作业"，直接把人劝退。
  // 播种之后只推**真正的变化**（新增/改期）与到点提醒。
  const isSeed = before === 0;

  // 1) 拉取 + 合并（**不让 pollOnce 直接发**，改成入队，才能失败重试）
  let pollResult;
  try {
    pollResult = await pollOnce({
      fetchItems: async () => (await fetchClasspipeTasks({ baseUrl: classpipeBase })).items,
      items: state.items,
      now,
      timeZone,
    });
  } catch (error) {
    state.lastError = `${now.toISOString()} poll: ${error.message}`;
    console.error(`[assistant] ❌ 拉取失败：${error.message}`);
    saveState(state);
    return;
  }

  state.items = pollResult.items;
  state.lastError = null;

  if (!isSeed) {
    for (const candidate of pollResult.candidates) {
      const key = `notify:${candidate.kind}:${candidate.itemId}:${candidate.to ?? ''}`;
      enqueue(key, candidate.text);
    }
  }

  // 2) 排提醒 → 到期入队（播种轮同样静默）
  const plan = planReminders(state.items, { now, sent: new Set(state.sentReminders) });
  const due = isSeed
    ? []
    : dueReminders(plan, now, new Set(state.sentReminders), {
        maxAgeMs: maxAgeHours * 3600_000,
      });
  for (const entry of due) {
    enqueue(`reminder:${entry.key}`, reminderText(entry));
  }

  // 3) 投递
  const flushed = await flushPending();

  state.lastTickAt = now.toISOString();
  saveState(state);

  console.log(
    `[assistant] ${now.toISOString()}  事项 ${before} → ${state.items.length}` +
      `（新增 ${pollResult.result.inserted.length} / 更新 ${pollResult.result.updated.length}）` +
      (isSeed
        ? `  【首次播种：静默导入，不推送】`
        : `  提醒计划 ${plan.length}（到期 ${due.length}）` +
          `  已发 ${flushed.sent} / 失败 ${flushed.failed} / 待发 ${state.pending.length}`) +
      (dry ? '  [dry]' : ''),
  );
}

// ---------------- 主流程 ----------------

console.log(`[assistant] classpipe=${classpipeBase}  dsh=${dshBase}  时区=${timeZone}`);
console.log(`[assistant] 状态=${statePath}  间隔=${intervalMin} 分钟  补发窗口=${maxAgeHours}h${dry ? '  [dry-run]' : ''}`);
console.log(`[assistant] 已有 ${state.items.length} 条事项、${state.pending.length} 条待发、${state.sentReminders.length} 条已发提醒`);

if (once) {
  await tick();
  console.log('[assistant] --once 完成');
} else {
  await tick(); // 先立刻跑一次，不等第一个间隔
  const poller = createPoller({ intervalMs: intervalMin * 60_000, run: tick });
  poller.start();
  console.log(`[assistant] 常驻中（Ctrl+C 退出）`);
  process.on('SIGINT', () => {
    poller.stop();
    saveState(state);
    console.log('\n[assistant] 已退出，状态已保存');
    process.exit(0);
  });
}
