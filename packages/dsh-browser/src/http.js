/**
 * HTTP 层 —— 契约见 docs/BROWSER-SERVICE.md，调用方是 assistant 的数据管线。
 *
 *   GET  /health                     → 服务活着吗、浏览器连上了吗、在等人吗
 *   POST /open    {url}              → 打开页面
 *   POST /snapshot {}                → 可见文本 + needsUser/reason
 *   POST /act     {action,selector,text?,timeoutMs?}
 *   POST /eval    {script,timeoutMs?} → 在页面里执行 JS（脚本报错返回 200 + ok:false）
 *   POST /askuser {reason,instructions,vncUrl} → 记一条"要人"请求
 *   POST /resume                     → 人做完了，清掉
 *
 * 设计取舍：
 *   1. **依赖注入 browser**：HTTP 层不认识 Playwright，单测用假 browser 就能覆盖
 *      所有路由/鉴权/判定组合，不用起真 Chromium。
 *   2. **health 不校验 token**：它是探活（docker healthcheck、上层判断可达性要用），
 *      且只暴露"活没活/要不要人"，不暴露页面内容。其余接口一律 401。
 *   3. **错误一律 {ok:false,error}**：调用方只需要判断 ok，不用解析堆栈。
 */

import { createServer } from 'node:http';
import { classifyNeedsUser, loginHints } from './classify.js';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  // 页面内容随时变，禁止任何中间层缓存
  'cache-control': 'no-store',
});

// 请求体上限。必须**大于** /eval 的脚本上限（默认 200KB），
// 因为 JSON 转义后还会膨胀（换行/引号/中文），这里留到 512KB。
const MAX_BODY_BYTES = 512 * 1024;
const ACTIONS = Object.freeze(['click', 'type', 'waitFor']);

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function errorMessage(error) {
  return String(error?.message ?? error);
}

/** 调用方（不是服务端）的问题 → 400 */
function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'bad_request';
  return error;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('请求体过大（上限 64 KB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(badRequest('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 生成请求处理器。
 *
 * @param {object} deps
 * @param {string} deps.token              共享密钥（空字符串 = 不校验，仅限本机调试）
 * @param {object} deps.browser            浏览器适配器（见 src/browser.js；单测注入假实现）
 * @param {object} [deps.pending]          createPendingRegistry() 的返回值
 * @param {Function} [deps.logger]         (level, message, extra) => void
 * @param {number} [deps.snapshotMaxChars] /snapshot 文本上限
 * @param {number} [deps.evalScriptMaxBytes] /eval 脚本上限（字节）
 * @param {string} [deps.publicVncUrl]     维护者打开 noVNC 的地址（可空）
 * @param {Function} [deps.now]            () => epoch ms
 */
export function createRequestHandler({
  token = '',
  browser,
  pending,
  logger = () => {},
  snapshotMaxChars = 48_000,
  evalScriptMaxBytes = 200 * 1024,
  publicVncUrl = '',
  now = () => Date.now(),
} = {}) {
  if (!browser) throw new Error('createRequestHandler 需要 browser');

  const startedAt = now();
  let lastActionAt = null;
  /** 最近一次 /snapshot 的结果（/health 的 loggedInHints 从这里来） */
  let lastSnapshot = null;

  const authorized = (req) => {
    if (!token) return true;
    const provided = req.headers['x-dsh-token'];
    return typeof provided === 'string' && provided === token;
  };

  const touch = () => {
    lastActionAt = now();
  };

  async function handleHealth() {
    let browserUp = false;
    let page = null;
    let browserError = null;
    try {
      const info = (await browser.health()) ?? {};
      browserUp = info.browserUp === true;
      page = info.page ?? null;
      browserError = info.error ?? null;
    } catch (error) {
      browserError = errorMessage(error);
    }

    const hints = lastSnapshot?.observation ? loginHints(lastSnapshot.observation) : null;
    const waiting = pending?.get?.() ?? null;

    return {
      ok: true,
      service: 'dsh-browser',
      browserUp,
      browserError,
      // 契约字段：给上层一个"看起来登录了吗"的粗线索（不用于判定，判定看 /snapshot）
      loggedInHints: {
        lastReason: lastSnapshot?.classification?.reason ?? null,
        lastSnapshotAt: lastSnapshot ? new Date(lastSnapshot.at).toISOString() : null,
        passwordFieldPresent: hints?.passwordFieldPresent ?? false,
        loginUrl: hints?.loginUrl ?? false,
        mfaText: hints?.mfaText ?? false,
        captchaMarkers: hints?.captchaMarkers ?? false,
      },
      lastActionAt: lastActionAt === null ? null : new Date(lastActionAt).toISOString(),
      uptimeSec: Math.max(0, Math.round((now() - startedAt) / 1000)),
      pendingUser: waiting,
      vncUrl: waiting?.vncUrl || publicVncUrl || null,
      page,
    };
  }

  async function handleOpen(req, res) {
    const body = await readJsonBody(req);
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!isHttpUrl(url)) {
      return sendJson(res, 400, { ok: false, error: 'url 必须是 http(s) 绝对地址' });
    }
    touch();
    const result = await browser.open(url);
    const finalUrl = result?.finalUrl ?? url;
    const navigationApplied = result?.navigationApplied !== false;
    const responseBody = {
      ok: result?.ok !== false && navigationApplied,
      navigationApplied,
      // finalUrl 与 url 是同一个值：前者是历史字段，后者让每个接口都有统一的 url
      title: result?.title ?? '',
      finalUrl,
      url: finalUrl,
      timedOut: result?.timedOut === true,
      httpStatus: result?.httpStatus ?? null,
      ...(navigationApplied ? {} : { code: result?.code ?? 'navigation_not_applied', error: result?.error }),
    };
    // 没导航就**不是成功**：用 502（我们让浏览器去导航，它没办到），
    // 只认状态码的调用方也能立刻发现；看 body 的调用方还能拿到停在哪个页。
    return sendJson(res, navigationApplied ? 200 : 502, responseBody);
  }

  async function handleSnapshot(res) {
    touch();
    const observation = (await browser.snapshot()) ?? {};
    const classification = classifyNeedsUser(observation);
    lastSnapshot = { at: now(), observation, classification };

    const rawText = typeof observation.text === 'string' ? observation.text : '';
    const text = rawText.slice(0, snapshotMaxChars);

    return sendJson(res, 200, {
      ok: true,
      url: typeof observation.url === 'string' ? observation.url : '',
      title: typeof observation.title === 'string' ? observation.title : '',
      text,
      truncated: rawText.length > text.length,
      chars: rawText.length,
      needsUser: classification.needsUser,
      reason: classification.reason,
      signals: classification.signals,
      hints: loginHints(observation),
      readyState: observation.readyState ?? null,
      httpStatus: observation.httpStatus ?? null,
      at: new Date(lastSnapshot.at).toISOString(),
      vncUrl: publicVncUrl || null,
    });
  }

  async function handleAct(req, res) {
    const body = await readJsonBody(req);
    const action = typeof body?.action === 'string' ? body.action : '';
    if (!ACTIONS.includes(action)) {
      return sendJson(res, 400, { ok: false, error: `action 只支持 ${ACTIONS.join('|')}` });
    }
    const selector = typeof body?.selector === 'string' ? body.selector.trim() : '';
    if (!selector) {
      return sendJson(res, 400, { ok: false, error: 'selector 不能为空' });
    }
    if (action === 'type' && typeof body?.text !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'action=type 时 text 必须是字符串' });
    }
    const timeoutMs = body?.timeoutMs === undefined ? undefined : Number(body.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return sendJson(res, 400, { ok: false, error: 'timeoutMs 必须是正数' });
    }

    touch();
    const result = await browser.act({
      action,
      selector,
      text: body?.text,
      timeoutMs,
    });
    return sendJson(res, 200, {
      ok: result?.ok !== false,
      action,
      selector,
      url: result?.url ?? null,
      // type 的降级信息：click 被浮层挡住 → 直接 fill 完成，上层可据此决定要不要复核
      ...(result?.inputMode ? { inputMode: result.inputMode } : {}),
      ...(result?.degraded ? { degraded: true, reason: result.reason ?? null } : {}),
    });
  }

  /**
   * POST /eval —— 在页面里执行一段 JS（Canvas 技能那类流程全靠它）。
   *
   * 状态码约定（和 /act 有意不同，别改）：
   *   - 脚本报错 / 不可序列化 / 超时 → **200** + ok:false + `code`
   *     上层要能区分"页面里的脚本挂了"和"服务挂了"
   *   - 请求本身不合法（缺 script、太长、timeoutMs 非法）→ 400
   *   - 浏览器不可用 → 503（由外层 catch 按 error.status 处理）
   */
  async function handleEval(req, res) {
    const body = await readJsonBody(req);
    if (typeof body?.script !== 'string' || body.script.trim() === '') {
      return sendJson(res, 400, { ok: false, error: 'script 必须是非空字符串', code: 'bad_request' });
    }
    const script = body.script;
    const scriptBytes = Buffer.byteLength(script, 'utf8');
    if (scriptBytes > evalScriptMaxBytes) {
      return sendJson(res, 400, {
        ok: false,
        error: `script 过长（${scriptBytes} 字节 > 上限 ${evalScriptMaxBytes} 字节）`,
        code: 'bad_request',
        scriptBytes,
      });
    }
    const timeoutMs = body?.timeoutMs === undefined ? undefined : Number(body.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return sendJson(res, 400, { ok: false, error: 'timeoutMs 必须是正数', code: 'bad_request' });
    }

    touch();
    const startedAt = now();
    const result = (await browser.evaluate({ script, timeoutMs })) ?? {};
    const durationMs = result.durationMs ?? now() - startedAt;

    // ⚠️ 日志里只记长度/耗时/结果码：脚本内容可能很长、可能含个人信息
    logger('info', 'eval', {
      scriptBytes,
      timeoutMs: timeoutMs ?? null,
      durationMs,
      ok: result.ok === true,
      code: result.code ?? null,
      truncated: result.truncated === true,
    });

    if (result.ok !== true) {
      return sendJson(res, 200, {
        ok: false,
        code: result.code ?? 'script_error',
        error: result.error ?? '脚本执行失败',
        ...(result.stack ? { stack: result.stack } : {}),
        durationMs,
        url: result.url ?? null,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      result: result.result ?? null,
      ...(result.undefinedResult ? { undefinedResult: true } : {}),
      ...(result.truncated ? { truncated: true, resultBytes: result.resultBytes ?? null } : {}),
      durationMs,
      url: result.url ?? null,
    });
  }

  async function handleAskUser(req, res) {
    const body = await readJsonBody(req);
    if (!pending) return sendJson(res, 503, { ok: false, error: 'pending 状态机未启用' });
    try {
      const result = pending.request({
        reason: body?.reason,
        instructions: body?.instructions,
        vncUrl: body?.vncUrl,
        defaultVncUrl: publicVncUrl,
      });
      logger('info', 'askuser', { reason: result.pending.reason });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }

  async function handleResume(res) {
    if (!pending) return sendJson(res, 503, { ok: false, error: 'pending 状态机未启用' });
    const result = pending.resume();
    logger('info', 'resume', { cleared: result.cleared });
    return sendJson(res, 200, result);
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, await handleHealth());
      }

      if (!authorized(req)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (req.method === 'POST' && path === '/open') return await handleOpen(req, res);
      if (req.method === 'POST' && path === '/snapshot') return await handleSnapshot(res);
      if (req.method === 'POST' && path === '/act') return await handleAct(req, res);
      if (req.method === 'POST' && path === '/eval') return await handleEval(req, res);
      if (req.method === 'POST' && path === '/askuser') return await handleAskUser(req, res);
      if (req.method === 'POST' && path === '/resume') return await handleResume(res);

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      // 浏览器不可用 → 503（调用方可重试）；其余 → 500
      const status = Number(error?.status);
      const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
      logger('warn', 'request_failed', { path: req.url, error: errorMessage(error) });
      return sendJson(res, code, { ok: false, error: errorMessage(error), code: error?.code ?? null });
    }
  };
}

/**
 * 启动 HTTP 服务。端口传 0 时由系统分配（测试用）。
 * @returns {Promise<{server:import('node:http').Server, port:number, close:()=>Promise<void>}>}
 */
export function startHttpServer({ port = 8789, host = '0.0.0.0', handler }) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
