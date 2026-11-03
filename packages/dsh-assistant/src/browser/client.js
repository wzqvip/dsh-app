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
 * 抓一次快照并给出 needsUser 判定。
 * @returns {Promise<{ok:boolean, browserUp?:boolean, needsUser?:boolean, reason?:string|null, vncUrl?:string, transient?:boolean, error?:string}>}
 */
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
