import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_HISTORY_CHARS,
  buildMessages,
  buildSystemPrompt,
  pickUpcoming,
  trimHistory,
} from '../src/chat/prompt.js';

const NOW = new Date('2026-11-03T22:30:00.000Z');
const TZ = 'America/New_York';

const items = [
  { id: 'a', title: 'Essay #2', course: 'CSE 2231', dueAt: '2026-11-09T04:59:00Z', status: 'open' },
  { id: 'b', title: 'Quiz 3', course: 'CSE 2231', dueAt: '2026-11-04T04:59:00Z', status: 'open' },
  { id: 'c', title: 'Old', course: null, dueAt: '2026-01-01T00:00:00Z', status: 'open' },
  { id: 'd', title: 'Done thing', course: null, dueAt: '2026-11-05T00:00:00Z', status: 'done' },
  { id: 'e', title: 'No due', course: null, dueAt: null, status: 'open' },
];

test('pickUpcoming: 只取未到期、按截止升序、排除已完成/无截止/已过期', () => {
  const picked = pickUpcoming(items, { now: NOW, limit: 5 });
  assert.deepEqual(
    picked.map((i) => i.id),
    ['b', 'a'],
  );
});

test('buildSystemPrompt: 注入时间、计数、近期截止、命令与规则', () => {
  const prompt = buildSystemPrompt({ items, now: NOW, timeZone: TZ });
  assert.match(prompt, /未完成/);
  assert.match(prompt, /已完成/);
  assert.match(prompt, /Quiz 3/);
  assert.match(prompt, /Essay #2/);
  assert.match(prompt, /2026/);
  assert.match(prompt, /\/done/);
  assert.match(prompt, /不要声称已经替他完成/);
});

test('buildSystemPrompt: 会话需要登录时明确告知模型', () => {
  const prompt = buildSystemPrompt({
    items,
    now: NOW,
    timeZone: TZ,
    session: { needsUser: true, reason: 'login_required' },
  });
  assert.match(prompt, /需要人工登录/);
  assert.match(prompt, /login_required/);
});

test('buildSystemPrompt: 没有近期截止时也给一句明确的', () => {
  const prompt = buildSystemPrompt({ items: [], now: NOW, timeZone: TZ });
  assert.match(prompt, /暂无/);
});

test('trimHistory: 只保留最近 N 轮，且跳过非法条目', () => {
  const history = [
    { role: 'system', content: 'x' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
    { role: 'user' },
  ];
  const trimmed = trimHistory(history, { keepTurns: 3 });
  assert.equal(trimmed.length, 6);
  assert.equal(trimmed.at(-1).content, 'm19');
});

test('trimHistory: 总字符超限时从最旧开始丢', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(1000),
  }));
  const trimmed = trimHistory(history, { keepTurns: 10, maxChars: 2500 });
  assert.ok(trimmed.length <= 3);
  assert.ok(trimmed.reduce((s, e) => s + e.content.length, 0) <= 2500);
});

test('MAX_HISTORY_CHARS 是个合理上限（不是无穷）', () => {
  assert.ok(MAX_HISTORY_CHARS > 0 && MAX_HISTORY_CHARS <= 20000);
});

test('buildMessages: 顺序为 system → history → user', () => {
  const messages = buildMessages({
    systemPrompt: 'SYS',
    history: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }],
    userText: '现在呢',
  });
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages[0].content, 'SYS');
  assert.equal(messages.at(-1).content, '现在呢');
});

test('buildMessages: 超长用户输入被截断（防 token 爆炸）', () => {
  const messages = buildMessages({ systemPrompt: 'S', history: [], userText: 'x'.repeat(5000) });
  assert.equal(messages.at(-1).content.length, 2000);
});
