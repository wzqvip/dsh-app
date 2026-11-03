/**
 * HTTP 层测试：路由、鉴权、入参校验、以及"假浏览器"下的完整判定链路。
 *
 * 关键设计：HTTP 层只依赖**注入的 browser 适配器**，
 * 所以这里不起 Chromium、不联网，却能覆盖真实流量会走的每条路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequestHandler, startHttpServer } from '../src/http.js';
import { createPendingRegistry } from '../src/pending.js';

const TOKEN = 'test-token-0123456789';

/** 假浏览器：默认一切正常，可按用例覆盖单个方法。 */
function fakeBrowser(overrides = {}) {
  return {
    async health() {
      return { browserUp: true, page: { url: 'https://example.com/', title: 'Example Domain', pageCount: 1 } };
    },
    async open(url) {
      return { ok: true, title: 'Example Domain', finalUrl: url, timedOut: false, httpStatus: 200 };
    },
    async snapshot() {
      return {
        url: 'https://example.com/',
        title: 'Example Domain',
        text: 'Example Domain\nThis domain is for use in illustrative examples in documents.',
        readyState: 'complete',
        passwordFieldCount: 0,
        interactiveCount: 2,
        captchaDom: false,
        iframeUrls: [],
        httpStatus: 200,
      };
    },
    async act() {
      return { ok: true };
    },
    ...overrides,
  };
}

async function startHarness({ browser = fakeBrowser(), token = TOKEN, snapshotMaxChars, publicVncUrl } = {}) {
  const pending = createPendingRegistry();
  const handler = createRequestHandler({
    token,
    browser,
    pending,
    snapshotMaxChars,
    publicVncUrl,
  });
  const server = await startHttpServer({ port: 0, host: '127.0.0.1', handler });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (path, { method = 'POST', body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, json };
  };
  const auth = { 'x-dsh-token': TOKEN };
  return {
    server,
    base,
    pending,
    call: (path, options = {}) => call(path, { ...options, headers: { ...auth, ...(options.headers ?? {}) } }),
    callNoAuth: call,
    close: () => server.close(),
  };
}

test('GET /health 不需要 token（探活用），返回契约字段', async () => {
  const harness = await startHarness({ publicVncUrl: 'http://192.168.3.30:16080/' });
  try {
    const { status, json } = await harness.callNoAuth('/health', { method: 'GET' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.service, 'dsh-browser');
    assert.equal(json.browserUp, true);
    assert.equal(json.lastActionAt, null);
    assert.equal(json.pendingUser, null);
    assert.equal(json.vncUrl, 'http://192.168.3.30:16080/');
    assert.deepEqual(json.loggedInHints, {
      lastReason: null,
      lastSnapshotAt: null,
      passwordFieldPresent: false,
      loginUrl: false,
      mfaText: false,
      captchaMarkers: false,
    });
    assert.equal(typeof json.uptimeSec, 'number');
  } finally {
    await harness.close();
  }
});

test('除 /health 外一律要求 x-dsh-token', async () => {
  const harness = await startHarness();
  try {
    for (const path of ['/open', '/snapshot', '/act', '/askuser', '/resume']) {
      const missing = await harness.callNoAuth(path, { body: {} });
      assert.equal(missing.status, 401, `${path} 缺 token 应 401`);
      assert.equal(missing.json.ok, false);

      const wrong = await harness.callNoAuth(path, { body: {}, headers: { 'x-dsh-token': 'nope' } });
      assert.equal(wrong.status, 401, `${path} 错 token 应 401`);
    }
    const ok = await harness.call('/snapshot', { body: {} });
    assert.equal(ok.status, 200);
  } finally {
    await harness.close();
  }
});

test('POST /open：非法 URL 400，合法 URL 透传结果并更新 lastActionAt', async () => {
  const harness = await startHarness();
  try {
    const bad = await harness.call('/open', { body: { url: 'javascript:alert(1)' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /http\(s\)/);

    const noUrl = await harness.call('/open', { body: {} });
    assert.equal(noUrl.status, 400);

    const opened = await harness.call('/open', { body: { url: 'https://example.com' } });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.ok, true);
    assert.equal(opened.json.title, 'Example Domain');
    assert.equal(opened.json.finalUrl, 'https://example.com');

    const health = await harness.call('/health', { method: 'GET' });
    assert.ok(health.json.lastActionAt);
  } finally {
    await harness.close();
  }
});

test('POST /open：浏览器报 502 时透传状态码', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async open() {
        const error = new Error('net::ERR_NAME_NOT_RESOLVED');
        error.status = 502;
        error.code = 'action_failed';
        throw error;
      },
    }),
  });
  try {
    const result = await harness.call('/open', { body: { url: 'https://nonexistent.invalid' } });
    assert.equal(result.status, 502);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, /ERR_NAME_NOT_RESOLVED/);
  } finally {
    await harness.close();
  }
});

test('POST /snapshot：普通页面 → needsUser false，并带 url/title/text', async () => {
  const harness = await startHarness();
  try {
    const { status, json } = await harness.call('/snapshot', { body: {} });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.needsUser, false);
    assert.equal(json.reason, null);
    assert.equal(json.url, 'https://example.com/');
    assert.equal(json.title, 'Example Domain');
    assert.match(json.text, /Example Domain/);
    assert.equal(json.truncated, false);
    assert.equal(json.httpStatus, 200);
    assert.ok(json.at);
  } finally {
    await harness.close();
  }
});

test('POST /snapshot：微软登录页 → needsUser true / login_required', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async snapshot() {
        return {
          url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
          title: 'Sign in to your account',
          text: 'Sign in\nEnter your email, phone, or Skype.\nNo account? Create one!',
          readyState: 'complete',
          passwordFieldCount: 1,
          interactiveCount: 7,
          captchaDom: false,
          iframeUrls: [],
          httpStatus: 200,
        };
      },
    }),
  });
  try {
    const { json } = await harness.call('/snapshot', { body: {} });
    assert.equal(json.needsUser, true);
    assert.equal(json.reason, 'login_required');
    assert.ok(json.signals.includes('login_url'));
    assert.equal(json.hints.passwordFieldPresent, true);

    const health = await harness.call('/health', { method: 'GET' });
    assert.equal(health.json.loggedInHints.lastReason, 'login_required');
    assert.equal(health.json.loggedInHints.loginUrl, true);
  } finally {
    await harness.close();
  }
});

test('POST /snapshot：正文按 snapshotMaxChars 截断，并如实报告长度', async () => {
  const harness = await startHarness({
    snapshotMaxChars: 1_000,
    browser: fakeBrowser({
      async snapshot() {
        return {
          url: 'https://outlook.office.com/mail/',
          title: 'Inbox',
          text: 'x'.repeat(5_000),
          readyState: 'complete',
          passwordFieldCount: 0,
          interactiveCount: 40,
          captchaDom: false,
          iframeUrls: [],
          httpStatus: 200,
        };
      },
    }),
  });
  try {
    const { json } = await harness.call('/snapshot', { body: {} });
    assert.equal(json.text.length, 1_000);
    assert.equal(json.chars, 5_000);
    assert.equal(json.truncated, true);
  } finally {
    await harness.close();
  }
});

test('POST /snapshot：浏览器挂掉 → 503（调用方知道该重试而不是当成"没内容"）', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async snapshot() {
        const error = new Error('连不上 Chromium 的 CDP');
        error.status = 503;
        error.code = 'browser_unavailable';
        throw error;
      },
    }),
  });
  try {
    const { status, json } = await harness.call('/snapshot', { body: {} });
    assert.equal(status, 503);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'browser_unavailable');
  } finally {
    await harness.close();
  }
});

test('POST /act：动作白名单、selector 必填、type 需要 text', async () => {
  const harness = await startHarness();
  try {
    assert.equal((await harness.call('/act', { body: { action: 'delete', selector: '#x' } })).status, 400);
    assert.equal((await harness.call('/act', { body: { action: 'click' } })).status, 400);
    assert.equal((await harness.call('/act', { body: { action: 'click', selector: '   ' } })).status, 400);
    assert.equal((await harness.call('/act', { body: { action: 'type', selector: '#x' } })).status, 400);
    assert.equal(
      (await harness.call('/act', { body: { action: 'click', selector: '#x', timeoutMs: -1 } })).status,
      400,
    );

    const click = await harness.call('/act', { body: { action: 'click', selector: 'button[type=submit]' } });
    assert.equal(click.status, 200);
    assert.equal(click.json.ok, true);

    const type = await harness.call('/act', { body: { action: 'type', selector: '#email', text: 'a@b.c' } });
    assert.equal(type.status, 200);

    const waitFor = await harness.call('/act', { body: { action: 'waitFor', selector: '#inbox' } });
    assert.equal(waitFor.status, 200);
  } finally {
    await harness.close();
  }
});

test('POST /act：把动作参数如实转给浏览器适配器', async () => {
  const calls = [];
  const harness = await startHarness({
    browser: fakeBrowser({
      async act(args) {
        calls.push(args);
        return { ok: true };
      },
    }),
  });
  try {
    await harness.call('/act', { body: { action: 'type', selector: '#code', text: '123456', timeoutMs: 5_000 } });
    assert.deepEqual(calls, [{ action: 'type', selector: '#code', text: '123456', timeoutMs: 5_000 }]);
  } finally {
    await harness.close();
  }
});

test('/askuser 记录待人工请求；/health 能看到；/resume 清掉', async () => {
  const harness = await startHarness({ publicVncUrl: 'http://192.168.3.30:16080/' });
  try {
    const ask = await harness.call('/askuser', {
      body: {
        reason: 'login_required',
        instructions: '请打开 noVNC 登录学校邮箱',
      },
    });
    assert.equal(ask.status, 200);
    assert.equal(ask.json.ok, true);
    assert.equal(ask.json.pending.reason, 'login_required');
    // 没传 vncUrl → 回落到服务默认值
    assert.equal(ask.json.pending.vncUrl, 'http://192.168.3.30:16080/');

    const health = await harness.call('/health', { method: 'GET' });
    assert.equal(health.json.pendingUser.reason, 'login_required');
    assert.equal(health.json.vncUrl, 'http://192.168.3.30:16080/');

    const resumed = await harness.call('/resume', { body: {} });
    assert.deepEqual(resumed.json, { ok: true, cleared: true });

    const healthAfter = await harness.call('/health', { method: 'GET' });
    assert.equal(healthAfter.json.pendingUser, null);
    assert.equal(healthAfter.json.vncUrl, 'http://192.168.3.30:16080/');
  } finally {
    await harness.close();
  }
});

test('/askuser 缺 reason → 400 且不带堆栈', async () => {
  const harness = await startHarness();
  try {
    const { status, json } = await harness.call('/askuser', { body: { instructions: 'x' } });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /reason/);
    assert.equal(json.stack, undefined);
  } finally {
    await harness.close();
  }
});

test('未知路由 404；GET /snapshot 也 404（只接受 POST）', async () => {
  const harness = await startHarness();
  try {
    assert.equal((await harness.call('/nope', { body: {} })).status, 404);
    assert.equal((await harness.call('/snapshot', { method: 'GET' })).status, 404);
  } finally {
    await harness.close();
  }
});

test('请求体不是 JSON → 400', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`http://127.0.0.1:${harness.server.port}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': TOKEN },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /JSON/);
  } finally {
    await harness.close();
  }
});

test('浏览器探活抛异常时 /health 仍 200，只是 browserUp=false', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async health() {
        throw new Error('boom');
      },
    }),
  });
  try {
    const { status, json } = await harness.callNoAuth('/health', { method: 'GET' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.browserUp, false);
    assert.match(json.browserError, /boom/);
  } finally {
    await harness.close();
  }
});
