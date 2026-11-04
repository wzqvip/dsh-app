/**
 * 配置装载：凭据只从文件/env 来，形状不对就早失败；错误信息里绝不能出现 token 内容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, loadConfig, loadSharedToken } from '../src/config.js';

const SECRET = 'shared-secret-0123456789';

function env(overrides = {}) {
  return { SHARED_TOKEN: SECRET, ...overrides };
}

/** 假文件读取：只有记录在 files 里的路径存在 */
function fakeFiles(files) {
  return (path) => {
    if (!(path in files)) {
      const error = new Error(`ENOENT: ${path}`);
      error.code = 'ENOENT';
      throw error;
    }
    return files[path];
  };
}

test('token：env SHARED_TOKEN 优先', () => {
  const result = loadSharedToken({
    env: env(),
    readFile: fakeFiles({ '/data/api-token.txt': 'from-file' }),
  });
  assert.equal(result.token, SECRET);
  assert.equal(result.source, 'env SHARED_TOKEN');
});

test('token：没有 env 时读文件，并 trim 换行', () => {
  const result = loadSharedToken({
    env: {},
    readFile: fakeFiles({ '/data/api-token.txt': `${SECRET}\n` }),
  });
  assert.equal(result.token, SECRET);
  assert.equal(result.source, '/data/api-token.txt');
});

test('token：文件缺失 → 报错并指出路径，但不回显任何密钥', () => {
  assert.throws(
    () => loadSharedToken({ env: {}, readFile: fakeFiles({}) }),
    (error) => {
      assert.match(error.message, /共享密钥缺失/);
      assert.match(error.message, /\/data\/api-token\.txt/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    },
  );
});

test('token：空文件 / 过短 → 报错', () => {
  assert.throws(() => loadSharedToken({ env: {}, readFile: fakeFiles({ '/data/api-token.txt': '  \n' }) }), /为空/);
  assert.throws(() => loadSharedToken({ env: { SHARED_TOKEN: 'short' } }), /过短/);
});

test('loadConfig：默认值齐全（端口 8789、CDP 127.0.0.1:9222）', () => {
  const config = loadConfig({ env: env(), readFile: fakeFiles({}) });
  assert.equal(config.port, DEFAULTS.port);
  assert.equal(config.port, 8789);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.cdpUrl, 'http://127.0.0.1:9222');
  assert.equal(config.snapshotMaxChars, 48_000);
  assert.equal(config.publicVncUrl, '');
  assert.equal(config.actionTimeoutMs, 20_000);
  assert.equal(config.maxActionTimeoutMs, 60_000);
});

test('loadConfig：env 覆盖 + URL 去掉尾部斜杠', () => {
  const config = loadConfig({
    env: env({
      HOST: '127.0.0.1',
      PORT: '9999',
      CDP_URL: 'http://127.0.0.1:9333/',
      SNAPSHOT_MAX_CHARS: '2048',
      ACTION_TIMEOUT_MS: '5000',
      PUBLIC_VNC_URL: 'http://192.168.3.30:16080/vnc.html',
    }),
    readFile: fakeFiles({}),
  });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 9999);
  assert.equal(config.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(config.snapshotMaxChars, 2048);
  assert.equal(config.actionTimeoutMs, 5000);
  assert.equal(config.publicVncUrl, 'http://192.168.3.30:16080/vnc.html');
});

test('loadConfig：端口/超时/URL 非法时抛错且信息可读', () => {
  assert.throws(() => loadConfig({ env: env({ PORT: '0' }), readFile: fakeFiles({}) }), /PORT/);
  assert.throws(() => loadConfig({ env: env({ PORT: 'abc' }), readFile: fakeFiles({}) }), /不是合法数字/);
  assert.throws(() => loadConfig({ env: env({ CDP_URL: 'file:///tmp/x' }), readFile: fakeFiles({}) }), /CDP_URL/);
  assert.throws(
    () => loadConfig({ env: env({ ACTION_TIMEOUT_MS: '99999' }), readFile: fakeFiles({}) }),
    /ACTION_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadConfig({ env: env({ SNAPSHOT_MAX_CHARS: '10' }), readFile: fakeFiles({}) }),
    /SNAPSHOT_MAX_CHARS/,
  );
});

test('loadConfig：tokenSource 只报出处，不报内容', () => {
  const config = loadConfig({ env: env(), readFile: fakeFiles({}) });
  assert.equal(config.token, SECRET);
  assert.equal(config.tokenSource, 'env SHARED_TOKEN');
  assert.ok(!JSON.stringify({ ...config, token: '' }).includes(SECRET));
});

test('loadConfig：/eval 的默认值（10s 超时 / 30s 上限 / 脚本 200KB / 结果 64KB）', () => {
  const config = loadConfig({ env: env(), readFile: fakeFiles({}) });
  assert.equal(config.evalTimeoutMs, 10_000);
  assert.equal(config.maxEvalTimeoutMs, 30_000);
  assert.equal(config.evalScriptMaxBytes, 200 * 1024);
  assert.equal(config.evalResultMaxBytes, 64 * 1024);
});

test('loadConfig：/eval 参数可调，且默认超时不能越过上限', () => {
  const config = loadConfig({
    env: env({
      EVAL_TIMEOUT_MS: '3000',
      EVAL_MAX_TIMEOUT_MS: '20000',
      EVAL_SCRIPT_MAX_BYTES: '4096',
      EVAL_RESULT_MAX_BYTES: '2048',
    }),
    readFile: fakeFiles({}),
  });
  assert.equal(config.evalTimeoutMs, 3_000);
  assert.equal(config.maxEvalTimeoutMs, 20_000);
  assert.equal(config.evalScriptMaxBytes, 4_096);
  assert.equal(config.evalResultMaxBytes, 2_048);

  // 默认超时越过上限要早失败，而不是跑起来才发现
  assert.throws(
    () =>
      loadConfig({
        env: env({ EVAL_TIMEOUT_MS: '60000', EVAL_MAX_TIMEOUT_MS: '10000' }),
        readFile: fakeFiles({}),
      }),
    /EVAL_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadConfig({ env: env({ EVAL_SCRIPT_MAX_BYTES: '10' }), readFile: fakeFiles({}) }),
    /EVAL_SCRIPT_MAX_BYTES/,
  );
  assert.throws(
    () => loadConfig({ env: env({ EVAL_RESULT_MAX_BYTES: '9999999' }), readFile: fakeFiles({}) }),
    /EVAL_RESULT_MAX_BYTES/,
  );
});
