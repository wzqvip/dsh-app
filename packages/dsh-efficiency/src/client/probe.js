/**
 * 诊断计数（保留的轻量探针）。
 *
 * 它不再负责注册 —— 注册在 answerer.js。
 * 这里只维护一个全局计数与最近一次提问的概要，供调试时快速确认：
 *   globalThis.__DSH_EFFICIENCY__
 *
 * 为什么保留：本插件跑在浏览器里，AI 看不到它的 console。
 * 有个可读取的全局状态，用户/排查者能在 DevTools 里一眼看到是否收到过提问。
 */

/** 全局诊断状态（挂在 globalThis，便于 DevTools 直接查看） */
export function ensureDiag() {
  if (!globalThis.__DSH_EFFICIENCY__) {
    globalThis.__DSH_EFFICIENCY__ = {
      seen: 0,
      answered: 0,
      declined: 0,
      last: null,
      errors: [],
      installedAt: new Date().toISOString(),
    };
  }
  return globalThis.__DSH_EFFICIENCY__;
}

export function diagNoteRequest(request) {
  const d = ensureDiag();
  d.seen += 1;
  d.last = {
    callId: request?.wait?.callId ?? null,
    timed: request?.wait?.timed ?? null,
    count: Array.isArray(request?.questions) ? request.questions.length : null,
    at: new Date().toISOString(),
  };
}

export function diagNoteOutcome(kind) {
  const d = ensureDiag();
  if (kind === 'answered') d.answered += 1;
  else if (kind === 'declined') d.declined += 1;
}

export function diagNoteError(message) {
  const d = ensureDiag();
  d.errors.push({ at: new Date().toISOString(), message: String(message) });
  if (d.errors.length > 20) d.errors.shift();
}
