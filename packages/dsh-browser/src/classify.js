/**
 * 核心判定：这一页**是否必须由人来操作**（登录 / 2FA / 验证码 / 被封 / 说不清）。
 *
 * 为什么把它做成**纯函数**：
 *   这是整个服务里唯一"猜"的地方 —— 猜错了就是 agent 拿不到数据，或者更糟：
 *   agent 在一张"输入验证码"的页面上乱点。所以规则要能被单测逐条钉住，
 *   而不是藏在 CDP 调用里只能靠真实页面回归。
 *
 * 输入是「观察」（observation）—— 由 src/browser.js 从活页面抽出来的结构化事实，
 * 不依赖 Playwright。单测可以直接构造任意恶意/诡异的观察。
 *
 * ── 判定优先级（顺序即优先级，写死在 classifyNeedsUser 里）──
 *   1. login_required   URL 是登录页（宿主/路径），或页面上有 password 输入框
 *   2. captcha          验证码痕迹（DOM 里的 recaptcha 之类 iframe，或文案）
 *   3. mfa_required     2FA 文案（"enter code" / "Authenticator" / "验证码" / "verify ..."）
 *   4. blocked          明确的封禁文案 / HTTP 403-451-503 / 正文几乎为空
 *   5. unknown          页面加载出错但又有内容 —— 不知道发生了什么，交给人
 *
 * ⚠️ 为什么 captcha 排在 mfa 前面（任务书里 2FA 写在验证码前面）：
 *   验证码页面的文案几乎都含 "verify"（"Verify you are human"），而任务的 2FA
 *   关键词里就包含裸的 "verify"。若先判 mfa，所有验证码都会被误报成 mfa_required，
 *   维护者按提示去"输入验证码"时看到的是"拖滑块"，体验崩坏。
 *   captcha 的判据（recaptcha/not a robot/人机验证/滑块）不会命中真正的 2FA 页面，
 *   所以先判 captcha 只会更准，不影响稳定枚举。
 */

/** 稳定枚举 —— 契约的一部分，新增值要同步 assistant 侧与文档。 */
export const REASONS = Object.freeze({
  LOGIN: 'login_required',
  MFA: 'mfa_required',
  CAPTCHA: 'captcha',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
});

export const NEEDS_USER_REASONS = Object.freeze(Object.values(REASONS));

/** 正文短于这个长度（且没有可交互元素）就认为"页面没内容"，多半被挡了。 */
export const NEAR_EMPTY_MIN_CHARS = 40;

// ── 登录页识别 ───────────────────────────────────────────────────────────────

/**
 * 宿主名本身就是登录入口。刻意覆盖常见的 SSO 子域（login./sso./auth./idp.）：
 * 学校门户千奇百怪，靠通配子域比穷举域名稳。
 */
const LOGIN_HOSTS = Object.freeze([
  /(?:^|\.)login\.microsoftonline\.com$/,
  /(?:^|\.)login\.live\.com$/,
  /(?:^|\.)login\.microsoft\.com$/,
  /(?:^|\.)accounts\.google\.com$/,
  /(?:^|\.)signin\.aws\.amazon\.com$/,
  /(?:^|\.)(?:login|signin|sso|idp|auth|adfs|sts)\.(?:[a-z0-9-]+\.)+[a-z]{2,}$/,
  // 微软/谷歌的 MFA 专属宿主（登录后才有）
  /(?:^|\.)mysignins\.microsoft\.com$/,
]);

/**
 * 路径本身就是登录入口。
 * 边界用 `[./]|$|/` 卡住，避免 `/authors`、`/login-help` 这类误伤
 * （`/login-help` 里的 `-` 不是边界 → 不匹配）。
 */
const LOGIN_PATH_RE = /(?:^|\/)(?:login|log-?in|signin|sign-in|signon|sign-on|logon|oauth2?|authorize|auth|sso|saml2?|adfs|cas)(?:[./]|$)/i;

/** 判断一个 URL 是否"看起来是登录/鉴权入口"。非 http(s) 一律 false。 */
export function looksLikeLoginUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (LOGIN_HOSTS.some((re) => re.test(host))) return true;
  return LOGIN_PATH_RE.test(parsed.pathname);
}

// ── 文案特征 ────────────────────────────────────────────────────────────────

/** 验证码 / 人机校验。Windows/Linux 上的实现在 DOM 里通常还有 iframe，见下方 captchaDom。 */
const CAPTCHA_PATTERNS = Object.freeze([
  /\bcaptcha\b/i,
  /recaptcha|hcaptcha|turnstile/i,
  /not a robot/i,
  /are you (?:a )?human/i,
  /verify (?:that )?you are (?:a )?human/i,
  /human verification/i,
  /checking your browser/i,
  /just a moment\.\.\./i,
  /ddos protection by/i,
  /人机验证/,
  /滑块/,
  /图形验证码/,
  /安全验证/,
  /请完成(?:下方的)?验证/,
  /拖动(?:滑块|下方)/,
]);

/**
 * 二次验证 / MFA。
 * 注意 "verify" 单独一条是**任务书要求的**，它能命中微软的
 * "Verify your identity" 页；captcha 已先判，所以不会把
 * "Verify you are human" 误吞进来。
 */
const MFA_PATTERNS = Object.freeze([
  /verification code/i,
  /enter (?:the )?(?:\w+ )?code/i,
  /one[- ]?time (?:code|password|passcode|passcode)/i,
  /two[- ]?(?:step|factor|stage)/i,
  /2[- ]?(?:step|factor|fa)\b/i,
  /authenticator/i,
  /approve (?:the |a |your )?(?:sign-?in|request|login)/i,
  /verify your identity/i,
  /verifying your identity/i,
  /verify it'?s you/i,
  /\bverify\b/i,
  /security code/i,
  /验证码/,
  /双重验证|二次验证|两步验证/,
  /身份验证器|验证器应用/,
  /动态(?:码|密码)/,
  /安全信息(?:确认|验证)/,
]);

/** 明确被拒 / 被风控挡住。 */
const BLOCKED_PATTERNS = Object.freeze([
  /access (?:is )?denied/i,
  /403 forbidden/i,
  /request blocked/i,
  /you have been blocked/i,
  /unusual traffic/i,
  /automated (?:queries|requests)/i,
  /enable javascript and cookies/i,
  /site connection is secure/i,
  /account (?:has been )?(?:locked|suspended)/i,
  /请求被拒绝|访问被拒绝|禁止访问|拒绝访问/,
  /访问受限|您的访问已被限制|无法访问此网站/,
  /帐户?已被(?:锁定|停用|禁用)/,
]);

const BLOCKING_HTTP_STATUS = Object.freeze([401, 403, 407, 429, 451, 503]);

function matchFirst(text, patterns) {
  for (const re of patterns) {
    if (re.test(text)) return re;
  }
  return null;
}

// ── 观察归一化 ──────────────────────────────────────────────────────────────

function toText(value) {
  return typeof value === 'string' ? value : '';
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 把外部传入的观察整理成判定需要的形状。
 * 缺失字段一律安全降级为"没有证据"，绝不因为字段缺失就报 needsUser。
 */
export function normalizeObservation(raw) {
  const obs = raw && typeof raw === 'object' ? raw : {};
  const iframeUrls = Array.isArray(obs.iframeUrls)
    ? obs.iframeUrls.filter((u) => typeof u === 'string' && u !== '').slice(0, 40)
    : [];
  const httpStatus = Number(obs.httpStatus);
  return {
    url: toText(obs.url),
    title: toText(obs.title),
    text: toText(obs.text),
    readyState: toText(obs.readyState),
    passwordFieldCount: toCount(obs.passwordFieldCount),
    interactiveCount: toCount(obs.interactiveCount),
    captchaDom: obs.captchaDom === true,
    iframeUrls,
    loadError: toText(obs.loadError),
    httpStatus: Number.isFinite(httpStatus) && httpStatus > 0 ? httpStatus : null,
    hint: toText(obs.hint),
  };
}

// ── 主判定 ──────────────────────────────────────────────────────────────────

/**
 * @param {object} observation
 * @param {{minTextChars?:number}} [options]
 * @returns {{needsUser:boolean, reason:string|null, signals:string[]}}
 */
export function classifyNeedsUser(observation = {}, options = {}) {
  const minTextChars = Number.isFinite(Number(options.minTextChars))
    ? Math.max(0, Number(options.minTextChars))
    : NEAR_EMPTY_MIN_CHARS;
  const obs = normalizeObservation(observation);
  const text = obs.text;
  const haystack = `${obs.title}\n${text}`;

  // 调用方显式指定（逃生舱：上层已经知道原因，别让规则再猜）
  if (obs.hint && NEEDS_USER_REASONS.includes(obs.hint)) {
    return { needsUser: true, reason: obs.hint, signals: ['caller_hint'] };
  }

  // 1. 登录
  const urls = [obs.url, ...obs.iframeUrls];
  if (urls.some((u) => looksLikeLoginUrl(u))) {
    return { needsUser: true, reason: REASONS.LOGIN, signals: ['login_url'] };
  }
  if (obs.passwordFieldCount > 0) {
    return { needsUser: true, reason: REASONS.LOGIN, signals: ['password_field'] };
  }

  // 2. 验证码（先于 MFA，理由见文件头）
  if (obs.captchaDom) {
    return { needsUser: true, reason: REASONS.CAPTCHA, signals: ['captcha_dom'] };
  }
  if (matchFirst(haystack, CAPTCHA_PATTERNS)) {
    return { needsUser: true, reason: REASONS.CAPTCHA, signals: ['captcha_text'] };
  }

  // 3. 2FA
  const mfaHit = matchFirst(haystack, MFA_PATTERNS);
  if (mfaHit) {
    return { needsUser: true, reason: REASONS.MFA, signals: ['mfa_text'] };
  }

  // 4. 被挡
  if (matchFirst(haystack, BLOCKED_PATTERNS)) {
    return { needsUser: true, reason: REASONS.BLOCKED, signals: ['blocked_text'] };
  }
  if (obs.httpStatus !== null && BLOCKING_HTTP_STATUS.includes(obs.httpStatus)) {
    return { needsUser: true, reason: REASONS.BLOCKED, signals: [`http_${obs.httpStatus}`] };
  }
  const nearEmpty = text.trim().length < minTextChars && obs.interactiveCount < 3;
  if (nearEmpty && (obs.readyState === 'complete' || obs.loadError !== '')) {
    return {
      needsUser: true,
      reason: REASONS.BLOCKED,
      signals: [obs.loadError !== '' ? 'load_error_empty' : 'empty_text'],
    };
  }

  // 5. 说不清
  //    加载出错却又有内容 → 我们真的不知道发生了什么，如实升级给人。
  //    （没内容的情况已在上面判成 blocked，所以这里只剩这一种。）
  if (obs.loadError !== '') {
    return { needsUser: true, reason: REASONS.UNKNOWN, signals: ['load_error'] };
  }

  return { needsUser: false, reason: null, signals: [] };
}

/**
 * 给 /health 用的「登录线索」——不判断要不要人，只汇报看到的痕迹。
 */
export function loginHints(observation = {}) {
  const obs = normalizeObservation(observation);
  const haystack = `${obs.title}\n${obs.text}`;
  return {
    passwordFieldPresent: obs.passwordFieldCount > 0,
    loginUrl: looksLikeLoginUrl(obs.url),
    mfaText: matchFirst(haystack, MFA_PATTERNS) !== null,
    captchaMarkers: obs.captchaDom || matchFirst(haystack, CAPTCHA_PATTERNS) !== null,
  };
}
