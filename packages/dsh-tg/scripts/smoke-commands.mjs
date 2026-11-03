#!/usr/bin/env node
/**
 * 部署后的只读冒烟：用**真实的 assistant**跑一遍命令分发，打印回复原文。
 *
 * 为什么单独写这个脚本：
 *   入站消息只能由维护者从 Telegram 发，自动化验证不到；但"拿到 update →
 *   解析 → 调 assistant → 生成回复"这段可以在容器里用**合成 update** 验证。
 *   本脚本只做**读操作**（/status、/list、/help）+ 一个必然失败的 `/done 99`，
 *   绝不修改真实数据。
 *
 * 用法（ubuntu 上）：
 *   docker exec dsh-tg node scripts/smoke-commands.mjs
 */
import { createAssistantClient } from '../src/assistant.js';
import { loadConfig } from '../src/config.js';
import { createCommandHandler } from '../src/handler.js';
import { createSeqStore } from '../src/seq.js';
import { createStateStore } from '../src/state.js';

const config = loadConfig({ env: process.env });
const assistant = createAssistantClient({
  baseUrl: config.assistant.baseUrl,
  token: config.assistant.token,
  timeoutMs: config.assistant.timeoutMs,
});
// 内存里的序号映射：冒烟不污染线上 /state/seq.json
const seq = createSeqStore({ file: null });
// 只读取真实 offset 用于展示；其余运行时字段是合成快照（真实值看 /health）
const state = createStateStore({ file: config.stateFile });
const handler = createCommandHandler({
  assistant,
  seq,
  config,
  logger: { error() {}, warn() {}, info() {}, debug() {} },
  runtime: () => ({
    running: true,
    startedAt: new Date().toISOString(),
    lastPollOkAt: null,
    lastUpdateAt: null,
    consecutiveFailures: 0,
    offset: state.offset,
    pollTimeoutSec: config.poller.pollTimeoutSec,
  }),
});

console.log('[smoke] 说明：下面是合成 update 的真实命令分发结果；');
console.log('[smoke] /status 里的 tg 运行时字段是合成快照（offset 取自真实状态文件），真实值请 curl /health。');

const chatId = Number(config.telegram.chatId);
let updateId = 1000;
const failures = [];

function update(text) {
  updateId += 1;
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId }, text },
  };
}

const cases = ['/status', '/list 3', '/help', '/done 99', '普通文本', '/next'];

for (const text of cases) {
  const result = await handler.handleUpdate(update(text));
  const reply = result.replies?.[0]?.text ?? '(无回复)';
  console.log(`\n===== ${text} =====`);
  console.log(reply);
  if (!result.handled || !result.replies?.length) failures.push(text);
}

if (failures.length > 0) {
  console.error(`\n[smoke] FAIL：${failures.join(', ')} 没有产生回复`);
  process.exit(1);
}
console.log('\n[smoke] OK：全部命令都产生了回复（只读，未改动真实数据）');
