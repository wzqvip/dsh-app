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
console.log('[smoke] 最后一条普通文本会真实调用 assistant /chat（DeepSeek）一次，这是部署后唯一的付费检查。');

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

const cases = [
  '/status',
  '/list 3',
  '/help',
  '/ready',
  '/done 99',
  '/next',
  // 普通文本 → assistant /chat（真实 LLM 调用，验证转发链路）
  '用一句话说我现在最急的事是什么？',
];

for (const text of cases) {
  const result = await handler.handleUpdate(update(text));
  const replies = Array.isArray(result.replies) ? result.replies : [];
  console.log(`\n===== ${text} =====`);
  if (replies.length === 0) {
    console.log('(无回复)');
  } else {
    replies.forEach((reply, index) => {
      if (replies.length > 1) console.log(`--- 第 ${index + 1}/${replies.length} 条 ---`);
      console.log(reply.text);
    });
  }
  if (!result.handled || replies.length === 0) failures.push(text);
}

if (failures.length > 0) {
  console.error(`\n[smoke] FAIL：${failures.join(' | ')} 没有产生回复`);
  process.exit(1);
}
console.log('\n[smoke] OK：全部命令都产生了回复（/chat 之外均只读，未改动真实数据）');
