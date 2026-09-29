/**
 * dsh-efficiency —— 宿主半侧（host half）
 *
 * 职责：把「agent 在等用户回答」这件事，变成客户端能读到、并点一下就能作答的东西。
 *
 * 为什么这样设计（见 ARCHITECTURE.md §3）：
 *   - DSH 官方 ctx.userQuestions 已提供完整机制：askTimed 超时后 agent 继续工作，
 *     提问保持在投影里可回答；answer() 会把回复 steer 回 agent。
 *   - 本插件【不抢答】：在 user-questions/request 这个 waterfall 上只做记录，
 *     然后调用 next() 交回官方链路 —— 否则网页端的问答 UI 会失效。
 *   - 客户端通过 HTTP 轮询读取待答清单（无需连接服务事件流，实现最简、最稳）。
 *
 * 路由前缀：/dsh-efficiency/api/
 */

/** 待答清单：callId -> 条目。进程内内存态，重启即清空（未答问题仍在会话里，可重新捕获）。 */
const pending = new Map();

/** 已作答的 callId，避免轮询重复提示。 */
const answered = new Set();

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const name = 'dsh-efficiency';
const inject = ['webServer', 'userQuestions'];

/** 插件是否已 apply（用于排障：客户端可读） */
let appliedAt = 0;
/** 旁听到的提问次数（用于排障） */
let seenRequests = 0;

/**
 * 沙箱专用开关：只有进程环境变量 DSH_EFFICIENCY_DEV_TOOLS=1 时，
 * 才注册 /api/dev/* 端点（注入合成提问，用于在没人提问时验证 UI）。
 * 生产环境不设该变量 → 端点根本不存在。
 */
const DEV_TOOLS = process.env.DSH_EFFICIENCY_DEV_TOOLS === '1';

function apply(ctx) {
  appliedAt = Date.now();
  // ctx.logger 可能不写 stdout；排障时用 console 直接打，确保可见
  const log = (msg) => {
    try { ctx.logger?.info?.(`[dsh-efficiency] ${msg}`); } catch { /* ignore */ }
    console.log(`[dsh-efficiency] ${msg}`);
  };
  log('apply() 开始');

  // ---- 1) 在 waterfall 上旁听提问，记录后【交回】官方链路 ----
  ctx.effect(() => {
    const dispose = ctx.on('user-questions/request', (request, next) => {
      try {
        seenRequests += 1;
        const wait = request?.wait;
        const callId = wait?.callId;
        const questions = request?.questions;
        log(`waterfall 命中 #${seenRequests} callId=${callId} questions=${Array.isArray(questions) ? questions.length : 'n/a'}`);
        if (callId && Array.isArray(questions) && questions.length > 0) {
          pending.set(callId, {
            callId,
            questions,
            agent: request.agent,
            timed: wait.timed === true,
            receivedAt: Date.now(),
          });
          log(`captured question ${callId} (${questions.length} item(s), timed=${wait.timed === true})`);
        }
      } catch (err) {
        // 旁听失败绝不能影响官方链路
        ctx.logger?.warn?.(`[dsh-efficiency] capture failed: ${String(err)}`);
      }
      // 关键：不抢答，交回官方 answerer（网页端 UI 等）
      return next();
    });
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  }, 'dsh-efficiency: question capture');

  // ---- 2) 暴露 HTTP 路由给客户端 ----
  const route = (path, handler) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler }),
      `dsh-efficiency: route ${path}`,
    );

  // 待答清单
  route('/dsh-efficiency/api/pending', async (req, res) => {
    const items = [];
    for (const [callId, entry] of pending) {
      if (answered.has(callId)) continue;
      items.push({
        callId,
        timed: entry.timed,
        receivedAt: entry.receivedAt,
        questions: entry.questions.map((q) => ({
          id: q.id,
          question: q.question,
          detail: q.detail,
          header: q.header,
          options: q.options,
          multiSelect: q.multiSelect === true,
          intent: q.intent,
        })),
      });
    }
    json(res, 200, { ok: true, count: items.length, items });
  });

  // 提交回答
  route('/dsh-efficiency/api/answer', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: `bad-json: ${String(err)}` });
    }
    const callId = body?.callId;
    const answers = body?.answers;
    if (!callId || !Array.isArray(answers) || answers.length === 0) {
      return json(res, 400, { ok: false, error: 'callId and non-empty answers are required' });
    }
    const entry = pending.get(callId);
    if (!entry) return json(res, 404, { ok: false, error: 'unknown-call-id' });
    if (answered.has(callId)) return json(res, 409, { ok: false, error: 'already-answered' });
    if (!entry.agent) return json(res, 409, { ok: false, error: 'no-live-agent-for-call' });

    try {
      entry.agent && ctx.userQuestions.answer(entry.agent, callId, { answers });
      answered.add(callId);
      log(`answered ${callId}`);
      return json(res, 200, { ok: true });
    } catch (err) {
      // 官方错误码（BAD_ANSWER / REPLY_QUEUED 等）原样回报，便于客户端提示
      return json(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
  });

  // 健康检查（便于排障）
  route('/dsh-efficiency/api/health', async (req, res) => {
    json(res, 200, {
      ok: true,
      plugin: name,
      // 排障字段：确认 apply 真的跑过、waterfall 是否命中过
      appliedAt,
      appliedAgoMs: appliedAt ? Date.now() - appliedAt : null,
      seenRequests,
      pending: pending.size,
      answered: answered.size,
      devTools: DEV_TOOLS,
    });
  });

  // ---- 沙箱专用：注入一条合成提问，用于在没有人提问时验证 UI ----
  // ⚠️ 只有进程环境变量 DSH_EFFICIENCY_DEV_TOOLS=1 时才注册。
  //    这样生产环境（不设该变量）永远不会暴露这个端点。
  if (DEV_TOOLS) {
    route('/dsh-efficiency/api/dev/inject', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, 400, { ok: false, error: `bad-json: ${String(err)}` });
      }
      const callId = body?.callId || `dev-${Date.now()}`;
      const questions = body?.questions;
      if (!Array.isArray(questions) || questions.length === 0) {
        return json(res, 400, { ok: false, error: 'questions (non-empty array) required' });
      }
      pending.set(callId, {
        callId,
        questions,
        agent: null, // 合成提问没有真实 agent
        timed: body?.timed === true,
        receivedAt: Date.now(),
        dev: true,
      });
      log(`[dev] injected synthetic question ${callId} (${questions.length} item(s))`);
      return json(res, 200, { ok: true, callId });
    });

    route('/dsh-efficiency/api/dev/clear', async (req, res) => {
      const n = pending.size;
      for (const [id, e] of pending) if (e.dev) pending.delete(id);
      log(`[dev] cleared synthetic questions (had ${n})`);
      return json(res, 200, { ok: true });
    });

    log('dev tools enabled (DSH_EFFICIENCY_DEV_TOOLS=1)');
  }

  log('host half ready');
}

export { apply, inject, name };
