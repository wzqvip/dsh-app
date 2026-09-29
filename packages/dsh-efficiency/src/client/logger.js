/**
 * 客户端 → 宿主的日志回流。
 *
 * 为什么需要：
 *   本插件是浏览器侧脚本，AI 看不到它的 console。
 *   而"面板没渲染"这类问题【只能】靠浏览器端的错误信息定位。
 *   所以把关键事件与异常批量 POST 回 /dsh-efficiency/api/client-log，
 *   AI 就能在宿主日志里读到 —— 不需要用户开 F12 转述。
 *
 * 设计：
 *   - 批量 + 定时冲刷（250ms），避免每个小事件一次请求
 *   - 失败静默重试一次就放弃，绝不能因为排障把功能拖垮
 *   - 同时镜像到 console，方便用户自己看
 */

const ENDPOINT = '/dsh-efficiency/api/client-log';
const FLUSH_MS = 250;
const MAX_QUEUE = 60;

let queue = [];
let timer = null;
let flushing = false;
let installed = false;

function push(entry) {
  queue.push(entry);
  if (queue.length > MAX_QUEUE) queue.shift();
  if (timer === null) timer = setTimeout(flush, FLUSH_MS);
}

async function flush() {
  timer = null;
  if (flushing || queue.length === 0) return;
  const batch = queue;
  queue = [];
  flushing = true;
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    /* 排障通道失败不能影响功能：丢弃这一批，不再重试 */
  } finally {
    flushing = false;
    if (queue.length > 0 && timer === null) timer = setTimeout(flush, FLUSH_MS);
  }
}

/** 记一条（level: info | warn | error） */
export function clog(level, msg, extra) {
  const entry = { at: new Date().toISOString(), level, msg: String(msg) };
  if (extra !== undefined) {
    try { entry.extra = JSON.parse(JSON.stringify(extra)); } catch { entry.extra = String(extra); }
  }
  push(entry);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  try { fn(`[dsh-efficiency] ${entry.msg}`, extra ?? ''); } catch { /* ignore */ }
}

/**
 * 装全局错误捕获。只装一次。
 * 这是"面板没渲染"最可能的线索来源 —— 渲染期抛错会被这里抓到。
 */
export function installClientLogging() {
  if (installed) return;
  installed = true;

  try {
    globalThis.addEventListener?.('error', (ev) => {
      const err = ev?.error;
      clog('error', `window.onerror: ${ev?.message ?? String(err)}`, {
        stack: err?.stack ? String(err.stack).slice(0, 800) : undefined,
        source: ev?.filename,
        line: ev?.lineno,
        col: ev?.colno,
      });
    });
    globalThis.addEventListener?.('unhandledrejection', (ev) => {
      const r = ev?.reason;
      clog('error', `unhandledrejection: ${r?.message ?? String(r)}`, {
        stack: r?.stack ? String(r.stack).slice(0, 800) : undefined,
      });
    });
  } catch { /* ignore */ }

  clog('info', 'client logging installed');
}
