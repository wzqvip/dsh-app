import test from 'node:test';
import assert from 'node:assert/strict';

import { createPoller, formatDue, pollOnce } from '../src/poll.js';

const NOW = new Date('2026-11-02T00:00:00.000Z');
const TZ = 'America/New_York';

const future = {
  source: 'canvas',
  kind: 'assignment',
  sourceId: 'c1:1',
  title: 'Essay #2',
  course: 'CSE 2231',
  dueAt: '2026-11-09T04:59:00Z',
};
const past = { ...future, sourceId: 'c1:2', title: 'Old thing', dueAt: '2026-10-01T00:00:00Z' };
const announcement = {
  source: 'canvas',
  kind: 'announcement',
  sourceId: 'c1:3',
  title: 'Week 10 update',
  course: 'CSE 2231',
  dueAt: null,
  postedAt: '2026-10-29T12:00:00Z',
};

test('pollOnce: 首次拉取只对未来的截止发通知', async () => {
  const { items, candidates, result } = await pollOnce({
    fetchItems: async () => [future, past, announcement],
    items: [],
    now: NOW,
    timeZone: TZ,
  });

  assert.equal(items.length, 3);
  assert.equal(result.inserted.length, 3);

  const kinds = candidates.map((c) => c.kind).sort();
  // 公告有候选（new_announcement），过期截止**没有**候选
  assert.deepEqual(kinds, ['new_announcement', 'new_deadline']);
  assert.ok(!candidates.some((c) => c.itemId.includes('c1:2')), '过期截止不该推');
});

test('pollOnce: 同一份数据第二次拉取 → 零候选（不打扰）', async () => {
  const first = await pollOnce({ fetchItems: async () => [future, announcement], items: [], now: NOW });
  const second = await pollOnce({
    fetchItems: async () => [future, announcement],
    items: first.items,
    now: new Date('2026-11-02T01:00:00.000Z'),
  });
  assert.equal(second.result.unchanged.length, 2);
  assert.deepEqual(second.candidates, []);
});

test('pollOnce: 截止改期 → deadline_changed，文案含箭头', async () => {
  const first = await pollOnce({ fetchItems: async () => [future], items: [], now: NOW, timeZone: TZ });
  const moved = { ...future, dueAt: '2026-11-12T04:59:00Z' };
  const second = await pollOnce({
    fetchItems: async () => [moved],
    items: first.items,
    now: new Date('2026-11-02T02:00:00.000Z'),
    timeZone: TZ,
  });

  assert.equal(second.candidates.length, 1);
  assert.equal(second.candidates[0].kind, 'deadline_changed');
  assert.match(second.candidates[0].text, /截止改期/);
  assert.match(second.candidates[0].text, /→/);
});

test('pollOnce: 只是标题变了 → 不单独推（噪音控制）', async () => {
  const first = await pollOnce({ fetchItems: async () => [future], items: [], now: NOW });
  const renamed = { ...future, title: 'Essay #2 (final)' };
  const second = await pollOnce({
    fetchItems: async () => [renamed],
    items: first.items,
    now: new Date('2026-11-02T02:00:00.000Z'),
  });
  assert.deepEqual(second.candidates, []);
});

test('pollOnce: 默认不推公告，notifyKinds=all 才推', async () => {
  const withDefault = await pollOnce({ fetchItems: async () => [announcement], items: [], now: NOW });
  assert.deepEqual(withDefault.delivered, []); // 没有 notify 也不该有 delivered
  assert.equal(withDefault.candidates.length, 1);
  assert.equal(withDefault.candidates[0].kind, 'new_announcement');

  const sent = [];
  const all = await pollOnce({
    fetchItems: async () => [announcement],
    items: [],
    now: NOW,
    notifyKinds: 'all',
    notify: (text) => sent.push(text),
  });
  assert.equal(all.delivered.length, 1);
  assert.match(sent[0], /新公告/);
});

test('pollOnce: 只投递默认类型（新截止），不投公告', async () => {
  const sent = [];
  const { delivered } = await pollOnce({
    fetchItems: async () => [future, announcement],
    items: [],
    now: NOW,
    notify: (text) => sent.push(text),
    timeZone: TZ,
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, 'new_deadline');
  assert.match(sent[0], /新截止/);
});

test('pollOnce: 投递失败不阻断入库，并记进 failed', async () => {
  const { items, failed, result } = await pollOnce({
    fetchItems: async () => [future],
    items: [],
    now: NOW,
    notify: () => {
      throw new Error('telegram down');
    },
  });
  assert.equal(result.inserted.length, 1);
  assert.equal(items.length, 1);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /telegram down/);
});

test('pollOnce: fetchItems 缺省 → 明确报错', async () => {
  await assert.rejects(() => pollOnce({ items: [] }), /fetchItems is required/);
});

test('formatDue: 按给定时区渲染，非法时区退到 ISO', () => {
  assert.equal(formatDue(null), '无截止时间');
  assert.equal(formatDue('garbage'), '时间无法解析');
  const rendered = formatDue('2026-11-09T04:59:00Z', TZ);
  assert.match(rendered, /11.*8.*23:59|11.*8.*59/); // 11-08 23:59 EST
  assert.match(formatDue('2026-11-09T04:59:00Z', 'Not/AZone'), /^2026-11-09T04:59:00\.000Z$/);
});

test('createPoller: 单飞保护——上一轮没结束就跳过', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const poller = createPoller({
    intervalMs: 1000,
    logger: { warn() {}, error() {} },
    run: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent -= 1;
    },
  });

  const first = poller.tick(); // 挂住
  await poller.tick(); // 应被跳过
  assert.equal(maxConcurrent, 1);
  assert.equal(poller.stats.skipped, 1);

  release();
  await first;
  assert.equal(poller.stats.running, false);
});

test('createPoller: 参数校验', () => {
  assert.throws(() => createPoller({ intervalMs: 0, run() {} }), /intervalMs/);
  assert.throws(() => createPoller({ intervalMs: 100 }), /run is required/);
});
