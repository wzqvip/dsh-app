import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEGRAM_API_BASE,
  createTelegramNotifier,
  maskToken,
  sendTelegramMessage,
} from '../src/notify/telegram.js';

/** 形状合法但完全虚构的 token，避免把真凭据写进测试 */
const FAKE_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

const okFetch = (capture) => async (url, init) => {
  capture.url = url;
  capture.body = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 6413978793 } } }),
  };
};

test('maskToken: 只留首尾，绝不完整回显', () => {
  const masked = maskToken(FAKE_TOKEN);
  assert.ok(!masked.includes(FAKE_TOKEN));
  assert.match(masked, /^123456…/);
  assert.equal(maskToken('short'), '***');
});

test('sendTelegramMessage: 打到正确端点并带上 chat_id/text', async () => {
  const captured = {};
  const result = await sendTelegramMessage({
    token: FAKE_TOKEN,
    chatId: '6413978793',
    text: 'hello',
    fetchImpl: okFetch(captured),
  });

  assert.deepEqual(result, { ok: true, messageId: 42, chatId: 6413978793 });
  assert.equal(captured.url, `${TELEGRAM_API_BASE}/bot${FAKE_TOKEN}/sendMessage`);
  assert.deepEqual(captured.body, {
    chat_id: '6413978793',
    text: 'hello',
    disable_web_page_preview: true,
  });
});

test('sendTelegramMessage: 可选 parse_mode', async () => {
  const captured = {};
  await sendTelegramMessage({
    token: FAKE_TOKEN,
    chatId: 1,
    text: '<b>x</b>',
    parseMode: 'HTML',
    fetchImpl: okFetch(captured),
  });
  assert.equal(captured.body.parse_mode, 'HTML');
});

test('sendTelegramMessage: token 形状不对直接拒绝（不发请求）', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await assert.rejects(() => sendTelegramMessage({ token: 'bad', chatId: 1, text: 'x', fetchImpl: spy }), /token 形状/);
  await assert.rejects(() => sendTelegramMessage({ token: FAKE_TOKEN, chatId: '', text: 'x', fetchImpl: spy }), /chatId/);
  await assert.rejects(() => sendTelegramMessage({ token: FAKE_TOKEN, chatId: 1, text: '  ', fetchImpl: spy }), /text/);
  assert.equal(called, false);
});

test('sendTelegramMessage: 超长文本提前失败（Bot API 上限 4096）', async () => {
  await assert.rejects(
    () => sendTelegramMessage({ token: FAKE_TOKEN, chatId: 1, text: 'x'.repeat(4097), fetchImpl: okFetch({}) }),
    /过长/,
  );
});

test('sendTelegramMessage: 错误信息里**不能出现 token**', async () => {
  const failing = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
  });
  await assert.rejects(
    () => sendTelegramMessage({ token: FAKE_TOKEN, chatId: 1, text: 'x', fetchImpl: failing }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /bot was blocked/);
      assert.ok(!error.message.includes(FAKE_TOKEN), '错误信息泄露了 token！');
      return true;
    },
  );
});

test('sendTelegramMessage: 429 带 retry_after 提示', async () => {
  const throttled = async () => ({
    ok: false,
    status: 429,
    text: async () =>
      JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } }),
  });
  await assert.rejects(
    () => sendTelegramMessage({ token: FAKE_TOKEN, chatId: 1, text: 'x', fetchImpl: throttled }),
    /retry_after=30s/,
  );
});

test('sendTelegramMessage: 200 但 ok=false 也算失败', async () => {
  const weird = async () => ({ ok: true, status: 200, text: async () => '{"ok":false,"description":"nope"}' });
  await assert.rejects(
    () => sendTelegramMessage({ token: FAKE_TOKEN, chatId: 1, text: 'x', fetchImpl: weird }),
    /nope/,
  );
});

test('sendTelegramMessage: 超时给出明确错误', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  await assert.rejects(
    () => sendTelegramMessage({ token: FAKE_TOKEN, chatId: 1, text: 'x', fetchImpl: hanging, timeoutMs: 10 }),
    /超时 10ms/,
  );
});

test('createTelegramNotifier: 返回 notify(text) 形状', async () => {
  const captured = {};
  const notify = createTelegramNotifier({ token: FAKE_TOKEN, chatId: 1, fetchImpl: okFetch(captured) });
  await notify('hi');
  assert.equal(captured.body.text, 'hi');
});
