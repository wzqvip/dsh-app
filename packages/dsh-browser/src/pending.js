/**
 * "待人工"请求的**内存状态机**：/askuser 记一条，/resume 清掉。
 *
 * 为什么只放内存、不落盘：
 *   它描述的是"**此刻**维护者需要做点什么"，容器重启后 agent 会重新发现
 *   （再抓一次页面就知道还是登录页），落盘反而会留下一条早已过期的请求，
 *   让上层误以为还在等人。代价：重启后 `/health.pendingUser` 变空 —— 可接受，
 *   因为 `/snapshot` 随时能重新给出 needsUser/reason。
 *
 * 为什么要限长：这条内容会被上层推送到 Telegram / 显示在进度面板里，
 * 无上限等于把整页正文塞进通知。这里只留"为什么 + 要做什么"。
 */
import { NEEDS_USER_REASONS } from './classify.js';

export const LIMITS = Object.freeze({
  reason: 200,
  instructions: 2_000,
  vncUrl: 500,
});

/**
 * @param {{now?:()=>number}} [options]
 */
export function createPendingRegistry({ now = () => Date.now() } = {}) {
  /** @type {null | {reason:string, instructions:string, vncUrl:string, since:string, sinceMs:number, id:number}} */
  let current = null;
  let sequence = 0;

  /**
   * 记录一条"需要人"请求。
   * @param {{reason?:string, instructions?:string, vncUrl?:string, defaultVncUrl?:string}} input
   * @returns {{ok:true, pending:object}}
   * @throws {Error} 入参不合法时抛，HTTP 层转成 400
   */
  function request(input = {}) {
    const reason = String(input.reason ?? '').trim();
    if (!reason) throw new Error('reason 不能为空');
    if (reason.length > LIMITS.reason) throw new Error(`reason 太长（上限 ${LIMITS.reason} 字符）`);

    const instructions = String(input.instructions ?? '').trim().slice(0, LIMITS.instructions);
    const vncUrl = String(input.vncUrl ?? input.defaultVncUrl ?? '').trim().slice(0, LIMITS.vncUrl);
    if (vncUrl !== '' && !/^https?:\/\//i.test(vncUrl)) {
      throw new Error('vncUrl 必须是 http(s) 地址');
    }

    const timestamp = now();
    sequence += 1;
    current = {
      id: sequence,
      reason,
      instructions,
      vncUrl,
      since: new Date(timestamp).toISOString(),
      sinceMs: timestamp,
      knownReason: NEEDS_USER_REASONS.includes(reason),
    };
    return { ok: true, pending: snapshot() };
  }

  /** 清掉待人工状态（人做完之后调）。重复调用是幂等的。 */
  function resume() {
    const cleared = current !== null;
    current = null;
    return { ok: true, cleared };
  }

  function snapshot() {
    if (!current) return null;
    return {
      id: current.id,
      reason: current.reason,
      instructions: current.instructions,
      vncUrl: current.vncUrl,
      since: current.since,
      knownReason: current.knownReason,
    };
  }

  return {
    request,
    resume,
    /** 当前待人工请求（null 表示没有）。 */
    get: snapshot,
    /** 是否正在等人。 */
    isWaiting: () => current !== null,
  };
}
