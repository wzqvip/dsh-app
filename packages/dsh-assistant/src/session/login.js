/**
 * 用保存的账号密码完成 Outlook 网页登录（维护者 2026-11-04 授权）。
 *
 * 边界（重要，写死在这里避免以后有人放松）：
 *   · **只填账号和密码**；2FA 验证码**永不填写**（那必须人来做，也做不了）
 *   · 密码只从 `/data/outlook.json` 读，**绝不写进日志、错误信息、state.json**
 *   · 遇到 mfa_required / captcha 立刻停手并把控制权交还给人
 *   · 每步都重新快照判断，成功即停（不做"无脑点到底"）
 *
 * 为什么需要它：Chrome 里虽然存了密码，但被登出后落在 ABTSignout 这类
 * "无表单"页面时，密码管理器不会自动填充 —— 必须真的走到登录表单上。
 */

/** 登录表单的候选选择器（按优先级；命中第一个即可） */
export const LOGIN_SELECTORS = Object.freeze({
  email: ['input[type="email"]', '#i0116', 'input[name="loginfmt"]'],
  password: ['input[type="password"]', '#i0118', 'input[name="passwd"]'],
  submit: ['#idSIButton9', 'input[type="submit"]', 'button[type="submit"]'],
  staySignedIn: ['#idSIButton9'],
  otherAccount: ['#otherTile', '[data-test-id="otherTile"]'],
});

/** 哪些状态值得尝试"填密码" */
export function shouldAttemptLogin(reason) {
  return reason === 'login_required' || reason === 'blocked' || reason === null;
}

/**
 * 依次尝试一组选择器执行动作，返回第一个成功的。
 * @returns {Promise<{ok:boolean, selector?:string, tried:number}>}
 */
async function firstSuccess(selectors, run) {
  let tried = 0;
  for (const selector of selectors) {
    tried += 1;
    const result = await run(selector);
    if (result?.ok) return { ok: true, selector, tried };
  }
  return { ok: false, tried };
}

/**
 * 尝试用账号密码登录。
 *
 * @param {object} options
 * @param {(url:string)=>Promise<object>} options.open
 * @param {()=>Promise<object>} options.snapshot
 * @param {(selector:string, text:string)=>Promise<object>} options.type
 * @param {(selector:string)=>Promise<object>} options.click
 * @param {{email:string, password:string}} options.creds
 * @param {string} [options.url]
 * @param {(msg:string)=>void} [options.log]
 * @param {(ms:number)=>Promise<void>} [options.sleep] 注入以便测试
 * @param {number} [options.settleMs] 每步后等页面渲染的时间
 * @returns {Promise<{ok:boolean, needsUser:boolean, reason:string|null, steps:string[]}>}
 */
export async function attemptPasswordLogin({
  open,
  snapshot,
  type,
  click,
  creds,
  url = 'https://outlook.office.com/mail/',
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  settleMs = 3500,
} = {}) {
  const steps = [];
  const done = (snap, extra = {}) => ({
    ok: !snap?.needsUser,
    needsUser: snap?.needsUser === true,
    reason: snap?.reason ?? null,
    steps,
    ...extra,
  });

  if (!creds?.email || !creds?.password) {
    steps.push('缺少凭据，跳过');
    return { ok: false, needsUser: true, reason: 'no_credentials', steps };
  }

  /**
   * 抓一次"渲染稳定后"的快照。
   *
   * 实测踩到：打开页面立刻抓只有 95 字符（还在加载），于是"没找到密码输入框"。
   * 现在等页面落定；若仍几乎为空，最多重试 3 次。
   */
  async function settledSnapshot(label) {
    let snap = await snapshot();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (snap && !snap.needsUser) return snap;
      if ((snap?.chars ?? 0) >= 100) return snap;
      await sleep(settleMs);
      snap = await snapshot();
    }
    steps.push(`${label}：页面仍为空（${snap?.chars ?? 0} 字符）`);
    return snap;
  }

  await open(url);
  await sleep(settleMs);
  let snap = await settledSnapshot('打开');
  steps.push(
    `打开后：${snap?.needsUser ? `需要人(${snap?.reason})` : '已登录'}（${snap?.chars ?? 0} 字符）`,
  );
  if (!snap?.needsUser) return done(snap);

  if (!shouldAttemptLogin(snap.reason)) {
    steps.push(`reason=${snap.reason} 必须人工，停手`);
    return done(snap);
  }

  // ① 账号：先直接找输入框；找不到多半是"选账户"页 → 点『使用其他账户』再来一次
  let emailStep = await firstSuccess(LOGIN_SELECTORS.email, (selector) => type(selector, creds.email));
  if (!emailStep.ok) {
    const other = await firstSuccess(LOGIN_SELECTORS.otherAccount, (selector) => click(selector));
    if (other.ok) {
      steps.push('点了「使用其他账户」');
      await sleep(settleMs);
      snap = await settledSnapshot('改用其他账户后');
      emailStep = await firstSuccess(LOGIN_SELECTORS.email, (selector) => type(selector, creds.email));
    }
  }

  if (emailStep.ok) {
    steps.push(`填入账号（${emailStep.selector}）`);
    await firstSuccess(LOGIN_SELECTORS.submit, (selector) => click(selector));
    await sleep(settleMs);
    snap = await settledSnapshot('填账号后');
    if (!snap?.needsUser) return done(snap);
  } else {
    steps.push('没找到账号输入框');
  }

  // ② 密码
  const passwordStep = await firstSuccess(LOGIN_SELECTORS.password, (selector) =>
    type(selector, creds.password),
  );
  if (!passwordStep.ok) {
    steps.push('没找到密码输入框');
    return done(snap);
  }
  steps.push(`填入密码（${passwordStep.selector}）`);
  await firstSuccess(LOGIN_SELECTORS.submit, (selector) => click(selector));
  await sleep(settleMs);
  snap = await settledSnapshot('提交密码后');
  if (!snap?.needsUser) return done(snap);

  // ③ 2FA / 验证码：到此为止，交还给人
  if (snap.reason === 'mfa_required' || snap.reason === 'captcha') {
    steps.push(`需要人工二次验证（${snap.reason}），停手`);
    return done(snap);
  }

  // ④ "保持登录?" → 是（减少下次重登）
  const stay = await firstSuccess(LOGIN_SELECTORS.staySignedIn, (selector) => click(selector));
  if (stay.ok) steps.push('点了「保持登录」');
  await sleep(settleMs);
  snap = await settledSnapshot('保持登录后');
  return done(snap);
}
