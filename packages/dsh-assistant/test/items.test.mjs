import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contentHash,
  itemId,
  mergeItems,
  normalizeItem,
  setStatus,
  toIso,
} from '../src/items.js';

const NOW = new Date('2026-11-02T00:00:00.000Z');

const essay = {
  source: 'canvas',
  kind: 'assignment',
  sourceId: '12345',
  title: 'Essay #2',
  course: 'CSE 2231',
  dueAt: '2026-11-09T04:59:00Z',
  url: 'https://canvas.example/courses/1/assignments/12345',
};

test('normalizeItem: 合法输入归一化', () => {
  const { item } = normalizeItem(essay, NOW);
  assert.equal(item.id, 'canvas:assignment:12345');
  assert.equal(item.dueAt, '2026-11-09T04:59:00.000Z');
  assert.equal(item.allDay, false);
  assert.equal(item.status, 'open');
  assert.equal(item.revision, 1);
  assert.equal(item.confidence, 1);
  assert.equal(item.firstSeenAt, NOW.toISOString());
  assert.match(item.contentHash, /^[0-9a-f]{16}$/);
});

test('normalizeItem: 非法输入给出可读原因而不是抛错', () => {
  assert.match(normalizeItem(null, NOW).error, /plain object/);
  assert.match(normalizeItem({ ...essay, source: 'wechat' }, NOW).error, /unknown source/);
  assert.match(normalizeItem({ ...essay, kind: 'nope' }, NOW).error, /unknown kind/);
  assert.match(normalizeItem({ ...essay, sourceId: '  ' }, NOW).error, /missing sourceId/);
  assert.match(normalizeItem({ ...essay, title: '' }, NOW).error, /missing title/);
});

test('normalizeItem: 坏时间不抛错，退化为 null', () => {
  const { item } = normalizeItem({ ...essay, dueAt: 'not-a-date' }, NOW);
  assert.equal(item.dueAt, null);
});

test('toIso 对空值返回 null', () => {
  assert.equal(toIso(null), null);
  assert.equal(toIso(''), null);
  assert.equal(toIso(undefined), null);
});

test('itemId 用 source:kind:sourceId 组成稳定键', () => {
  assert.equal(itemId({ source: 'canvas', kind: 'assignment', sourceId: 7 }), 'canvas:assignment:7');
});

test('contentHash: 只随内容字段变化，不随 status/revision 变化', () => {
  const base = normalizeItem(essay, NOW).item;
  const h1 = contentHash(base);
  assert.equal(h1, contentHash({ ...base, status: 'done', revision: 9 }));
  assert.notEqual(h1, contentHash({ ...base, dueAt: '2026-11-10T04:59:00.000Z' }));
});

test('mergeItems: 首次插入', () => {
  const { items, result } = mergeItems([], [essay], NOW);
  assert.equal(items.length, 1);
  assert.deepEqual(result.inserted, ['canvas:assignment:12345']);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.unchanged, []);
});

test('mergeItems: 重复摄取 → unchanged（幂等）', () => {
  const first = mergeItems([], [essay], NOW);
  const second = mergeItems(first.items, [essay], new Date('2026-11-02T06:00:00.000Z'));
  assert.equal(second.items.length, 1);
  assert.deepEqual(second.result.unchanged, ['canvas:assignment:12345']);
  assert.deepEqual(second.result.inserted, []);
  // lastSeenAt 推进，证明"又看到了"
  assert.equal(second.items[0].lastSeenAt, '2026-11-02T06:00:00.000Z');
  assert.equal(second.items[0].revision, 1);
});

test('mergeItems: DDL 改了 → updated 且 revision+1', () => {
  const first = mergeItems([], [essay], NOW);
  const moved = { ...essay, dueAt: '2026-11-10T04:59:00Z' };
  const second = mergeItems(first.items, [moved], new Date('2026-11-03T00:00:00.000Z'));

  assert.deepEqual(second.result.updated, ['canvas:assignment:12345']);
  assert.equal(second.items[0].revision, 2);
  assert.equal(second.items[0].dueAt, '2026-11-10T04:59:00.000Z');
  assert.equal(second.items[0].firstSeenAt, NOW.toISOString(), '首次时间不该被覆盖');
});

test('mergeItems: 用户标 done 后，重复摄取不得复活', () => {
  const first = mergeItems([], [essay], NOW);
  const done = setStatus(first.items, 'canvas:assignment:12345', 'done');

  const again = mergeItems(done, [essay], new Date('2026-11-04T00:00:00.000Z'));
  assert.equal(again.items[0].status, 'done');

  // 即使内容变了（改 DDL），状态依然保留
  const moved = { ...essay, dueAt: '2026-11-10T04:59:00Z' };
  const changed = mergeItems(done, [moved], new Date('2026-11-04T00:00:00.000Z'));
  assert.equal(changed.items[0].status, 'done');
  assert.equal(changed.items[0].revision, 2);
});

test('mergeItems: 非法项进 rejected，不影响合法项', () => {
  const { items, result } = mergeItems([], [essay, { source: 'x', kind: 'y' }], NOW);
  assert.equal(items.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].error, /unknown source/);
});

test('mergeItems: 不同来源同 sourceId 不冲突（id 带 source）', () => {
  const mail = { ...essay, source: 'gmail', kind: 'email', sourceId: '12345' };
  const { items } = mergeItems([], [essay, mail], NOW);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
});

test('setStatus: 拒绝未知状态', () => {
  assert.throws(() => setStatus([], 'a', 'archived'), /unknown status/);
});
