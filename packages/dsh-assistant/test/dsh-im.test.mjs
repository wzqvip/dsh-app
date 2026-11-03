import test from 'node:test';
import assert from 'node:assert/strict';

import { createDshImNotifier, sendDelivery, DSH_IM_DELIVERY_PATH } from '../src/notify/dsh-im.js';

const okFetch = (capture) => async (url, init) => {
  capture.url = url;
  capture.init = init;
  capture.body = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ sent: true }),
  };
};

test('sendDelivery: 打到固定路径并带齐字段', async () => {
  const captured = {};
  const result = await sendDelivery({
    botId: 'telegram_abc',
    targetId: 'assistant-ddl',
    text: '新截止',
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: okFetch(captured),
  });

  assert.deepEqual(result, { sent: true, status: 200 });
  assert.equal(captured.url, `http://127.0.0.1:3080${DSH_IM_DELIVERY_PATH}`);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  assert.deepEqual(captured.body, {
    botId: 'telegram_abc',
    targetId: 'assistant-ddl',
    text: '新截止',
    format: 'plain',
  });
});

test('sendDelivery: baseUrl 尾斜杠归一', async () => {
  const captured = {};
  await sendDelivery({
    botId: 'b',
    targetId: 't',
    text: 'x',
    baseUrl: 'http://127.0.0.1:3080///',
    fetchImpl: okFetch(captured),
  });
  assert.equal(captured.url, `http://127.0.0.1:3080${DSH_IM_DELIVERY_PATH}`);
});

test('sendDelivery: 支持 markdown', async () => {
  const captured = {};
  await sendDelivery({
    botId: 'b',
    targetId: 't',
    text: '**粗体**',
    format: 'markdown',
    fetchImpl: okFetch(captured),
  });
  assert.equal(captured.body.format, 'markdown');
});

test('sendDelivery: 缺参数明确报错（不发出请求）', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => '{"sent":true}' };
  };
  await assert.rejects(() => sendDelivery({ targetId: 't', text: 'x', fetchImpl: spy }), /botId is required/);
  await assert.rejects(() => sendDelivery({ botId: 'b', text: 'x', fetchImpl: spy }), /targetId is required/);
  await assert.rejects(() => sendDelivery({ botId: 'b', targetId: 't', text: '  ', fetchImpl: spy }), /text is required/);
  assert.equal(called, false, '参数校验失败时不该发请求');
});

test('sendDelivery: format 只允许 plain/markdown', async () => {
  await assert.rejects(
    () => sendDelivery({ botId: 'b', targetId: 't', text: 'x', format: 'html', fetchImpl: okFetch({}) }),
    /format must be/,
  );
});

test('sendDelivery: 非 2xx 带上状态码与上游错误信息', async () => {
  const failing = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { code: 'bad-request', message: 'Invalid delivery request.' } }),
  });
  await assert.rejects(
    () => sendDelivery({ botId: 'b', targetId: 't', text: 'x', fetchImpl: failing }),
    /HTTP 400 Invalid delivery request\./,
  );
});

test('sendDelivery: 200 但没有 sent:true 也算失败', async () => {
  const weird = async () => ({ ok: true, status: 200, text: async () => '{"sent":false}' });
  await assert.rejects(
    () => sendDelivery({ botId: 'b', targetId: 't', text: 'x', fetchImpl: weird }),
    /unexpected response/,
  );
});

test('sendDelivery: 超时给出明确错误', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  await assert.rejects(
    () => sendDelivery({ botId: 'b', targetId: 't', text: 'x', fetchImpl: hanging, timeoutMs: 10 }),
    /timed out after 10ms/,
  );
});

test('createDshImNotifier: 返回 notify(text) 形状', async () => {
  const captured = {};
  const notify = createDshImNotifier({
    botId: 'b',
    targetId: 't',
    fetchImpl: okFetch(captured),
  });
  await notify('hello');
  assert.equal(captured.body.text, 'hello');
});
