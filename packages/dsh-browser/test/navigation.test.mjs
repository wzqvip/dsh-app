/**
 * 导航「说真话」的两块逻辑：
 *   · `isNavigationApplied` —— 判断导航到底有没有发生（task：Canvas 的 beforeunload 拦截）
 *   · `createDialogHandler` —— beforeunload 要 accept（允许离开），其它弹框 dismiss
 *
 * 这两个函数都不依赖 Playwright，所以能用假 dialog 直接测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDialogHandler, isNavigationApplied } from '../src/navigation.js';

// ── isNavigationApplied ─────────────────────────────────────────────────────

test('现场复现：从 Canvas 答题页 open example.com 失败 → 不算导航', () => {
  const result = isNavigationApplied({
    beforeUrl: 'https://osu.instructure.com/courses/220921/quizzes/1503007/take',
    requestedUrl: 'https://example.com',
    finalUrl: 'https://osu.instructure.com/courses/220921/quizzes/1503007/take',
  });
  assert.equal(result, false, '还停在原页 = 没导航（旧实现会当成功）');
});

test('正常导航：URL 变了就算（哪怕跨域 SSO 跳转）', () => {
  assert.equal(
    isNavigationApplied({
      beforeUrl: 'https://osu.instructure.com/',
      requestedUrl: 'https://osu.instructure.com/',
      finalUrl: 'https://webauth.service.ohio-state.edu/idp/profile/SAML2/Redirect/SSO',
    }),
    true,
    'SSO 跨域跳转是成功导航',
  );
  assert.equal(
    isNavigationApplied({
      beforeUrl: 'about:blank',
      requestedUrl: 'https://example.com',
      finalUrl: 'https://example.com/',
    }),
    true,
  );
});

test('重新加载同一页（URL 没变但 host 与请求一致）→ 算导航', () => {
  assert.equal(
    isNavigationApplied({
      beforeUrl: 'https://example.com/',
      requestedUrl: 'https://example.com',
      finalUrl: 'https://example.com/',
    }),
    true,
  );
});

test('URL 没变且 host 与请求不一致 → 不算导航', () => {
  assert.equal(
    isNavigationApplied({
      beforeUrl: 'https://a.example/x',
      requestedUrl: 'https://b.example/',
      finalUrl: 'https://a.example/x',
    }),
    false,
  );
});

test('空/非法输入一律保守判 false（宁可让上层重试）', () => {
  assert.equal(isNavigationApplied({ beforeUrl: '', requestedUrl: 'https://example.com', finalUrl: '' }), false);
  assert.equal(isNavigationApplied({ beforeUrl: 'https://a/x', requestedUrl: 'not a url', finalUrl: 'https://a/x' }), false);
  assert.equal(isNavigationApplied(), false);
});

// ── createDialogHandler ─────────────────────────────────────────────────────

function fakeDialog(type, message = '') {
  const calls = [];
  return {
    calls,
    type: () => type,
    message: () => message,
    accept: async () => calls.push('accept'),
    dismiss: async () => calls.push('dismiss'),
  };
}

test('beforeunload → accept（允许离开，这是修 bug 的关键）', async () => {
  const dialog = fakeDialog('beforeunload', 'Changes you made may not be saved.');
  const handler = createDialogHandler();
  const decision = await handler(dialog);

  assert.deepEqual(decision, { type: 'beforeunload', action: 'accept' });
  assert.deepEqual(dialog.calls, ['accept']);
});

test('alert / confirm / prompt → dismiss（与 Playwright 默认行为一致，不替人确认危险操作）', async () => {
  for (const type of ['alert', 'confirm', 'prompt']) {
    const dialog = fakeDialog(type);
    const decision = await createDialogHandler()(dialog);
    assert.equal(decision.action, 'dismiss', `${type} 应 dismiss`);
    assert.deepEqual(dialog.calls, ['dismiss']);
  }
});

test('处理弹框失败不抛异常（否则会把后续 CDP 调用带崩），只记 warn', async () => {
  const lines = [];
  const dialog = {
    type: () => 'beforeunload',
    message: () => '',
    accept: async () => {
      throw new Error('Target closed');
    },
    dismiss: async () => {},
  };
  const handler = createDialogHandler({ logger: (level, msg, extra) => lines.push({ level, msg, extra }) });

  const decision = await handler(dialog);
  assert.equal(decision.action, 'accept', '决策仍然返回，便于调用方记录');
  assert.ok(lines.some((l) => l.level === 'warn' && l.msg === 'dialog_handle_failed'));
});

test('弹框文案进日志时截断（可能含页面内容）', async () => {
  const lines = [];
  const handler = createDialogHandler({ logger: (level, msg, extra) => lines.push({ msg, extra }) });
  await handler(fakeDialog('beforeunload', 'x'.repeat(500)));

  const logged = lines.find((l) => l.msg === 'dialog_handled');
  assert.ok(logged);
  assert.equal(logged.extra.message.length, 160);
  assert.equal(logged.extra.action, 'accept');
});
