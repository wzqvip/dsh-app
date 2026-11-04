/**
 * Google Calendar REST 客户端（零依赖，只用 fetch）。
 *
 * 设计要点：
 *   · **不缓存 access_token 到磁盘**：refresh_token 才是长期凭据，
 *     access_token 每次现换（有效期 1 小时，缓存反而带来过期判断的坑）。
 *     仅在本进程内做**内存缓存**，减少无谓请求。
 *   · 目标日历靠**名字查找**（维护者的日历里有一个叫 `OSU` 的子日历），
 *     绝不硬编码 calendarId —— 换个账号也能用。
 *   · 所有写入都带 `extendedProperties.private.dshItemId`，用于**幂等 upsert**
 *     （找得到就 PATCH，找不到才 INSERT）。
 */

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_TIMEOUT_MS = 20_000;

/** 进程内 access_token 缓存 */
let tokenCache = null;

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
 * 用 refresh_token 换 access_token。
 * @returns {Promise<{accessToken:string, expiresAt:number}>}
 */
export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('google: 缺 clientId / clientSecret / refreshToken');
  }
  const response = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal,
    }),
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const detail = body?.error_description ?? body?.error ?? JSON.stringify(body).slice(0, 160);
    throw new Error(`google: 换 token 失败 HTTP ${response.status} ${detail}`);
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

/** 带自动刷新的授权头（进程内缓存，提前 60 秒过期） */
async function authHeader({ clientId, clientSecret, refreshToken, fetchImpl, timeoutMs }) {
  if (!tokenCache || Date.now() > tokenCache.expiresAt - 60_000) {
    const fresh = await refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl, timeoutMs });
    tokenCache = fresh;
  }
  return { authorization: `Bearer ${tokenCache.accessToken}` };
}

/** 测试用：清掉内存里的 access_token */
export function __resetTokenCache() {
  tokenCache = null;
}

async function apiRequest({
  method = 'GET',
  path,
  query,
  body,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const url = new URL(`${CALENDAR_API}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = {
    ...(await authHeader({ clientId, clientSecret, refreshToken, fetchImpl, timeoutMs })),
  };
  if (body) headers['content-type'] = 'application/json';

  const response = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(url.toString(), {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    }),
  );

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* 保留原文 */
  }

  if (!response.ok) {
    const detail = parsed?.error?.message ?? parsed?.error ?? text.slice(0, 200);
    throw new Error(`google: HTTP ${response.status} ${detail}`);
  }
  return parsed;
}

/** 列出账号下所有日历（含 primary 与子日历） */
export async function listCalendars(options) {
  const data = await apiRequest({
    ...options,
    path: '/users/me/calendarList',
    query: { maxResults: 250, showHidden: true },
  });
  return (data?.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary ?? '',
    summaryOverride: item.summaryOverride ?? null,
    primary: item.primary === true,
    accessRole: item.accessRole ?? null,
    timeZone: item.timeZone ?? null,
  }));
}

/**
 * 按名字找日历。优先精确匹配，其次包含匹配（不区分大小写）。
 * 找不到返回 null —— 调用方要**明确报错**，绝不能退回到 primary
 * （维护者明确要求"不要弄乱了"）。
 */
export function findCalendarByName(calendars, name) {
  const needle = String(name ?? '').trim().toLowerCase();
  if (!needle) return null;
  const list = calendars ?? [];
  const exact = list.find(
    (cal) =>
      String(cal.summary ?? '').trim().toLowerCase() === needle ||
      String(cal.summaryOverride ?? '').trim().toLowerCase() === needle,
  );
  if (exact) return exact;
  return (
    list.find(
      (cal) =>
        String(cal.summary ?? '').toLowerCase().includes(needle) ||
        String(cal.summaryOverride ?? '').toLowerCase().includes(needle),
    ) ?? null
  );
}

/** 拉取一个日历的事件（自动翻页）。用于备份与去重查询。 */
export async function listEvents({
  calendarId,
  timeMin,
  timeMax,
  maxResults = 2500,
  ...options
} = {}) {
  if (!calendarId) throw new Error('google: calendarId is required');
  const events = [];
  let pageToken;

  do {
    const data = await apiRequest({
      ...options,
      path: `/calendars/${encodeURIComponent(calendarId)}/events`,
      query: {
        maxResults,
        singleEvents: false, // 备份要原始事件（含 recurring 的规则），不要展开
        showDeleted: false,
        timeMin,
        timeMax,
        pageToken,
      },
    });
    events.push(...(data?.items ?? []));
    pageToken = data?.nextPageToken;
  } while (pageToken);

  return events;
}

/** 建事件 */
export async function createEvent({ calendarId, event, ...options } = {}) {
  if (!calendarId) throw new Error('google: calendarId is required');
  return apiRequest({
    ...options,
    method: 'POST',
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    body: event,
  });
}

/** 改事件（只传要改的字段） */
export async function patchEvent({ calendarId, eventId, patch, ...options } = {}) {
  if (!calendarId || !eventId) throw new Error('google: calendarId / eventId are required');
  return apiRequest({
    ...options,
    method: 'PATCH',
    path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    body: patch,
  });
}

/** 按 dshItemId 找已存在的事件（幂等 upsert 的核心） */
export async function findEventByDshItemId({ calendarId, dshItemId, ...options } = {}) {
  if (!calendarId || !dshItemId) return null;
  const data = await apiRequest({
    ...options,
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    query: { privateExtendedProperty: `dshItemId=${dshItemId}`, maxResults: 5, showDeleted: false },
  });
  return data?.items?.[0] ?? null;
}
