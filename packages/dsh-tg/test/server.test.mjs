import test from 'node:test';
import assert from 'node:assert/strict';

import { silentLogger } from '../src/log.js';
import { createHttpServer } from '../src/server.js';
import { createStateStore } from '../src/state.js';
import { TelegramApiError, maskToken } from '../src/telegram.js';

const FAKE_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const SHARED = 'shared-secret-0123456789abcdef';
const CHAT = '6413978793';

function testConfig(overrides = {}) {
  return {
    telegram: { token: FAKE_TOKEN, chatId: CHAT },
    sharedToken: SHARED,
    assistant: { baseUrl: 'http://dsh-assistant:8787' },
    poller: { pollTimeoutSec: 30, heartbeatStaleMs: 300_000 },
    ...overrides,
  };
}

function fakeTelegram({ error = null } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(message) {
      if (error) throw error;
      sent.push(message);
      return { ok: true, messageId: 99, chatId: message.chatId ?? CHAT };
    },
  };
}

const RUNTIME = {
  running: true,
  startedAt: '2026-11-03T10:00:00.000Z',
  lastPollOkAt: '2026-11-03T11:59:00.000Z',
  lastUpdateAt: '2026-11-03T11:30:00.000Z',
  consecutiveFailures: 0,
  offset: 5,
  stale: false,
  lastError: null,
};

async function startServer(t, { telegram = fakeTelegram(), state, runtime = () => RUNTIME, config = testConfig() } = {}) {
  const store = state ?? createStateStore({ file: null });
  if (store.offset === null) store.setOffset(RUNTIME.offset);
  const server = createHttpServer({
    config,
    telegram,
    state: store,
    runtime,
    logger: silentLogger,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}`, telegram };
}

function notify(base, { token = SHARED, body = { text: 'hello' }, rawBody } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers['x-dsh-token'] = token;
  return fetch(`${base}/notify`, {
    method: 'POST',
    headers,
    body: rawBody ?? JSON.stringify(body),
  });
}

test('GET /health: 200，暴露轮询健康度，但不泄露 token', async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'dsh-tg');
  assert.equal(body.offset, 5);
  assert.equal(body.lastPollOkAt, RUNTIME.lastPollOkAt);
  assert.equal(body.poller.running, true);
  assert.equal(body.bot.tokenMasked, maskToken(FAKE_TOKEN));
  assert.equal(body.assistant.baseUrl, 'http://dsh-assistant:8787');

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(FAKE_TOKEN), '/health 泄露了 bot token！');
  assert.ok(!serialized.includes(SHARED), '/health 泄露了共享密钥！');
});

test('HEAD /health: 200（探活用）', async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(`${base}/health`, { method: 'HEAD' });
  assert.equal(response.status, 200);
});

test('POST /notify: 缺 token → 401，且不调用 Telegram', async (t) => {
  const { base, telegram } = await startServer(t);
  const response = await notify(base, { token: null });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unauthorized');
  assert.equal(telegram.sent.length, 0);
});

test('POST /notify: 错 token → 401；正确 token → 200 并真实下发', async (t) => {
  const { base, telegram } = await startServer(t);

  const bad = await notify(base, { token: 'wrong-token-value' });
  assert.equal(bad.status, 401);

  const good = await notify(base, { body: { text: 'hello', format: 'markdown' } });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.deepEqual(body, { ok: true, messageId: 99, chatId: CHAT });
  assert.deepEqual(telegram.sent, [{ text: 'hello', format: 'markdown' }]);
});

test('POST /notify: 默认 format=plain', async (t) => {
  const { base, telegram } = await startServer(t);
  await notify(base, { body: { text: 'hi' } });
  assert.deepEqual(telegram.sent, [{ text: 'hi', format: 'plain' }]);
});

test('POST /notify: 请求体校验（空 / 非 JSON / 缺 text / 非法 format / 过长）', async (t) => {
  const { base, telegram } = await startServer(t);

  const empty = await notify(base, { rawBody: '' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'empty_body');

  const badJson = await notify(base, { rawBody: '{not json' });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'invalid_json');

  const noText = await notify(base, { body: { format: 'plain' } });
  assert.equal(noText.status, 400);
  assert.equal((await noText.json()).error.code, 'invalid_body');

  const badFormat = await notify(base, { body: { text: 'x', format: 'html' } });
  assert.equal(badFormat.status, 400);
  const badFormatBody = await badFormat.json();
  assert.equal(badFormatBody.error.code, 'invalid_format');
  assert.match(badFormatBody.error.message, /plain\|markdown\|markdownv2/);

  const tooLong = await notify(base, { body: { text: 'x'.repeat(4097) } });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.code, 'text_too_long');

  assert.equal(telegram.sent.length, 0);
});

test('POST /notify: 超大请求体 → 413（不把内存打爆）', async (t) => {
  const { base, telegram } = await startServer(t);
  const response = await notify(base, { body: { text: 'x'.repeat(70 * 1024) } });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'payload_too_large');
  assert.equal(telegram.sent.length, 0);
});

test('POST /notify: Telegram 429 → 429 + retryAfter 结构化返回', async (t) => {
  const throttle = new TelegramApiError('telegram sendMessage: HTTP 429 Too Many Requests（retry_after=5s）', {
    kind: 'rate_limited',
    method: 'sendMessage',
    status: 429,
    description: 'Too Many Requests: retry after 5',
    retryAfter: 5,
  });
  const { base } = await startServer(t, { telegram: fakeTelegram({ error: throttle }) });

  const response = await notify(base, { body: { text: 'x' } });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, 'rate_limited');
  assert.equal(body.error.retryAfter, 5);
  assert.equal(body.error.telegramStatus, 429);
  assert.match(body.error.description, /retry after 5/);
});

test('POST /notify: Telegram 403 → 502 + description（便于调用方判断 bot 被封）', async (t) => {
  const forbidden = new TelegramApiError('telegram sendMessage: HTTP 403 Forbidden: bot was blocked', {
    kind: 'api',
    method: 'sendMessage',
    status: 403,
    description: 'Forbidden: bot was blocked by the user',
  });
  const { base } = await startServer(t, { telegram: fakeTelegram({ error: forbidden }) });

  const response = await notify(base, { body: { text: 'x' } });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.telegramStatus, 403);
  assert.match(body.error.description, /bot was blocked/);
  assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN));
});

test('路由：未知路径 404、GET /notify 405、POST /health 405', async (t) => {
  const { base } = await startServer(t);

  const notFound = await fetch(`${base}/nope`);
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).error.code, 'not_found');

  const method = await fetch(`${base}/notify`, { method: 'GET' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');

  const healthPost = await fetch(`${base}/health`, { method: 'POST' });
  assert.equal(healthPost.status, 405);
});

test('/health 反映运行时错误（lastError），但不含共享密钥', async (t) => {
  const runtime = () => ({
    ...RUNTIME,
    running: false,
    consecutiveFailures: 3,
    stale: true,
    lastError: {
      kind: 'network',
      status: null,
      message: 'telegram getUpdates: fetch failed',
      retryAfter: null,
      at: '2026-11-03T11:59:30.000Z',
    },
  });
  const { base } = await startServer(t, { runtime });
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.poller.consecutiveFailures, 3);
  assert.equal(body.poller.stale, true);
  assert.match(body.lastError.message, /fetch failed/);
});
