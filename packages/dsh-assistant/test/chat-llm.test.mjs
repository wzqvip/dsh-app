import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CHAT_MODEL, chatCompletion } from '../src/chat/llm.js';

const okFetch = (capture, reply = '收到，明天 23:59 有 OPCA 截止。') => async (url, init) => {
  capture.url = url;
  capture.init = init;
  capture.body = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        model: 'deepseek-chat',
        choices: [{ message: { content: reply } }],
        usage: { total_tokens: 123 },
      }),
  };
};

test('chatCompletion: 打到 /chat/completions 并带 Bearer', async () => {
  const captured = {};
  const result = await chatCompletion({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: okFetch(captured),
  });

  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.authorization, 'Bearer sk-test');
  assert.equal(captured.body.model, DEFAULT_CHAT_MODEL);
  assert.equal(captured.body.stream, false);
  assert.equal(result.reply, '收到，明天 23:59 有 OPCA 截止。');
  assert.equal(result.usage.total_tokens, 123);
});

test('chatCompletion: max_tokens 默认 600（手机消息，长回复没人看）', async () => {
  const captured = {};
  await chatCompletion({
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: okFetch(captured),
  });
  assert.equal(captured.body.max_tokens, 600);
});

test('chatCompletion: 非 200 带上游错误信息', async () => {
  const failing = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }),
  });
  await assert.rejects(
    () => chatCompletion({ apiKey: 'sk-test', messages: [{ role: 'user', content: 'x' }], fetchImpl: failing }),
    /HTTP 401 Invalid API key/,
  );
});

test('chatCompletion: 空回复算失败（不能给用户推空消息）', async () => {
  const empty = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
  });
  await assert.rejects(
    () => chatCompletion({ apiKey: 'sk-test', messages: [{ role: 'user', content: 'x' }], fetchImpl: empty }),
    /模型返回为空/,
  );
});

test('chatCompletion: 错误信息里不能出现 apiKey', async () => {
  const key = 'sk-very-secret-key-1234567890';
  const leaking = async () => {
    throw new Error(`connect failed for Bearer ${key}`);
  };
  await assert.rejects(
    () => chatCompletion({ apiKey: key, messages: [{ role: 'user', content: 'x' }], fetchImpl: leaking }),
    (error) => {
      assert.ok(!error.message.includes(key), '错误信息泄露了 apiKey');
      return true;
    },
  );
});

test('chatCompletion: 超时明确报错', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  await assert.rejects(
    () =>
      chatCompletion({
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'x' }],
        fetchImpl: hanging,
        timeoutMs: 10,
      }),
    /超时 10ms/,
  );
});

test('chatCompletion: 参数校验', async () => {
  await assert.rejects(() => chatCompletion({ messages: [] }), /apiKey is required/);
  await assert.rejects(() => chatCompletion({ apiKey: 'sk' }), /messages must be a non-empty array/);
});
