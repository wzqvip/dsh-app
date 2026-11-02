import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY,
  HOUR,
  dueReminders,
  offsetLabel,
  planReminders,
  reminderKey,
  reminderText,
} from '../src/reminders.js';

const NOW = new Date('2026-11-02T00:00:00.000Z');

/** 距离 NOW 还有 7 天到期 */
const item = {
  id: 'canvas:assignment:12345',
  title: 'Essay #2',
  dueAt: '2026-11-09T04:59:00.000Z',
  status: 'open',
  tzUncertain: false,
};

test('planReminders: 默认生成 3 个递减提醒', () => {
  const plan = planReminders([item], { now: NOW });
  assert.equal(plan.length, 3);
  assert.deepEqual(
    plan.map((p) => p.at),
    [
      '2026-11-06T04:59:00.000Z', // T-3d
      '2026-11-08T04:59:00.000Z', // T-1d
      '2026-11-09T00:59:00.000Z', // T-4h
    ],
  );
});

test('planReminders: 已过去的时间点不补发', () => {
  // 到 11-08 12:00，T-3d 与 T-1d 都已过去，只剩 T-4h
  const plan = planReminders([item], { now: new Date('2026-11-08T12:00:00.000Z') });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].at, '2026-11-09T00:59:00.000Z');
});

test('planReminders: 跳过 done / dropped / 无截止', () => {
  const plan = planReminders(
    [
      { ...item, status: 'done' },
      { ...item, id: 'b', status: 'dropped' },
      { ...item, id: 'c', dueAt: null },
      { ...item, id: 'd', dueAt: 'garbage' },
    ],
    { now: NOW },
  );
  assert.deepEqual(plan, []);
});

test('planReminders: 发过的键不再出现（重启不重发）', () => {
  const key = reminderKey('canvas:assignment:12345', 3 * DAY);
  const plan = planReminders([item], { now: NOW, sent: new Set([key]) });
  assert.equal(plan.length, 2);
  assert.ok(!plan.some((p) => p.key === key));
});

test('planReminders: 按时间升序', () => {
  const plan = planReminders([item], { now: NOW });
  const times = plan.map((p) => Date.parse(p.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('planReminders: tzUncertain 透传', () => {
  const plan = planReminders([{ ...item, tzUncertain: true }], { now: NOW });
  assert.equal(plan[0].tzUncertain, true);
  assert.match(reminderText(plan[0]), /时区未能确认/);
});

test('planReminders: 非法 now 抛错（早失败胜过静默算错）', () => {
  assert.throws(() => planReminders([item], { now: 'nope' }), /invalid `now`/);
});

test('offsetLabel: 天/小时/分钟', () => {
  assert.equal(offsetLabel(3 * DAY), '3 天前');
  assert.equal(offsetLabel(4 * HOUR), '4 小时前');
  assert.equal(offsetLabel(30 * 60_000), '30 分钟前');
});

test('dueReminders: 只取已到点且未发送的', () => {
  const plan = planReminders([item], { now: NOW });
  assert.equal(dueReminders(plan, NOW).length, 0);

  // T-3d 到点
  const atT3d = new Date('2026-11-06T05:00:00.000Z');
  const due = dueReminders(plan, atT3d);
  assert.equal(due.length, 1);
  assert.equal(due[0].at, '2026-11-06T04:59:00.000Z');

  // 标记已发后不再返回
  assert.equal(dueReminders(plan, atT3d, new Set([due[0].key])).length, 0);
});

test('reminderText: 含标题、提前量、截止时间', () => {
  const plan = planReminders([item], { now: NOW });
  const text = reminderText(plan[0]);
  assert.match(text, /Essay #2/);
  assert.match(text, /3 天前/);
  assert.match(text, /截止：/);
});
