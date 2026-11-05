import test from 'node:test';
import assert from 'node:assert/strict';

import { SUBAGENT_SYSTEM_PROMPT, runSubAgent, subAgentTools } from '../src/chat/subagent.js';
import { TOOL_DEFS } from '../src/chat/tools.js';

const llm = { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

/** 造一个按脚本返回的 fake chat */
function scriptedChat(steps) {
  let index = 0;
  const calls = [];
  const chat = async (options) => {
    calls.push(options);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return typeof step === 'function' ? step(options) : step;
  };
  return { chat, calls };
}

test('subAgentTools: 过滤掉 delegate_task（禁止递归）', () => {
  const tools = subAgentTools(TOOL_DEFS);
  assert.ok(!tools.some((t) => t.function.name === 'delegate_task'));
  assert.ok(tools.some((t) => t.function.name === 'canvas_read_quiz'));
});

test('SUBAGENT_SYSTEM_PROMPT: 声明不直接跟用户说话 + 无提交能力', () => {
  assert.match(SUBAGENT_SYSTEM_PROMPT, /不直接和用户说话/);
  assert.match(SUBAGENT_SYSTEM_PROMPT, /没有\*\*提交|没有.*提交/);
});

test('runSubAgent: 第一轮就给出结论 → 不调工具', async () => {
  const { chat } = scriptedChat([{ reply: '结论：X', toolCalls: null }]);
  const result = await runSubAgent({ llm, goal: '查 X', toolDefs: TOOL_DEFS, toolCtx: {}, chat });
  assert.equal(result.ok, true);
  assert.equal(result.text, '结论：X');
  assert.equal(result.rounds, 0);
});

test('runSubAgent: 先调工具再给结论', async () => {
  const { chat, calls } = scriptedChat([
    {
      toolCalls: [{ id: 'c1', function: { name: 'list_items', arguments: '{"status":"open","limit":1}' } }],
      assistantMessage: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'list_items' } }] },
    },
    { reply: '有 1 条未完成', toolCalls: null },
  ]);
  const result = await runSubAgent({
    llm,
    goal: '看看有什么',
    toolDefs: TOOL_DEFS,
    toolCtx: { listItems: () => [{ id: 'a', title: 'T', status: 'open' }] },
    chat,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 1);
  assert.match(result.text, /1 条/);
  // 第二次调用应当带上 tool 结果消息
  assert.ok(calls[1].messages.some((m) => m.role === 'tool'));
});

test('runSubAgent: 子代理里不允许调用 delegate_task（递归防护）', async () => {
  const { chat, calls } = scriptedChat([
    {
      toolCalls: [{ id: 'c1', function: { name: 'delegate_task', arguments: '{"goal":"再派一个"}' } }],
      assistantMessage: { role: 'assistant', tool_calls: [] },
    },
    { reply: '拒绝递归', toolCalls: null },
  ]);
  const result = await runSubAgent({ llm, goal: 'g', toolDefs: TOOL_DEFS, toolCtx: {}, chat });
  assert.equal(result.ok, true);
  const toolMessage = calls[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /not allowed in subagent/);
});

test('runSubAgent: 超轮次时强制收尾（不是直接失败）', async () => {
  // 永远只返回 toolCalls，永不收尾
  const alwaysTools = {
    toolCalls: [{ id: 'c1', function: { name: 'list_items', arguments: '{}' } }],
    assistantMessage: { role: 'assistant', tool_calls: [] },
  };
  const { chat, calls } = scriptedChat([alwaysTools, alwaysTools, alwaysTools, { reply: '收尾结论', toolCalls: null }]);
  const result = await runSubAgent({
    llm,
    goal: 'g',
    toolDefs: TOOL_DEFS,
    toolCtx: { listItems: () => [] },
    maxRounds: 2,
    chat,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '收尾结论');
  assert.equal(result.truncated, true);
  // 收尾那次不能再带工具
  const last = calls.at(-1);
  assert.equal(last.tools, null);
});
