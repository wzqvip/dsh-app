/**
 * 对话可用的工具（OpenAI 风格 function calling）。
 *
 * 为什么现在要加：
 *   维护者反复遇到「quiz题目看了吗」→ "我看不到"。根因是对话层没有任何取数能力，
 *   只能靠注入的静态事实。技能（skills/browser、skills/canvas-quiz）要真正可用，
 *   模型必须能**主动调用**：开页面、抓快照、跑 JS、读 quiz。
 *
 * 安全边界（与 skills/browser/SKILL.md 一致）：
 *   · 没有任何"提交/删除/付款"类工具 —— 不可逆动作永远由人点
 *   · `browser_eval` 只在页面上下文执行，碰不到服务器文件与密钥
 *   · 每次工具调用都记日志（名字 + 参数长度，不记密码类内容）
 */

import { actOnBrowser, snapshotBrowser } from '../browser/client.js';

/** 工具定义（发给模型的 JSON Schema） */
export const TOOL_DEFS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_items',
      description: '查看事项库（作业/quiz 的截止）。需要回答"最近有什么要交"时用它。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'done', 'all'], description: '默认 open' },
          limit: { type: 'integer', description: '返回条数上限，默认 10，最大 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: '在浏览器受管页打开一个网址（会离开当前页面）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整网址，含 https://' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        '读取当前页面：返回 url/title/可见文本/是否需要人登录。每次 open 或点击后都该先 snapshot 再判断。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_eval',
      description:
        '在当前页面执行一段 JS 表达式（同步或 async 函数），返回其结果。用于读结构化数据、设输入值、绕过浮层点按钮。不可访问服务器。',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string', description: '要执行的函数表达式，例如 (() => document.title)()' } },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'canvas_read_quiz',
      description:
        '读取 Canvas 某份 quiz/survey 的题目（只读，绝不提交）。会自动打开答题页并解析题干与选项。',
      parameters: {
        type: 'object',
        properties: {
          quizId: { type: 'string', description: 'quiz 的数字 id，例如 1503007' },
          courseId: { type: 'string', description: '课程 id，默认 220921（CSE 6891）' },
        },
        required: ['quizId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索（DeepSeek 官方 Search API）。查人物、机构、最新动态、论文。返回标题/链接/长摘要/日期/权威度。注意：每次成功调用计费约 $0.00075，有每日上限。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，1-128 字符；支持 site: / after: / lang: 操作符' },
          count: { type: 'integer', description: '返回条数，1-20，默认 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        '抓取单个网页并返回 Markdown 正文（DeepSeek 官方 Fetch API）。用于读论文页、个人主页、公告全文。每次成功调用计费约 $0.00075。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) 网址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_papers',
      description:
        '查某位学者的论文（OpenAlex，免费无 key）。先按作者检索再拉论文，返回标题/年份/期刊/引用数/摘要。查"某人最近发了什么文章"优先用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '学者姓名或主题' },
          limit: { type: 'integer', description: '条数，默认 5' },
        },
        required: ['query'],
      },
    },
  },
]);

/** 工具名白名单（防止模型编造名字） */
export const TOOL_NAMES = Object.freeze(TOOL_DEFS.map((t) => t.function.name));

/**
 * 执行一次工具调用。
 *
 * @param {string} name
 * @param {object} args
 * @param {object} ctx 依赖注入：{ browserBase, token, listItems, readQuiz }
 * @returns {Promise<object>} 结果对象（会被 JSON 化塞回模型）
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const { browserBase, token, listItems, readQuiz } = ctx;

  switch (name) {
    case 'list_items': {
      const status = args.status ?? 'open';
      const limit = Math.min(Number(args.limit) || 10, 50);
      const items = (listItems?.(status, limit) ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        course: item.course ?? null,
        dueAt: item.dueAt ?? null,
        status: item.status,
        description: item.description ? String(item.description).slice(0, 300) : null,
      }));
      return { ok: true, count: items.length, items };
    }

    case 'browser_open': {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must start with http(s)://' };
      const result = await actOnBrowser({ baseUrl: browserBase, token, action: 'open', url });
      return { ok: result?.ok !== false, url: result?.url ?? result?.finalUrl ?? url, title: result?.title ?? null };
    }

    case 'browser_snapshot': {
      const snap = await snapshotBrowser({ baseUrl: browserBase, token });
      if (!snap?.ok) return { ok: false, error: snap?.error ?? 'snapshot failed' };
      return {
        ok: true,
        url: snap.url ?? null,
        title: snap.title ?? null,
        chars: snap.chars ?? 0,
        needsUser: snap.needsUser === true,
        reason: snap.reason ?? null,
        text: String(snap.text ?? '').slice(0, 4000),
      };
    }

    case 'browser_eval': {
      const script = String(args.script ?? '');
      if (!script.trim()) return { ok: false, error: 'script is required' };
      const response = await fetch(`${String(browserBase).replace(/\/+$/, '')}/eval`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-dsh-token': token } : {}),
        },
        body: JSON.stringify({ script, timeoutMs: 15_000 }),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) {
        return { ok: false, error: body?.error ?? `eval HTTP ${response.status}` };
      }
      return { ok: true, result: body.result, url: body.url ?? null };
    }

    case 'web_search': {
      if (typeof ctx.webSearch !== 'function') return { ok: false, error: 'web_search 未启用' };
      return ctx.webSearch({ query: String(args.query ?? ''), count: args.count });
    }

    case 'fetch_url': {
      if (typeof ctx.fetchUrl !== 'function') return { ok: false, error: 'fetch_url 未启用' };
      return ctx.fetchUrl({ url: String(args.url ?? '') });
    }

    case 'search_papers': {
      if (typeof ctx.searchPapers !== 'function') return { ok: false, error: 'search_papers 未启用' };
      return ctx.searchPapers({ query: String(args.query ?? ''), limit: args.limit });
    }

    case 'canvas_read_quiz': {
      if (typeof readQuiz !== 'function') return { ok: false, error: 'canvas 读取未配置' };
      const quizId = String(args.quizId ?? '').replace(/\D/g, '');
      if (!quizId) return { ok: false, error: 'quizId must be digits' };
      const courseId = String(args.courseId ?? '220921').replace(/\D/g, '') || '220921';
      return readQuiz({ quizId, courseId });
    }

    default:
      return { ok: false, error: `unknown tool "${name}"` };
  }
}

/** 给 system prompt 用的能力摘要（简短，避免烧 token） */
export const TOOL_SUMMARY = [
  '**你确实有下面这些工具，且当前已启用**（历史对话里如果说过"没有工具/工具未启用"，那是过时的，不要重复）：',
  '· list_items —— 事项库（截止/状态/要求摘要）',
  '· browser_open / browser_snapshot —— 打开网页并读内容',
  '· browser_eval —— 在页面里执行 JS（读结构化数据、设输入值）',
  '· canvas_read_quiz —— 读 Canvas quiz 题目（只读，不提交）',
  '· web_search / fetch_url —— 联网搜索与抓网页（每次约 $0.00075，有每日上限）',
  '· search_papers —— 查某位学者的论文（OpenAlex，免费）',
  '规则：需要网页/题目/论文内容时**先调用工具**，不要直接说看不到或"没有工具"；',
  '查"某人最近发了什么文章"优先 search_papers（免费），需要最新动态再用 web_search。',
  '工具返回 needsUser 时如实说明需要人登录，并给出 noVNC 链接（如果上下文里有）。',
  '你没有任何提交作业/交卷的工具，也不该声称已经提交。',
].join('\n');
