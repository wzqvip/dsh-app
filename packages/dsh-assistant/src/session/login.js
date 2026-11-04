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

/**
 * 登录表单的候选选择器（按站点分"配方"）。
 *
 * 为什么分配方：Outlook 是 Microsoft 的 `#i0116 / #i0118`，
 * 而 OSU 的 Canvas 走 Shibboleth SSO（`webauth.service.ohio-state.edu`，`#username / #password`），
 * 两套 DOM 完全不同。硬塞一套选择器会在另一套上乱填（甚至填进搜索框）。
 */
export const LOGIN_SELECTORS = Object.freeze({
  email: ['input[type="email"]', '#i0116', 'input[name="loginfmt"]'],
  password: ['input[type="password"]', '#i0118', 'input[name="passwd"]'],
  submit: ['#idSIButton9', 'input[type="submit"]', 'button[type="submit"]'],
  staySignedIn: ['#idSIButton9'],
  otherAccount: ['#otherTile', '[data-test-id="otherTile"]'],
});

/** 各站点的登录配方 */
export const LOGIN_PROFILES = Object.freeze({
  microsoft: {
    startUrl: 'https://outlook.office.com/mail/',
    email: LOGIN_SELECTORS.email,
    password: LOGIN_SELECTORS.password,
    submit: LOGIN_SELECTORS.submit,
    // Microsoft 的"保持登录"是同一个按钮
    staySignedIn: LOGIN_SELECTORS.staySignedIn,
    otherAccount: LOGIN_SELECTORS.otherAccount,
    // Microsoft 的账号框本身就是 email 类型，不需要额外点击
    extraClicks: [],
  },
  osu: {
    // OSU Canvas 走 Shibboleth；访问 canvas 会被重定向到 webauth
    startUrl: 'https://osu.instructure.com/',
    email: [
      '#username',
      'input[name="j_username"]',
      'input[name="username"]',
      'input[type="text"][autocomplete="username"]',
    ],
    password: ['#password', 'input[name="j_password"]', 'input[type="password"]'],
    submit: ['input[type="submit"]', 'button[type="submit"]', '#login-button'],
    // OSU 没有"保持登录"，但有 "Is this a private computer/device?" 单选（选 Yes 减少后续验证）
    staySignedIn: [],
    otherAccount: [],
    // 先点 "Yes"（私人设备），再提交
    extraClicks: [
      '#private-computer-yes',
      'input[name="privateComputer"][value="yes"]',
      'label[for="private-computer-yes"]',
    ],
  },
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
  profile = 'microsoft',
  // 显式指定入口时优先；不传则用配方里的 startUrl
  url = null,
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
      // ⚠️ 不能只看 !needsUser —— 跳转中途的空白页也是 needsUser=false，
      // 曾被当成"登录成功"（2026-11-04 实测：Canvas SSO 明明没进去却报成功）。
      if (snap && !snap.needsUser && (snap.chars ?? 0) >= 100) return snap;
      if ((snap?.chars ?? 0) >= 100) return snap;
      await sleep(settleMs);
      snap = await snapshot();
    }
    steps.push(`${label}：页面仍为空（${snap?.chars ?? 0} 字符）`);
    return snap;
  }

  // 按配方决定选择器与入口（microsoft / osu 两套 DOM 完全不同）
  const recipe = LOGIN_PROFILES[profile] ?? LOGIN_PROFILES.microsoft;
  const targetUrl = url ?? recipe.startUrl;

  await open(targetUrl);
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
  let emailStep = await firstSuccess(recipe.email, (selector) => type(selector, creds.email));
  if (!emailStep.ok) {
    const other = await firstSuccess(recipe.otherAccount, (selector) => click(selector));
    if (other.ok) {
      steps.push('点了「使用其他账户」');
      await sleep(settleMs);
      snap = await settledSnapshot('改用其他账户后');
      emailStep = await firstSuccess(recipe.email, (selector) => type(selector, creds.email));
    }
  }

  if (emailStep.ok) {
    steps.push(`填入账号（${emailStep.selector}）`);
    await firstSuccess(recipe.submit, (selector) => click(selector));
    await sleep(settleMs);
    snap = await settledSnapshot('填账号后');
    if (!snap?.needsUser) return done(snap);
  } else {
    steps.push('没找到账号输入框');
  }

  // ② 密码
  const passwordStep = await firstSuccess(recipe.password, (selector) =>
    type(selector, creds.password),
  );
  if (!passwordStep.ok) {
    steps.push('没找到密码输入框');
    return done(snap);
  }
  steps.push(`填入密码（${passwordStep.selector}）`);

  // ②.5 站点特有的附加点击（OSU 的 "Is this a private computer?" → Yes）
  for (const selector of recipe.extraClicks ?? []) {
    const clicked = await firstSuccess([selector], (sel) => click(sel));
    if (clicked.ok) steps.push(`点了附加项（${selector}）`);
  }

  await firstSuccess(recipe.submit, (selector) => click(selector));
  await sleep(settleMs);
  snap = await settledSnapshot('提交密码后');

  // 还在登录页 → 把页面文字的头一段记下来，便于判断是"密码错"还是"卡在 Duo"
  if (snap?.needsUser) {
    const head = String(snap.text ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    steps.push(`提交后仍在登录态（${snap.reason ?? 'unknown'}）：${head}`);
  }

  if (!snap?.needsUser) return done(snap);

  // ③ 2FA / 验证码：到此为止，交还给人
  if (snap.reason === 'mfa_required' || snap.reason === 'captcha') {
    steps.push(`需要人工二次验证（${snap.reason}），停手`);
    return done(snap);
  }

  // ④ "保持登录?" → 是（减少下次重登）
  const stay = await firstSuccess(recipe.staySignedIn, (selector) => click(selector));
  if (stay.ok) steps.push('点了「保持登录」');
  await sleep(settleMs);
  snap = await settledSnapshot('保持登录后');
  return done(snap);
}
