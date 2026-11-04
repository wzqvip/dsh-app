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
      return { ok: true, url: 'https://example.com/' };
    },
    async evaluate({ script } = {}) {
      return { ok: true, result: `evaluated:${script}`, durationMs: 1, url: 'https://example.com/' };
    },
    ...overrides,
  };
}

async function startHarness({
  browser = fakeBrowser(),
  token = TOKEN,
  snapshotMaxChars,
  evalScriptMaxBytes,
  publicVncUrl,
  logger,
} = {}) {
  const pending = createPendingRegistry();
  const handler = createRequestHandler({
    token,
    browser,
    pending,
    snapshotMaxChars,
    evalScriptMaxBytes,
    publicVncUrl,
    logger,
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
    for (const path of ['/open', '/snapshot', '/act', '/eval', '/askuser', '/resume']) {
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
    // 统一字段：url 与 finalUrl 同值，其它接口也都有 url
    assert.equal(opened.json.url, opened.json.finalUrl);

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

// ── POST /eval ──────────────────────────────────────────────────────────────
// Canvas 技能全靠它。契约要点：**页面里的失败一律 200 + ok:false**，
// 只有"请求不合法"是 400、"浏览器不可用"是 503 —— 上层靠这个区分该重试还是该修脚本。

test('POST /eval：成功返回 result 与 durationMs', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return { ok: true, result: { title: 'Example Domain' }, durationMs: 42 };
      },
    }),
  });
  try {
    const { status, json } = await harness.call('/eval', {
      body: { script: '(() => ({ title: document.title }))()', timeoutMs: 10_000 },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.result, { title: 'Example Domain' });
    assert.equal(json.durationMs, 42);
    assert.equal(json.truncated, undefined);
  } finally {
    await harness.close();
  }
});

test('POST /eval：脚本抛错 → HTTP 200 + ok:false + code=script_error', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return {
          ok: false,
          code: 'script_error',
          error: 'x',
          stack: 'Error: x\n    at <anonymous>:1:1',
          durationMs: 3,
        };
      },
    }),
  });
  try {
    const { status, json } = await harness.call('/eval', { body: { script: "throw new Error('x')" } });
    // 关键：不是 500，也不是 4xx
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'script_error');
    assert.equal(json.error, 'x');
    assert.match(json.stack, /anonymous/);
    assert.equal(json.durationMs, 3);
  } finally {
    await harness.close();
  }
});

test('POST /eval：结果不可序列化 → 200 + code=not_serializable', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return { ok: false, code: 'not_serializable', error: 'result not serializable: Converting circular structure', durationMs: 2 };
      },
    }),
  });
  try {
    const { status, json } = await harness.call('/eval', { body: { script: '(() => { const a = {}; a.self = a; return a; })()' } });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'not_serializable');
    assert.match(json.error, /not serializable/);
  } finally {
    await harness.close();
  }
});

test('POST /eval：超时 → 200 + code=timeout', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return { ok: false, code: 'timeout', error: '脚本超时（100ms 内未完成）', durationMs: 100 };
      },
    }),
  });
  try {
    const { status, json } = await harness.call('/eval', { body: { script: 'await sleep()', timeoutMs: 100 } });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'timeout');
  } finally {
    await harness.close();
  }
});

test('POST /eval：把 script / timeoutMs 原样交给浏览器适配器', async () => {
  const calls = [];
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate(args) {
        calls.push(args);
        return { ok: true, result: 1, durationMs: 1 };
      },
    }),
  });
  try {
    await harness.call('/eval', { body: { script: 'document.title', timeoutMs: 4321 } });
    assert.deepEqual(calls, [{ script: 'document.title', timeoutMs: 4321 }]);
  } finally {
    await harness.close();
  }
});

test('POST /eval：入参校验（空/非字符串/非法 timeoutMs/超大脚本）→ 400', async () => {
  const harness = await startHarness({ evalScriptMaxBytes: 100 });
  try {
    const cases = [
      { body: {} },
      { body: { script: '' } },
      { body: { script: '   ' } },
      { body: { script: 123 } },
      { body: { script: 'document.title', timeoutMs: -1 } },
      { body: { script: 'document.title', timeoutMs: 'abc' } },
      { body: { script: 'a'.repeat(101) } },
    ];
    for (const { body } of cases) {
      const { status, json } = await harness.call('/eval', { body });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
      assert.equal(json.ok, false);
      assert.equal(json.code, 'bad_request');
    }

    // 边界内必须放行（100 字节整）
    const ok = await harness.call('/eval', { body: { script: 'a'.repeat(100) } });
    assert.equal(ok.status, 200);
  } finally {
    await harness.close();
  }
});

test('POST /eval：中文脚本按 UTF-8 字节算长度上限', async () => {
  // 每个汉字 3 字节：40 个汉字 = 120 字节 > 100
  const harness = await startHarness({ evalScriptMaxBytes: 100 });
  try {
    const { status, json } = await harness.call('/eval', { body: { script: '汉'.repeat(40) } });
    assert.equal(status, 400);
    assert.match(json.error, /script 过长/);
    assert.equal(json.scriptBytes, 120);
  } finally {
    await harness.close();
  }
});

test('POST /eval：浏览器不可用 → 503（与其它接口一致）', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        const error = new Error('连不上 Chromium 的 CDP');
        error.status = 503;
        error.code = 'browser_unavailable';
        throw error;
      },
    }),
  });
  try {
    const { status, json } = await harness.call('/eval', { body: { script: '1' } });
    assert.equal(status, 503);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'browser_unavailable');
  } finally {
    await harness.close();
  }
});

test('POST /eval：truncated / undefinedResult 透传', async () => {
  const truncated = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return { ok: true, result: 'x'.repeat(64), truncated: true, resultBytes: 9_999, durationMs: 5 };
      },
    }),
  });
  try {
    const { json } = await truncated.call('/eval', { body: { script: 'big()' } });
    assert.equal(json.ok, true);
    assert.equal(json.truncated, true);
    assert.equal(json.resultBytes, 9_999);
    assert.equal(json.result.length, 64);
  } finally {
    await truncated.close();
  }

  const undefinedResult = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return { ok: true, result: null, undefinedResult: true, durationMs: 1 };
      },
    }),
  });
  try {
    const { json } = await undefinedResult.call('/eval', { body: { script: '(() => undefined)()' } });
    assert.equal(json.ok, true);
    assert.equal(json.undefinedResult, true);
    assert.equal(json.result, null);
  } finally {
    await undefinedResult.close();
  }
});

test('POST /eval：日志只记长度/耗时，**不打印脚本内容**', async () => {
  const lines = [];
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate({ script }) {
        return { ok: true, result: script.length, durationMs: 7 };
      },
    }),
    logger: (level, message, extra) => lines.push(JSON.stringify({ level, message, extra })),
  });
  try {
    const secret = 'const password="S3CRET-TOKEN"; document.title';
    await harness.call('/eval', { body: { script: secret, timeoutMs: 5_000 } });
    const evalLine = lines.find((line) => line.includes('"eval"'));
    assert.ok(evalLine, '应有 eval 日志行');
    assert.ok(!lines.join('\n').includes('S3CRET-TOKEN'), '日志里不能出现脚本内容');
    assert.match(evalLine, /"scriptBytes":\d+/);
    assert.match(evalLine, /"durationMs":\d+/);
  } finally {
    await harness.close();
  }
});

test('POST /eval：GET 也 404（只接受 POST）', async () => {
  const harness = await startHarness();
  try {
    assert.equal((await harness.call('/eval', { method: 'GET' })).status, 404);
  } finally {
    await harness.close();
  }
});

test('页面语义：/open /snapshot /act /eval 的 url 必须是同一个受管页（task-4）', async () => {
  // 假浏览器只有一个"受管页"，它的 url 随 open 变化；任何接口都必须如实回报它
  let currentUrl = 'https://outlook.cloud.microsoft/mail/';
  const browser = fakeBrowser({
    async open(url) {
      currentUrl = url;
      return { ok: true, title: 'x', finalUrl: url, timedOut: false, httpStatus: 200 };
    },
    async snapshot() {
      return {
        url: currentUrl,
        title: 'x',
        text: 'content',
        readyState: 'complete',
        passwordFieldCount: 0,
        interactiveCount: 1,
        captchaDom: false,
        iframeUrls: [],
        httpStatus: 200,
      };
    },
    async act() {
      return { ok: true, url: currentUrl };
    },
    async evaluate() {
      return { ok: true, result: 1, durationMs: 1, url: currentUrl };
    },
    async health() {
      return { browserUp: true, page: { url: currentUrl, title: 'x', pageCount: 1 } };
    },
  });
  const harness = await startHarness({ browser });
  try {
    const targets = ['https://example.com', 'https://osu.instructure.com/', 'https://webauth.service.ohio-state.edu/'];
    for (const target of targets) {
      const opened = await harness.call('/open', { body: { url: target } });
      assert.equal(opened.json.url, target);

      const snap = await harness.call('/snapshot', { body: {} });
      assert.equal(snap.json.url, target, 'snapshot 必须跟得上最近一次 open');

      const acted = await harness.call('/act', { body: { action: 'click', selector: '#x' } });
      assert.equal(acted.json.url, target);

      const evaluated = await harness.call('/eval', { body: { script: '1' } });
      assert.equal(evaluated.json.url, target);

      const health = await harness.call('/health', { method: 'GET' });
      assert.equal(health.json.page.url, target, '/health.page 必须与 snapshot 一致');
    }
  } finally {
    await harness.close();
  }
});

test('POST /eval：响应里回 url（脚本报错时也要回，方便上层定位）', async () => {
  const harness = await startHarness({
    browser: fakeBrowser({
      async evaluate() {
        return { ok: false, code: 'script_error', error: 'x', durationMs: 1, url: 'https://osu.instructure.com/' };
      },
    }),
  });
  try {
    const { json } = await harness.call('/eval', { body: { script: "throw new Error('x')" } });
    assert.equal(json.ok, false);
    assert.equal(json.url, 'https://osu.instructure.com/');
  } finally {
    await harness.close();
  }
});
