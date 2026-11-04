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
    '· 上面「最近的未完成截止」是**刚从系统读到的最新事实**。历史对话可能已经过时：',
    '  如果历史里说过"我不知道某某要求"，而现在上面有「要求：」，**以最新事实为准**，不要重复旧结论。',
    '· 不确定的信息不要编，直接说不知道或建议他用命令查。',
    '· 他问某条作业的「要求」时，**必须先把「要求：」后面的原文照转述出来**（哪怕只是',
    '  一个文件名或一句英文），然后再说"学校只给了这些"。**绝不能说"我看不到要求"** ——',
    '  那等于否认你已经拿到的数据。那条没有「要求：」才说"这条学校没填要求"。',
    '· 不要声称已经替他完成了某个动作（标记完成、打开网页等）——你没有那些权限。',
    '· 不要输出任何密钥、token、密码。',
  );

  return lines.join('\n');
}

/** 历史保留时长：超过这个年龄的对话不再注入（事实早就变了，留着只会误导模型） */
export const MAX_HISTORY_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 只生成「最新事实」块（不含人设与规则）。
 *
 * 为什么单独抽出来：小模型会**锚定在历史里自己说过的话**。
 * 实测：上一轮它答过"我看不到要求"，下一轮即使 system prompt 里有「要求：…」，
 * 它仍重复"我没有要求内容"。
 * 解法是把事实**重新注入到紧贴用户提问的位置**（作为最后一条 system），
 * 并显式声明"与历史冲突时以此为准" —— 这比只加强 system prompt 有效得多。
 */
export function buildFactsBlock({
  items = [],
  now = new Date(),
  timeZone = 'UTC',
  upcomingLimit = 8,
} = {}) {
  const upcoming = pickUpcoming(items, { now, limit: upcomingLimit });
  const lines = ['【最新事实 · 与历史对话冲突时以此为准】', '最近的未完成截止：'];

  if (upcoming.length === 0) {
    lines.push('  （暂无）');
  } else {
    for (const item of upcoming) {
      const course = item.course ? `（${item.course}）` : '';
      lines.push(`  · ${dueText(item.dueAt, timeZone)}  ${item.title}${course}`);
      if (item.description) {
        const text =
          item.description.length > DESC_IN_PROMPT_CHARS
            ? `${item.description.slice(0, DESC_IN_PROMPT_CHARS)}…`
            : item.description;
        lines.push(`      要求：${text.replace(/\n+/g, ' ')}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 修剪历史：按轮数、年龄、总字符三个维度收敛。
 *
 * 加"年龄"是因为实测踩到：早上问「OPCA 要求是啥」我答"看不到"，
 * 中午数据已经补全后，历史里那句旧结论让模型继续复读"没有记录"。
 * 带时间戳的条目超过 MAX_HISTORY_AGE_MS 直接丢弃。
 */
export function trimHistory(
  history,
  { keepTurns = KEEP_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS, maxAgeMs = MAX_HISTORY_AGE_MS, now = Date.now() } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const list = (history ?? []).filter((entry) => {
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) return false;
    if (typeof entry.content !== 'string') return false;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return true;
    const at = entry.at ? Date.parse(entry.at) : NaN;
    if (!Number.isFinite(at)) return true; // 没有时间戳的历史不因此丢弃（向后兼容）
    return nowMs - at <= maxAgeMs;
  });

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
