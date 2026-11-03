import test from 'node:test';
import assert from 'node:assert/strict';

import { listLocalCourses, syncAllCourses } from '../src/sources/classpipe-sync.js';

const COURSES = {
  success: true,
  courses: [
    { id: 'default', canvas_course_id: null, name: '全部课程全局总览' },
    { id: 'tlielp_5050', canvas_course_id: '215739', name: 'TLIELP 5050' },
    { id: 'philos_1332', canvas_course_id: '202369', name: 'PHILOS 1332' },
  ],
};

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('listLocalCourses: 过滤掉 default 伪课程', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(COURSES));
  const courses = await listLocalCourses({ fetchImpl });
  assert.deepEqual(
    courses.map((c) => c.id),
    ['tlielp_5050', 'philos_1332'],
  );
  assert.equal(courses[0].canvasId, '215739');
});

test('listLocalCourses: 兼容裸数组返回', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse(COURSES.courses));
  const courses = await listLocalCourses({ fetchImpl });
  assert.equal(courses.length, 2);
});

test('listLocalCourses: 非 200 明确报错', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse({}, 503));
  await assert.rejects(() => listLocalCourses({ fetchImpl }), /HTTP 503/);
});

test('syncAllCourses: 每门课都 POST 一次 sync', async () => {
  const { fetchImpl, calls } = makeFetch(async (url, init) => {
    if (url.endsWith('/courses')) return jsonResponse(COURSES);
    assert.equal(init.method, 'POST');
    return jsonResponse({ success: true });
  });

  const result = await syncAllCourses({ fetchImpl, now: () => 0 });
  assert.equal(result.listed, 2);
  assert.deepEqual(result.synced, ['tlielp_5050', 'philos_1332']);
  assert.deepEqual(result.failed, []);

  const synced = calls.filter((c) => c.method === 'POST').map((c) => c.url);
  assert.equal(synced.length, 2);
  assert.match(synced[0], /\/canvas\/courses\/tlielp_5050\/sync$/);
});

test('syncAllCourses: 单课失败不影响其余', async () => {
  const { fetchImpl } = makeFetch(async (url) => {
    if (url.endsWith('/courses')) return jsonResponse(COURSES);
    if (url.includes('tlielp_5050')) return jsonResponse({}, 500);
    return jsonResponse({ success: true });
  });

  const result = await syncAllCourses({ fetchImpl, now: () => 0 });
  assert.deepEqual(result.synced, ['philos_1332']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'tlielp_5050');
  assert.match(result.failed[0].error, /HTTP 500/);
});

test('syncAllCourses: 200 但 success=false 也算失败', async () => {
  const { fetchImpl } = makeFetch(async (url) => {
    if (url.endsWith('/courses')) return jsonResponse(COURSES);
    return jsonResponse({ success: false });
  });
  const result = await syncAllCourses({ fetchImpl, now: () => 0 });
  assert.equal(result.synced.length, 0);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[0].error, /success=false/);
});

test('syncAllCourses: 列课程就失败 → 记为 (list) 失败，不抛', async () => {
  const { fetchImpl } = makeFetch(async () => jsonResponse({}, 404));
  const result = await syncAllCourses({ fetchImpl, now: () => 0 });
  assert.equal(result.listed, 0);
  assert.deepEqual(result.synced, []);
  assert.equal(result.failed[0].id, '(list)');
});

test('syncAllCourses: 单课超时被记为 timeout 而不是整体挂起', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  const { fetchImpl } = makeFetch(async (url, init) => {
    if (url.endsWith('/courses')) return jsonResponse(COURSES);
    return hanging(url, init);
  });

  const result = await syncAllCourses({ fetchImpl, timeoutMs: 10, now: () => 0 });
  assert.equal(result.synced.length, 0);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[0].error, /timeout 10ms/);
});
