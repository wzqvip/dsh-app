import test from 'node:test';
import assert from 'node:assert/strict';

import { STALE_OVERRIDE_REASON, mergeItems, planStaleDrops, setStatus } from '../src/items.js';

const NOW = new Date('2026-11-03T00:00:00.000Z');

const mk = (id, dueAt, status = 'open') => ({
  id,
  source: 'canvas',
  kind: 'assignment',
  sourceId: id,
  title: `task ${id}`,
  dueAt,
  status,
});

test('planStaleDrops: 超过 30 天且未完成 → 建议丢弃', () => {
  const items = [
    mk('old', '2026-09-01T00:00:00Z'), // 63 天前
    mk('recent', '2026-10-20T00:00:00Z'), // 14 天前
    mk('future', '2026-12-01T00:00:00Z'),
  ];
  assert.deepEqual(planStaleDrops(items, { now: NOW, days: 30 }), ['old']);
});

test('planStaleDrops: done/dropped 不重复处理', () => {
  const items = [
    mk('a', '2026-09-01T00:00:00Z', 'done'),
    mk('b', '2026-09-01T00:00:00Z', 'dropped'),
  ];
  assert.deepEqual(planStaleDrops(items, { now: NOW }), []);
});

test('planStaleDrops: 无截止 / 坏时间 → 不动（宁可留着也不误删）', () => {
  const items = [mk('a', null), mk('b', 'not-a-date')];
  assert.deepEqual(planStaleDrops(items, { now: NOW }), []);
});

test('planStaleDrops: 边界（刚好 30 天）不算陈旧', () => {
  // 30 天前整 = cutoff，用 `<` 比较 → 不算
  const atCutoff = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  assert.deepEqual(planStaleDrops([mk('edge', atCutoff)], { now: NOW }), []);
  const oneMsEarlier = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000 - 1).toISOString();
  assert.deepEqual(planStaleDrops([mk('edge2', oneMsEarlier)], { now: NOW }), ['edge2']);
});

test('planStaleDrops: days 可配置', () => {
  const items = [mk('x', '2026-10-25T00:00:00Z')]; // 9 天前
  assert.deepEqual(planStaleDrops(items, { now: NOW, days: 7 }), ['x']);
  assert.deepEqual(planStaleDrops(items, { now: NOW, days: 30 }), []);
});

test('planStaleDrops: 参数校验', () => {
  assert.throws(() => planStaleDrops([], { now: 'nope' }), /invalid `now`/);
  assert.throws(() => planStaleDrops([], { days: 0 }), /days must be > 0/);
});

test('过期标记写进 override 后，重复摄取不会复活', () => {
  // 模拟 daemon 的流程：merge → 标 dropped → 再 merge 一次同样的来源数据
  const raw = {
    source: 'canvas',
    kind: 'assignment',
    sourceId: 'old',
    title: 'task old',
    dueAt: '2026-09-01T00:00:00Z',
  };
  const first = mergeItems([], [raw], NOW);
  const staleIds = planStaleDrops(first.items, { now: NOW, days: 30 });
  assert.deepEqual(staleIds, ['canvas:assignment:old']);

  // daemon 用 overrides 记录（这里直接模拟覆盖效果）
  const overrides = { 'canvas:assignment:old': { status: 'dropped', at: NOW.toISOString(), reason: STALE_OVERRIDE_REASON } };
  const overridden = first.items.map((i) =>
    overrides[i.id] ? { ...i, status: overrides[i.id].status } : i,
  );

  const second = mergeItems(overridden, [raw], new Date('2026-11-04T00:00:00.000Z'));
  const reapplied = second.items.map((i) =>
    overrides[i.id] ? { ...i, status: overrides[i.id].status } : i,
  );
  assert.equal(reapplied[0].status, 'dropped');
  assert.equal(STALE_OVERRIDE_REASON, 'stale');
});

test('用户手动 done 仍然优先于自动过期（不会被改成 dropped）', () => {
  const items = [setStatus([mk('x', '2026-09-01T00:00:00Z')], 'x', 'done')];
  assert.deepEqual(planStaleDrops(items, { now: NOW }), []);
});
