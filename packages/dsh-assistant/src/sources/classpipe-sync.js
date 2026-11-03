/**
 * classpipe 同步触发器。
 *
 * 为什么需要这个（本轮发现的硬伤）：
 *   classpipe 自己**没有任何调度器**（`app/*.py` 里没有 APScheduler / while True）。
 *   它只在被调用时同步。所以如果我们只读 `/canvas/all_tasks`，
 *   读到的永远是**上次有人手动点同步时的快照** —— 助理会安静地报过期数据。
 *
 * 做法：每轮 poll 前先对**已导入的课程**逐个调 `POST /canvas/courses/{id}/sync`，
 * 再读 `/canvas/all_tasks`。
 *
 * - 不调 `/canvas/import_all`：那个会**新建**本地课程（还会带 default 伪课程），
 *   我们只想刷新已有的。
 * - 串行执行：Canvas API 有速率限制，14 门课并发容易被限流。
 * - 单课失败不阻断其余：某门课 404/超时不该让整轮报废。
 */

const DEFAULT_TIMEOUT_MS = 20_000;
/** classpipe 的伪课程：不是真课，同步它会报错 */
const PSEUDO_COURSE_ID = 'default';

function baseOf(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '');
}

async function withTimeout(timeoutMs, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 列出 classpipe 里已导入的本地课程。
 * @returns {Promise<Array<{id: string, canvasId: string|null, name: string}>>}
 */
export async function listLocalCourses({
  baseUrl = 'http://127.0.0.1:8000',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${baseOf(baseUrl)}/courses`;
  const response = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(url, { headers: { accept: 'application/json' }, signal }),
  );
  if (!response.ok) throw new Error(`classpipe: HTTP ${response.status} from ${url}`);

  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : (payload?.courses ?? []);
  return rows
    .filter((row) => row && typeof row.id === 'string' && row.id !== PSEUDO_COURSE_ID)
    .map((row) => ({
      id: row.id,
      canvasId: row.canvas_course_id ? String(row.canvas_course_id) : null,
      name: typeof row.name === 'string' ? row.name : row.id,
    }));
}

/**
 * 逐课触发同步。
 *
 * @param {object} options
 * @returns {Promise<{listed:number, synced:string[], failed:{id:string,error:string}[], skipped:string[], durationMs:number}>}
 */
export async function syncAllCourses({
  baseUrl = 'http://127.0.0.1:8000',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  logger,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  let courses;
  try {
    courses = await listLocalCourses({ baseUrl, timeoutMs, fetchImpl });
  } catch (error) {
    return {
      listed: 0,
      synced: [],
      failed: [{ id: '(list)', error: String(error.message ?? error) }],
      skipped: [],
      durationMs: now() - startedAt,
    };
  }

  const synced = [];
  const failed = [];
  const skipped = [];

  for (const course of courses) {
    const url = `${baseOf(baseUrl)}/canvas/courses/${encodeURIComponent(course.id)}/sync`;
    try {
      const response = await withTimeout(timeoutMs, (signal) =>
        fetchImpl(url, { method: 'POST', headers: { accept: 'application/json' }, signal }),
      );
      if (!response.ok) {
        failed.push({ id: course.id, error: `HTTP ${response.status}` });
        continue;
      }
      // 有些实现返回 {success:false} 但仍是 200，按失败处理
      const body = await response.json().catch(() => null);
      if (body && body.success === false) {
        failed.push({ id: course.id, error: 'success=false' });
        continue;
      }
      synced.push(course.id);
    } catch (error) {
      failed.push({
        id: course.id,
        error: String(error?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : (error?.message ?? error)),
      });
    }
  }

  if (courses.length === 0) logger?.warn?.('[assistant] classpipe 里没有已导入的课程（先用 UI 导入？）');

  return { listed: courses.length, synced, failed, skipped, durationMs: now() - startedAt };
}
