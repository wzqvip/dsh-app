import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEGRAM_API_BASE,
  TelegramApiError,
  createTelegramClient,
  isValidToken,
  maskToken,
} from '../src/telegram.js';

/** 形状合法但完全虚构的 token，避免把真凭据写进测试 */
const FAKE_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

function okFetch(capture, result = { message_id: 42, chat: { id: 6413978793 } }) {
  return async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    capture.headers = init.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
}

function failingFetch(status, payload, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.body = init.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    };
  };
}

test('maskToken: 只留首尾，绝不完整回显', () => {
  const masked = maskToken(FAKE_TOKEN);
  assert.ok(!masked.includes(FAKE_TOKEN));
  assert.match(masked, /^123456…/);
  assert.equal(maskToken('short'), '***');
  assert.equal(maskToken(undefined), '***');
});

test('isValidToken: 只接受 <数字>:<30+ 字符>', () => {
  assert.equal(isValidToken(FAKE_TOKEN), true);
  assert.equal(isValidToken('bad'), false);
  assert.equal(isValidToken('123:short'), false);
  assert.equal(isValidToken(undefined), false);
});

test('createTelegramClient: token 形状不对时构造即失败（不回显 token）', () => {
  assert.throws(() => createTelegramClient({ token: 'nope' }), (error) => {
    assert.match(error.message, /token 形状/);
    assert.ok(!error.message.includes('nope'));
    return true;
  });
});

test('sendMessage: 打到正确端点并带 chat_id/text/disable_web_page_preview', async () => {
  const captured = {};
  const client = createTelegramClient({ token: FAKE_TOKEN, fetchImpl: okFetch(captured) });

  const result = await client.sendMessage({ text: 'hello', chatId: '6413978793' });

  assert.deepEqual(result, { ok: true, messageId: 42, chatId: 6413978793 });
  assert.equal(captured.url, `${TELEGRAM_API_BASE}/bot${FAKE_TOKEN}/sendMessage`);
  assert.deepEqual(captured.body, {
    chat_id: '6413978793',
    text: 'hello',
    disable_web_page_preview: true,
  });
  assert.equal(captured.headers['content-type'], 'application/json');
});

test('sendMessage: 默认使用构造时的 chatId', async () => {
  const captured = {};
  const client = createTelegramClient({ token: FAKE_TOKEN, chatId: 7, fetchImpl: okFetch(captured) });
  await client.sendMessage({ text: 'hi' });
  assert.equal(captured.body.chat_id, 7);
});

test('sendMessage: format=markdown → parse_mode=Markdown；markdownv2 → MarkdownV2', async () => {
  const captured = {};
  const client = createTelegramClient({ token: FAKE_TOKEN, chatId: 1, fetchImpl: okFetch(captured) });
  await client.sendMessage({ text: '*x*', format: 'markdown' });
  assert.equal(captured.body.parse_mode, 'Markdown');
  await client.sendMessage({ text: '*x*', format: 'markdownv2' });
  assert.equal(captured.body.parse_mode, 'MarkdownV2');
  await client.sendMessage({ text: 'x', format: 'plain' });
  assert.equal('parse_mode' in captured.body, false);
});

test('sendMessage: 参数校验在本地完成，不发请求', async () => {
  let called = 0;
  const spy = async () => {
    called += 1;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const client = createTelegramClient({ token: FAKE_TOKEN, chatId: 1, fetchImpl: spy });

  await assert.rejects(() => client.sendMessage({ text: '  ' }), /text 必填/);
  await assert.rejects(() => client.sendMessage({ text: 'x'.repeat(4097) }), /过长/);
  await assert.rejects(() => client.sendMessage({ text: 'x', format: 'html' }), /不支持的 format/);
  await assert.rejects(() => client.sendMessage({ text: 'x', chatId: '' }), /chatId 必填/);
  assert.equal(called, 0);
});

test('sendMessage: 错误信息里不能出现 token，但要带 description 与状态', async () => {
  const client = createTelegramClient({
    token: FAKE_TOKEN,
    chatId: 1,
    fetchImpl: failingFetch(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }),
  });

  await assert.rejects(
    () => client.sendMessage({ text: 'x' }),
    (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.kind, 'api');
      assert.equal(error.status, 403);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /bot was blocked/);
      assert.match(error.description, /bot was blocked/);
      assert.ok(!error.message.includes(FAKE_TOKEN), '错误信息泄露了 token！');
      assert.equal(error.retryAfter, null);
      return true;
    },
  );
});

test('sendMessage: 429 带 retry_after 与结构化字段', async () => {
  const client = createTelegramClient({
    token: FAKE_TOKEN,
    chatId: 1,
    fetchImpl: failingFetch(429, {
      ok: false,
      description: 'Too Many Requests: retry after 30',
      parameters: { retry_after: 30 },
    }),
  });

  await assert.rejects(
    () => client.sendMessage({ text: 'x' }),
    (error) => {
      assert.equal(error.kind, 'rate_limited');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 30);
      assert.match(error.message, /retry_after=30s/);
      return true;
    },
  );
});

test('sendMessage: HTTP 200 但 ok=false 也算失败', async () => {
  const client = createTelegramClient({
    token: FAKE_TOKEN,
    chatId: 1,
    fetchImpl: failingFetch(200, { ok: false, description: 'nope' }),
  });
  await assert.rejects(() => client.sendMessage({ text: 'x' }), /nope/);
});

test('sendMessage: 超时给出明确错误', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const client = createTelegramClient({ token: FAKE_TOKEN, chatId: 1, fetchImpl: hanging, timeoutMs: 10 });
  await assert.rejects(
    () => client.sendMessage({ text: 'x' }),
    (error) => error.kind === 'timeout' && /超时 10ms/.test(error.message),
  );
});

test('sendMessage: 网络错误脱敏后再抛出', async () => {
  const leaky = async () => {
    throw new Error(`connect ECONNREFUSED ${TELEGRAM_API_BASE}/bot${FAKE_TOKEN}/sendMessage`);
  };
  const client = createTelegramClient({ token: FAKE_TOKEN, chatId: 1, fetchImpl: leaky });
  await assert.rejects(
    () => client.sendMessage({ text: 'x' }),
    (error) => {
      assert.equal(error.kind, 'network');
      assert.ok(!error.message.includes(FAKE_TOKEN));
      return true;
    },
  );
});

test('getUpdates: 带上 offset / timeout / allowed_updates，返回数组', async () => {
  const captured = {};
  const client = createTelegramClient({
    token: FAKE_TOKEN,
    fetchImpl: okFetch(captured, [{ update_id: 1, message: {} }]),
  });

  const updates = await client.getUpdates({ offset: 11, timeoutSec: 5 });
  assert.equal(captured.url, `${TELEGRAM_API_BASE}/bot${FAKE_TOKEN}/getUpdates`);
  assert.deepEqual(captured.body, { timeout: 5, offset: 11, allowed_updates: ['message'] });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update_id, 1);
});

test('getUpdates: offset 缺失时不下发该字段；result 非数组时返回空数组', async () => {
  const captured = {};
  const client = createTelegramClient({
    token: FAKE_TOKEN,
    fetchImpl: okFetch(captured, undefined),
  });
  const updates = await client.getUpdates({ offset: undefined, timeoutSec: 1 });
  assert.equal('offset' in captured.body, false);
  assert.deepEqual(updates, []);
});

test('getUpdates: 外部 abort（停机）→ code=aborted，不被当网络故障', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const client = createTelegramClient({ token: FAKE_TOKEN, fetchImpl: hanging });
  const controller = new AbortController();
  const pending = client.getUpdates({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted' && error.kind === 'aborted');
});
