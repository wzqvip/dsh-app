import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideSession,
  formatDuration,
  reasonText,
  shouldCheck,
} from '../src/session/decide.js';

const T0 = new Date('2026-11-03T12:00:00.000Z');
const T1 = new Date('2026-11-03T12:15:00.000Z');
const T2 = new Date('2026-11-04T12:00:00.000Z');

test('decideSession: 首次看到正常 → 记录 okSince，不通知', () => {
  const { next, notify } = decideSession(null, { browserUp: true, needsUser: false }, T0);
  assert.equal(notify, null);
  assert.equal(next.needsUser, false);
  assert.equal(next.okSince, T0.toISOString());
  assert.equal(next.lastOkAt, T0.toISOString());
});

test('decideSession: 正常 → 需要人（跃迁）→ 通知一次，含原因与时长', () => {
  const first = decideSession(null, { browserUp: true, needsUser: false }, T0).next;
  const { next, notify } = decideSession(
    first,
    { browserUp: true, needsUser: true, reason: 'login_required', vncUrl: 'http://vnc' },
    T2,
  );

  assert.equal(next.needsUser, true);
  assert.equal(next.reason, 'login_required');
  assert.ok(notify, '应该通知');
  assert.equal(notify.kind, 'session_expired');
  assert.match(notify.text, /需要重新登录/);
  assert.match(notify.text, /会话过期/);
  assert.match(notify.text, /1 天/); // T0 → T2 约 1 天
  assert.match(notify.text, /http:\/\/vnc/);
});

test('decideSession: 持续需要人 → 不重复通知（防刷屏）', () => {
  const first = decideSession(null, { browserUp: true, needsUser: false }, T0).next;
  const expired = decideSession(first, { browserUp: true, needsUser: true, reason: 'login_required' }, T1).next;
  const again = decideSession(expired, { browserUp: true, needsUser: true, reason: 'login_required' }, T2);
  assert.equal(again.notify, null);
});

test('decideSession: 需要人 → 恢复 → 通知一次', () => {
  const first = decideSession(null, { browserUp: true, needsUser: false }, T0).next;
  const expired = decideSession(first, { browserUp: true, needsUser: true, reason: 'login_required' }, T1).next;
  const recovered = decideSession(expired, { browserUp: true, needsUser: false }, T2);

  assert.ok(recovered.notify);
  assert.equal(recovered.notify.kind, 'session_recovered');
  assert.equal(recovered.next.needsUser, false);
});

test('decideSession: 暂时性故障（503/browserUp=false）不改状态、不通知', () => {
  const first = decideSession(null, { browserUp: true, needsUser: false }, T0).next;
  const transient = decideSession(first, { ok: false, transient: true }, T1);
  assert.equal(transient.notify, null);
  assert.equal(transient.next.needsUser, false);
  assert.equal(transient.next.okSince, first.okSince); // 不清零

  const down = decideSession(first, { browserUp: false }, T1);
  assert.equal(down.notify, null);
});

test('decideSession: 未知 reason 也能通知', () => {
  const first = decideSession(null, { browserUp: true, needsUser: false }, T0).next;
  const { notify } = decideSession(first, { browserUp: true, needsUser: true, reason: 'weird' }, T1);
  assert.match(notify.text, /未知/);
});

test('reasonText: 稳定枚举都有中文说明', () => {
  for (const r of ['login_required', 'mfa_required', 'captcha', 'blocked', 'unknown']) {
    assert.ok(reasonText(r).length > 0, r);
  }
  assert.match(reasonText('nope'), /未知/);
});

test('formatDuration: 天/小时/分钟', () => {
  assert.equal(formatDuration(90), '1 分钟');
  assert.equal(formatDuration(3700), '1 小时 1 分钟');
  assert.equal(formatDuration(90000), '1 天 1 小时');
  assert.equal(formatDuration(NaN), '未知时长');
});

test('shouldCheck: 按间隔节流', () => {
  assert.equal(shouldCheck(null, T0, 15), true);
  assert.equal(shouldCheck({ lastCheckAt: T0.toISOString() }, T1, 15), true);
  assert.equal(
    shouldCheck({ lastCheckAt: T0.toISOString() }, new Date('2026-11-03T12:05:00Z'), 15),
    false,
  );
  assert.equal(shouldCheck({ lastCheckAt: 'garbage' }, T1, 15), true);
});
