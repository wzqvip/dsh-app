/**
 * `Item` 仓库的核心纯逻辑：归一化、内容指纹、幂等合并。
 *
 * 设计原则（见 docs/ASSISTANT.md §3）：
 *   · 纯函数：不碰文件系统、不依赖 DSH —— 这样能脱离宿主单测，也能被 web/CLI 复用
 *   · 幂等：同一份来源重复摄取，结果必须稳定（既不重复插入，也不误判"内容变了"）
 *   · 用户状态优先：摄取**永远不能**把用户标成 done/dropped 的事项复活
 */

import { createHash } from 'node:crypto';

/** 允许的来源；新增来源要同时改这里与 docs 里的表 */
export const SOURCES = Object.freeze(['canvas', 'gmail', 'outlook', 'manual']);
/** 事项类型；`quiz` 与 `assignment` 都算"有截止的事项"，但来源与语义不同 */
export const KINDS = Object.freeze([
  'assignment',
  'quiz',
  'announcement',
  'email',
  'event',
  'note',
]);
/** 用户可见状态 */
export const STATUSES = Object.freeze(['open', 'done', 'dropped']);

/**
 * 参与内容指纹的字段。
 *
 * ⚠️ 这里的选择是去重正确性的**关键**：
 *   · 必须包含来源决定的字段（改了 DDL 要能识别成"更新"→ 重新排提醒）
 *   · 必须**排除** status / revision / 时间戳（否则用户一改状态就被判成内容变了）
 */
export const CONTENT_FIELDS = Object.freeze([
  'source',
  'kind',
  'sourceId',
  'title',
  'course',
  'dueAt',
  'allDay',
  'url',
]);

/** 稳定序列化：键排序，避免对象键序不同导致指纹漂移 */
function canonicalJson(obj) {
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k] ?? null)}`);
  return `{${parts.join(',')}}`;
}

/** 内容指纹（16 位十六进制，够用且短） */
export function contentHash(item) {
  const payload = {};
  for (const field of CONTENT_FIELDS) payload[field] = item[field] ?? null;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

/** 稳定唯一键：`${source}:${kind}:${sourceId}` */
export function itemId({ source, kind, sourceId }) {
  return `${source}:${kind}:${sourceId}`;
}

/** 宽松转 ISO（失败返回 null，绝不抛） */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 只取内容字段 */
function pickContent(item) {
  const out = {};
  for (const field of CONTENT_FIELDS) out[field] = item[field] ?? null;
  return out;
}

/**
 * 把一条"来源原始数据"归一成 `Item`。
 * @returns {{ item: object } | { error: string }} 失败时给出可读原因（供 rejected 记录）
 */
export function normalizeItem(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'item must be a plain object' };
  }
  const source = String(raw.source ?? '').trim();
  const kind = String(raw.kind ?? '').trim();
  const sourceId =
    raw.sourceId === null || raw.sourceId === undefined ? '' : String(raw.sourceId).trim();
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';

  const problems = [];
  if (!SOURCES.includes(source)) problems.push(`unknown source "${source}"`);
  if (!KINDS.includes(kind)) problems.push(`unknown kind "${kind}"`);
  if (!sourceId) problems.push('missing sourceId');
  if (!title) problems.push('missing title');
  if (problems.length > 0) return { error: problems.join('; ') };

  const status = STATUSES.includes(raw.status) ? raw.status : 'open';
  const stamp = toIso(now) ?? new Date().toISOString();

  const item = {
    id: itemId({ source, kind, sourceId }),
    source,
    kind,
    sourceId,
    title,
    course: typeof raw.course === 'string' && raw.course.trim() ? raw.course.trim() : null,
    dueAt: toIso(raw.dueAt),
    // 公告类没有截止，但有发布时间（用于"今天有什么新公告"摘要）
    postedAt: toIso(raw.postedAt),
    // 只有显式 true 才算全天；缺失/非布尔一律按"有具体时刻"处理（更保守）
    allDay: raw.allDay === true,
    // TZID 解析不了时由解析层置 true —— 这里只透传，不猜
    tzUncertain: raw.tzUncertain === true,
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : null,
    confidence: typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
      ? raw.confidence
      : 1,
    status,
    revision: 1,
    contentHash: null, // 下面填
    firstSeenAt: stamp,
    lastSeenAt: stamp,
  };
  item.contentHash = contentHash(item);
  return { item };
}

/**
 * 幂等合并：把一批来源数据并入现有集合。
 *
 * @param {object[]} existing 现有 items（不会被打包修改）
 * @param {object|object[]} incoming 来源原始数据
 * @param {Date} now 注入时间，便于测试
 * @returns {{ items: object[], result: { inserted: string[], updated: string[], unchanged: string[], rejected: {raw: unknown, error: string}[] } }}
 */
export function mergeItems(existing, incoming, now = new Date()) {
  const byId = new Map();
  for (const item of existing ?? []) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }

  const result = { inserted: [], updated: [], unchanged: [], rejected: [] };
  const list = Array.isArray(incoming) ? incoming : [incoming];

  for (const raw of list) {
    const normalized = normalizeItem(raw, now);
    if (normalized.error) {
      result.rejected.push({ raw, error: normalized.error });
      continue;
    }
    const item = normalized.item;
    const prev = byId.get(item.id);

    if (!prev) {
      byId.set(item.id, item);
      result.inserted.push(item.id);
      continue;
    }

    if (prev.contentHash === item.contentHash) {
      // 完全没变：只推进 lastSeenAt（证明"我确实又看到了它"）
      byId.set(item.id, { ...prev, lastSeenAt: item.lastSeenAt });
      result.unchanged.push(item.id);
      continue;
    }

    // 内容变了（例如老师改了 DDL）：更新内容，但**保留用户状态**与首次时间
    byId.set(item.id, {
      ...prev,
      ...pickContent(item),
      status: prev.status, // ← 摄取不得复活 done/dropped
      revision: (Number(prev.revision) || 1) + 1,
      contentHash: item.contentHash,
      lastSeenAt: item.lastSeenAt,
      // 这两项不是"来源内容"，但需要随最新一次摄取更新
      tzUncertain: item.tzUncertain,
      confidence: item.confidence,
    });
    result.updated.push(item.id);
  }

  return { items: [...byId.values()], result };
}

/** 设置用户状态（done/dropped/open）—— 唯一允许改 status 的入口 */
export function setStatus(items, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`);
  return (items ?? []).map((item) => (item.id === id ? { ...item, status } : item));
}

/** 自动过期的原因标记（写进 override，便于日后区分"用户手动丢"与"系统判定过期"） */
export const STALE_OVERRIDE_REASON = 'stale';

/**
 * 找出「早就过期且一直没完成」的事项，建议标记为 dropped。
 *
 * 为什么需要：Canvas 里有 2017 年就没关闭的作业，status 永远是 open。
 * 不清理的话 `/list` 会一直很吵，而且"400 条未完成"这个数字会让人放弃看它。
 *
 * 纯函数：只**建议**要丢哪些 id，不修改输入。调用方负责把它们写进 overrides
 * （必须走 override，否则下一次摄取会把它们复活成 open）。
 *
 * @param {object[]} items
 * @param {object} [options]
 * @param {Date|string|number} [options.now]
 * @param {number} [options.days] 超过多少天算陈旧，默认 30
 * @returns {string[]} 需要标记为 dropped 的 item id
 */
export function planStaleDrops(items, { now = new Date(), days = 30 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('planStaleDrops: invalid `now`');
  if (!Number.isFinite(days) || days <= 0) throw new Error('planStaleDrops: days must be > 0');

  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const stale = [];
  for (const item of items ?? []) {
    if (!item || item.status !== 'open' || !item.dueAt) continue;
    const dueMs = Date.parse(item.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    if (dueMs < cutoff) stale.push(item.id);
  }
  return stale;
}
