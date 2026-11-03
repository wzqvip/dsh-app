/**
 * 待人工状态机：/askuser → /resume 的生命周期与入参边界。
 * 不碰网络、不碰浏览器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, createPendingRegistry } from '../src/pending.js';
import { NEEDS_USER_REASONS } from '../src/classify.js';

/** 可注入时钟，避免依赖真实时间 */
function fixedClock(start = Date.parse('2026-11-03T19:00:00.000Z')) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test('初始状态：没有待人工请求', () => {
  const registry = createPendingRegistry();
  assert.equal(registry.get(), null);
  assert.equal(registry.isWaiting(), false);
});

test('askuser 后能拿到完整记录，含 ISO 时间戳', () => {
  const clock = fixedClock();
  const registry = createPendingRegistry({ now: clock.now });

  const result = registry.request({
    reason: 'login_required',
    instructions: '请在 noVNC 里登录学校邮箱，完成后告诉我',
    vncUrl: 'http://192.168.3.30:16080/vnc.html',
  });

  assert.equal(result.ok, true);
  assert.equal(result.pending.reason, 'login_required');
  assert.equal(result.pending.instructions, '请在 noVNC 里登录学校邮箱，完成后告诉我');
  assert.equal(result.pending.since, '2026-11-03T19:00:00.000Z');
  assert.equal(result.pending.knownReason, true);
  assert.equal(registry.isWaiting(), true);
  assert.deepEqual(registry.get(), result.pending);
});

test('vncUrl 可缺省，回落到 defaultVncUrl', () => {
  const registry = createPendingRegistry();
  const result = registry.request({ reason: 'mfa_required', defaultVncUrl: 'http://127.0.0.1:16080/' });
  assert.equal(result.pending.vncUrl, 'http://127.0.0.1:16080/');
  assert.equal(result.pending.instructions, '');
});

test('vncUrl 必须是 http(s)', () => {
  const registry = createPendingRegistry();
  assert.throws(() => registry.request({ reason: 'login_required', vncUrl: 'javascript:alert(1)' }), /vncUrl/);
  assert.throws(() => registry.request({ reason: 'login_required', vncUrl: 'vnc://host:5900' }), /vncUrl/);
});

test('reason 必填、有长度上限', () => {
  const registry = createPendingRegistry();
  assert.throws(() => registry.request({}), /reason 不能为空/);
  assert.throws(() => registry.request({ reason: '   ' }), /reason 不能为空/);
  assert.throws(() => registry.request({ reason: 'x'.repeat(LIMITS.reason + 1) }), /太长/);
});

test('instructions 超长时截断而不是报错（上层可能塞了整段正文）', () => {
  const registry = createPendingRegistry();
  const result = registry.request({ reason: 'unknown', instructions: 'a'.repeat(LIMITS.instructions + 500) });
  assert.equal(result.pending.instructions.length, LIMITS.instructions);
});

test('非枚举的 reason 也接受，但 knownReason=false（便于上层区分）', () => {
  const registry = createPendingRegistry();
  const result = registry.request({ reason: 'policy_denied' });
  assert.equal(result.pending.reason, 'policy_denied');
  assert.equal(result.pending.knownReason, false);
  assert.ok(!NEEDS_USER_REASONS.includes('policy_denied'));
});

test('resume 清空且幂等', () => {
  const registry = createPendingRegistry();
  registry.request({ reason: 'login_required' });
  assert.deepEqual(registry.resume(), { ok: true, cleared: true });
  assert.equal(registry.get(), null);
  assert.deepEqual(registry.resume(), { ok: true, cleared: false });
});

test('同一时刻以最后一次 askuser 为准，id 递增', () => {
  const clock = fixedClock();
  const registry = createPendingRegistry({ now: clock.now });
  const first = registry.request({ reason: 'login_required' });
  clock.advance(60_000);
  const second = registry.request({ reason: 'mfa_required' });

  assert.ok(second.pending.id > first.pending.id);
  assert.equal(registry.get().reason, 'mfa_required');
  assert.equal(registry.get().since, '2026-11-03T19:01:00.000Z');
});

test('返回的 pending 是快照：外部改写不影响内部状态', () => {
  const registry = createPendingRegistry();
  const { pending } = registry.request({ reason: 'login_required' });
  pending.reason = 'captcha';
  assert.equal(registry.get().reason, 'login_required');
});
