import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFS, TOOL_NAMES, TOOL_SUMMARY, executeTool } from '../src/chat/tools.js';

const ctx = {
  browserBase: 'http://dsh-browser:8789',
  token: 't',
  listItems: (status, limit) => [
    { id: 'a', title: 'Essay', course: 'C', dueAt: '2026-11-09T00:00:00Z', status: 'open', description: 'x'.repeat(500) },
    { id: 'b', title: 'Quiz', course: null, dueAt: null, status: 'open' },
  ].slice(0, limit),
  readQuiz: async ({ quizId }) => ({ ok: true, quizId }),
};

test('工具定义：名字唯一且都在白名单里', () => {
  const names = TOOL_DEFS.map((d) => d.function.name);
  assert.deepEqual(names, [...TOOL_NAMES]);
  assert.equal(new Set(names).size, names.length);
});

test('工具定义：每个都有 description 与 parameters', () => {
  for (const d of TOOL_DEFS) {
    assert.ok(d.function.description.length > 10, d.function.name);
    assert.equal(typeof d.function.parameters, 'object');
  }
});

test('没有任何"提交/删除"类危险工具', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(!/submit|delete|pay|send/i.test(name), `危险工具：${name}`);
  }
  assert.ok(!/submit/i.test(TOOL_SUMMARY));
});

test('executeTool: list_items 截断描述，默认 open', async () => {
  const result = await executeTool('list_items', {}, ctx);
  assert.equal(result.ok, true);
  assert.ok(result.items.length > 0);
  assert.equal(result.items[0].description.length, 300);
});

test('executeTool: browser_open 拒绝非 http(s)', async () => {
  const result = await executeTool('browser_open', { url: 'file:///etc/passwd' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /http/);
});

test('executeTool: canvas_read_quiz 透传到 readQuiz', async () => {
  const result = await executeTool('canvas_read_quiz', { quizId: 'q1503007x' }, ctx);
  assert.deepEqual(result, { ok: true, quizId: '1503007' });
});

test('executeTool: canvas_read_quiz 无 quizId → 报错', async () => {
  const result = await executeTool('canvas_read_quiz', { quizId: 'abc' }, ctx);
  assert.equal(result.ok, false);
});

test('executeTool: 未知工具 → 明确报错', async () => {
  const result = await executeTool('rm_rf', {}, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown tool/);
});

test('executeTool: 没配置 readQuiz 时不崩', async () => {
  const result = await executeTool('canvas_read_quiz', { quizId: '1' }, { ...ctx, readQuiz: undefined });
  assert.equal(result.ok, false);
});

test('TOOL_SUMMARY: 明确告诉模型"先调工具、别直接说看不到"', () => {
  assert.match(TOOL_SUMMARY, /先调用工具/);
  assert.match(TOOL_SUMMARY, /不要直接说看不到/);
  assert.match(TOOL_SUMMARY, /needsUser/);
});
