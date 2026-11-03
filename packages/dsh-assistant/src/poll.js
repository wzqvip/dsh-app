/**
 * 「定时/触发器 → 主动查看 → 通知」的核心循环。
 *
 * 这是本产品与普通 DSH 会话的根本差别：**由时间或事件发起**，不是用户发起。
 *
 * 一轮 poll 做四件事：
 *   1. 从来源拉当前快照
 *   2. 幂等并入仓库（去重、识别变更）
 *   3. 把"值得告诉用户的变化"翻译成通知（新增截止 / 截止改期）
 *   4. 通过 notify 投递（失败不阻断入库）
 *
 * ⚠️ 关键取舍：
 *   · **先入库再通知**。通知失败最多丢一条消息；反过来会丢数据。
 *   · **只有"变化"才通知**。同一份数据第二次拉取是 unchanged → 不打扰用户，
 *     否则每小时都会收到"还有 2 天截止"。
 *   · **过去的截止不做新增通知**（补发一堆过期 DDL 是噪音，不是信息）。
 */

import { mergeItems } from './items.js';

/** 默认通知哪些类型：只通知真正的截止变化；公告默认为静默（进摘要，不单独推） */
export const DEFAULT_NOTIFY_KINDS = Object.freeze(['new_deadline', 'deadline_changed']);

/** 默认时区取运行环境；生产上应显式传（classpipe / 用户所在时区） */
function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 人类可读的截止时间。
 * @param {string|null} iso
 * @param {string} [timeZone]
 */
export function formatDue(iso, timeZone = defaultTimeZone()) {
  if (!iso) return '无截止时间';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间无法解析';
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    // 时区名非法时不要静默：退到 ISO，至少是准确的
    return new Date(ms).toISOString();
  }
}

function headline(item) {
  const course = item.course ? `（${item.course}）` : '';
  return `${item.title}${course}`;
}

/**
 * 跑一轮：拉取 → 合并 → 生成通知 → 投递。
 *
 * @param {object} options
 * @param {() => Promise<object[]>} options.fetchItems 返回原始项数组（来源适配器的输出）
 * @param {object[]} [options.items] 现有仓库内容
 * @param {Date} [options.now]
 * @param {(text: string, meta: object) => Promise<void>|void} [options.notify]
 * @param {string[]|'all'} [options.notifyKinds]
 * @param {string} [options.timeZone]
 * @returns {Promise<{items: object[], result: object, candidates: object[], delivered: object[], failed: object[]}>}
 */
export async function pollOnce({
  fetchItems,
  items = [],
  now = new Date(),
  notify,
  notifyKinds = DEFAULT_NOTIFY_KINDS,
  timeZone = defaultTimeZone(),
} = {}) {
  if (typeof fetchItems !== 'function') throw new Error('pollOnce: fetchItems is required');

  const incoming = await fetchItems();
  const { items: next, result } = mergeItems(items, incoming, now);

  const before = new Map((items ?? []).map((item) => [item.id, item]));
  const after = new Map(next.map((item) => [item.id, item]));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));

  const candidates = [];

  for (const id of result.inserted) {
    const item = after.get(id);
    if (!item) continue;
    if (item.kind === 'announcement') {
      candidates.push({
        kind: 'new_announcement',
        itemId: id,
        text: `📣 新公告：${headline(item)}`,
      });
      continue;
    }
    if (!item.dueAt) continue;
    const dueMs = Date.parse(item.dueAt);
    // 已过期的截止不当"新截止"推送（补发是噪音）
    if (!Number.isFinite(dueMs) || dueMs <= nowMs) continue;
    candidates.push({
      kind: 'new_deadline',
      itemId: id,
      dueAt: item.dueAt,
      text: `🆕 新截止：${headline(item)}\n截止 ${formatDue(item.dueAt, timeZone)}`,
    });
  }

  for (const id of result.updated) {
    const prev = before.get(id);
    const item = after.get(id);
    if (!item) continue;
    if ((prev?.dueAt ?? null) === (item.dueAt ?? null)) continue; // 只是标题/链接变了，不值得单独推
    if (!item.dueAt) continue;
    candidates.push({
      kind: 'deadline_changed',
      itemId: id,
      from: prev?.dueAt ?? null,
      to: item.dueAt,
      text:
        `🔄 截止改期：${headline(item)}\n` +
        `${formatDue(prev?.dueAt, timeZone)} → ${formatDue(item.dueAt, timeZone)}`,
    });
  }

  const allowAll = notifyKinds === 'all';
  const allowed = new Set(allowAll ? [] : notifyKinds);
  const selected = allowAll ? candidates : candidates.filter((c) => allowed.has(c.kind));

  const delivered = [];
  const failed = [];

  for (const notification of selected) {
    if (typeof notify !== 'function') break;
    try {
      await notify(notification.text, notification);
      delivered.push(notification);
    } catch (error) {
      // 投递失败不影响入库：下一次 poll 这些项是 unchanged，不会重复刷屏，
      // 但这条消息确实丢了 —— 记进 failed 让调用方决定是否重试/告警。
      failed.push({ ...notification, error: String(error?.message ?? error) });
    }
  }

  return { items: next, result, candidates, delivered, failed };
}

/**
 * 定时器封装：固定间隔跑 `run`，带**单飞保护**（上一轮没跑完就跳过本轮）。
 *
 * 为什么需要单飞：拉取可能比间隔还慢（几百条任务 + 网络慢），
 * 没有保护就会叠加请求，最终把自己打挂。
 *
 * ⚠️ `unref` 的陷阱：默认 `unref: true` 是为了让测试/短脚本不被定时器拖住退出；
 * 但**常驻守护进程必须传 `unref: false`** —— 否则定时器不持有事件循环，
 * Node 会在 main() 返回后立刻退出（看起来"启动了但马上没了"）。实测踩过。
 *
 * @param {object} options
 * @param {number} options.intervalMs
 * @param {() => Promise<void>|void} options.run
 * @param {boolean} [options.unref] 是否 unref 定时器（常驻进程设为 false）
 * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
 */
export function createPoller({ intervalMs, run, unref = true, logger = console } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('createPoller: intervalMs must be a positive number');
  }
  if (typeof run !== 'function') throw new Error('createPoller: run is required');

  let timer = null;
  let running = false;
  let skipped = 0;

  async function tick() {
    if (running) {
      skipped += 1;
      logger?.warn?.(`[assistant] 上一轮尚未结束，跳过本次（累计跳过 ${skipped}）`);
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      logger?.error?.(`[assistant] 本轮失败：${error?.message ?? error}`);
    } finally {
      running = false;
    }
  }

  return {
    /** 启动（`unref: true` 时不会拖住进程退出；常驻守护进程要传 `unref: false`） */
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (unref && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 手动触发一轮（测试/立刻刷新用） */
    tick,
    get stats() {
      return { running, skipped, intervalMs };
    },
  };
}
