/**
 * dsh-im 主动投递适配器。
 *
 * 为什么**不 fork** dsh-im：它已经把我们要的做完了 ——
 *   `POST /api/dsh-im/delivery/messages  { botId, targetId, text, format? }  → { sent: true }`
 * 复用官方接口比自己维护一个 fork 便宜得多；只有将来需要它没有的能力时才考虑 fork。
 *
 * 接口事实（来自包内 `PROACTIVE_DELIVERY.md`，2026-11-02 核对）：
 *   · 路径固定 `POST /api/dsh-im/delivery/messages`，复用 DSH Host 的 WebServer，不另开端口
 *   · 必填 `botId` / `targetId` / `text`；可选 `format`（`plain` | `markdown`，默认 plain）
 *   · JSON 总体积 ≤ 1 MiB
 *   · **无鉴权、无 CORS** —— 只应在本机或可信网络使用
 *   · `targetId` 是调用方自定义的稳定别名（不是平台用户/群 ID），需先在设置里创建
 *
 * 实测：`POST` 空 body 返回 400 `{"error":{"code":"bad-request"}}` —— 说明路由存在且校验生效。
 */

/** DSH Web Host 默认地址 */
export const DSH_IM_DEFAULT_BASE = 'http://127.0.0.1:3080';
/** 投递路径（固定） */
export const DSH_IM_DELIVERY_PATH = '/api/dsh-im/delivery/messages';
/** 请求体上限 1 MiB；留出余量给字段名 */
const MAX_TEXT_BYTES = 900 * 1024;

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-im: ${name} is required`);
  }
}

/**
 * 通过 dsh-im 的 HTTP 接口主动发一条消息。
 *
 * @param {object} options
 * @param {string} options.botId 机器人 id（设置里显示的 `telegram_…` / `feishu_…`）
 * @param {string} options.targetId 投递目标别名（先在 UI 里创建）
 * @param {string} options.text 消息正文
 * @param {string} [options.baseUrl]
 * @param {'plain'|'markdown'} [options.format]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] 注入便于测试
 * @returns {Promise<{sent:true, status:number}>}
 */
export async function sendDelivery({
  botId,
  targetId,
  text,
  baseUrl = DSH_IM_DEFAULT_BASE,
  format = 'plain',
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertNonEmptyString(botId, 'botId');
  assertNonEmptyString(targetId, 'targetId');
  assertNonEmptyString(text, 'text');
  if (format !== 'plain' && format !== 'markdown') {
    throw new Error(`dsh-im: format must be "plain" or "markdown", got ${JSON.stringify(format)}`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error(`dsh-im: text too large (${Buffer.byteLength(text, 'utf8')} bytes > ${MAX_TEXT_BYTES})`);
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}${DSH_IM_DELIVERY_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId, targetId, text, format }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // 保留原文用于报错
    }

    if (!response.ok) {
      const detail = parsed?.error?.message ?? raw.slice(0, 200) ?? '';
      throw new Error(`dsh-im: HTTP ${response.status} ${detail}`.trim());
    }
    if (parsed?.sent !== true) {
      throw new Error(`dsh-im: unexpected response ${raw.slice(0, 200)}`);
    }
    return { sent: true, status: response.status };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`dsh-im: timed out after ${timeoutMs}ms (${url})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 `sendDelivery` 包成 poller/reminder 期望的 `notify(text, meta)` 形状。
 * `meta` 目前不用（留给将来按类型选 format）。
 */
export function createDshImNotifier(options) {
  return async function notify(text) {
    await sendDelivery({ ...options, text });
  };
}
