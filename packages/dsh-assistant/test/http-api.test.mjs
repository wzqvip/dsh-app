import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequestHandler, startApiServer } from '../src/http/api.js';

const TOKEN = 'test-token-123';

function makeDeps(overrides = {}) {
  const items = [
    { id: 'a', title: 'Essay #2', course: 'CSE 2231', dueAt: '2026-11-09T04:59:00.000Z', status: 'open', revision: 1 },
    { id: 'b', title: 'Quiz 3', course: 'CSE 2231', dueAt: '2026-11-04T04:59:00.000Z', status: 'open', revision: 2 },
    { id: 'c', title: 'Old thing', course: null, dueAt: null, status: 'done', revision: 1 },
  ];
  const calls = [];
  return {
    items,
    calls,
    deps: {
      token: TOKEN,
      stats: () => ({ items: items.length, open: 2 }),
      listItems: (status, limit) =>
        items
          .filter((item) => (status === 'all' ? true : item.status === status))
          .slice(0, limit),
      setItemStatus: (id, status) => {
        calls.push({ id, status });
        const item = items.find((entry) => entry.id === id);
        if (!item) return { ok: false, error: 'item not found' };
        item.status = status;
        return { ok: true };
      },
      ...overrides,
    },
  };
}

async function withServer(deps, run) {
  const server = startApiServer({ port: 0, host: '127.0.0.1', ...deps });
  const started = await server;
  try {
    await run(`http://127.0.0.1:${started.port}`);
  } finally {
    await started.close();
  }
}

test('GET /health 不需要 token', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.items, 3);
  });
});

test('GET /items 缺 token → 401', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items`);
    assert.equal(res.status, 401);
  });
});

test('GET /items 带 token → 只返回 open，且字段收敛', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items?status=open&limit=10`, {
      headers: { 'x-dsh-token': TOKEN },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.deepEqual(Object.keys(body.items[0]).sort(), [
      'course',
      'dueAt',
      'id',
      'revision',
      'status',
      'title',
    ]);
  });
});

test('GET /items?status=all 返回全部', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items?status=all`, { headers: { 'x-dsh-token': TOKEN } });
    const body = await res.json();
    assert.equal(body.count, 3);
  });
});

test('POST /items/{id}/status 正常标记', async () => {
  const { deps, calls } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items/a/status`, {
      method: 'POST',
      headers: { 'x-dsh-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, id: 'a', status: 'done' });
    assert.deepEqual(calls, [{ id: 'a', status: 'done' }]);
  });
});

test('POST /items/{id}/status 非法 status → 400', async () => {
  const { deps, calls } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items/a/status`, {
      method: 'POST',
      headers: { 'x-dsh-token': TOKEN },
      body: JSON.stringify({ status: 'archived' }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

test('POST /items/{id}/status 不存在 → 404', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items/nope/status`, {
      method: 'POST',
      headers: { 'x-dsh-token': TOKEN },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST 坏 JSON → 400', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items/a/status`, {
      method: 'POST',
      headers: { 'x-dsh-token': TOKEN },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

test('未知路径 → 404', async () => {
  const { deps } = makeDeps();
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/nope`, { headers: { 'x-dsh-token': TOKEN } });
    assert.equal(res.status, 404);
  });
});

test('token 为空时不校验（仅本机调试用）', async () => {
  const { deps } = makeDeps({ token: '' });
  await withServer(deps, async (base) => {
    const res = await fetch(`${base}/items`);
    assert.equal(res.status, 200);
  });
});

test('createRequestHandler 是纯函数工厂（不依赖真实端口）', () => {
  const handler = createRequestHandler(makeDeps().deps);
  assert.equal(typeof handler, 'function');
});
