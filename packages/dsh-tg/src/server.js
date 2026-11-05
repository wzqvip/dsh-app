/**
 * HTTP 入口：
 *   GET  /health  → 存活 + 轮询健康度（**不需要 token**，只暴露掩码后的 bot 标识）
 *   POST /notify  → 出站推送（需要 `x-dsh-token`）
 *
 * 边界：
 *   · 端口/监听地址由 config 决定（容器内 0.0.0.0:8788，只在 dsh-net 内可见）
 *   · 不发布到宿主机 0.0.0.0（否则同网段任何人都能用它发消息/间接改状态）
 *   · 返回体里绝不出现 token 原文；失败时返回结构化的 Telegram 错误
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { FORMATS, MAX_TEXT_LENGTH, TelegramApiError, maskToken } from './telegram.js';
import { silentLogger } from './log.js';
import { toIso } from './util.js';

export const SERVICE_NAME = 'dsh-tg';
export const SERVICE_VERSION = '0.2.1';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** 恒定时间比较；长度不同直接 false（不泄露长度以外的信息） */
function safeEqual(provided, expected) {
  const left = Array.isArray(provided) ? provided[0] : provided;
  if (typeof left !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const fail = (status, code, message) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.status = status;
      error.code = code;
      reject(error);
      // 不 destroy：先把 413 响应写回去，剩余请求体由上面的 settled 判断丢弃
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(413, 'payload_too_large', `请求体超过 ${limit} 字节`);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        const error = new Error('请求体为空（应传 {text, format?}）');
        error.status = 400;
        error.code = 'empty_body';
        reject(error);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const error = new Error('请求体不是合法 JSON');
        error.status = 400;
        error.code = 'invalid_json';
        reject(error);
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const error = new Error('请求体必须是 JSON 对象');
        error.status = 400;
        error.code = 'invalid_body';
        reject(error);
        return;
      }
      resolve(parsed);
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      error.status = 400;
      error.code = 'bad_request';
      reject(error);
    });
  });
}

/**
 * @param {object} options
 * @param {object} options.config loadConfig() 的结果
 * @param {object} options.telegram createTelegramClient() 的结果
 * @param {object} options.state createStateStore() 的结果
 * @param {() => object} [options.runtime] 返回 poller.status
 * @param {object} [options.logger]
 * @param {number} [options.startedAt]
 * @param {() => number} [options.now]
 */
export function createHttpServer({
  config,
  telegram,
  state,
  runtime = () => ({}),
  logger = silentLogger,
  startedAt = Date.now(),
  now = () => Date.now(),
} = {}) {
  if (!config) throw new Error('server: config 必填');
  if (!telegram || typeof telegram.sendMessage !== 'function') {
    throw new Error('server: telegram 客户端必填');
  }
  if (!state) throw new Error('server: state 必填');

  async function handleHealth(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '只接受 GET' } }, { allow: 'GET' });
      return;
    }
    const rt = runtime() ?? {};
    sendJson(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      pid: process.pid,
      startedAt: toIso(startedAt),
      uptimeSec: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      offset: state.offset,
      lastPollOkAt: rt.lastPollOkAt ?? null,
      lastUpdateAt: rt.lastUpdateAt ?? null,
      lastError: rt.lastError ?? null,
      poller: {
        running: Boolean(rt.running),
        busy: Boolean(rt.busy),
        consecutiveFailures: Number(rt.consecutiveFailures) || 0,
        stale: Boolean(rt.stale),
        pollTimeoutSec: rt.pollTimeoutSec ?? config.poller?.pollTimeoutSec ?? null,
        heartbeatStaleMs: rt.heartbeatStaleMs ?? config.poller?.heartbeatStaleMs ?? null,
      },
      chat: {
        timeoutMs: config.assistant?.chatTimeoutMs ?? null,
        progressDelayMs: config.chatProgressDelayMs ?? null,
      },
      bot: {
        tokenMasked: maskToken(config.telegram.token),
        chatId: config.telegram.chatId ?? null,
      },
      assistant: { baseUrl: config.assistant?.baseUrl ?? null },
    });
  }

  async function handleNotify(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '只接受 POST' } }, { allow: 'POST' });
      return;
    }

    // 先鉴权再读 body：未授权的请求不浪费解析、也不泄露校验细节
    if (!safeEqual(req.headers['x-dsh-token'], config.sharedToken)) {
      sendJson(res, 401, {
        ok: false,
        error: { code: 'unauthorized', message: '无效或缺失的 x-dsh-token' },
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status ?? 400, {
        ok: false,
        error: { code: error.code ?? 'bad_request', message: error.message },
      });
      return;
    }

    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim() === '') {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'invalid_body', message: 'text 必填（非空字符串）' },
      });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'text_too_long',
          message: `text 过长（${text.length} > ${MAX_TEXT_LENGTH} 字符）`,
        },
      });
      return;
    }

    const format = body.format === undefined || body.format === null ? 'plain' : String(body.format).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FORMATS, format)) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'invalid_format',
          message: `format 只支持 ${Object.keys(FORMATS).join('|')}（收到 "${body.format}"）`,
        },
      });
      return;
    }

    if (body.meta !== undefined) {
      const metaKind = typeof body.meta === 'object' && body.meta !== null ? Object.keys(body.meta).join(',') : typeof body.meta;
      logger.debug?.(`[server] /notify meta：${metaKind}`);
    }

    try {
      const result = await telegram.sendMessage({ text, format });
      logger.info?.(`[server] /notify 已发送 messageId=${result.messageId} chat=${result.chatId}`);
      sendJson(res, 200, {
        ok: true,
        messageId: result.messageId,
        chatId: result.chatId,
      });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        const status = error.retryAfter ? 429 : error.kind === 'validation' ? 400 : 502;
        logger.error?.(`[server] /notify 失败：${error.message}`);
        sendJson(res, status, {
          ok: false,
          error: {
            kind: error.kind,
            message: error.message,
            description: error.description ?? null,
            retryAfter: error.retryAfter ?? null,
            telegramStatus: error.status ?? null,
          },
        });
        return;
      }
      logger.error?.(`[server] /notify 内部错误：${error?.message ?? error}`);
      sendJson(res, 500, {
        ok: false,
        error: { kind: 'internal', message: '发送失败（内部错误，详见容器日志）' },
      });
    }
  }

  const server = createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        const path = (req.url ?? '/').split('?')[0];
        if (path === '/health') return handleHealth(req, res);
        if (path === '/notify') return handleNotify(req, res);
        sendJson(res, 404, {
          ok: false,
          error: { code: 'not_found', message: `未知路径 ${path}` },
        });
        return undefined;
      })
      .catch((error) => {
        logger.error?.(`[server] 未捕获异常：${error?.stack ?? error?.message ?? error}`);
        if (!res.writableEnded) {
          sendJson(res, 500, { ok: false, error: { code: 'internal', message: '内部错误' } });
        }
      });
  });

  // 长轮询是出站请求，HTTP 侧不该有慢请求：给个兜底超时
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  return server;
}
