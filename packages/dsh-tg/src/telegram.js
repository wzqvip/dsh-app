/**
 * Telegram Bot API 客户端（本服务是**唯一**与 Telegram 通信的组件）。
 *
 * 安全约定（本文件的核心职责之一）：
 *   · token 是凭据：不打印、不写进错误信息、不出现在任何返回体里
 *   · 所有错误信息都过 `redact()`，把 URL / message 里可能出现的 token 换成掩码
 *   · 日志里只出现 `maskToken()` 的结果
 *
 * 为什么不 import `packages/dsh-assistant/src/notify/telegram.js`：
 *   两个包刻意解耦 —— Telegram 链路由本服务独立维护，改这里不需要动 assistant。
 *   `sendMessage` 的核心逻辑是从那里**复制**的（见 docs/TELEGRAM-GATEWAY.md）。
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** 合法 bot token 形状：<digits>:<30+ 字符> */
export const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** format 的合法取值 → Bot API 的 parse_mode（null 表示不带 parse_mode） */
export const FORMATS = Object.freeze({
  plain: null,
  markdown: 'Markdown',
  markdownv2: 'MarkdownV2',
});

/** 一条消息的硬上限（Bot API 限制） */
export const MAX_TEXT_LENGTH = 4096;

/** 只留前 6 位与后 4 位；日志用 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length < 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/** 把字符串里出现的 token 全部换成掩码 */
export function redact(text, token) {
  const value = String(text ?? '');
  if (typeof token !== 'string' || token.length < 8) return value;
  return value.split(token).join(maskToken(token));
}

/**
 * 结构化的 Telegram 错误。
 * `retryAfter` 来自 429 的 `parameters.retry_after`（秒），上层据此决定等多久。
 */
export class TelegramApiError extends Error {
  constructor(message, { kind = 'unknown', method = null, status = null, description = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.kind = kind;
    this.method = method;
    this.status = status;
    this.description = description;
    this.retryAfter = Number.isFinite(retryAfter) ? retryAfter : null;
  }
}

/** 主动中断（停机）导致的错误：poller 不应把它当故障记录 */
export class TelegramAbortError extends Error {
  constructor(method = null) {
    super(`telegram ${method ?? ''}: 已中断`.replace(/\s+/g, ' ').trim());
    this.name = 'TelegramAbortError';
    this.kind = 'aborted';
    this.code = 'aborted';
  }
}

/**
 * @param {object} options
 * @param {string} options.token bot token
 * @param {string|number} [options.chatId] 默认 chat（/notify 与回复共用）
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs] 单次请求（非长轮询）超时
 * @param {string} [options.apiBase]
 */
export function createTelegramClient({
  token,
  chatId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  apiBase = TELEGRAM_API_BASE,
} = {}) {
  if (!isValidToken(token)) {
    // 绝不回显 token 本身，只描述形状
    throw new Error('telegram: token 形状不对（应为 <数字>:<30+ 字符>）');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('telegram: 缺少 fetch 实现');
  }

  /**
   * 调任意 Bot API 方法。
   * @param {string} method
   * @param {object} payload
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async function call(method, payload, { timeoutMs: requestTimeout = timeoutMs, signal } = {}) {
    const url = `${apiBase}/bot${token}/${method}`;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), requestTimeout);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        /* 保留原文片段用于报错 */
      }

      if (!response.ok || parsed?.ok !== true) {
        const description = String(parsed?.description ?? raw.slice(0, 200) ?? '').trim();
        const retryAfter = Number(parsed?.parameters?.retry_after);
        const hint = Number.isFinite(retryAfter) ? `（retry_after=${retryAfter}s）` : '';
        throw new TelegramApiError(
          redact(`telegram ${method}: HTTP ${response.status} ${description}${hint}`, token),
          {
            kind: response.status === 429 ? 'rate_limited' : 'api',
            method,
            status: response.status,
            description: redact(description, token),
            retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
          },
        );
      }

      return parsed.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (signal?.aborted) throw new TelegramAbortError(method);
      if (error?.name === 'AbortError') {
        throw new TelegramApiError(`telegram ${method}: 超时 ${requestTimeout}ms`, {
          kind: 'timeout',
          method,
        });
      }
      // 兜底：网络层异常也可能把 URL（含 token）写进 message
      throw new TelegramApiError(redact(`telegram ${method}: ${error?.message ?? error}`, token), {
        kind: 'network',
        method,
      });
    } finally {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  return {
    /** 便于日志与 /health 用的掩码 */
    maskedToken: maskToken(token),
    defaultChatId: chatId,

    /**
     * 发一条消息。
     * @param {object} options
     * @param {string} options.text
     * @param {'plain'|'markdown'|'markdownv2'} [options.format]
     * @param {string|number} [options.chatId]
     * @param {boolean} [options.disablePreview]
     * @returns {Promise<{ok:true, messageId:number, chatId:string|number}>}
     */
    async sendMessage({ text, format = 'plain', chatId: targetChatId = chatId, disablePreview = true } = {}) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new TelegramApiError('telegram sendMessage: text 必填', {
          kind: 'validation',
          method: 'sendMessage',
        });
      }
      if (text.length > MAX_TEXT_LENGTH) {
        throw new TelegramApiError(`telegram sendMessage: text 过长（${text.length} > ${MAX_TEXT_LENGTH} 字符）`, {
          kind: 'validation',
          method: 'sendMessage',
        });
      }
      if (targetChatId === undefined || targetChatId === null || String(targetChatId).trim() === '') {
        throw new TelegramApiError('telegram sendMessage: chatId 必填', {
          kind: 'validation',
          method: 'sendMessage',
        });
      }
      if (!Object.prototype.hasOwnProperty.call(FORMATS, format)) {
        throw new TelegramApiError(
          `telegram sendMessage: 不支持的 format "${format}"（只支持 ${Object.keys(FORMATS).join('|')}）`,
          { kind: 'validation', method: 'sendMessage' },
        );
      }

      const parseMode = FORMATS[format];
      const result = await call('sendMessage', {
        chat_id: targetChatId,
        text,
        disable_web_page_preview: disablePreview,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return {
        ok: true,
        messageId: Number(result?.message_id),
        chatId: result?.chat?.id ?? targetChatId,
      };
    },

    /**
     * 长轮询取更新。HTTP 超时必须比长轮询 timeout 更大，否则每轮都自己超时。
     * @param {object} options
     * @param {number} [options.offset]
     * @param {number} [options.timeoutSec]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<object[]>}
     */
    async getUpdates({ offset, timeoutSec = 30, signal } = {}) {
      const payload = { timeout: timeoutSec };
      if (Number.isFinite(offset)) payload.offset = offset;
      payload.allowed_updates = ['message'];
      const result = await call('getUpdates', payload, {
        // 多留 15s 给网络抖动与 Bot API 的排队
        timeoutMs: Math.max(timeoutMs, timeoutSec * 1000 + 15_000),
        signal,
      });
      return Array.isArray(result) ? result : [];
    },

    /** 校验 token（启动时可选调用；失败不阻塞启动） */
    async getMe() {
      return call('getMe', {});
    },
  };
}
