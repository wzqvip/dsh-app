import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_EVENT_MINUTES, localDateOf, needsUpdate, nextDate, toGoogleEvent } from '../src/calendar/event.js';

const TZ = 'America/New_York';
const item = {
  id: 'canvas:assignment:123',
  title: 'Essay #2',
  course: 'CSE 2231',
  dueAt: '2026-11-09T04:59:00.000Z', // 11/8 23:59 EST
  allDay: false,
  status: 'open',
  revision: 3,
  url: 'https://canvas.example/courses/1/assignments/123',
};

test('toGoogleEvent: 定时事项 → dateTime + 时区 + 幂等键', () => {
  const body = toGoogleEvent(item, { timeZone: TZ });
  assert.equal(body.summary, '⏰ [CSE 2231] Essay #2');
  assert.deepEqual(body.start, { dateTime: '2026-11-09T04:59:00.000Z', timeZone: TZ });
  assert.deepEqual(body.end, {
    dateTime: new Date(Date.parse(item.dueAt) + DEFAULT_EVENT_MINUTES * 60_000).toISOString(),
    timeZone: TZ,
  });
  assert.equal(body.extendedProperties.private.dshItemId, item.id);
  assert.match(body.description, /CSE 2231/);
  assert.match(body.description, /canvas\.example/);
});

test('toGoogleEvent: 日历侧不设提醒（提醒只由 Telegram 推）', () => {
  const body = toGoogleEvent(item, { timeZone: TZ });
  assert.deepEqual(body.reminders, { useDefault: false, overrides: [] });
  assert.equal(body.status, 'confirmed');
});

test('toGoogleEvent: 无截止/坏时间 → null（不建没有时间的事件）', () => {
  assert.equal(toGoogleEvent({ ...item, dueAt: null }), null);
  assert.equal(toGoogleEvent({ ...item, dueAt: 'garbage' }), null);
});

test('toGoogleEvent: 全天事项用 date，end 排他 +1 天', () => {
  // 2026-11-09T04:59Z = 11/8 23:59 EST → 本地日期 11-08
  const body = toGoogleEvent({ ...item, allDay: true }, { timeZone: TZ });
  assert.deepEqual(body.start, { date: '2026-11-08' });
  assert.deepEqual(body.end, { date: '2026-11-09' });
});

test('toGoogleEvent: dropped → cancelled（不删事件，保留记录）', () => {
  const body = toGoogleEvent({ ...item, status: 'dropped' }, { timeZone: TZ });
  assert.equal(body.status, 'cancelled');
});

test('toGoogleEvent: 无 course 时标题不带方括号', () => {
  const body = toGoogleEvent({ ...item, course: null }, { timeZone: TZ });
  assert.equal(body.summary, '⏰ Essay #2');
});

test('toGoogleEvent: 参数校验', () => {
  assert.throws(() => toGoogleEvent({ title: 'x' }), /id\/title is required/);
});

test('localDateOf / nextDate', () => {
  assert.equal(localDateOf('2026-11-09T04:59:00.000Z', TZ), '2026-11-08');
  assert.equal(localDateOf('garbage', TZ), null);
  assert.equal(nextDate('2026-11-08'), '2026-11-09');
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
});

test('needsUpdate: 只比较关心的字段（避免无谓 PATCH 消耗配额）', () => {
  const next = toGoogleEvent(item, { timeZone: TZ });
  assert.equal(needsUpdate(null, next), true);
  assert.equal(
    needsUpdate({ summary: next.summary, start: next.start, end: next.end, status: next.status }, next),
    false,
  );
  // 改期 → 需要更新
  const moved = toGoogleEvent({ ...item, dueAt: '2026-11-10T04:59:00.000Z' }, { timeZone: TZ });
  assert.equal(
    needsUpdate({ summary: next.summary, start: next.start, end: next.end, status: next.status }, moved),
    true,
  );
});
