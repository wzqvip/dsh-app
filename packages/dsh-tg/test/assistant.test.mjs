import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantError, createAssistantClient } from '../src/assistant.js';

const TOKEN = 'shared-secret-0123456789abcdef';
const BASE = 'http://dsh-assistant:8787';

function okFetch(capture, payload) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = init?.body ? JSON.parse(init.body) : undefined;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}

test('listItems: 带 x-dsh-token 与 status/limit 查询参数，返回 {items,count}', async () => {
  const captured = {};
  const client = createAssistantClient({
    baseUrl: `${BASE}/`,
    token: TOKEN,
    fetchImpl: okFetch(captured, {
      ok: true,
      count: 2,
      items: [{ id: 'canvas:assignment:1', title: 'A' }, { id: 'canvas:assignment:2', title: 'B' }],
    }),
  });

  const result = await client.listItems({ status: 'open', limit: 5 });

  assert.equal(captured.url, `${BASE}/items?status=open&limit=5`);
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers['x-dsh-token'], TOKEN);
  assert.equal(result.count, 2);
  assert.equal(result.items.length, 2);

  const filtered = {};
  const client2 = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch(filtered, { items: [] }),
  });
  await client2.listItems();
  assert.equal(filtered.url, `${BASE}/items?status=open`);
});

test('listItems: 返回体缺 items 数组时报 invalid_response', async () => {
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch({}, { ok: true }),
  });
  await assert.rejects(() => client.listItems(), (error) => error.kind === 'invalid_response');
});

test('setStatus: POST 到 /items/{id}/status，id 里的冒号保持字面量', async () => {
  const captured = {};
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch(captured, { ok: true, id: 'canvas:assignment:123', status: 'done' }),
  });

  const result = await client.setStatus('canvas:assignment:123', 'done');

  assert.equal(captured.url, `${BASE}/items/canvas:assignment:123/status`);
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(captured.body, { status: 'done' });
  assert.deepEqual(result, { ok: true, id: 'canvas:assignment:123', status: 'done' });
});

test('setStatus: 非法 status 本地拒绝（不发请求）', async () => {
  let called = 0;
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  await assert.rejects(() => client.setStatus('x', 'archived'), /非法 status/);
  assert.equal(called, 0);
});

test('setStatus: 服务端 ok!==true 时报 invalid_response', async () => {
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch({}, { ok: false }),
  });
  await assert.rejects(() => client.setStatus('a:b:1', 'done'), (error) => error.kind === 'invalid_response');
});

test('HTTP 401: 结构化错误，消息里不出现共享密钥', async () => {
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ ok: false, error: { message: 'unauthorized' } }),
    }),
  });

  await assert.rejects(
    () => client.listItems(),
    (error) => {
      assert.ok(error instanceof AssistantError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 401);
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test('不可达 / 超时: kind=unreachable / timeout', async () => {
  const unreachable = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  await assert.rejects(() => unreachable.listItems(), (error) => {
    assert.equal(error.kind, 'unreachable');
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });

  const hanging = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  await assert.rejects(() => hanging.listItems(), (error) => error.kind === 'timeout');
});

test('probe: 可达时返回 open/items，不可达时不抛异常', async () => {
  const reachable = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch({}, { ok: true, items: 400, open: 400, pending: 0, lastTickAt: '2026-11-03T00:00:00.000Z' }),
  });
  const good = await reachable.probe();
  assert.equal(good.reachable, true);
  assert.equal(good.open, 400);
  assert.equal(good.items, 400);

  const unreachable = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const bad = await unreachable.probe();
  assert.equal(bad.reachable, false);
  assert.equal(bad.error.kind, 'unreachable');
});

test('chat: POST /chat 转发文本，返回 reply（无状态）', async () => {
  const captured = {};
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch(captured, {
      ok: true,
      reply: '最急的是明天 23:59 截止的 OPCA 作业。',
      usage: { total_tokens: 12 },
    }),
  });

  const result = await client.chat({ text: '最急的事？' });

  assert.equal(captured.url, `${BASE}/chat`);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-dsh-token'], TOKEN);
  assert.deepEqual(captured.body, { text: '最急的事？' });
  assert.equal(result.reply, '最急的是明天 23:59 截止的 OPCA 作业。');
});

test('chat: 空文本本地拒绝（不发请求）', async () => {
  let called = 0;
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  await assert.rejects(() => client.chat({ text: '   ' }), (error) => error.kind === 'validation');
  assert.equal(called, 0);
});

test('chat: 502/503 的字符串 error 被解析成可读原因，且不泄露 token', async () => {
  const client502 = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ ok: false, error: 'DeepSeek 调用失败' }),
    }),
  });
  await assert.rejects(
    () => client502.chat({ text: '你好' }),
    (error) => {
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 502);
      assert.match(error.message, /DeepSeek 调用失败/);
      assert.match(error.description, /DeepSeek 调用失败/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );

  const client503 = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ ok: false, error: 'chat 未启用（缺 /data/llm.json）' }),
    }),
  });
  await assert.rejects(
    () => client503.chat({ text: '你好' }),
    (error) => error.status === 503 && /chat 未启用/.test(error.description),
  );
});

test('chat: 200 但缺 reply 字段 → invalid_response', async () => {
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch({}, { ok: true }),
  });
  await assert.rejects(() => client.chat({ text: '你好' }), (error) => error.kind === 'invalid_response');
});

test('chat: 用 chatTimeoutMs（默认 600s）而不是普通请求超时，并带上 timeoutMs', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    timeoutMs: 10,
    chatTimeoutMs: 10,
    fetchImpl: hanging,
  });
  await assert.rejects(
    () => client.chat({ text: '写一段长文' }),
    (error) =>
      error.kind === 'timeout' && /超时 10ms/.test(error.message) && error.timeoutMs === 10,
  );
});

test('checkSession: POST /session/check，解析 needsUser/reason/okSince', async () => {
  const captured = {};
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: okFetch(captured, {
      ok: true,
      needsUser: true,
      reason: 'blocked',
      okSince: null,
    }),
  });

  const session = await client.checkSession();

  assert.equal(captured.url, `${BASE}/session/check`);
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(captured.body, {});
  assert.deepEqual(session, { needsUser: true, reason: 'blocked', okSince: null });
});

test('checkSession: 失败返回结构化错误（503）', async () => {
  const client = createAssistantClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ ok: false, error: 'session 检查未启用' }),
    }),
  });
  await assert.rejects(
    () => client.checkSession(),
    (error) => error.status === 503 && /session 检查未启用/.test(error.description),
  );
});
