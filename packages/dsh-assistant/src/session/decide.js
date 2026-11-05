/**
 * 浏览器会话状态机（纯函数）。
 *
 * 维护者的关切（2026-11-03）："Outlook 可能超时会自动要求重新登陆。"
 * 我们要做的是**在它悄悄过期时主动告诉你**，而不是等你发现"怎么不提醒了"。
 *
 * 三条规则：
 *   1. **只在状态跃迁时通知**（正常→需要人 / 需要人→恢复），不是每次都吼
 *   2. 浏览器服务不可达（browserUp=false / 503）视为**暂时性**，不动状态、不通知
 *      —— Chromium 自愈时会短暂 503，那不是"登录过期"
 *   3. 记录 lastOkAt，用于回答"这次登录撑了多久"
 */

/** 会话状态机：给定上一状态与本次观测，返回新状态与该不该通知 */
export function decideSession(prev, observation, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : String(now);
  // 保留 prev 上的其它字段（例如 autoRecoverAt 冷却时间戳）——
  // 否则每次状态机返回都会把它们抹掉，冷却逻辑就失效了。
  const state = {
    ...(prev ?? {}),
    lastCheckAt: at,
    lastOkAt: prev?.lastOkAt ?? null,
    needsUser: prev?.needsUser ?? false,
    reason: prev?.reason ?? null,
    since: prev?.since ?? null,
    // 记录"本次登录态从何时开始"，用于回答会话能撑多久
    okSince: prev?.okSince ?? null,
  };

  // 暂时性故障：不改变"是否需要人"的判断
  if (observation?.browserUp === false || observation?.transient) {
    return { next: state, notify: null };
  }

  const needsUser = observation?.needsUser === true;
  const reason = needsUser ? (observation.reason ?? 'unknown') : null;

  if (needsUser) {
    const wasOk = state.needsUser === false;
    state.needsUser = true;
    state.reason = reason;
    state.since = wasOk && !prev?.needsUser ? at : (prev?.since ?? at);
    state.okSince = null;

    if (wasOk) {
      const lastedSec = prev?.okSince ? Math.round((Date.parse(at) - Date.parse(prev.okSince)) / 1000) : null;
      const lasted = lastedSec !== null ? `本次会话维持了约 ${formatDuration(lastedSec)}。` : '';
      return {
        next: state,
        notify: {
          kind: 'session_expired',
          text:
            `🔐 学校邮箱需要重新登录（原因：${reasonText(reason)}）\n` +
            `${lasted}\n` +
            `请打开 noVNC 登录一次，完成后回复 /ready：\n` +
            `${observation.vncUrl ?? ''}`,
        },
      };
    }
    return { next: state, notify: null };
  }

  // 登录态正常
  const recovered = state.needsUser === true;
  state.needsUser = false;
  state.reason = null;
  state.since = null;
  state.lastOkAt = at;
  if (recovered || !state.okSince) state.okSince = at;

  if (recovered) {
    return {
      next: state,
      notify: {
        kind: 'session_recovered',
        text: '✅ 学校邮箱已重新登录，会话恢复正常。',
      },
    };
  }
  return { next: state, notify: null };
}

export function reasonText(reason) {
  switch (reason) {
    case 'login_required':
      return '会话过期/未登录';
    case 'mfa_required':
      return '需要二次验证';
    case 'captcha':
      return '需要人工过验证码';
    case 'blocked':
      return '页面被拦截';
    default:
      return '未知（页面状态可疑）';
  }
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知时长';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

/** 该不该在这轮做检查（按间隔节流） */
export function shouldCheck(prev, now = new Date(), intervalMinutes = 15) {
  const last = prev?.lastCheckAt ? Date.parse(prev.lastCheckAt) : NaN;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMinutes * 60_000;
}

/** Outlook 会话巡检只认这些站点（含它的登录页） */
export const SESSION_HOSTS = Object.freeze([
  'outlook.cloud.microsoft',
  'outlook.office.com',
  'outlook.office365.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
]);

/**
 * 当前页面是否属于"该做 Outlook 会话巡检"的站点。
 *
 * 为什么需要：浏览器只有**一个受管页**。做 Canvas 的事（读 quiz、登录 SSO）会把受管页
 * 从 Outlook 导航走；此时若照常巡检，就会拿 Canvas 页面的状态去判断 Outlook 会话，
 * 得出"需要重新登录"之类的**假告警**。
 *
 * 实测踩到：读 quiz 后受管页停在 osu.instructure.com，巡检仍按 Outlook 逻辑跑。
 */
export function isSessionHost(url) {
  let host = '';
  try {
    host = new URL(String(url ?? '')).host.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return SESSION_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
