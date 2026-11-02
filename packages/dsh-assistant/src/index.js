/**
 * 公开 API（P0：纯数据层，尚不是 DSH 插件）。
 *
 * 为什么先做数据层：整个产品的正确性几乎全压在
 * 「同一份来源重复摄取不能重复插入 / 不能复活已完成事项 / 提醒不能重发」这三件事上。
 * 这三件都能用纯函数表达，也都能脱离 DSH 单测 —— 先把它们钉死，
 * 再接 ICS、再接插件外壳，才不会在宿主里调试业务逻辑。
 */

export {
  CONTENT_FIELDS,
  KINDS,
  SOURCES,
  STATUSES,
  contentHash,
  itemId,
  mergeItems,
  normalizeItem,
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
