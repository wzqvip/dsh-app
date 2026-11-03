import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REPLY_LENGTH,
  buildHelpReply,
  buildItemLine,
  buildListReply,
  buildNextReply,
  buildStatusReply,
  buildTextReply,
  buildUnknownCommandReply,
  formatDue,
  parseCommand,
  parseIndex,
  parseLimit,
  truncateForTelegram,
} from '../src/commands.js';

const TZ = 'America/New_York';
const NOW = new Date('2026-11-03T12:00:00.000Z');

const ITEMS = [
  {
    id: 'canvas:assignment:1',
    title: 'Potential Topic Considerations',
    course: 'TLIELP 5050',
    dueAt: '2026-11-05T04:59:59.000Z',
    status: 'open',
  },
  { id: 'canvas:quiz:2', title: 'Survey Quiz', course: 'CSE 6891', dueAt: null, status: 'open' },
  {
    id: 'canvas:assignment:3',
    title: '2017 年的老作业',
    course: null,
    dueAt: '2017-01-01T00:00:00.000Z',
    status: 'open',
  },
];

test('parseCommand: 命令 / 带 @mention / 普通文本 / 空文本', () => {
  assert.deepEqual(parseCommand('/next'), {
    kind: 'command',
    raw: '/next',
    name: 'next',
    args: [],
    mention: null,
    known: true,
  });

  assert.deepEqual(parseCommand('  /list 5  '), {
    kind: 'command',
    raw: '/list 5',
    name: 'list',
    args: ['5'],
    mention: null,
    known: true,
  });

  assert.deepEqual(parseCommand('/DONE 3'), {
    kind: 'command',
    raw: '/DONE 3',
    name: 'done',
    args: ['3'],
    mention: null,
    known: true,
  });

  const mentioned = parseCommand('/list@MyBot 7');
  assert.equal(mentioned.name, 'list');
  assert.equal(mentioned.mention, 'MyBot');
  assert.deepEqual(mentioned.args, ['7']);

  assert.equal(parseCommand('你好').kind, 'text');
  assert.equal(parseCommand('   ').kind, 'empty');
  assert.equal(parseCommand('/').kind, 'text');

  const unknown = parseCommand('/deploy now');
  assert.equal(unknown.kind, 'command');
  assert.equal(unknown.name, 'deploy');
  assert.equal(unknown.known, false);
});

test('parseLimit: 默认 / 上限 / 非法值', () => {
  assert.deepEqual(parseLimit([]), { limit: 10 });
  assert.deepEqual(parseLimit(['5']), { limit: 5 });
  assert.deepEqual(parseLimit(['999']), { limit: 50 });
  assert.match(parseLimit(['abc']).error, /正整数/);
  assert.match(parseLimit(['0']).error, /≥ 1/);
  assert.match(parseLimit(['1', '2']).error, /参数太多/);
});

test('parseIndex: 正整数校验', () => {
  assert.deepEqual(parseIndex(['2']), { index: 2 });
  assert.match(parseIndex([]).error, /缺少序号/);
  assert.match(parseIndex(['-1']).error, /正整数/);
  assert.match(parseIndex(['1.5']).error, /正整数/);
  assert.match(parseIndex(['1', '2']).error, /参数太多/);
});

test('formatDue: 无截止/非法/正常三种情况都说清楚', () => {
  assert.equal(formatDue(null, TZ), '无截止时间');
  assert.equal(formatDue('not-a-date', TZ), '时间无法解析');
  // 2026-11-01 之后美东是 EST（UTC-5），04:59Z = 前一日 23:59
  assert.equal(formatDue('2026-11-05T04:59:59.000Z', TZ), '11/4 23:59');
  // 非法时区不要静默给错时间：退回 ISO
  assert.match(formatDue('2026-11-05T04:59:59.000Z', 'Not/AZone'), /^2026-11-05T/);
});

test('buildItemLine: 序号 + 标题 + 课程 + 截止 + 过期标记', () => {
  assert.equal(
    buildItemLine(ITEMS[0], 1, { timeZone: TZ, now: NOW }),
    '1. Potential Topic Considerations（TLIELP 5050） — 11/4 23:59',
  );
  assert.equal(buildItemLine(ITEMS[1], 2, { timeZone: TZ, now: NOW }), '2. Survey Quiz（CSE 6891） — 无截止时间');
  assert.match(buildItemLine(ITEMS[2], 3, { timeZone: TZ, now: NOW }), /⚠️已过期/);
});

test('buildListReply: 表头 / 取满时提示还有更多 / /done 提示', () => {
  const reply = buildListReply({ items: ITEMS.slice(0, 2), limit: 2, timeZone: TZ, now: NOW });
  assert.match(reply, /📋 未完成事项（显示 2 条）/);
  assert.match(reply, /1\. Potential Topic Considerations/);
  assert.match(reply, /2\. Survey Quiz/);
  assert.match(reply, /可能还有更多，用 \/list 50 查看更多/);
  assert.match(reply, /用 \/done <序号> 标记完成/);

  // 还没取满 limit：不提示"还有更多"
  const partial = buildListReply({ items: ITEMS.slice(0, 2), limit: 10, timeZone: TZ, now: NOW });
  assert.ok(!partial.includes('可能还有更多'));

  // 已到单次上限（50 条都取满）
  const fifty = Array.from({ length: 50 }, (_, index) => ({
    id: `canvas:assignment:${index}`,
    title: `事项 ${index + 1}`,
    course: null,
    dueAt: null,
  }));
  const maxed = buildListReply({ items: fifty, limit: 50, timeZone: TZ, now: NOW });
  assert.match(maxed, /已达到单次上限 50 条/);
});

test('buildListReply: 空清单给出明确文案', () => {
  assert.match(buildListReply({ items: [], limit: 10, timeZone: TZ, now: NOW }), /没有未完成的事项/);
});

test('buildNextReply: 最多 5 条（调用方已切片）', () => {
  const reply = buildNextReply({ items: ITEMS.slice(0, 2), timeZone: TZ, now: NOW });
  assert.match(reply, /⏰ 最近 2 个未完成截止/);
  assert.match(reply, /1\. Potential Topic/);
  assert.match(reply, /2\. Survey Quiz/);
  assert.match(buildNextReply({ items: [], timeZone: TZ, now: NOW }), /没有未完成的截止/);
});

test('truncateForTelegram: 4096 上限，截断有明确后缀', () => {
  const short = 'x'.repeat(10);
  assert.equal(truncateForTelegram(short), short);

  const long = '字'.repeat(MAX_REPLY_LENGTH + 100);
  const truncated = truncateForTelegram(long);
  assert.equal(truncated.length, MAX_REPLY_LENGTH);
  assert.match(truncated, /内容过长已截断/);
});

test('buildListReply: 超长清单被截断但仍是合法长度', () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    id: `id:${index}`,
    title: '很长的标题'.repeat(10),
    course: 'COURSE 1234',
    dueAt: '2026-11-05T04:59:59.000Z',
  }));
  const reply = buildListReply({ items: many, limit: 10, timeZone: TZ, now: NOW });
  assert.ok(reply.length <= MAX_REPLY_LENGTH);
});

test('buildHelpReply / buildTextReply / buildUnknownCommandReply 覆盖全部命令', () => {
  for (const text of [buildHelpReply(), buildTextReply(), buildUnknownCommandReply('deploy')]) {
    assert.match(text, /\/next/);
    assert.match(text, /\/list/);
    assert.match(text, /\/done/);
    assert.match(text, /\/status/);
    assert.match(text, /\/help/);
    assert.match(text, /普通文本暂不对话/);
  }
  assert.match(buildUnknownCommandReply('deploy'), /未知命令 \/deploy/);
});

test('buildStatusReply: 两个服务都正常时展示统计', () => {
  const reply = buildStatusReply({
    tg: {
      running: true,
      startedAt: '2026-11-03T10:00:00.000Z',
      lastPollOkAt: '2026-11-03T11:59:50.000Z',
      lastUpdateAt: '2026-11-03T11:30:00.000Z',
      consecutiveFailures: 0,
      offset: 123456,
      pollTimeoutSec: 30,
    },
    assistant: {
      baseUrl: 'http://dsh-assistant:8787',
      reachable: true,
      open: 400,
      pending: 0,
      latencyMs: 12,
      lastSyncAt: '2026-11-03T11:00:00.000Z',
      lastTickAt: '2026-11-03T11:55:00.000Z',
    },
    timeZone: TZ,
    now: NOW,
  });

  assert.match(reply, /🩺 dsh-tg/);
  assert.match(reply, /running 中|运行中/);
  assert.match(reply, /offset 123456/);
  assert.match(reply, /未完成 400/);
  assert.match(reply, /状态 ✅ 可达/);
  assert.match(reply, /http:\/\/dsh-assistant:8787/);
  assert.ok(!reply.includes('x-dsh-token='));
});

test('buildStatusReply: assistant 不可达时给排查提示，且失败次数可见', () => {
  const reply = buildStatusReply({
    tg: {
      running: false,
      startedAt: '2026-11-03T10:00:00.000Z',
      lastPollOkAt: null,
      lastUpdateAt: null,
      consecutiveFailures: 3,
      offset: null,
      pollTimeoutSec: 30,
      lastError: { message: 'telegram getUpdates: HTTP 502 Bad Gateway' },
    },
    assistant: {
      baseUrl: 'http://dsh-assistant:8787',
      reachable: false,
      error: { kind: 'unreachable', status: null, message: 'assistant GET /health: fetch failed' },
    },
    timeZone: TZ,
    now: NOW,
  });

  assert.match(reply, /长轮询 已停止/);
  assert.match(reply, /尚未成功/);
  assert.match(reply, /连续失败 3 次/);
  assert.match(reply, /状态 ❌ 不可达/);
  assert.match(reply, /检查 dsh-assistant 容器/);
});
