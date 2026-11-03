/**
 * 公开 API。
 *
 * P0：数据层 —— 归一化 / 去重 / 提醒
 * P1：classpipe 适配器 + 轮询循环（定时主动查看 → 通知）
 *
 * 仍**不是** DSH 插件 —— 插件外壳（tool 注册 + 持久化 + 常驻调度）在 P2。
 * 这样安排是为了让全部业务逻辑都能用 `node --test` 秒级验证，
 * 而不是在宿主进程里调试。
 */

export {
  CONTENT_FIELDS,
  KINDS,
  SOURCES,
  STATUSES,
  STALE_OVERRIDE_REASON,
  contentHash,
  itemId,
  mergeItems,
  normalizeItem,
  planStaleDrops,
  setStatus,
  toIso,
} from './items.js';

export {
  DAY,
  DEFAULT_OFFSETS,
  HOUR,
  MINUTE,
  dueReminders,
  offsetLabel,
  planReminders,
  reminderKey,
  reminderText,
} from './reminders.js';

export { DEFAULT_NOTIFY_KINDS, createPoller, formatDue, pollOnce } from './poll.js';

export {
  CLASSPIPE_DEFAULT_BASE,
  fetchClasspipeTasks,
  mapClasspipeTasks,
} from './sources/classpipe.js';

export { listLocalCourses, syncAllCourses } from './sources/classpipe-sync.js';

export {
  DSH_IM_DEFAULT_BASE,
  DSH_IM_DELIVERY_PATH,
  createDshImNotifier,
  sendDelivery,
} from './notify/dsh-im.js';

export {
  TELEGRAM_API_BASE,
  createTelegramNotifier,
  maskToken,
  sendTelegramMessage,
} from './notify/telegram.js';

export {
  DEFAULT_EVENT_MINUTES,
  localDateOf,
  needsUpdate,
  nextDate,
  toGoogleEvent,
} from './calendar/event.js';

export { escapeText, foldLine, toIcs, toUtcStamp } from './calendar/ics.js';