import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, loadSharedToken, loadTelegramCredentials } from '../src/config.js';

const FAKE_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const SHARED = 'shared-secret-0123456789abcdef';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCredentials(dir, payload) {
  const file = join(dir, 'telegram.json');
  writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  return file;
}

test('loadTelegramCredentials: 从文件读 token/chatId，忽略多余字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-config-'));
  try {
    const file = writeCredentials(dir, {
      savedAt: '2026-11-03T00:00:00.000Z',
      username: 'somebot',
      chatId: 6413978793,
      token: FAKE_TOKEN,
    });
    const credentials = loadTelegramCredentials({ env: { TELEGRAM_CONFIG: file }, readFile: undefined });
    assert.deepEqual(credentials, { token: FAKE_TOKEN, chatId: '6413978793', source: file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTelegramCredentials: env 优先于文件', () => {
  const credentials = loadTelegramCredentials({
    env: { TELEGRAM_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: '42', TELEGRAM_CONFIG: '/nope.json' },
  });
  assert.deepEqual(credentials, { token: FAKE_TOKEN, chatId: '42', source: 'env' });
});

test('loadTelegramCredentials: 缺文件/坏 JSON/token 形状错，都给出不含 token 的明确原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-config-'));
  try {
    assert.throws(
      () => loadTelegramCredentials({ env: { TELEGRAM_CONFIG: join(dir, 'missing.json') } }),
      /找不到凭据文件/,
    );

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{not json');
    assert.throws(() => loadTelegramCredentials({ env: { TELEGRAM_CONFIG: broken } }), /不是合法 JSON/);

    const wrong = writeCredentials(dir, { chatId: '1', token: 'bad-token-shape' });
    assert.throws(() => loadTelegramCredentials({ env: { TELEGRAM_CONFIG: wrong } }), (error) => {
      assert.match(error.message, /token 形状不对/);
      assert.ok(!error.message.includes('bad-token-shape'));
      return true;
    });

    const noChat = writeCredentials(dir, { token: FAKE_TOKEN });
    assert.throws(() => loadTelegramCredentials({ env: { TELEGRAM_CONFIG: noChat } }), /缺少 chatId/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSharedToken: 文件 / env，trim 后返回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-config-'));
  try {
    const file = join(dir, 'api-token.txt');
    writeFileSync(file, `${SHARED}\n`, 'utf8');
    assert.equal(loadSharedToken({ env: { SHARED_TOKEN_FILE: file } }), SHARED);
    assert.equal(loadSharedToken({ env: { SHARED_TOKEN: ` ${SHARED} `, SHARED_TOKEN_FILE: '/nope' } }), SHARED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSharedToken: 缺失/过短时报错（不打印密钥内容）', () => {
  assert.throws(() => loadSharedToken({ env: { SHARED_TOKEN_FILE: '/definitely/missing' } }), /共享密钥缺失/);
  assert.throws(() => loadSharedToken({ env: { SHARED_TOKEN: 'short' } }), (error) => {
    assert.match(error.message, /共享密钥过短/);
    assert.ok(!error.message.includes('short'));
    return true;
  });
});

test('loadConfig: 组装完整配置，assistant token 默认复用共享密钥', (t) => {
  const dir = tempDir(t);
  const telegramFile = writeCredentials(dir, { chatId: 7, token: FAKE_TOKEN });
  const tokenFile = join(dir, 'api-token.txt');
  writeFileSync(tokenFile, SHARED, 'utf8');

  const config = loadConfig({
    env: {
      TELEGRAM_CONFIG: telegramFile,
      SHARED_TOKEN_FILE: tokenFile,
      ASSISTANT_BASE_URL: 'http://dsh-assistant:8787/',
      PORT: '8788',
      TG_TIMEZONE: 'Asia/Shanghai',
      POLL_TIMEOUT_SEC: '10',
      HEARTBEAT_STALE_MS: '60000',
      LOG_LEVEL: 'debug',
    },
  });

  assert.equal(config.port, 8788);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.telegram.token, FAKE_TOKEN);
  assert.equal(config.telegram.chatId, '7');
  assert.equal(config.sharedToken, SHARED);
  assert.equal(config.assistant.baseUrl, 'http://dsh-assistant:8787');
  assert.equal(config.assistant.token, SHARED);
  assert.equal(config.assistant.chatTimeoutMs, 600_000);
  assert.equal(config.chatProgressDelayMs, 3000);
  assert.equal(config.poller.pollTimeoutSec, 10);
  assert.equal(config.poller.heartbeatStaleMs, 60_000);
});

test('loadConfig: CHAT_TIMEOUT_MS 可覆盖（上限 900s），非法值直接失败', (t) => {
  const dir = tempDir(t);
  const telegramFile = writeCredentials(dir, { chatId: 7, token: FAKE_TOKEN });
  const tokenFile = join(dir, 'api-token.txt');
  writeFileSync(tokenFile, SHARED, 'utf8');
  const base = { TELEGRAM_CONFIG: telegramFile, SHARED_TOKEN_FILE: tokenFile };

  assert.equal(loadConfig({ env: { ...base, CHAT_TIMEOUT_MS: '900000' } }).assistant.chatTimeoutMs, 900_000);
  assert.throws(() => loadConfig({ env: { ...base, CHAT_TIMEOUT_MS: '1000' } }), /CHAT_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ env: { ...base, CHAT_TIMEOUT_MS: '900001' } }), /CHAT_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ env: { ...base, CHAT_TIMEOUT_MS: 'abc' } }), /CHAT_TIMEOUT_MS/);
});

test('loadConfig: CHAT_PROGRESS_DELAY_MS（0 = 关闭进度提示）', (t) => {
  const dir = tempDir(t);
  const telegramFile = writeCredentials(dir, { chatId: 7, token: FAKE_TOKEN });
  const tokenFile = join(dir, 'api-token.txt');
  writeFileSync(tokenFile, SHARED, 'utf8');
  const base = { TELEGRAM_CONFIG: telegramFile, SHARED_TOKEN_FILE: tokenFile };

  assert.equal(loadConfig({ env: { ...base, CHAT_PROGRESS_DELAY_MS: '0' } }).chatProgressDelayMs, 0);
  assert.equal(loadConfig({ env: { ...base, CHAT_PROGRESS_DELAY_MS: '5000' } }).chatProgressDelayMs, 5000);
  assert.throws(() => loadConfig({ env: { ...base, CHAT_PROGRESS_DELAY_MS: '-1' } }), /CHAT_PROGRESS_DELAY_MS/);
});

test('loadConfig: TZ 作为时区回退', (t) => {
  const dir = tempDir(t);
  const telegramFile = writeCredentials(dir, { chatId: 7, token: FAKE_TOKEN });
  const tokenFile = join(dir, 'api-token.txt');
  writeFileSync(tokenFile, SHARED, 'utf8');
  const config = loadConfig({
    env: { TELEGRAM_CONFIG: telegramFile, SHARED_TOKEN_FILE: tokenFile, TZ: 'America/New_York' },
  });
  assert.equal(config.timeZone, 'America/New_York');
});

test('loadConfig: 非法 PORT / 非法 base URL 直接失败', (t) => {
  const dir = tempDir(t);
  const telegramFile = writeCredentials(dir, { chatId: 7, token: FAKE_TOKEN });
  const tokenFile = join(dir, 'api-token.txt');
  writeFileSync(tokenFile, SHARED, 'utf8');
  const base = { TELEGRAM_CONFIG: telegramFile, SHARED_TOKEN_FILE: tokenFile };

  assert.throws(() => loadConfig({ env: { ...base, PORT: '99999' } }), /PORT/);
  assert.throws(() => loadConfig({ env: { ...base, PORT: 'abc' } }), /PORT/);
  assert.throws(() => loadConfig({ env: { ...base, ASSISTANT_BASE_URL: 'ftp://x' } }), /http\/https/);
  assert.throws(() => loadConfig({ env: { ...base, LOG_LEVEL: 'verbose' } }), /LOG_LEVEL/);
});
