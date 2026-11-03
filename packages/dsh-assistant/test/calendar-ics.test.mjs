import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeText, foldLine, toIcs, toUtcStamp } from '../src/calendar/ics.js';

const TZ = 'America/New_York';
const items = [
  {
    id: 'canvas:assignment:123',
    title: 'Essay #2',
    course: 'CSE 2231',
    dueAt: '2026-11-09T04:59:00.000Z',
    status: 'open',
    revision: 3,
    url: 'https://canvas.example/courses/1/assignments/123',
  },
  {
    id: 'canvas:quiz:9',
    title: 'Quiz 3',
    course: 'CSE 2231',
    dueAt: '2026-11-04T04:59:00.000Z',
    status: 'done',
    revision: 1,
  },
];

test('toIcs: 生成合法骨架', () => {
  const ics = toIcs(items, { timeZone: TZ, now: new Date('2026-11-03T00:00:00Z') });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /PRODID:-/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('toIcs: 每个事项一个 VEVENT，UID 稳定且 SEQUENCE=revision', () => {
  const ics = toIcs(items, { timeZone: TZ });
  const events = ics.match(/BEGIN:VEVENT/g) ?? [];
  assert.equal(events.length, 2);
  assert.match(ics, /UID:canvas:assignment:123@dsh-assistant/);
  assert.match(ics, /SEQUENCE:3/);
});

test('toIcs: 已完成的加 ✅ 前缀且 TRANSPARENT', () => {
  const ics = toIcs(items, { timeZone: TZ });
  assert.match(ics, /SUMMARY:✅ \[CSE 2231\] Quiz 3/);
  assert.match(ics, /TRANSP:TRANSPARENT/);
});

test('toIcs: dropped 的事项不出现', () => {
  const ics = toIcs([{ ...items[0], status: 'dropped' }], { timeZone: TZ });
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});

test('toIcs: 无截止/坏时间跳过', () => {
  const ics = toIcs([{ ...items[0], dueAt: null }, { ...items[0], dueAt: 'x' }], { timeZone: TZ });
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});

test('toIcs: 时间用 UTC Z 输出', () => {
  const ics = toIcs([items[0]], { timeZone: TZ });
  assert.match(ics, /DTSTART:20261109T045900Z/);
  assert.match(ics, /DTEND:20261109T051400Z/); // +15 分钟
});

test('toIcs: 全天事项用 VALUE=DATE 且结束 +1 天', () => {
  const ics = toIcs([{ ...items[0], allDay: true }], { timeZone: TZ });
  assert.match(ics, /DTSTART;VALUE=DATE:20261108/);
  assert.match(ics, /DTEND;VALUE=DATE:20261109/);
});

test('toIcs: 文本转义与折行（中文/长标题不破坏格式）', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');

  const longTitle = '很长的标题'.repeat(30);
  const ics = toIcs([{ ...items[0], title: longTitle }], { timeZone: TZ });
  // 每一行（按 CRLF 切）的字节数不超过 75
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line.length}`);
  }
  // 折行后的续行以空格开头
  assert.match(ics, /\r\n /);
});

test('foldLine: 短行原样返回', () => {
  assert.equal(foldLine('short'), 'short');
});

test('toUtcStamp: 格式正确', () => {
  assert.equal(toUtcStamp('2026-11-09T04:59:00.000Z'), '20261109T045900Z');
  assert.equal(toUtcStamp('garbage'), null);
});
