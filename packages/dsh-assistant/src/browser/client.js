/**
 * dsh-browser 的 HTTP 客户端（仅本机内网）。
 *
 * 只做两件事：读健康、抓快照。失败一律转成 { transient: true }，
 * 因为 Chromium 自愈期间会短暂 503 —— 那不代表"登录过期"。
 */

const DEFAULT_TIMEOUT_MS = 15_000;

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
 * @param {object} options
 * @param {string} options.baseUrl 例 `http://dsh-browser:8789`
 * @param {string} options.token
 * @returns {Promise<{ok:boolean, browserUp?:boolean, vncUrl?:string, page?:object, transient?:boolean, error?:string}>}
 */
export async function fetchBrowserHealth({
  baseUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/health`;
  try {
    const response = await withTimeout(timeoutMs, (signal) => fetchImpl(url, { signal }));
    if (!response.ok) return { ok: false, transient: true, error: `HTTP ${response.status}` };
    const body = await response.json();
    return {
      ok: true,
      browserUp: body.browserUp !== false,
      vncUrl: body.vncUrl ?? null,
      page: body.page ?? null,
    };
  } catch (error) {
    return { ok: false, transient: true, error: String(error?.message ?? error) };
  }
}

/**
 * 执行一个浏览器动作（open / click / type / waitFor）。
 * 失败返回 {ok:false}，不抛 —— 自愈流程要能逐个尝试、失败继续。
 */
export async function actOnBrowser({
  baseUrl,
  token,
  action,
  selector,
  url,
  text,
  timeoutMs = 10_000,
} = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'no browser baseUrl' };

  const body = { action, timeoutMs };
  if (selector) body.selector = selector;
  if (url) body.url = url;
  if (text !== undefined) body.text = text;

  try {
    const response = await withTimeout(timeoutMs + 5_000, (signal) =>
      fetchImplFor()(`${base}/act`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-dsh-token': token } : {}),
        },
        body: JSON.stringify(body),
        signal,
      }),
    );
    const payload = await response.json().catch(() => ({}));
    if (action === 'open' && (!response.ok || payload?.ok === false)) {
      return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
    }
    return { ok: response.ok && payload?.ok !== false, ...payload };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 允许测试注入；默认用全局 fetch */
let fetchImplOverride = null;
export function __setFetchImplForTest(fn) {
  fetchImplOverride = fn;
}
function fetchImplFor() {
  return fetchImplOverride ?? globalThis.fetch;
}

export async function snapshotBrowser({
  baseUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  try {
    const response = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${base}/snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-dsh-token': token } : {}),
        },
        body: '{}',
        signal,
      }),
    );

    if (response.status === 503) return { ok: false, browserUp: false, transient: true, error: 'HTTP 503' };
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      return { ok: false, transient: true, error: `HTTP ${response.status} ${raw.slice(0, 120)}` };
    }

    const body = await response.json();
    return {
      ok: true,
      browserUp: true,
      needsUser: body.needsUser === true,
      reason: body.reason ?? null,
      vncUrl: body.vncUrl ?? null,
      page: { url: body.url, title: body.title },
      chars: body.chars ?? null,
      text: body.text ?? '',
    };
  } catch (error) {
    return { ok: false, transient: true, error: String(error?.message ?? error) };
  }
}
