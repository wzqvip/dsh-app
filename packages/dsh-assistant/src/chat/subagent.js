/**
 * 子代理（sub-agent）：主对话把"干活"委派出去，自己保持轻量、随时能回话。
 *
 * 维护者 2026-11-04 的要求：
 *   "token 预算可以多给点无所谓。或者允许他调用子 agent 去做任务，自己负责和我对话"
 *
 * 设计动机：
 *   主对话的职责是**跟人聊**——要短、要快。但"读 quiz / 查论文 / 起草长文"这类活
 *   需要多轮工具调用和更长输出。混在一条链上会让每次回话都很慢、很贵。
 *   所以拆开：主对话决定"要不要派人"，子代理独立跑（可以用 thinking、更大的 token），
 *   跑完把**结论**交回主对话。
 *
 * 安全边界：
 *   · 子代理**继承同一套工具**（但**不含 delegate_task**，防止无限递归）
 *   · 子代理同样没有提交/删除类工具
 *   · 轮数封顶，避免死循环烧钱
 */

import { chatCompletion } from './llm.js';
import { TOOL_NAMES, executeTool } from './tools.js';

/** 子代理里**不允许**出现的工具（递归 + 提交类） */
const FORBIDDEN_IN_SUBAGENT = new Set(['delegate_task']);

/** 子代理可用的工具定义（过滤掉禁止项） */
export function subAgentTools(toolDefs) {
  return (toolDefs ?? []).filter((def) => !FORBIDDEN_IN_SUBAGENT.has(def.function.name));
}

export const SUBAGENT_SYSTEM_PROMPT = [
  '你是一个执行子任务的子代理，不直接和用户说话。',
  '你的产出会被主对话转述给主人，所以要**结论清晰、带来源、不要客套**。',
  '',
  '工作方式：',
  '1. 需要事实就用工具去拿（事项库 / Canvas / 浏览器 / 联网检索 / 论文检索），不要凭空猜。',
  '2. 工具失败时如实说明失败原因与你尝试过什么，不要编。',
  '3. 完成后用**中文、简洁、结构化**给出结论（要点 + 来源）。',
  '4. 你**没有**提交作业/交卷/发消息给对方的能力，也不要假装做过。',
].join('\n');

/**
 * 跑一个子代理任务。
 *
 * @param {object} options
 * @param {object} options.llm {apiKey, baseUrl, model}
 * @param {string} options.goal 任务目标（主对话写的）
 * @param {string} [options.context] 额外背景
 * @param {object[]} options.toolDefs 工具定义
 * @param {object} options.toolCtx 工具执行上下文
 * @param {boolean} [options.thinking] 是否开启思考（默认开）
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxRounds]
 * @param {(msg:string)=>void} [options.log]
 * @param {typeof chatCompletion} [options.chat]
 * @returns {Promise<{ok:boolean, text:string, rounds:number, usage:object|null, error?:string}>}
 */
export async function runSubAgent({
  llm,
  goal,
  context = '',
  toolDefs = [],
  toolCtx = {},
  thinking = true,
  maxTokens = 2500,
  maxRounds = 4,
  log = () => {},
  chat = chatCompletion,
} = {}) {
  if (!llm?.apiKey) return { ok: false, text: '', rounds: 0, usage: null, error: '没有 LLM 凭据' };
  const task = String(goal ?? '').trim();
  if (!task) return { ok: false, text: '', rounds: 0, usage: null, error: 'goal 不能为空' };

  const tools = subAgentTools(toolDefs);
  const messages = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: context ? `${task}\n\n【背景】\n${context}` : task },
  ];

  let usage = null;
  let rounds = 0;

  while (rounds <= maxRounds) {
    const result = await chat({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      messages,
      maxTokens,
      thinking: thinking ? 'enabled' : 'disabled',
      tools,
    });
    usage = result.usage ?? usage;

    if (!result.toolCalls?.length) {
      return { ok: true, text: String(result.reply ?? '').trim(), rounds, usage };
    }

    rounds += 1;
    if (rounds > maxRounds) break;

    messages.push(result.assistantMessage);
    for (const call of result.toolCalls) {
      const name = call.function?.name;
      if (!TOOL_NAMES.includes(name) || FORBIDDEN_IN_SUBAGENT.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: `tool "${name}" not allowed in subagent` }),
        });
        continue;
      }
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      log(`子代理工具：${name}`);
      let output;
      try {
        output = await executeTool(name, args, toolCtx);
      } catch (error) {
        output = { ok: false, error: String(error?.message ?? error) };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output).slice(0, 8000),
      });
    }
  }

  return finalize({
    llm,
    chat,
    messages,
    maxTokens,
    thinking,
    rounds,
    usage,
    maxRounds,
    log,
  });
}

/**
 * 轮次用完时**不要直接失败** —— 让模型用已收集的信息给一份结论。
 * 实测：子代理查了 5 轮工具，明明已有足够信息，却因为"没到最后一轮"直接报失败，
 * 主对话只能自己善后。这个兜底能把"失败"变成"带保留的答案"。
 */
async function finalize({ llm, chat, messages, maxTokens, thinking, rounds, usage, maxRounds, log }) {
  log(`子代理达到 ${maxRounds} 轮上限，要求它用现有信息收尾`);
  messages.push({
    role: 'user',
    content:
      '工具轮次已用完。请**立刻**基于你已经拿到的信息给出结论：' +
      '说明哪些是确认的事实（带来源）、哪些还不确定。不要再调用工具。',
  });

  try {
    const result = await chat({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      messages,
      maxTokens,
      thinking: thinking ? 'enabled' : 'disabled',
      tools: null, // 强制收尾，不许再调工具
    });
    return {
      ok: true,
      text: String(result.reply ?? '').trim(),
      rounds,
      usage: result.usage ?? usage,
      truncated: true,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      rounds,
      usage,
      error: `子代理超过 ${maxRounds} 轮仍未给出结论，收尾也失败：${String(error?.message ?? error)}`,
    };
  }
}
