/**
 * needsUser 判定的单测 —— 这是整个服务里唯一"猜"的地方，逐条钉住。
 *
 * 每条用例都从**观察对象**开始（也就是 src/browser.js 从活页面抽出来的那份事实），
 * 不碰 Playwright、不碰网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEEDS_USER_REASONS,
  REASONS,
  classifyNeedsUser,
  loginHints,
  looksLikeLoginUrl,
} from '../src/classify.js';

/** 一个"正常网页"的观察：有正文、有链接、没有登录痕迹。 */
function normalPage(overrides = {}) {
  return {
    url: 'https://example.com/',
    title: 'Example Domain',
    text: 'Example Domain\nThis domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.',
    readyState: 'complete',
    passwordFieldCount: 0,
    interactiveCount: 2,
    captchaDom: false,
    iframeUrls: [],
    httpStatus: 200,
    loadError: '',
    ...overrides,
  };
}

test('普通页面：不需要人', () => {
  const result = classifyNeedsUser(normalPage());
  assert.equal(result.needsUser, false);
  assert.equal(result.reason, null);
  assert.deepEqual(result.signals, []);
});

test('reason 枚举是稳定的五个值', () => {
  assert.deepEqual([...NEEDS_USER_REASONS].sort(), [
    'blocked',
    'captcha',
    'login_required',
    'mfa_required',
    'unknown',
  ]);
});

test('URL：login.microsoftonline.com → login_required', () => {
  const result = classifyNeedsUser(
    normalPage({
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
      title: 'Sign in to your account',
      text: 'Sign in\nEnter your email, phone, or Skype.',
      interactiveCount: 6,
    }),
  );
  assert.equal(result.needsUser, true);
  assert.equal(result.reason, REASONS.LOGIN);
  assert.ok(result.signals.includes('login_url'));
});

test('URL：/login、/auth、/signin、/oauth2 路径 → login_required', () => {
  const urls = [
    'https://canvas.example.edu/login/canvas',
    'https://portal.example.edu/auth/session',
    'https://app.example.com/signin',
    'https://id.example.com/oauth2/authorize?x=1',
    'https://school.example.edu/Login.aspx',
  ];
  for (const url of urls) {
    const result = classifyNeedsUser(normalPage({ url }));
    assert.equal(result.reason, REASONS.LOGIN, `expected login for ${url}`);
  }
});

test('URL：/authors 这类"像但不是"的路径不误判', () => {
  assert.equal(looksLikeLoginUrl('https://example.com/authors'), false);
  assert.equal(looksLikeLoginUrl('https://example.com/login-help'), false);
  assert.equal(looksLikeLoginUrl('https://example.com/logins'), false);
  assert.equal(looksLikeLoginUrl('https://example.com/articles/auth-in-design'), false);
});

test('URL：非 http(s) 与非法 URL 不算登录页', () => {
  assert.equal(looksLikeLoginUrl('about:blank'), false);
  assert.equal(looksLikeLoginUrl('chrome-error://chromewebdata/'), false);
  assert.equal(looksLikeLoginUrl(''), false);
  assert.equal(looksLikeLoginUrl(null), false);
  assert.equal(looksLikeLoginUrl('not a url'), false);
});

test('页面里有 password 输入框 → login_required（哪怕 URL 很普通）', () => {
  const result = classifyNeedsUser(
    normalPage({
      url: 'https://mail.school.edu/owa/',
      text: 'Please sign in to continue',
      passwordFieldCount: 1,
    }),
  );
  assert.equal(result.reason, REASONS.LOGIN);
  assert.ok(result.signals.includes('password_field'));
});

test('iframe 里是登录页也算（学校的 SSO 常套在 iframe 里）', () => {
  const result = classifyNeedsUser(
    normalPage({
      url: 'https://portal.example.edu/home',
      text: 'Welcome to the student portal. Course materials and grades are below.',
      iframeUrls: ['https://login.microsoftonline.com/common/oauth2/authorize'],
    }),
  );
  assert.equal(result.reason, REASONS.LOGIN);
  assert.ok(result.signals.includes('login_iframe'), 'iframe 命中要和顶层 URL 区分开');
});

test('现场复现：Canvas 答题页的 sso.canvaslms.com iframe **不能**算登录页', () => {
  // 实测页面：已登录的 Canvas 答题页，iframe 是 Instructure 自己的 LTI 消息转发
  const result = classifyNeedsUser(
    normalPage({
      url: 'https://osu.instructure.com/courses/220921/quizzes/1503007/take',
      title: 'Survey: Survey Quiz: Han-Wei Shen',
      text: 'Fill out the 3 question survey\nFlag question: Question 1\nQuestion 1\n1 pts\nAre you interested',
      interactiveCount: 80,
      iframeUrls: [
        'about:blank',
        'https://sso.canvaslms.com/post_message_forwarding?rev=1b7f65852f&token=eyJhbGciOiJIUzUxMiJ9',
      ],
    }),
  );
  assert.equal(result.needsUser, false, '已登录的答题页不该报"需要人"');
  assert.equal(result.reason, null);
});

test('iframe 严格判据：明确登录域名 / 登录路径仍然命中', () => {
  const cases = [
    'https://login.microsoftonline.com/common/oauth2/authorize',
    'https://webauth.service.ohio-state.edu/idp/profile/SAML2/Redirect/SSO',
    'https://shibboleth.osu.edu/idp/Authn/UserPassword',
    'https://sso.school.edu/login',
  ];
  for (const iframeUrl of cases) {
    const result = classifyNeedsUser(
      normalPage({ url: 'https://app.example.edu/home', iframeUrls: [iframeUrl] }),
    );
    assert.equal(result.reason, REASONS.LOGIN, `iframe ${iframeUrl} 应判登录`);
  }
});

test('looksLikeLoginUrl 的 strict 模式：只认强证据', () => {
  // iframe 用的严格模式：不认宽泛的 sso.* 子域
  assert.equal(looksLikeLoginUrl('https://sso.canvaslms.com/post_message_forwarding', { strict: true }), false);
  // 顶层 URL 用的宽模式：sso.* 仍算（学校门户常见）
  assert.equal(looksLikeLoginUrl('https://sso.school.edu/anything'), true);
  // 严格模式下，路径是登录入口的仍然算
  assert.equal(looksLikeLoginUrl('https://sso.school.edu/login', { strict: true }), true);
  assert.equal(looksLikeLoginUrl('https://sso.canvaslms.com/login', { strict: true }), true);
});

test('2FA 文案 → mfa_required', () => {
  const texts = [
    'Enter code\nWe texted a verification code to ••••1234',
    'Use the Microsoft Authenticator app to approve the sign-in request.',
    'Two-step verification is required to continue.',
    '为了保护你的帐户，请输入验证码',
    'Verify your identity to continue to Outlook',
  ];
  for (const text of texts) {
    const result = classifyNeedsUser(normalPage({ url: 'https://outlook.office.com/mail/', text }));
    assert.equal(result.reason, REASONS.MFA, `expected mfa for: ${text.slice(0, 30)}`);
  }
});

test('验证码（captcha）优先于 2FA："Verify you are human" 不能报成 mfa', () => {
  const text = 'Verify you are human by completing the action below.';
  const result = classifyNeedsUser(normalPage({ url: 'https://portal.example.edu/home', text }));
  assert.equal(result.reason, REASONS.CAPTCHA);
});

test('captcha DOM（recaptcha/hcaptcha iframe）→ captcha', () => {
  const result = classifyNeedsUser(
    normalPage({
      captchaDom: true,
      url: 'https://portal.example.edu/home',
      text: 'Please complete the security check to continue browsing the portal.',
    }),
  );
  assert.equal(result.reason, REASONS.CAPTCHA);
  assert.ok(result.signals.includes('captcha_dom'));
});

test('中文验证码文案 → captcha', () => {
  const texts = ['请完成安全验证', '拖动滑块完成拼图', '请输入图形验证码'];
  for (const text of texts) {
    const result = classifyNeedsUser(normalPage({ url: 'https://portal.example.edu/home', text }));
    assert.equal(result.reason, REASONS.CAPTCHA, `expected captcha for: ${text}`);
  }
});

test('被封：正文几乎为空（readyState=complete）→ blocked', () => {
  const result = classifyNeedsUser(
    normalPage({
      text: '   ',
      interactiveCount: 0,
      title: '',
      url: 'https://outlook.office.com/mail/',
    }),
  );
  assert.equal(result.needsUser, true);
  assert.equal(result.reason, REASONS.BLOCKED);
  assert.ok(result.signals.includes('empty_text'));
});

test('被封：HTTP 403/429 → blocked，signal 里带状态码', () => {
  for (const status of [403, 429]) {
    const result = classifyNeedsUser(normalPage({ httpStatus: status }));
    assert.equal(result.reason, REASONS.BLOCKED);
    assert.ok(result.signals.includes(`http_${status}`));
  }
});

test('被封：Access denied 文案 → blocked', () => {
  const result = classifyNeedsUser(
    normalPage({
      text: 'Access denied. Reference #18.abc123. You do not have permission to access this server.',
      url: 'https://outlook.office.com/mail/',
    }),
  );
  assert.equal(result.reason, REASONS.BLOCKED);
});

test('加载出错但页面有内容 → unknown（说不清，交给人）', () => {
  const result = classifyNeedsUser(
    normalPage({
      loadError: 'net::ERR_CONNECTION_RESET',
      url: 'https://portal.example.edu/home',
    }),
  );
  assert.equal(result.needsUser, true);
  assert.equal(result.reason, REASONS.UNKNOWN);
  assert.ok(result.signals.includes('load_error'));
});

test('加载出错且没内容 → blocked（页面根本没出来）', () => {
  const result = classifyNeedsUser(
    normalPage({
      loadError: 'net::ERR_NAME_NOT_RESOLVED',
      text: '',
      interactiveCount: 0,
      title: '',
      url: 'https://nonexistent.invalid/',
    }),
  );
  assert.equal(result.reason, REASONS.BLOCKED);
  assert.ok(result.signals.includes('load_error_empty'));
});

test('调用方显式 hint 优先于所有规则（逃生舱）', () => {
  const result = classifyNeedsUser(normalPage({ hint: 'captcha' }));
  assert.equal(result.reason, REASONS.CAPTCHA);
  assert.deepEqual(result.signals, ['caller_hint']);

  // 非枚举值的 hint 一律忽略，回落到正常判定
  const ignored = classifyNeedsUser(normalPage({ hint: 'do-not-trust-me' }));
  assert.equal(ignored.needsUser, false);
});

test('空/畸形观察不崩、也不误报', () => {
  for (const observation of [undefined, null, {}, { text: null, url: 123 }, []]) {
    const result = classifyNeedsUser(observation);
    assert.equal(typeof result.needsUser, 'boolean');
    assert.equal(result.needsUser, false);
  }
});

test('minTextChars 可调：默认 40 会判"几乎为空"，放宽后不判', () => {
  const shortPage = normalPage({ text: 'Hi', interactiveCount: 1 });
  assert.equal(classifyNeedsUser(shortPage).reason, REASONS.BLOCKED);
  assert.equal(classifyNeedsUser(shortPage, { minTextChars: 2 }).needsUser, false);
});

test('loginHints 只汇报痕迹，不做判定', () => {
  const hints = loginHints(
    normalPage({
      url: 'https://login.microsoftonline.com/',
      passwordFieldCount: 2,
      text: 'Enter the verification code from your authenticator',
    }),
  );
  assert.equal(hints.loginUrl, true);
  assert.equal(hints.passwordFieldPresent, true);
  assert.equal(hints.mfaText, true);
  assert.equal(hints.captchaMarkers, false);

  const clean = loginHints(normalPage());
  assert.equal(clean.loginUrl, false);
  assert.equal(clean.passwordFieldPresent, false);
  assert.equal(clean.mfaText, false);
  assert.equal(clean.captchaMarkers, false);
});
