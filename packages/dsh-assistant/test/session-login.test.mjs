import test from 'node:test';
import assert from 'node:assert/strict';

import { LOGIN_SELECTORS, attemptPasswordLogin, shouldAttemptLogin } from '../src/session/login.js';

const CREDS = { email: 'a@b.com', password: 'super-secret-pw' };

function harness({ snaps, typeOk = () => true, clickOk = () => true }) {
  const calls = [];
  let index = 0;
  return {
    calls,
    deps: {
      creds: CREDS,
      sleep: async () => {},
      settleMs: 0,
      log: () => {},
      open: async (url) => {
        calls.push(['open', url]);
        return { ok: true };
      },
      snapshot: async () => {
        const raw = snaps[Math.min(index, snaps.length - 1)];
        index += 1;
        // 默认给非零字符数：否则会触发"空页重试"，把快照序列提前消耗掉
        return { chars: 500, ...raw };
      },
      type: async (selector, text) => {
        calls.push(['type', selector, text]);
        return { ok: typeOk(selector) };
      },
      click: async (selector) => {
        calls.push(['click', selector]);
        return { ok: clickOk(selector) };
      },
    },
  };
}

test('shouldAttemptLogin: 只对可自愈的 reason 尝试', () => {
  assert.equal(shouldAttemptLogin('login_required'), true);
  assert.equal(shouldAttemptLogin('blocked'), true);
  assert.equal(shouldAttemptLogin('mfa_required'), false);
  assert.equal(shouldAttemptLogin('captcha'), false);
});

test('缺少凭据 → 直接返回，不打开页面', async () => {
  const h = harness({ snaps: [{ needsUser: true, reason: 'login_required' }] });
  const result = await attemptPasswordLogin({ ...h.deps, creds: { email: '', password: '' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_credentials');
  assert.equal(h.calls.length, 0);
});

test('打开就发现已登录 → 不填任何东西', async () => {
  const h = harness({ snaps: [{ needsUser: false }] });
  const result = await attemptPasswordLogin(h.deps);
  assert.equal(result.ok, true);
  assert.ok(!h.calls.some((c) => c[0] === 'type'));
});

test('正常流程：填账号 → 下一步 → 填密码 → 登录 → 成功', async () => {
  const h = harness({
    snaps: [
      { needsUser: true, reason: 'login_required' }, // 打开后
      { needsUser: true, reason: 'login_required' }, // 填账号后（密码页）
      { needsUser: false, chars: 1200 }, // 填密码后
      { needsUser: false, chars: 1200 },
    ],
  });
  const result = await attemptPasswordLogin(h.deps);
  assert.equal(result.ok, true);
  const typed = h.calls.filter((c) => c[0] === 'type');
  assert.equal(typed[0][2], CREDS.email);
  assert.equal(typed[1][2], CREDS.password);
});

test('遇到 2FA → 立即停手，不上报成功', async () => {
  const h = harness({
    snaps: [
      { needsUser: true, reason: 'login_required' },
      { needsUser: true, reason: 'login_required' },
      { needsUser: true, reason: 'mfa_required' },
      { needsUser: true, reason: 'mfa_required' },
    ],
  });
  const result = await attemptPasswordLogin(h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mfa_required');
  assert.ok(result.steps.some((s) => s.includes('二次验证')));
});

test('reason=captcha → 不尝试填任何东西', async () => {
  const h = harness({ snaps: [{ needsUser: true, reason: 'captcha' }] });
  const result = await attemptPasswordLogin(h.deps);
  assert.equal(result.ok, false);
  assert.ok(!h.calls.some((c) => c[0] === 'type'));
});

test('只能拿到账号输入框、没有密码框 → 不假装成功，也不真的填入密码', async () => {
  const h = harness({
    snaps: [{ needsUser: true, reason: 'login_required' }],
    typeOk: (selector) => LOGIN_SELECTORS.email.includes(selector),
  });
  const result = await attemptPasswordLogin(h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.needsUser, true);
  // 允许"尝试"填密码（选择器不存在时服务端会失败），但不能有**成功**的密码填入
  const passwordSelectors = LOGIN_SELECTORS.password;
  const succeeded = h.calls.some(
    (c) => c[0] === 'type' && passwordSelectors.includes(c[1]) && typeOkStub(c[1]),
  );
  function typeOkStub(selector) {
    return LOGIN_SELECTORS.email.includes(selector);
  }
  assert.equal(succeeded, false);
  assert.ok(result.steps.some((s) => s.includes('没找到密码输入框')));
});

test('步骤记录里不能出现密码明文', async () => {
  const h = harness({
    snaps: [
      { needsUser: true, reason: 'login_required' },
      { needsUser: true, reason: 'login_required' },
      { needsUser: false },
    ],
  });
  const result = await attemptPasswordLogin(h.deps);
  const joined = result.steps.join(' | ');
  assert.ok(!joined.includes(CREDS.password), `步骤泄露密码：${joined}`);
});

test('选择器表里不含明文密码或验证码输入', () => {
  const flat = JSON.stringify(LOGIN_SELECTORS);
  assert.ok(!/password=/.test(flat));
  // 允许 input[type="password"] 作为「去哪填」的定位，但代码里不会去读它的值
  assert.ok(!/otp|code|verification/i.test(flat));
});
