/**
 * 对话用的 LLM 客户端（OpenAI 兼容 chat/completions）。
 *
 * 为什么独立于 DSH：这个服务跑在 ubuntu 的容器里，拿不到 Windows 上 DSH 的登录态；
 * 所以直接用 provider 的 HTTP API。默认 DeepSeek 官方（便宜、够用）。
 *
 * 预算纪律（本项目的硬约定：花钱的能力必须显式且可算）：
 *   · max_tokens 默认 600 —— 回复是发到手机的，长了没人看
 *   · 只保留最近 N 轮历史，且总字符数有上限（见 prompt.js）
 *   · 失败不重试多次（避免一次抖动烧掉配额），把错误原样抛给上层
 */

/** 默认端点与模型（可用配置覆盖） */
export const DEFAULT_CHAT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_CHAT_MODEL = 'deepseek-flash';

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} options.messages
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok:true, reply:string, usage:object|null, model:string}>}
 */
export async function chatCompletion({
  apiKey,
  messages,
  baseUrl = DEFAULT_CHAT_BASE_URL,
  model = DEFAULT_CHAT_MODEL,
  maxTokens = 600,
  temperature = 0.6,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tools = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('chat: apiKey is required');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chat: messages must be a non-empty array');
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = { model, messages, max_tokens: maxTokens, temperature, stream: false };
    // 只有传了工具才带 tools（避免某些兼容端点对空数组报错）
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* 保留原文用于报错 */
    }

    if (!response.ok) {
      const detail = body?.error?.message ?? body?.message ?? raw.slice(0, 200);
      throw new Error(`chat: HTTP ${response.status} ${detail}`.trim());
    }

    const message = body?.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;

    // 模型要调工具：把原始 assistant 消息带回去（OpenAI 协议要求原样回传）
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return {
        ok: true,
        reply: null,
        toolCalls,
        assistantMessage: message,
        usage: body.usage ?? null,
        model: body.model ?? model,
      };
    }

    const reply = message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      throw new Error('chat: 模型返回为空');
    }

    return {
      ok: true,
      reply: reply.trim(),
      toolCalls: null,
      assistantMessage: message ?? null,
      usage: body.usage ?? null,
      model: body.model ?? model,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`chat: 超时 ${timeoutMs}ms`);
    // 不要把 apiKey 带进错误信息
    throw new Error(String(error?.message ?? error).split(apiKey).join('***'));
  } finally {
    clearTimeout(timer);
  }
}
