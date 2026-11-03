import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUpdatePoller } from '../src/poller.js';
import { createStateStore } from '../src/state.js';
import { TelegramApiError } from '../src/telegram.js';

const CHAT = '6413978793';

function pollerConfig(overrides = {}) {
  return {
    poller: {
      pollTimeoutSec: 5,
      heartbeatStaleMs: 1000,
      alertThrottleMs: 100_000,
      backoffBaseMs: 1000,
      backoffMaxMs: 5000,
      ...overrides,
    },
  };
}

function makeTelegram({ responses = [], sendError = null } = {}) {
  const sent = [];
  const pollCalls = [];
  let failSend = Boolean(sendError);
  return {
    sent,
    pollCalls,
    responses,
    setSendError(value) {
      failSend = Boolean(value);
    },
    async getUpdates(options) {
      pollCalls.push(options);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
    async sendMessage(message) {
      if (failSend) throw sendError ?? new Error('send failed');
      sent.push(message);
      return { ok: true, messageId: sent.length, chatId: message.chatId };
    },
  };
}

function makeHandler(records = []) {
  return {
    async handleUpdate(update) {
      records.push(update.update_id);
      return { handled: true, replies: [{ text: `回复 ${update.update_id}` }] };
    },
  };
}

function baseOptions({ telegram, state, handler, clock, slept, config, logger } = {}) {
  return {
    telegram,
    chatId: CHAT,
    state,
    handler,
    config: config ?? pollerConfig(),
    logger: logger ?? { error() {}, warn() {}, info() {}, debug() {} },
    now: clock ? () => clock.value : () => 0,
    sleep:
      slept === undefined
        ? async () => {}
        : async (ms) => {
            slept.push(ms);
          },
  };
}

test('成功一轮：分发 → 回复 → offset = update_id+1 并落盘', async () => {
  const state = createStateStore({ file: null });
  const telegram = makeTelegram({
    responses: [
      [
        { update_id: 10, message: { chat: { id: CHAT }, text: '/next' } },
        { update_id: 20, message: { chat: { id: CHAT }, text: '/help' } },
      ],
    ],
  });
  const records = [];
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler(records) }));

  const result = await poller.runOnce();

  assert.deepEqual(result, { ok: true, count: 2, recovered: false });
  assert.deepEqual(records, [10, 20]);
  assert.equal(state.offset, 21);
  assert.deepEqual(
    telegram.sent.map((message) => message.text),
    ['回复 10', '回复 20'],
  );
  assert.equal(telegram.sent[0].chatId, CHAT);
  assert.equal(telegram.pollCalls[0].offset, undefined);
  assert.equal(telegram.pollCalls[0].timeoutSec, 5);

  // 下一轮从落盘后的 offset 继续
  await poller.runOnce();
  assert.equal(telegram.pollCalls[1].offset, 21);
});

test('offset 跨重启持久化：新 poller 从上次确认的位置继续', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-poller-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');

  const firstState = createStateStore({ file });
  const firstTelegram = makeTelegram({ responses: [[{ update_id: 41 }]] });
  const first = createUpdatePoller(
    baseOptions({ telegram: firstTelegram, state: firstState, handler: makeHandler() }),
  );
  await first.runOnce();
  assert.equal(firstState.offset, 42);

  const reloaded = createStateStore({ file });
  const secondTelegram = makeTelegram({ responses: [[]] });
  const second = createUpdatePoller(
    baseOptions({ telegram: secondTelegram, state: reloaded, handler: makeHandler() }),
  );
  await second.runOnce();
  assert.equal(secondTelegram.pollCalls[0].offset, 42);
});

test('handled:false（非配置 chat）不回复，但仍然确认 offset', async () => {
  const state = createStateStore({ file: null });
  const telegram = makeTelegram({ responses: [[{ update_id: 5 }]] });
  const poller = createUpdatePoller(
    baseOptions({
      telegram,
      state,
      handler: {
        async handleUpdate() {
          return { handled: false, reason: 'foreign_chat' };
        },
      },
    }),
  );

  const result = await poller.runOnce();
  assert.equal(result.ok, true);
  assert.equal(telegram.sent.length, 0);
  assert.equal(state.offset, 6);
  assert.equal(poller.status.lastUpdateAt, null);
});

test('回复失败不毒死循环：offset 仍然前进', async () => {
  const state = createStateStore({ file: null });
  const telegram = makeTelegram({ responses: [[{ update_id: 7 }]], sendError: new Error('reply boom') });
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler() }));

  const result = await poller.runOnce();
  assert.equal(result.ok, true);
  assert.equal(state.offset, 8);
  assert.equal(telegram.sent.length, 0);
});

test('处理单条 update 抛异常：记日志但不卡住队列', async () => {
  const state = createStateStore({ file: null });
  const telegram = makeTelegram({ responses: [[{ update_id: 9 }]] });
  const poller = createUpdatePoller(
    baseOptions({
      telegram,
      state,
      handler: {
        async handleUpdate() {
          throw new Error('handler boom');
        },
      },
    }),
  );
  const result = await poller.runOnce();
  assert.equal(result.ok, true);
  assert.equal(state.offset, 10);
});

test('429：遵从 retry_after（+250ms），offset 不变', async () => {
  const state = createStateStore({ file: null });
  const slept = [];
  const telegram = makeTelegram({
    responses: [
      new TelegramApiError('telegram getUpdates: HTTP 429 Too Many Requests（retry_after=30s）', {
        kind: 'rate_limited',
        method: 'getUpdates',
        status: 429,
        retryAfter: 30,
      }),
      [],
    ],
  });
  const poller = createUpdatePoller(
    baseOptions({ telegram, state, handler: makeHandler(), slept }),
  );

  const result = await poller.runOnce();
  assert.equal(result.ok, false);
  assert.equal(result.delay, 30_250);
  assert.deepEqual(slept, [30_250]);
  assert.equal(state.offset, null);
  assert.equal(poller.status.consecutiveFailures, 1);
  assert.equal(poller.status.lastError.retryAfter, 30);
});

test('指数退避：1s → 2s → 4s → 5s（上限），成功后重置', async () => {
  const state = createStateStore({ file: null });
  const slept = [];
  const telegram = makeTelegram({
    responses: [
      new TelegramApiError('boom 1', { kind: 'network' }),
      new TelegramApiError('boom 2', { kind: 'network' }),
      new TelegramApiError('boom 3', { kind: 'network' }),
      new TelegramApiError('boom 4', { kind: 'network' }),
      [],
    ],
  });
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler(), slept }));

  for (let i = 0; i < 4; i += 1) await poller.runOnce();
  assert.deepEqual(slept, [1000, 2000, 4000, 5000]);
  assert.equal(poller.status.consecutiveFailures, 4);

  await poller.runOnce();
  assert.equal(poller.status.consecutiveFailures, 0);
  assert.equal(poller.status.lastError, null);

  // 恢复后再失败，退避从 base 重新开始
  telegram.responses.push(new TelegramApiError('boom again', { kind: 'network' }));
  await poller.runOnce();
  assert.equal(slept.at(-1), 1000);
});

test('心跳告警：超过阈值才发，且按 alertThrottleMs 限频', async () => {
  const state = createStateStore({ file: null });
  const clock = { value: 0 };
  const telegram = makeTelegram({
    responses: [
      new TelegramApiError('down 1', { kind: 'network' }),
      new TelegramApiError('down 2', { kind: 'network' }),
      new TelegramApiError('down 3', { kind: 'network' }),
    ],
  });
  const poller = createUpdatePoller(
    baseOptions({ telegram, state, handler: makeHandler(), clock }),
  );

  await poller.runOnce(); // t=0：刚启动，不算 stale
  assert.equal(telegram.sent.length, 0);

  clock.value = 1000; // 距启动满 1s，达到阈值
  await poller.runOnce();
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /心跳异常/);
  assert.match(telegram.sent[0].text, /已有 1 分钟/);
  assert.ok(telegram.sent[0].text.includes('down 2'));

  clock.value = 1500; // 仍在限频窗口内
  await poller.runOnce();
  assert.equal(telegram.sent.length, 1);
  assert.ok(state.getAlertAt('heartbeat') !== null);
});

test('401/403 立即告警（鉴权不会自愈），同样限频', async () => {
  const state = createStateStore({ file: null });
  const telegram = makeTelegram({
    responses: [
      new TelegramApiError('telegram getUpdates: HTTP 401 Unauthorized', {
        kind: 'api',
        status: 401,
        description: 'Unauthorized',
      }),
      new TelegramApiError('telegram getUpdates: HTTP 401 Unauthorized', {
        kind: 'api',
        status: 401,
        description: 'Unauthorized',
      }),
    ],
  });
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler() }));

  await poller.runOnce();
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /Telegram 拒绝了这个 bot/);

  await poller.runOnce();
  assert.equal(telegram.sent.length, 1);
});

test('409 冲突告警：提示可能有第二个实例在长轮询', async () => {
  const state = createStateStore({ file: null });
  const telegram = makeTelegram({
    responses: [
      new TelegramApiError('telegram getUpdates: HTTP 409 Conflict', { kind: 'api', status: 409 }),
    ],
  });
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler() }));
  await poller.runOnce();
  assert.match(telegram.sent[0].text, /409/);
  assert.match(telegram.sent[0].text, /另一个进程/);
});

test('恢复后清空告警限频记录（下次异常能立刻告警）', async () => {
  const state = createStateStore({ file: null });
  state.setAlertAt('heartbeat', 1);
  state.setAlertAt('auth', 2);
  const telegram = makeTelegram({
    responses: [
      new TelegramApiError('down', { kind: 'network' }),
      [],
    ],
  });
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler() }));

  await poller.runOnce(); // 失败
  assert.equal(poller.status.consecutiveFailures, 1);

  await poller.runOnce(); // 成功 → recovered
  assert.equal(poller.status.consecutiveFailures, 0);
  assert.equal(state.getAlertAt('heartbeat'), null);
  assert.equal(state.getAlertAt('auth'), null);
});

test('stop(): 中断在途长轮询并让循环退出', async () => {
  const state = createStateStore({ file: null });
  const hanging = {
    async getUpdates({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.code = 'aborted';
          reject(error);
        });
      });
    },
    async sendMessage() {
      return { ok: true, messageId: 1, chatId: CHAT };
    },
  };

  const poller = createUpdatePoller(
    baseOptions({ telegram: hanging, state, handler: makeHandler() }),
  );
  poller.start();
  await poller.stop();
  assert.equal(poller.status.running, false);
});

test('runOnce: 停机中不告警、不再睡', async () => {
  const state = createStateStore({ file: null });
  const slept = [];
  const telegram = {
    async getUpdates({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.code = 'aborted';
          reject(error);
        });
      });
    },
    async sendMessage() {
      return { ok: true, messageId: 1, chatId: CHAT };
    },
  };
  const poller = createUpdatePoller(baseOptions({ telegram, state, handler: makeHandler(), slept }));
  const pending = poller.runOnce();
  await poller.stop();
  const result = await pending;
  assert.deepEqual(result, { ok: false, aborted: true });
  assert.deepEqual(slept, []);
});
