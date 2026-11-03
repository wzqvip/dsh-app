import test from 'node:test';
import assert from 'node:assert/strict';

import { sendViaGateway } from '../src/notify/tg-gateway.js';

const okFetch = (capture) => async (url, init) => {
  capture.url = url;
  capture.init = init;
  capture.body = JSON.parse(init.body);
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, messageId: 77 }) };
};

test('sendViaGateway: 打到 /notify 且带 token 与 format', async () => {
  const captured = {};
  const result = await sendViaGateway({
    baseUrl: 'http://dsh-tg:8788',
    token: 'secret-token',
    text: 'hello',
    fetchImpl: okFetch(captured),
  });

  assert.deepEqual(result, { ok: true, messageId: 77 });
  assert.equal(captured.url, 'http://dsh-tg:8788/notify');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-dsh-token'], 'secret-token');
  assert.deepEqual(captured.body, { text: 'hello', format: 'plain' });
});

test('sendViaGateway: baseUrl 尾斜杠归一', async () => {
  const captured = {};
  await sendViaGateway({
    baseUrl: 'http://dsh-tg:8788///',
    text: 'x',
    fetchImpl: okFetch(captured),
  });
  assert.equal(captured.url, 'http://dsh-tg:8788/notify');
});

test('sendViaGateway: 无 token 时不带该头（本地调试）', async () => {
  const captured = {};
  await sendViaGateway({ baseUrl: 'http://x', text: 'x', fetchImpl: okFetch(captured) });
  assert.equal(captured.init.headers['x-dsh-token'], undefined);
});

test('sendViaGateway: 401 报错并带上游信息', async () => {
  const unauthorized = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }),
  });
  await assert.rejects(
    () => sendViaGateway({ baseUrl: 'http://x', text: 'x', fetchImpl: unauthorized }),
    /HTTP 401 bad token/,
  );
});

test('sendViaGateway: 200 但 ok!==true 也算失败', async () => {
  const weird = async () => ({ ok: true, status: 200, text: async () => '{"ok":false}' });
  await assert.rejects(
    () => sendViaGateway({ baseUrl: 'http://x', text: 'x', fetchImpl: weird }),
    /unexpected response/,
  );
});

test('sendViaGateway: 超时给出明确错误（兜底逻辑要能识别）', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  await assert.rejects(
    () => sendViaGateway({ baseUrl: 'http://x', text: 'x', fetchImpl: hanging, timeoutMs: 10 }),
    /timed out after 10ms/,
  );
});

test('sendViaGateway: 参数校验（不发请求）', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  await assert.rejects(() => sendViaGateway({ text: 'x', fetchImpl: spy }), /baseUrl is required/);
  await assert.rejects(() => sendViaGateway({ baseUrl: 'http://x', text: '  ', fetchImpl: spy }), /text is required/);
  await assert.rejects(
    () => sendViaGateway({ baseUrl: 'http://x', text: 'x', format: 'html', fetchImpl: spy }),
    /format must be/,
  );
  assert.equal(called, false);
});
