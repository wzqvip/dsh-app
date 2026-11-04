/**
 * 对话上下文构造（纯函数）。
 *
 * 设计取舍：**MVP 不做 function calling**。
 *   理由：工具调用会把"模型说错话"升级成"模型做了错事"（比如误标完成、误开页面），
 *   而我们已经有确定性的命令（/list /done /next）承担这些动作。
 *   所以对话层只负责"用已知事实回答 + 引导用命令"，副作用走命令。
 *
 * 事实注入（而不是让模型瞎猜）：
 *   · 当前时间（带时区）
 *   · 未完成事项的**摘要**（近期若干条 + 总数 + 已完成数）
 *   · 学校邮箱会话状态（正常/需要重新登录）
 *   · 可用命令清单
 */

/** 历史保留轮数（user+assistant 各算一条） */
export const KEEP_HISTORY_TURNS = 6;
/** 历史总字符上限（防止长对话把 prompt 撑爆） */
export const MAX_HISTORY_CHARS = 4000;

/** 本地时间文本（不依赖进程 TZ） */
export function localNowText(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).format(now);
  } catch {
    return new Date(now).toISOString();
  }
}

/** 截止时间的人读文本 */
function dueText(iso, timeZone) {
  if (!iso) return '无截止';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * 挑选要注入的"近期未完成"事项。
 * 规则与 /items 一致：未到期优先、按截止升序；已过期的只在末尾少量出现。
 */
export function pickUpcoming(items, { now = new Date(), limit = 8 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const open = (items ?? []).filter((item) => item?.status === 'open' && item.dueAt);
  const future = open
    .filter((item) => Date.parse(item.dueAt) > nowMs)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  return future.slice(0, limit);
}

/** 每条事项把要求正文截到多少字符塞进 prompt（太小答不全，太大烧 token） */
export const DESC_IN_PROMPT_CHARS = 240;

/**
 * 构造 system prompt
 */
export function buildSystemPrompt({
  items = [],
  session = null,
  now = new Date(),
  timeZone = 'UTC',
  upcomingLimit = 8,
} = {}) {
  const openCount = (items ?? []).filter((item) => item?.status === 'open').length;
  const doneCount = (items ?? []).filter((item) => item?.status === 'done').length;
  const upcoming = pickUpcoming(items, { now, limit: upcomingLimit });

  const lines = [
    '你是一个学生的私人助理，通过 Telegram 和主人对话。',
    '语气：简洁、直接、像熟人；中文回答（除非他用英文）。',
    '回复要短 —— 这是手机消息，不要写长篇和表格。',
    '',
    `现在：${localNowText(now, timeZone)}（时区 ${timeZone}）`,
    `事项库：${openCount} 条未完成，${doneCount} 条已完成。`,
  ];

  if (upcoming.length > 0) {
    lines.push('最近的未完成截止：');
    for (const item of upcoming) {
      const course = item.course ? `（${item.course}）` : '';
      lines.push(`  · ${dueText(item.dueAt, timeZone)}  ${item.title}${course}`);
      // 作业要求：没有这一行，被问「要求是啥」就只能瞎猜或说不知道（维护者 2026-11-04 踩到）
      if (item.description) {
        const text =
          item.description.length > DESC_IN_PROMPT_CHARS
            ? `${item.description.slice(0, DESC_IN_PROMPT_CHARS)}…`
            : item.description;
        lines.push(`      要求：${text.replace(/\n+/g, ' ')}`);
      }
    }
  } else {
    lines.push('最近的未完成截止：暂无。');
  }

  if (session && session.needsUser) {
    lines.push(
      '',
      `⚠️ 学校邮箱当前需要人工登录（原因：${session.reason ?? 'unknown'}）。` +
        '如果主人问起邮箱/邮件，要如实说"需要重新登录才能读"。',
    );
  }

  lines.push(
    '',
    '可用命令（你可以建议他用，但不要假装自己执行了副作用）：',
    '/next 最近 5 个截止 · /list 清单 · /done <序号> 标记完成 · /status 健康状态',
    '',
    '规则：',
    '· 不确定的信息不要编，直接说不知道或建议他用命令查。',
    '· 他问某条作业的「要求」时，用上面「要求：」后面的内容回答；那条没有「要求：」就直说"这条学校没写要求"。',
    '· 不要声称已经替他完成了某个动作（标记完成、打开网页等）——你没有那些权限。',
    '· 不要输出任何密钥、token、密码。',
  );

  return lines.join('\n');
}

/** 修剪历史：只留最近 N 轮，总字符超限时从最旧开始丢 */
export function trimHistory(history, { keepTurns = KEEP_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS } = {}) {
  const list = (history ?? []).filter(
    (entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string',
  );
  let trimmed = list.slice(-keepTurns * 2);

  const total = (arr) => arr.reduce((sum, entry) => sum + entry.content.length, 0);
  while (trimmed.length > 1 && total(trimmed) > maxChars) trimmed = trimmed.slice(1);
  return trimmed;
}

/** 组装 messages */
export function buildMessages({ systemPrompt, history = [], userText }) {
  return [
    { role: 'system', content: systemPrompt },
    ...trimHistory(history),
    { role: 'user', content: String(userText ?? '').slice(0, 2000) },
  ];
}
