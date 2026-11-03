import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantError } from '../src/assistant.js';
import { createCommandHandler } from '../src/handler.js';
import { createSeqStore } from '../src/seq.js';

const TZ = 'America/New_York';
const CHAT = '6413978793';

const ITEMS = [
  {
    id: 'canvas:assignment:1',
    title: 'Potential Topic Considerations',
    course: 'TLIELP 5050',
    dueAt: '2026-11-05T04:59:59.000Z',
    status: 'open',
  },
  { id: 'canvas:quiz:2', title: 'Survey Quiz', course: 'CSE 6891', dueAt: null, status: 'open' },
  { id: 'canvas:assignment:3', title: '第三个', course: null, dueAt: '2026-11-07T04:59:59.000Z', status: 'open' },
];

function textUpdate(text, { chatId = CHAT, updateId = 1 } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: Number(chatId) },
      chat: { id: Number(chatId) },
      text,
    },
  };
}

function fakeAssistant({ items = ITEMS, count = items.length, listError = null, statusError = null, probe } = {}) {
  const calls = [];
  return {
    baseUrl: 'http://dsh-assistant:8787',
    calls,
    async listItems(options) {
      calls.push({ op: 'listItems', options });
      if (listError) throw listError;
      return { items, count };
    },
    async setStatus(id, status) {
      calls.push({ op: 'setStatus', id, status });
      if (statusError) throw statusError;
      return { ok: true, id, status };
    },
    async probe() {
      calls.push({ op: 'probe' });
      return probe ?? { reachable: true, open: count, pending: 0, items: count, latencyMs: 3 };
    },
  };
}

function makeHandler(t, { assistant = fakeAssistant(), seq, runtime } = {}) {
  const store = seq ?? createSeqStore({ file: null });
  const handler = createCommandHandler({
    assistant,
    seq: store,
    config: {
      telegram: { chatId: CHAT },
      timeZone: TZ,
      poller: { pollTimeoutSec: 30 },
    },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    now: () => new Date('2026-11-03T12:00:00.000Z'),
    runtime:
      runtime ??
      (() => ({
        running: true,
        startedAt: '2026-11-03T10:00:00.000Z',
        lastPollOkAt: '2026-11-03T11:59:00.000Z',
        lastUpdateAt: null,
        consecutiveFailures: 0,
        offset: 7,
      })),
  });
  return { handler, assistant, seq: store };
}

test('handleUpdate: 非配置 chat 的消息一律忽略（bot 进群也不泄露数据）', async () => {
  const { handler, assistant } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/status', { chatId: '999' }));
  assert.deepEqual(result, { handled: false, reason: 'foreign_chat' });
  assert.equal(assistant.calls.length, 0);
});

test('handleUpdate: 没有文本（贴纸/图片）的消息忽略', async () => {
  const { handler } = makeHandler(test);
  const result = await handler.handleUpdate({ update_id: 2, message: { chat: { id: CHAT }, sticker: {} } });
  assert.deepEqual(result, { handled: false, reason: 'no_text' });
});

test('普通文本 → 友好提示 + 命令列表（本轮不做 LLM 对话）', async () => {
  const { handler } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('今天有什么作业？'));
  assert.equal(result.handled, true);
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].text, /普通对话暂未开启/);
  assert.match(result.replies[0].text, /\/next/);
});

test('/help → 帮助', async () => {
  const { handler } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/help'));
  assert.match(result.replies[0].text, /🤖 dsh-tg 命令/);
  assert.match(result.replies[0].text, /\/done <序号>/);
});

test('/next: 取前 5 条、分配序号并回复', async () => {
  const { handler, assistant, seq } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/next'));

  assert.deepEqual(assistant.calls[0], { op: 'listItems', options: { status: 'open', limit: 5 } });
  assert.match(result.replies[0].text, /最近 3 个未完成截止/);
  assert.match(result.replies[0].text, /1\. Potential Topic Considerations/);
  assert.equal(seq.resolve(1).id, 'canvas:assignment:1');
  assert.equal(seq.resolve(3).id, 'canvas:assignment:3');
});

test('/next: 只展示前 5 条，序号只覆盖展示出来的', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `canvas:assignment:${i + 1}`, title: `T${i + 1}`, dueAt: null }));
  const assistant = fakeAssistant({ items: many, count: 8 });
  const { handler, seq } = makeHandler(test, { assistant });
  await handler.handleUpdate(textUpdate('/next'));
  assert.equal(seq.size, 5);
  assert.equal(seq.resolve(5).id, 'canvas:assignment:5');
  assert.equal(seq.resolve(6), null);
});

test('/list [n]: 把 n 传给 assistant，默认 10、上限 50', async () => {
  const { handler, assistant } = makeHandler(test);
  await handler.handleUpdate(textUpdate('/list 2'));
  assert.deepEqual(assistant.calls[0], { op: 'listItems', options: { status: 'open', limit: 2 } });

  const second = makeHandler(test);
  await second.handler.handleUpdate(textUpdate('/list 999'));
  assert.deepEqual(second.assistant.calls[0], { op: 'listItems', options: { status: 'open', limit: 50 } });

  const third = makeHandler(test);
  await third.handler.handleUpdate(textUpdate('/list'));
  assert.deepEqual(third.assistant.calls[0], { op: 'listItems', options: { status: 'open', limit: 10 } });
});

test('/list abc: 本地报错，不打 assistant', async () => {
  const { handler, assistant } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/list abc'));
  assert.match(result.replies[0].text, /n 必须是正整数/);
  assert.equal(assistant.calls.length, 0);
});

test('/done <序号>: 解析上一次清单的序号 → 调 assistant 标记完成', async () => {
  const { handler, assistant, seq } = makeHandler(test);
  await handler.handleUpdate(textUpdate('/list 3', { updateId: 1 }));
  assert.equal(seq.resolve(2).id, 'canvas:quiz:2');

  const result = await handler.handleUpdate(textUpdate('/done 2', { updateId: 2 }));
  assert.deepEqual(assistant.calls.at(-1), { op: 'setStatus', id: 'canvas:quiz:2', status: 'done' });
  assert.match(result.replies[0].text, /✅ 已标记完成：Survey Quiz/);
});

test('/done: 没有清单记录时明确要求先 /list，不瞎猜', async () => {
  const { handler, assistant } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/done 1'));
  assert.match(result.replies[0].text, /找不到第 1 项/);
  assert.match(result.replies[0].text, /\/list/);
  assert.equal(assistant.calls.length, 0);
});

test('/done: 序号非法直接报错', async () => {
  const { handler } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/done abc'));
  assert.match(result.replies[0].text, /序号必须是正整数/);
});

test('/done: assistant 返回 404（事项被删）时说清楚', async () => {
  const statusError = new AssistantError('assistant POST /items/x/status: HTTP 404 not found', {
    kind: 'http',
    status: 404,
  });
  const { handler } = makeHandler(test, { assistant: fakeAssistant({ statusError }) });
  await handler.handleUpdate(textUpdate('/list 1'));
  const result = await handler.handleUpdate(textUpdate('/done 1', { updateId: 2 }));
  assert.match(result.replies[0].text, /第 1 项已不存在/);
  assert.match(result.replies[0].text, /\/list 刷新/);
});

test('/done: assistant 不可达时给出可行动提示', async () => {
  const statusError = new AssistantError('assistant POST /items/x/status: fetch failed', {
    kind: 'unreachable',
  });
  const { handler } = makeHandler(test, { assistant: fakeAssistant({ statusError }) });
  await handler.handleUpdate(textUpdate('/list 1'));
  const result = await handler.handleUpdate(textUpdate('/done 1', { updateId: 2 }));
  assert.match(result.replies[0].text, /assistant 服务暂时不可用/);
  assert.match(result.replies[0].text, /\/status/);
});

test('/list: assistant 不可达时友好回复，而不是抛异常', async () => {
  const listError = new AssistantError('assistant GET /items?status=open: fetch failed', { kind: 'unreachable' });
  const { handler } = makeHandler(test, { assistant: fakeAssistant({ listError }) });
  const result = await handler.handleUpdate(textUpdate('/list'));
  assert.equal(result.handled, true);
  assert.match(result.replies[0].text, /取未完成清单失败/);
  assert.match(result.replies[0].text, /不可用/);
});

test('/status: 展示本服务运行时 + assistant 探测结果', async () => {
  const { handler, assistant } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/status'));
  assert.equal(assistant.calls.at(-1).op, 'probe');
  assert.match(result.replies[0].text, /🩺 dsh-tg/);
  assert.match(result.replies[0].text, /🩺 assistant/);
  assert.match(result.replies[0].text, /状态 ✅ 可达/);
  assert.match(result.replies[0].text, /未完成 3/);
});

test('未知命令 → 提示未知 + 帮助', async () => {
  const { handler } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('/deploy'));
  assert.match(result.replies[0].text, /未知命令 \/deploy/);
  assert.match(result.replies[0].text, /\/next/);
});

test('空文本 → 帮助', async () => {
  const { handler } = makeHandler(test);
  const result = await handler.handleUpdate(textUpdate('   '));
  assert.match(result.replies[0].text, /dsh-tg 命令/);
});

test('序号映射落盘：重启后 /done 仍能解析（Lead 的契约要求）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-handler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'seq.json');

  return (async () => {
    const first = makeHandler(t, { seq: createSeqStore({ file }) });
    await first.handler.handleUpdate(textUpdate('/list 3'));

    // 模拟重启：新的 seq store + 新的 handler（assistant 记录调用）
    const assistant = fakeAssistant();
    const second = makeHandler(t, { assistant, seq: createSeqStore({ file }) });
    const result = await second.handler.handleUpdate(textUpdate('/done 3'));

    assert.deepEqual(assistant.calls[0], { op: 'setStatus', id: 'canvas:assignment:3', status: 'done' });
    assert.match(result.replies[0].text, /已标记完成：第三个/);
  })();
});
