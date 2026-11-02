/**
 * Classpipe 适配器 —— 把已有的 Canvas 集成当作**上游数据源**，不重复造轮子。
 *
 * 为什么复用而不是自己调 Canvas：
 *   维护者的 `classpipe`（FastAPI + SQLite）已经做完了 Canvas 认证、课程关联、
 *   作业/测验/公告同步、去重入库（`UNIQUE(course_id, canvas_id)`）这些脏活。
 *   我们只需读它的一个接口，把结果归一成 `Item`。
 *
 * 接口契约（**实测确认，不是猜的**，2026-11-02）：
 *   GET {base}/canvas/all_tasks  →  200 JSON
 *   {
 *     success: true,
 *     total_assignments, total_quizzes, total_announcements,
 *     assignments:   [{ id, course_id, canvas_id, name, description, due_at,
 *                       points_possible, has_submitted, html_url, synced_at,
 *                       course_name, course_code }],
 *     quizzes:       [{ id, course_id, canvas_id, title, description, due_at, … }],
 *     announcements: [{ id, course_id, canvas_id, title, message, posted_at,
 *                       author_name, html_url, … }]
 *   }
 *
 * ⚠️ `due_at` / `posted_at` 是 **ISO 8601 UTC**（`2026-09-18T03:59:59Z`）或 `null`。
 *    实测坑：用 PowerShell 的 `ConvertFrom-Json` 看这个接口时，ISO 字符串会被自动
 *    转成 DateTime 并按本地文化显示（变成 `01/17/2026 04:59:59`），
 *    **看起来像是"非 ISO 格式"**。当时差点据此写错解析器；核对 SQLite 原始值才确认是 ISO。
 *    教训：判断线上数据格式要读**原始字节**（DB/原始 body），不要读经过一层工具渲染的视图。
 */

/** classpipe 默认监听地址（它默认同时开 8000 与 3000） */
export const CLASSPIPE_DEFAULT_BASE = 'http://127.0.0.1:8000';
/** 拉全量任务可能较慢（实测几百条），给足超时 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 组合稳定源内 id：同一门课里 canvas_id 才唯一 */
function sourceIdOf(courseId, canvasId, localId) {
  const inner = canvasId === null || canvasId === undefined || canvasId === ''
    ? `local:${localId}`
    : String(canvasId);
  return `${courseId ?? 'unknown'}:${inner}`;
}

/** 课程展示名：优先课程代码（`CSE 2231`），回落到课程名 */
function courseOf(row) {
  const code = typeof row.course_code === 'string' ? row.course_code.trim() : '';
  const name = typeof row.course_name === 'string' ? row.course_name.trim() : '';
  return code || name || null;
}

/**
 * 纯函数：把 `/canvas/all_tasks` 的响应映射成 `Item` 原始数据数组。
 * 不做网络、不改输入 —— 便于用固定 fixture 单测。
 *
 * @param {object} payload 接口响应
 * @returns {object[]} 可直接喂给 `mergeItems` 的原始项
 */
export function mapClasspipeTasks(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('classpipe: payload must be an object');
  }

  const items = [];

  for (const row of payload.assignments ?? []) {
    if (!row || typeof row.name !== 'string' || !row.name.trim()) continue;
    items.push({
      source: 'canvas',
      kind: 'assignment',
      sourceId: sourceIdOf(row.course_id, row.canvas_id, row.id),
      title: row.name,
      course: courseOf(row),
      dueAt: row.due_at ?? null,
      url: row.html_url || null,
      confidence: 1,
    });
  }

  for (const row of payload.quizzes ?? []) {
    if (!row || typeof row.title !== 'string' || !row.title.trim()) continue;
    items.push({
      source: 'canvas',
      kind: 'quiz',
      sourceId: sourceIdOf(row.course_id, row.canvas_id, row.id),
      title: row.title,
      course: courseOf(row),
      dueAt: row.due_at ?? null,
      url: row.html_url || null,
      confidence: 1,
    });
  }

  for (const row of payload.announcements ?? []) {
    if (!row || typeof row.title !== 'string' || !row.title.trim()) continue;
    items.push({
      source: 'canvas',
      // 公告通常没有截止时间：它进仓库是为了"今天有什么新消息"的摘要，
      // 具体 DDL 要另做抽取（P4，见 docs §7），这里不臆造 dueAt
      kind: 'announcement',
      sourceId: sourceIdOf(row.course_id, row.canvas_id, row.id),
      title: row.title,
      course: courseOf(row),
      dueAt: null,
      postedAt: row.posted_at ?? null,
      url: row.html_url || null,
      confidence: 1,
    });
  }

  return items;
}

/**
 * 从 classpipe 拉取并映射。
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] 注入便于测试
 * @returns {Promise<{items: object[], counts: object}>}
 */
export async function fetchClasspipeTasks({
  baseUrl = CLASSPIPE_DEFAULT_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/canvas/all_tasks`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`classpipe: HTTP ${response.status} from ${url}`);
    }
    const payload = await response.json();
    if (payload?.success === false) {
      throw new Error('classpipe: upstream reported success=false');
    }
    return {
      items: mapClasspipeTasks(payload),
      counts: {
        assignments: Number(payload?.total_assignments) || 0,
        quizzes: Number(payload?.total_quizzes) || 0,
        announcements: Number(payload?.total_announcements) || 0,
      },
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`classpipe: timed out after ${timeoutMs}ms (${url})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
