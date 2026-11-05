/**
 * assistant 服务的客户端（数据管线 / 对话由 Lead 维护，这里只按契约调用）。
 *
 * 契约（2026-11-03 Lead 定稿）：
 *   GET  /health                     → {ok:true, items, open, pending, lastTickAt, lastSyncAt}（免 token）
 *   GET  /items?status=open&limit=50 → {ok:true, count:N, items:[{id,title,course,dueAt,status,revision}]}
 *   POST /items/{id}/status {status} → {ok:true, id, status}
 *   POST /chat {text}                → {ok:true, reply, usage}（DeepSeek，P50 2-5s，长回复 20s+）
 *   POST /session/check {}           → {ok:true, needsUser, reason, okSince}
 *   鉴权头：x-dsh-token: <共享密钥>
 *
 * 与 telegram.js 同一条安全规则：共享密钥只进请求头，绝不进错误信息/日志。
 */

export class AssistantError extends Error {
  constructor(
    message,
    { kind = 'unknown', status = null, description = null, method = null, path = null, timeoutMs = null } = {},
  ) {
    super(message);
    this.name = 'AssistantError';
    this.kind = kind;
    this.status = status;
    this.description = description;
    this.method = method;
    this.path = path;
    // 超时错误带上原始超时值：用户文案要显示"超 N 秒"
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : null;
  }
}

/** 从 assistant 的错误返回体里抽出一句可读原因（支持 `error` 是字符串或对象） */
function describeError(parsed, raw) {
  const value = parsed?.error;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim()) {
    return value.message.trim();
  }
  if (typeof parsed?.description === 'string' && parsed.description.trim()) return parsed.description.trim();
  return String(raw ?? '').slice(0, 300).trim();
}

/** id 形如 `canvas:assignment:123` —— 保留 `:` 字面量（服务端按原样匹配），其它字符转义 */
function encodeItemId(id) {
  return encodeURIComponent(String(id)).replace(/%3A/gi, ':');
}

/**
 * @param {object} options
 * @param {string} options.baseUrl 例：http://dsh-assistant:8787
 * @param {string} options.token 共享密钥
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs] 普通请求（items/health/status）超时
 * @param {number} [options.chatTimeoutMs] 对话请求超时（工具轮次放开后可能跑几分钟）
 */
export function createAssistantClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  chatTimeoutMs = 600_000,
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('assistant: baseUrl 必填');
  }
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('assistant: token 必填（共享密钥）');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('assistant: 缺少 fetch 实现');
  }

  const base = baseUrl.trim().replace(/\/+$/, '');
  const scrub = (text) => String(text ?? '').split(token).join('***');

  async function request(path, { method = 'GET', body, timeoutMs: requestTimeout = timeoutMs } = {}) {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);

    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-dsh-token': token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        /* 保留原文片段 */
      }

      if (!response.ok) {
        const description = describeError(parsed, raw);
        throw new AssistantError(
          scrub(`assistant ${method} ${path}: HTTP ${response.status} ${description}`),
          {
            kind: 'http',
            status: response.status,
            description: scrub(description),
            method,
            path,
          },
        );
      }

      return parsed;
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      if (error?.name === 'AbortError') {
        throw new AssistantError(`assistant ${method} ${path}: 超时 ${requestTimeout}ms`, {
          kind: 'timeout',
          method,
          path,
          timeoutMs: requestTimeout,
        });
      }
      throw new AssistantError(scrub(`assistant ${method} ${path}: ${error?.message ?? error}`), {
        kind: 'unreachable',
        method,
        path,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function listItems({ status = 'open', limit } = {}) {
    const params = new URLSearchParams({ status });
    if (Number.isFinite(limit)) params.set('limit', String(limit));
    const payload = await request(`/items?${params.toString()}`);
    if (!payload || !Array.isArray(payload.items)) {
      throw new AssistantError('assistant /items 返回格式不对（缺 items 数组）', {
        kind: 'invalid_response',
        path: '/items',
      });
    }
    return {
      items: payload.items,
      count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : payload.items.length,
    };
  }

  async function setStatus(id, status) {
    const trimmedStatus = String(status ?? '').trim();
    if (!['open', 'done', 'dropped'].includes(trimmedStatus)) {
      throw new AssistantError(`assistant: 非法 status "${status}"（只支持 open|done|dropped）`, {
        kind: 'validation',
        path: '/items/:id/status',
      });
    }
    const path = `/items/${encodeItemId(id)}/status`;
    const payload = await request(path, { method: 'POST', body: { status: trimmedStatus } });
    if (!payload || payload.ok !== true) {
      throw new AssistantError(`assistant ${path} 未返回 ok:true`, {
        kind: 'invalid_response',
        path,
      });
    }
    return payload;
  }

  async function health() {
    return request('/health');
  }

  /**
   * 无状态转发一句话给 assistant 的对话逻辑（LLM/上下文/历史都在 assistant 侧）。
   * @param {object} options
   * @param {string} options.text 用户原始文本
   * @returns {Promise<{ok:true, reply:string, usage?:object}>}
   */
  async function chat({ text } = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new AssistantError('assistant chat: text 必填', { kind: 'validation', path: '/chat' });
    }
    // 对话是**唯一**允许超过默认超时的请求（DeepSeek 长回复可能 20s+）
    const payload = await request('/chat', {
      method: 'POST',
      body: { text },
      timeoutMs: chatTimeoutMs,
    });
    if (!payload || payload.ok !== true) {
      const description = scrub(describeError(payload, ''));
      throw new AssistantError(`assistant /chat 返回失败：${description}`, {
        kind: 'chat_failed',
        description,
        path: '/chat',
      });
    }
    if (typeof payload.reply !== 'string') {
      throw new AssistantError('assistant /chat 返回格式不对（缺 reply 字符串）', {
        kind: 'invalid_response',
        path: '/chat',
      });
    }
    return payload;
  }

  /**
   * 立即验证 noVNC 会话是否已登录（维护者回复 /ready 时调用）。
   * @returns {Promise<{needsUser:boolean, reason:string|null, okSince:string|null}>}
   */
  async function checkSession() {
    const payload = await request('/session/check', { method: 'POST', body: {} });
    if (!payload || payload.ok !== true) {
      const description = scrub(describeError(payload, ''));
      throw new AssistantError(`assistant /session/check 返回失败：${description}`, {
        kind: 'session_failed',
        description,
        path: '/session/check',
      });
    }
    return {
      needsUser: payload.needsUser === true,
      reason: payload.reason ?? null,
      okSince: payload.okSince ?? null,
    };
  }

  /** 永不抛：给 /status 用 */
  async function probe() {
    const startedAt = Date.now();
    try {
      const body = await health();
      return {
        reachable: true,
        latencyMs: Date.now() - startedAt,
        items: Number(body?.items) || 0,
        open: Number(body?.open) || 0,
        pending: Number(body?.pending) || 0,
        lastTickAt: body?.lastTickAt ?? null,
        lastSyncAt: body?.lastSyncAt ?? null,
      };
    } catch (error) {
      return {
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: { kind: error.kind ?? 'unknown', status: error.status ?? null, message: error.message },
      };
    }
  }

  return { baseUrl: base, listItems, setStatus, health, chat, checkSession, probe };
}
