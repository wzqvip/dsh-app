import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESCRIPTION_MAX_CHARS,
  normalizeDescription,
  normalizeItem,
  mergeItems,
} from '../src/items.js';
import { buildSystemPrompt } from '../src/chat/prompt.js';
import { mapClasspipeTasks } from '../src/sources/classpipe.js';

const NOW = new Date('2026-11-04T00:00:00.000Z');
const TZ = 'America/New_York';

test('normalizeDescription: 去 HTML 标签、解实体、压空白', () => {
  const html = '<p>Enter your <strong>OPCA</strong> docx&nbsp;file</p><br><p>Second&nbsp;line</p>';
  const text = normalizeDescription(html);
  assert.ok(!/[<>]/.test(text), `仍有标签：${text}`);
  assert.match(text, /Enter your OPCA docx file/);
  assert.match(text, /Second line/);
  assert.ok(!text.includes('&nbsp;'));
});

test('normalizeDescription: 保留换行（多段要求不要挤成一行）', () => {
  const text = normalizeDescription('<p>a</p><p>b</p>');
  assert.match(text, /a\n+b/);
});

test('normalizeDescription: 空/非字符串 → null（不要塞空串）', () => {
  assert.equal(normalizeDescription(''), null);
  assert.equal(normalizeDescription('   '), null);
  assert.equal(normalizeDescription(null), null);
  assert.equal(normalizeDescription(123), null);
  assert.equal(normalizeDescription('<p></p>'), null);
});

test('normalizeDescription: 超长截断并加省略号', () => {
  const long = 'x'.repeat(DESCRIPTION_MAX_CHARS + 500);
  const text = normalizeDescription(long);
  assert.equal(text.length, DESCRIPTION_MAX_CHARS + 1); // +1 是 …
  assert.ok(text.endsWith('…'));
});

test('normalizeItem: description 落库并参与内容指纹', () => {
  const base = {
    source: 'canvas',
    kind: 'assignment',
    sourceId: '1',
    title: 'OPCA',
    dueAt: '2026-11-05T04:59:59Z',
    description: '<p>Enter your OPCA docx</p>',
  };
  const { item } = normalizeItem(base, NOW);
  assert.equal(item.description, 'Enter your OPCA docx');

  // 只改描述 → 必须被判成"更新"（否则改了要求我们不会重新提醒）
  const changed = normalizeItem({ ...base, description: '<p>Enter a PDF instead</p>' }, NOW).item;
  assert.notEqual(item.contentHash, changed.contentHash);
});

test('normalizeItem: 没有描述时是 null（不是空字符串）', () => {
  const { item } = normalizeItem(
    { source: 'canvas', kind: 'assignment', sourceId: '2', title: 'x' },
    NOW,
  );
  assert.equal(item.description, null);
});

test('mergeItems: 描述变了会触发 revision++', () => {
  const raw = { source: 'canvas', kind: 'assignment', sourceId: '3', title: 't', description: 'old' };
  const first = mergeItems([], [raw], NOW);
  const second = mergeItems(first.items, [{ ...raw, description: 'new' }], NOW);
  assert.equal(second.result.updated.length, 1);
  assert.equal(second.items[0].revision, 2);
  assert.equal(second.items[0].description, 'new');
});

test('classpipe 映射：带 description', () => {
  const payload = {
    assignments: [
      {
        id: 1,
        canvas_id: 11,
        course_id: 'c1',
        course_code: 'TLIELP 5050',
        course_name: 'TLIELP',
        name: 'OPCA',
        description: 'Enter your OPCA docx',
        due_at: '2026-11-05T04:59:59Z',
        html_url: 'https://canvas/x',
      },
    ],
    quizzes: [],
    announcements: [],
  };
  const raw = mapClasspipeTasks(payload);
  const assignment = raw.find((r) => r.kind === 'assignment');
  assert.equal(assignment.description, 'Enter your OPCA docx');
});

test('buildSystemPrompt: 注入「要求」正文，模型才答得出', () => {
  const items = [
    {
      id: 'canvas:assignment:1',
      title: '[OPCA] Potential Topic Considerations',
      course: 'TLIELP 5050',
      dueAt: '2026-11-05T04:59:59Z',
      status: 'open',
      description: 'Enter your OPCA--Potential Topic Considerations_5050 AU26.docx',
    },
  ];
  const prompt = buildSystemPrompt({ items, now: NOW, timeZone: TZ });
  assert.match(prompt, /要求：/);
  assert.match(prompt, /Potential Topic Considerations_5050 AU26\.docx/);
  // 规则里要明确告诉模型"用要求那段回答"
  assert.match(prompt, /他问某条作业的「要求」时/);
});

test('buildSystemPrompt: 长描述被截断，不烧 token', () => {
  const items = [
    {
      id: 'canvas:assignment:2',
      title: 'x',
      dueAt: '2026-11-05T04:59:59Z',
      status: 'open',
      description: 'y'.repeat(2000),
    },
  ];
  const prompt = buildSystemPrompt({ items, now: NOW, timeZone: TZ });
  const line = prompt.split('\n').find((l) => l.includes('要求：'));
  assert.ok(line.length < 400, `要求行太长：${line.length}`);
  assert.ok(line.endsWith('…'));
});
