/**
 * 个人助理守护进程：**定时主动查看 → 推送**。
 *
 * 两种运行方式：
 *   · `--once`：跑一轮就退出（**Windows 计划任务用这个**，最稳，重启后仍在）
 *   · 不加 `--once`：常驻 setInterval（关终端就没了，只适合临时调试）
 *
 * 用法：
 *   node scripts/run-assistant.mjs --dry --once          # 只看会推什么
 *   node scripts/run-assistant.mjs --once                 # 真跑一轮（计划任务调这个）
 *   node scripts/run-assistant.mjs --once --digest        # 跑一轮 + 发本周摘要
 *   node scripts/run-assistant.mjs --digest-only          # 只发摘要（每日早报）
 *   node scripts/run-assistant.mjs --interval 45          # 常驻调试
 *
 * 状态：`~/.dsh-assistant/state.json`；日志：`~/.dsh-assistant/run.log`；
 * 单实例锁：`~/.dsh-assistant/run.lock`（防计划任务与手动执行撞车重复发消息）。
 *
 * ⚠️ 三个设计要点：
 *   1. **通知先进持久队列，发成功才出队** —— 否则 Telegram 抖动一次，
 *      那条「新截止」就永久丢了（下一轮它已是 unchanged）。
 *   2. **单实例锁** —— 计划任务 + 手动执行同时跑会重复推送。
 *   3. **失败告警限频** —— classpipe 挂了要告诉你，但不能每 45 分钟吼一次。
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
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
import { syncAllCourses } from '../src/sources/classpipe-sync.js';
import { sendDelivery } from '../src/notify/dsh-im.js';
import { maskToken, sendTelegramMessage } from '../src/notify/telegram.js';

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
const digestOnly = flag('digest-only', false) === true;
const maxAgeHours = Number(flag('max-age-hours', 12));
const alertCooldownHours = Number(flag('alert-cooldown-hours', 6));
// 同步开关：默认**开**。关掉它助理就只会读快照（classpipe 自己不会定时同步）。
const syncEnabled = flag('no-sync', false) !== true;
const syncMaxAgeHours = Number(flag('sync-max-age-hours', 6));
const logPath = flag('log-file', join(homedir(), '.dsh-assistant', 'run.log'));
const useLock = flag('no-lock', false) !== true;
const lockPath = join(dirname(statePath), 'run.lock');
const LOCK_STALE_MS = 30 * 60_000;

// ---------------- 日志（控制台 + 文件，便于计划任务排查） ----------------

const LOG_MAX_BYTES = 1 * 1024 * 1024;

function rotateLogIfNeeded() {
  try {
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`); // 只保留一份旧档，够排查了
    }
  } catch {
    /* 日志轮转失败不该影响主流程 */
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    rotateLogIfNeeded();
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* 写日志失败也不该让助理停摆 */
  }
}

function logError(message) {
  const line = `[${new Date().toISOString()}] ERROR ${message}`;
  console.error(message);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------- 单实例锁 ----------------
//
// 为什么需要：计划任务每 45 分钟跑一次 **同时** 你可能手动执行一次，
// 两个进程读同一份 state → 各自把同一条「新截止」入队 → 用户收到重复消息。
// 锁文件记录 pid + 时间；超过 30 分钟的锁视为僵死（进程被强杀时不会留死锁）。

function acquireLock() {
  if (!useLock) return { ok: true };
  try {
    if (existsSync(lockPath)) {
      const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
      const age = Date.now() - Date.parse(holder.at);
      if (Number.isFinite(age) && age < LOCK_STALE_MS) {
        return { ok: false, holder };
      }
      log(`检测到僵死锁（${Math.round(age / 60_000)} 分钟前，pid ${holder.pid}），接管`);
    }
  } catch {
    /* 锁文件坏了就当没有 */
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return { ok: true };
  } catch (error) {
    log(`⚠️ 无法创建锁文件（继续执行）：${error.message}`);
    return { ok: true };
  }
}

function releaseLock() {
  if (!useLock) return;
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (holder.pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// ---- 投递凭据：优先 Telegram 直连，其次 dsh-im ----
const tgConfigPath = flag('tg-config', join(homedir(), '.dsh-assistant', 'telegram.json'));
let tgToken = process.env.DSH_ASSISTANT_TG_TOKEN ?? '';
let tgChat = String(flag('tg-chat', process.env.DSH_ASSISTANT_TG_CHAT ?? '') ?? '');

if ((!tgToken || !tgChat) && existsSync(tgConfigPath)) {
  try {
    const tgConfig = JSON.parse(readFileSync(tgConfigPath, 'utf8'));
    tgToken = tgToken || tgConfig.token || '';
    tgChat = tgChat || String(tgConfig.chatId ?? '');
  } catch (error) {
    console.error(`[assistant] ⚠️ 读取 ${tgConfigPath} 失败：${error.message}`);
  }
}

const hasTelegram = Boolean(tgToken && tgChat);
const hasDshIm = Boolean(botId && targetId);

if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
  console.error('[assistant] --interval 必须是正数（分钟）');
  process.exit(2);
}
if (!dry && !hasTelegram && !hasDshIm) {
  console.error('[assistant] 缺少投递配置。二选一：');
  console.error(`  ① Telegram 直连：把 {"token":"…","chatId":"…"} 写进 ${tgConfigPath}`);
  console.error('  ② dsh-im：先在 DSH 设置里新建投递目标，再用 --bot-id/--target-id');
  console.error('  或先用 --dry 看它会推什么（不需要凭据）。');
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

/** 发送一条；dry 模式只打印。优先 Telegram 直连，其次 dsh-im。 */
async function deliver(text) {
  if (dry) {
    console.log(`[dry] 会推送：\n${text.replace(/^/gm, '        ')}`);
    return;
  }
  if (hasTelegram) {
    await sendTelegramMessage({ token: tgToken, chatId: tgChat, text });
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
      logError(`❌ 投递失败（保留在队列）：${error.message}`);
      remaining.push(entry);
    }
  }

  state.pending = remaining;
  return { sent, failed };
}

// ---------------- 一轮 ----------------

/**
 * 拉取失败时告诉用户（但要限频）。
 * 为什么限频：classpipe 挂了以后每 45 分钟一条"拉取失败"等于自己变成噪音源。
 */
async function alertFailure(error, now) {
  const cooldownMs = alertCooldownHours * 3600_000;
  const last = state.lastAlertAt ? Date.parse(state.lastAlertAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < cooldownMs) {
    log(`（失败告警冷却中，${alertCooldownHours}h 内不再提醒）`);
    return;
  }
  const text =
    `⚠️ 助理拉取失败\n\n` +
    `${String(error.message).split('\n')[0]}\n\n` +
    `classpipe: ${classpipeBase}\n` +
    `会继续重试；${alertCooldownHours} 小时内不再重复提醒。`;
  try {
    await deliver(text);
    state.lastAlertAt = now.toISOString();
  } catch (sendError) {
    logError(`告警也发不出去：${sendError.message}`);
  }
}

async function tick() {
  const now = new Date();
  const before = state.items.length;
  // 首次运行 = 播种：把现状静默导入，**不推送**。
  // 否则用户第一次启动就会收到"你这学期全部未到期作业"，直接把人劝退。
  // 播种之后只推**真正的变化**（新增/改期）与到点提醒。
  const isSeed = before === 0;

  // 0) 按需触发 classpipe 同步。
  //    ⚠️ classpipe 自己**没有调度器**，不触发它就永远是上次手动同步的快照。
  //    同步失败不阻断本轮：至少还能读库里已有的数据。
  if (syncEnabled) {
    const staleMs = syncMaxAgeHours * 3600_000;
    const lastSync = state.lastSyncAt ? Date.parse(state.lastSyncAt) : NaN;
    if (!Number.isFinite(lastSync) || now.getTime() - lastSync >= staleMs) {
      try {
        const sync = await syncAllCourses({ baseUrl: classpipeBase });
        log(
          `同步 classpipe：${sync.synced.length}/${sync.listed} 门课成功` +
            (sync.failed.length ? `，失败 ${sync.failed.length}` : '') +
            `（${Math.round(sync.durationMs / 1000)}s）`,
        );
        if (sync.failed.length > 0) {
          logError(
            `同步失败明细：${sync.failed
              .slice(0, 3)
              .map((f) => `${f.id}: ${f.error}`)
              .join('; ')}`,
          );
        }
        state.lastSyncAt = now.toISOString();
      } catch (error) {
        logError(`同步异常（继续用库里数据）：${error.message}`);
      }
    }
  }

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
    logError(`❌ 拉取失败：${error.message}`);
    await alertFailure(error, now);
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

  log(
    `事项 ${before} → ${state.items.length}` +
      `（新增 ${pollResult.result.inserted.length} / 更新 ${pollResult.result.updated.length}）` +
      (isSeed
        ? `  【首次播种：静默导入，不推送】`
        : `  提醒计划 ${plan.length}（到期 ${due.length}）` +
          `  已发 ${flushed.sent} / 失败 ${flushed.failed} / 待发 ${state.pending.length}`) +
      (dry ? '  [dry]' : ''),
  );
}

// ---------------- 摘要（digest） ----------------

/**
 * 发一条"未来 N 天截止"的摘要。
 * 与逐条提醒互补：提醒是"这一条要到期了"，摘要是"这周整体长什么样"。
 */
async function sendDigest({ days = 7, limit = 12 } = {}) {
  const now = Date.now();
  const horizon = now + days * 24 * 3600 * 1000;

  const upcoming = state.items
    .filter((item) => item.status === 'open' && item.dueAt)
    .map((item) => ({ item, dueMs: Date.parse(item.dueAt) }))
    .filter(({ dueMs }) => Number.isFinite(dueMs) && dueMs > now && dueMs <= horizon)
    .sort((a, b) => a.dueMs - b.dueMs);

  const total = state.items.filter((item) => item.status === 'open').length;

  if (upcoming.length === 0) {
    const text = `📋 未来 ${days} 天没有新的截止。\n仓库中共 ${total} 条进行中的事项。`;
    await deliver(text);
    return { sent: 1, count: 0 };
  }

  const lines = upcoming.slice(0, limit).map(({ item, dueMs }) => {
    const when = new Date(dueMs).toLocaleString('zh-CN', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const course = item.course ? `（${item.course}）` : '';
    return `· ${when}  ${item.title}${course}`;
  });

  const more = upcoming.length > limit ? `\n…还有 ${upcoming.length - limit} 条` : '';
  const text =
    `📋 未来 ${days} 天有 ${upcoming.length} 个截止：\n\n` +
    `${lines.join('\n')}${more}\n\n` +
    `仓库中共 ${total} 条进行中的事项。`;

  await deliver(text);
  return { sent: 1, count: upcoming.length };
}

// ---------------- 主流程 ----------------

/** 主流程：先抢锁，再按模式跑，任何退出路径都释放锁 */
async function main() {
  const lock = acquireLock();
  if (!lock.ok) {
    // 另一个进程正在跑：**静默成功退出**（计划任务重入是正常情况，不该算失败）
    log(
      `另一个助理进程正在运行（pid ${lock.holder?.pid}，${lock.holder?.at}），本轮跳过`,
    );
    return;
  }

  process.on('exit', releaseLock);

  try {
    log(`classpipe=${classpipeBase}  dsh=${dshBase}  时区=${timeZone}`);
    log(
      `投递=${
        hasTelegram
          ? `telegram(chat ${tgChat}, bot ${maskToken(tgToken)})`
          : hasDshIm
            ? `dsh-im(bot ${botId}, target ${targetId})`
            : '未配置'
      }`,
    );
    log(
      `状态=${statePath}  日志=${logPath}  间隔=${intervalMin} 分钟  补发窗口=${maxAgeHours}h${dry ? '  [dry-run]' : ''}`,
    );
    log(
      `已有 ${state.items.length} 条事项、${state.pending.length} 条待发、${state.sentReminders.length} 条已发提醒`,
    );

    if (digestOnly) {
      const result = await sendDigest({ days: Number(flag('digest-days', 7)) });
      log(`摘要已发送（${result.count} 条截止）`);
      return;
    }

    if (once) {
      await tick();
      if (flag('digest', false) === true) {
        const result = await sendDigest({ days: Number(flag('digest-days', 7)) });
        log(`摘要已发送（${result.count} 条截止）`);
      }
      log('--once 完成');
      return;
    }

    await tick(); // 先立刻跑一次，不等第一个间隔
    const poller = createPoller({ intervalMs: intervalMin * 60_000, run: tick, unref: false });
    poller.start();
    log('常驻中（Ctrl+C 退出）');

    process.on('SIGINT', () => {
      poller.stop();
      saveState(state);
      log('已退出，状态已保存');
      releaseLock();
      process.exit(0);
    });
  } finally {
    // --once 路径在这里释放；常驻路径由 SIGINT 处理
    if (once || digestOnly) releaseLock();
  }
}

await main();
