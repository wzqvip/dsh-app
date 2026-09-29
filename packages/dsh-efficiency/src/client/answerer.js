/**
 * 客户端 answerer —— 本项目真正的核心。
 *
 * 为什么需要它（见 research/11、research/12）：
 *   1. answerer 在【客户端】，不在宿主侧；宿主侧 ctx.on 收不到该事件
 *   2. 官方答案卡注册在 conversation.composer，显示与否取决于宿主投影出来的
 *      pendingInteraction；实测【不渲染】，所以用户看不到选项卡、无法作答
 *   3. 而 remote waterfall 本身是好的：桌面宠物能收到 question/requested 帧
 *
 * 于是做法是：自己当一个 answerer。事件到达时把问题交给面板渲染，
 * 用户点选后把答案 return 回去 —— 不依赖官方的 pendingInteraction 链路。
 *
 * 协议（抄自 dsh-client-ui-user-questions 的 createWaterfallRequest）：
 *   handler(request, next) => Promise<Answer>
 *     · resolve 一个答案  → 本次提问由此回答
 *     · return next()     → 让位给下一个 answerer
 *     · 抛错              → 本次提问失败
 *
 * 安全性设计：
 *   - 未启用（面板已关闭 / 用户选择不用本插件）时立刻 return next()，不干扰任何东西
 *   - 认领失败或认领被释放时同样让位
 *   - 超时后仍允许作答（沿用官方语义）；用户放弃则让位
 */

import { diagNoteRequest, diagNoteOutcome } from './probe.js';

/** 把 answerer 与面板连接起来的小桥：面板注册接收器，answerer 投递请求 */
export function createAnswerBridge() {
  let receiver = null;
  return {
    /** 面板挂载时注册自己；返回注销函数 */
    setReceiver(fn) {
      receiver = fn;
      return () => { if (receiver === fn) receiver = null; };
    },
    get hasReceiver() { return typeof receiver === 'function'; },
    /**
     * 把一批问题交给面板，等用户作答。
     * @returns {Promise<{ok:true, answer:object} | {ok:false, reason:'no-panel'|'declined'|'aborted'}>}
     */
    ask(payload, signal) {
      if (typeof receiver !== 'function') return Promise.resolve({ ok: false, reason: 'no-panel' });
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        };
        const onAbort = () => finish({ ok: false, reason: 'aborted' });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        receiver(payload, {
          submit: (answer) => finish({ ok: true, answer }),
          decline: () => finish({ ok: false, reason: 'declined' }),
        });
      });
    },
  };
}

/**
 * 注册 answerer。
 * @param {object} ctx 客户端 cordis 上下文（需已 inject 'remote'）
 * @param {object} bridge createAnswerBridge() 的产物
 * @param {(msg:string)=>void} log
 * @returns {boolean} 是否注册成功
 */
export function installAnswerer(ctx, bridge, log = () => {}) {
  const remote = ctx?.remote;
  if (!remote || typeof remote.$on !== 'function') {
    log('ctx.remote.$on 不可用，answerer 未注册');
    return false;
  }

  try {
    ctx.effect(
      () =>
        remote.$on('user-questions/request', function dshEfficiencyAnswerer(request, next) {
          return handleRequest(ctx, bridge, request, next, log);
        }),
      'dsh-efficiency: answerer',
    );
    log('answerer 已注册到 user-questions/request');
    return true;
  } catch (err) {
    log(`answerer 注册失败: ${String(err)}`);
    return false;
  }
}

/**
 * 处理一次提问。任何不确定的情况都让位（return next()），
 * 宁可退回官方链路，也不要把提问吞掉。
 */
async function handleRequest(ctx, bridge, request, next, log) {
  const callId = request?.wait?.callId;
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const timed = request?.wait?.timed === true;
  diagNoteRequest(request);
  log(`提问到达 callId=${callId} questions=${questions.length} timed=${timed}`);

  if (!callId || questions.length === 0) return next();
  if (!bridge.hasReceiver) {
    log('面板未挂载，让位给官方 answerer');
    return next();
  }

  // 认领（仅限时提问有 attachWait 语义；其余默认直接展示）
  let claim = null;
  let claimIterator = null;
  let claimEnded = null;
  const claimLifetime = new AbortController();
  const sessionId = ctx?.sessions?.scopeOf?.(this) ?? undefined;

  if (timed && sessionId && ctx?.remote?.userQuestions?.attachWait) {
    try {
      claim = ctx.remote.userQuestions.attachWait(sessionId, callId, claimLifetime.signal);
      claimIterator = claim?.[Symbol.asyncIterator]?.();
      if (claimIterator) {
        const opening = await claimIterator.next();
        if (opening?.done === true) {
          // 已被别的前台认领 —— 让位
          log('提问已被其他 answerer 认领，让位');
          return next();
        }
      }
    } catch (err) {
      log(`认领失败，让位: ${String(err)}`);
      claimLifetime.abort();
      return next();
    }
  }

  try {
    const outcome = await bridge.ask({ callId, questions, timed, request }, request?.signal);
    if (outcome.ok) {
      diagNoteOutcome('answered');
      log(`面板作答 callId=${callId}`);
      return outcome.answer;
    }
    if (outcome.reason === 'no-panel') {
      log('作答时面板已卸载，让位');
      return next();
    }
    diagNoteOutcome('declined');
    log(`用户放弃作答（${outcome.reason}），让位`);
    return next();
  } finally {
    // 认领窗口的生命周期：结束或让位都由它收口
    try {
      claimIterator?.return?.();
    } catch { /* ignore */ }
    claim?.dispose?.();
    claimLifetime.abort();
    void claimEnded;
  }
}
