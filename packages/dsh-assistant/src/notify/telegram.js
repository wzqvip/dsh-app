/**
 * Telegram Bot API 直连投递。
 *
 * 为什么除了 dsh-im 还要这个：
 *   dsh-im 的主动投递要求 bot **先在它的设置里注册**（botId + targetId）。
 *   而用户给的是一对新凭据（新 bot + chat id），直连 Bot API 立刻可用，
 *   不必等 UI 配置；dsh-im 那条路保留作备选（多目标广播、渠道抽象时更好）。
 *
 * ⚠️ 安全约定（本文件的核心职责之一）：
 *   · token 是**凭据**：不写进仓库、不打印、不出现在错误信息里
 *   · 所有错误信息都经过 `redact()`，把 URL 里的 token 换成掩码
 *     （否则一次 fetch 异常就能把 token 打进日志）
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** 合法 bot token 形状：<digits>:<35+ 字符> */
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** 掩码：只留前 6 位与后 4 位，用于日志 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length < 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** 把字符串里出现的 token 全部换成掩码 */
function redact(text, token) {
  const value = String(text ?? '');
  if (typeof token !== 'string' || token.length < 8) return value;
  return value.split(token).join(maskToken(token));
}

/**
 * 发一条消息。
 *
 * @param {object} options
 * @param {string} options.token bot token（`123456:ABC…`）
 * @param {string|number} options.chatId 目标 chat id
 * @param {string} options.text 正文（纯文本，最长 4096 字符）
 * @param {'HTML'|'MarkdownV2'|undefined} [options.parseMode]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, messageId:number, chatId:string|number}>}
 */
export async function sendTelegramMessage({
  token,
  chatId,
  text,
  parseMode,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new Error('telegram: token 形状不对（应为 <数字>:<35+ 字符>）');
  }
  if (chatId === undefined || chatId === null || String(chatId).trim() === '') {
    throw new Error('telegram: chatId 必填');
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('telegram: text 必填');
  }
  if (text.length > 4096) {
    // Bot API 硬限制；超了会整条失败，早失败比被上游拒绝更清楚
    throw new Error(`telegram: text 过长（${text.length} > 4096 字符）`);
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* 保留原文 */
    }

    if (!response.ok || parsed?.ok !== true) {
      const description = parsed?.description ?? raw.slice(0, 200) ?? '';
      const retryAfter = parsed?.parameters?.retry_after;
      const hint = retryAfter ? `（retry_after=${retryAfter}s）` : '';
      throw new Error(
        redact(`telegram: HTTP ${response.status} ${description}${hint}`, token),
      );
    }

    return {
      ok: true,
      messageId: Number(parsed.result?.message_id),
      chatId: parsed.result?.chat?.id ?? chatId,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`telegram: 超时 ${timeoutMs}ms`);
    }
    // 兜底：任何异常信息都再过一次脱敏
    throw new Error(redact(error?.message ?? String(error), token));
  } finally {
    clearTimeout(timer);
  }
}

/** 适配 poller/reminder 的 `notify(text)` 形状 */
export function createTelegramNotifier(options) {
  return async function notify(text) {
    return sendTelegramMessage({ ...options, text });
  };
}
