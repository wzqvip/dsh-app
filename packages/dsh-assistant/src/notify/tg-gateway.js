/**
 * 通过 dsh-tg 网关发消息。
 *
 * 为什么改成"经网关"而不是 daemon 直连 Bot API：
 *   Telegram 链路（发送、retry、限流、掩码、告警）应当**只有一个所有者**。
 *   否则两个服务各自实现一份重试/限流逻辑，行为迟早不一致。
 *   现在：dsh-tg 是唯一会碰 Bot API 的组件；daemon 只是"交投递"。
 *
 * 但**保留直连兜底**：网关重启/异常时，daemon 仍能直接发一条 ——
 * 宁可多一条重复，也不要静默丢提醒（提醒是可重复的，错过 deadline 不可逆）。
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {object} options
 * @param {string} options.baseUrl 例：`http://dsh-tg:8788`
 * @param {string} options.token 共享密钥（x-dsh-token）
 * @param {string} options.text
 * @param {'plain'|'markdown'} [options.format]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, messageId:number|string|null}>}
 */
export async function sendViaGateway({
  baseUrl,
  token,
  text,
  format = 'plain',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('tg-gateway: baseUrl is required');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('tg-gateway: text is required');
  if (format !== 'plain' && format !== 'markdown') {
    throw new Error(`tg-gateway: format must be plain|markdown, got ${JSON.stringify(format)}`);
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/notify`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-dsh-token': token } : {}),
      },
      body: JSON.stringify({ text, format }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* 保留原文 */
    }

    if (!response.ok) {
      const detail = parsed?.error?.message ?? parsed?.error ?? raw.slice(0, 160);
      throw new Error(`tg-gateway: HTTP ${response.status} ${detail}`.trim());
    }
    if (parsed?.ok !== true) {
      throw new Error(`tg-gateway: unexpected response ${raw.slice(0, 160)}`);
    }
    return { ok: true, messageId: parsed.messageId ?? null };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`tg-gateway: timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
