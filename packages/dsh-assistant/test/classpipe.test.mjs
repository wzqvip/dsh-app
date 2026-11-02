import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchClasspipeTasks, mapClasspipeTasks } from '../src/sources/classpipe.js';

/** 取自 classpipe 真实接口的**字段形状**（值已换成中性数据） */
const payload = {
  success: true,
  total_assignments: 2,
  total_quizzes: 1,
  total_announcements: 1,
  assignments: [
    {
      id: 1,
      course_id: 'TLIELP 5902',
      canvas_id: '5172056',
      name: 'Plagiarism check',
      description: '',
      due_at: '2026-01-17T09:59:59Z',
      points_possible: 10,
      has_submitted: 1,
      html_url: 'https://osu.instructure.com/courses/1/assignments/5172056',
      synced_at: '2026-10-30T00:54:47.405300+00:00',
      course_name: 'TLIELP 5902 SP2026',
      course_code: 'TLIELP 5902 SP2026 (12890)',
    },
    {
      // 无 canvas_id、无截止：验证兜底与"没有 deadline"
      id: 2,
      course_id: 'CSE 2231',
      canvas_id: null,
      name: 'Essay #2',
      due_at: null,
      html_url: '',
      course_name: 'Software II',
      course_code: '',
    },
  ],
  quizzes: [
    {
      id: 10,
      course_id: 'CSE 2231',
      canvas_id: '99',
      title: 'Quiz 3',
      due_at: '2026-02-01T04:59:00Z',
      html_url: 'https://x/quizzes/99',
      course_name: 'Software II',
      course_code: 'CSE 2231',
    },
  ],
  announcements: [
    {
      id: 20,
      course_id: 'CSE 2231',
      canvas_id: '555',
      title: 'Week 10 update',
      message: '…',
      posted_at: '2026-10-29T12:00:00Z',
      author_name: 'Prof',
      html_url: 'https://x/announcements/555',
      course_name: 'Software II',
      course_code: 'CSE 2231',
    },
  ],
};

test('mapClasspipeTasks: 作业/测验/公告都映射出来', () => {
  const items = mapClasspipeTasks(payload);
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['assignment', 'assignment', 'quiz', 'announcement'],
  );
});

test('mapClasspipeTasks: 字段映射正确（含课程代码回落）', () => {
  const [first, second] = mapClasspipeTasks(payload);
  assert.equal(first.source, 'canvas');
  assert.equal(first.title, 'Plagiarism check');
  assert.equal(first.course, 'TLIELP 5902 SP2026 (12890)');
  assert.equal(first.dueAt, '2026-01-17T09:59:59Z');
  assert.equal(first.confidence, 1);

  // course_code 为空 → 回落到 course_name
  assert.equal(second.course, 'Software II');
  assert.equal(second.dueAt, null);
});

test('mapClasspipeTasks: sourceId 优先 canvas_id，缺失时用 local:id', () => {
  const items = mapClasspipeTasks(payload);
  assert.equal(items[0].sourceId, 'TLIELP 5902:5172056');
  assert.equal(items[1].sourceId, 'CSE 2231:local:2');
});

test('mapClasspipeTasks: 公告没有 dueAt（不臆造截止），但有 postedAt', () => {
  const ann = mapClasspipeTasks(payload).at(-1);
  assert.equal(ann.kind, 'announcement');
  assert.equal(ann.dueAt, null);
  assert.equal(ann.postedAt, '2026-10-29T12:00:00Z');
});

test('mapClasspipeTasks: 跳过没有标题的行', () => {
  const items = mapClasspipeTasks({
    assignments: [{ id: 1, course_id: 'c', name: '   ' }],
    quizzes: [{ id: 2, course_id: 'c', title: null }],
    announcements: [{ id: 3, course_id: 'c' }],
  });
  assert.deepEqual(items, []);
});

test('mapClasspipeTasks: 空/缺字段不炸', () => {
  assert.deepEqual(mapClasspipeTasks({ success: true }), []);
  assert.throws(() => mapClasspipeTasks(null), /payload must be an object/);
});

test('fetchClasspipeTasks: 正常响应 → items + counts', async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /\/canvas\/all_tasks$/);
    assert.equal(init.method, 'GET');
    return { ok: true, status: 200, json: async () => payload };
  };
  const { items, counts } = await fetchClasspipeTasks({ fetchImpl: fakeFetch });
  assert.equal(items.length, 4);
  assert.deepEqual(counts, { assignments: 2, quizzes: 1, announcements: 1 });
});

test('fetchClasspipeTasks: 非 200 → 明确报错（含状态码与 URL）', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => fetchClasspipeTasks({ fetchImpl: fakeFetch }),
    /HTTP 503 from .*canvas\/all_tasks/,
  );
});

test('fetchClasspipeTasks: success=false → 报错', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ success: false }) });
  await assert.rejects(() => fetchClasspipeTasks({ fetchImpl: fakeFetch }), /success=false/);
});

test('fetchClasspipeTasks: 超时 → 明确的超时错误', async () => {
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  await assert.rejects(
    () => fetchClasspipeTasks({ fetchImpl: hangingFetch, timeoutMs: 10 }),
    /timed out after 10ms/,
  );
});

test('fetchClasspipeTasks: baseUrl 尾部斜杠不影响拼接', async () => {
  let seen;
  const fakeFetch = async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => payload };
  };
  await fetchClasspipeTasks({ baseUrl: 'http://127.0.0.1:8000///', fetchImpl: fakeFetch });
  assert.equal(seen, 'http://127.0.0.1:8000/canvas/all_tasks');
});
