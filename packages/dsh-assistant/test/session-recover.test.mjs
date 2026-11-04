import test from 'node:test';
import assert from 'node:assert/strict';

import { attemptAutoRecover, SAFE_CLICK_SELECTORS, shouldAttemptRecovery } from '../src/session/recover.js';

function harness({ snaps, clickOk = () => true }) {
  const clicks = [];
  const opens = [];
  let index = 0;
  return {
    clicks,
    opens,
    deps: {
      url: 'https://outlook.office.com/mail/',
      log: () => {},
      open: async (url) => {
        opens.push(url);
        return { ok: true };
      },
      snapshot: async () => {
        const snap = snaps[Math.min(index, snaps.length - 1)];
        index += 1;
        return snap;
      },
      click: async (selector) => {
        const ok = clickOk(selector);
        clicks.push({ selector, ok });
        return { ok };
      },
    },
  };
}

test('shouldAttemptRecovery: 只对 login_required/blocked/null 尝试', () => {
  assert.equal(shouldAttemptRecovery('login_required'), true);
  assert.equal(shouldAttemptRecovery('blocked'), true);
  assert.equal(shouldAttemptRecovery(null), true);
  assert.equal(shouldAttemptRecovery('mfa_required'), false);
  assert.equal(shouldAttemptRecovery('captcha'), false);
});

test('attemptAutoRecover: 重新打开就恢复了 → 不点任何按钮', async () => {
  const h = harness({ snaps: [{ needsUser: false, chars: 900 }] });
  const result = await attemptAutoRecover(h.deps);
  assert.equal(result.recovered, true);
  assert.equal(h.clicks.length, 0);
  assert.deepEqual(h.opens, ['https://outlook.office.com/mail/']);
});

test('attemptAutoRecover: mfa_required 必须人工 → 不点击', async () => {
  const h = harness({ snaps: [{ needsUser: true, reason: 'mfa_required' }] });
  const result = await attemptAutoRecover(h.deps);
  assert.equal(result.recovered, false);
  assert.equal(h.clicks.length, 0);
});

test('attemptAutoRecover: 点中账户磁贴后恢复', async () => {
  const h = harness({
    snaps: [
      { needsUser: true, reason: 'login_required' },
      { needsUser: false, chars: 1200 },
    ],
    clickOk: (selector) => selector === SAFE_CLICK_SELECTORS[0],
  });
  const result = await attemptAutoRecover(h.deps);
  assert.equal(result.recovered, true);
  assert.equal(h.clicks.length, 1);
  assert.equal(h.clicks[0].selector, SAFE_CLICK_SELECTORS[0]);
});

test('attemptAutoRecover: 所有按钮都点不中 → 交还给人，尝试记录完整', async () => {
  const h = harness({
    snaps: [{ needsUser: true, reason: 'login_required' }],
    clickOk: () => false,
  });
  const result = await attemptAutoRecover(h.deps);
  assert.equal(result.recovered, false);
  assert.equal(h.clicks.length, SAFE_CLICK_SELECTORS.length);
  assert.equal(result.attempts.length, SAFE_CLICK_SELECTORS.length);
  assert.ok(result.attempts.every((a) => a.ok === false));
});

test('attemptAutoRecover: click 抛错不影响后续尝试', async () => {
  const h = harness({ snaps: [{ needsUser: true, reason: 'login_required' }] });
  let calls = 0;
  h.deps.click = async (selector) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { ok: false };
  };
  const result = await attemptAutoRecover(h.deps);
  assert.equal(result.recovered, false);
  assert.equal(result.attempts[0].ok, false);
  assert.match(String(result.attempts[0].error), /boom/);
  assert.equal(calls, SAFE_CLICK_SELECTORS.length);
});

test('SAFE_CLICK_SELECTORS: 只包含按钮类，不含密码输入框', () => {
  for (const selector of SAFE_CLICK_SELECTORS) {
    assert.ok(!/password|passwd|type="password"/i.test(selector), `危险选择器：${selector}`);
  }
});
