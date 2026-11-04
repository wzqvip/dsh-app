/**
 * 命令解析与回复文案 —— **纯函数**，不碰网络/磁盘，方便单测。
 *
 * 解析规则：
 *   · 以 `/` 开头才算命令；`/list@MyBot 5` 这种带 @mention 的写法也支持（群聊里常见）
 *   · 其它文本一律当普通文本 → 转发给 assistant 的 `/chat`（LLM/上下文都在那边）
 *   · 顺序：assistant 已经按「未到期升序 → 无截止 → 已过期（最近的在前）」排好，
 *     本服务**不再重排**（否则会把 2017 年没关的旧作业翻到 /next 第一条）。
 */

export const COMMAND_NAMES = Object.freeze(['next', 'list', 'done', 'ready', 'status', 'help']);
export const DEFAULT_LIST_LIMIT = 10;
export const MAX_LIST_LIMIT = 50;
export const NEXT_COUNT = 5;
export const MAX_REPLY_LENGTH = 4096;
/** 对话回复切分上限：比 4096 留 96 字符余量，避免分条时再被 Telegram 拒 */
export const CHAT_CHUNK_LENGTH = 4000;

/**
 * @param {string} input
 * @returns {{kind:'empty',raw:string}
 *   | {kind:'text',raw:string,text:string}
 *   | {kind:'command',raw:string,name:string,args:string[],mention:string|null,known:boolean}}
 */
export function parseCommand(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { kind: 'empty', raw };
  if (!raw.startsWith('/')) return { kind: 'text', raw, text: raw };

  const parts = raw.split(/\s+/);
  const head = parts[0].slice(1);
  if (!head) return { kind: 'text', raw, text: raw };

  const at = head.indexOf('@');
  const name = (at >= 0 ? head.slice(0, at) : head).toLowerCase();
  const mention = at >= 0 ? head.slice(at + 1) : null;
  if (!name) return { kind: 'text', raw, text: raw };

  return {
    kind: 'command',
    raw,
    name,
    args: parts.slice(1),
    mention,
    known: COMMAND_NAMES.includes(name),
  };
}

/**
 * `/list [n]` 的 n。
 * @returns {{limit:number}|{error:string}}
 */
export function parseLimit(args, { defaultLimit = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT } = {}) {
  const list = Array.isArray(args) ? args : [];
  if (list.length === 0) return { limit: defaultLimit };
  if (list.length > 1) return { error: '参数太多，用法：/list [n]' };
  const token = String(list[0]).trim();
  if (!/^\d+$/.test(token)) return { error: `n 必须是正整数（收到 "${token}"）` };
  const n = Number(token);
  if (n < 1) return { error: 'n 必须 ≥ 1' };
  return { limit: Math.min(n, max) };
}

/**
 * `/done <序号>` 的序号。
 * @returns {{index:number}|{error:string}}
 */
export function parseIndex(args) {
  const list = Array.isArray(args) ? args : [];
  if (list.length === 0) return { error: '缺少序号，用法：/done <序号>（先用 /list 查看）' };
  if (list.length > 1) return { error: '参数太多，用法：/done <序号>' };
  const token = String(list[0]).trim();
  if (!/^\d+$/.test(token)) return { error: `序号必须是正整数（收到 "${token}"）` };
  const n = Number(token);
  if (n < 1) return { error: '序号必须 ≥ 1' };
  return { index: n };
}

/** 截止时间的人类可读形式；无/非法时给明确文案，不猜 */
export function formatDue(iso, timeZone) {
  if (!iso) return '无截止时间';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间无法解析';
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      timeZone,
      hour12: false,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function isOverdue(dueAt, now = new Date()) {
  const ms = Date.parse(dueAt ?? '');
  return Number.isFinite(ms) && ms < now.getTime();
}

/** `1. 标题（课程）— 11/5 23:59 ⚠️已过期` */
export function buildItemLine(item, index, { timeZone, now = new Date(), overdue = true } = {}) {
  const title = String(item?.title ?? '(无标题)');
  const course = item?.course ? `（${item.course}）` : '';
  const due = formatDue(item?.dueAt, timeZone);
  const late = overdue && isOverdue(item?.dueAt, now) ? ' ⚠️已过期' : '';
  return `${index}. ${title}${course} — ${due}${late}`;
}

/** Telegram 上限 4096；超了截断并明确说明（不要静默丢内容） */
export function truncateForTelegram(text, max = MAX_REPLY_LENGTH) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const suffix = '\n…（内容过长已截断）';
  return value.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/**
 * `/list [n]` 回复。
 *
 * ⚠️ assistant 的 `count` 是**本次返回的条数**，不是未完成总数（实测 limit=5 → count=5，
 * 而 /health 的 open 是 301）。所以这里不写"共 N 条未完成"，只写"显示 N 条"，
 * 并在取满 limit 时提示可能还有更多。
 * @param {object} options
 * @param {object[]} options.items 已按展示顺序排好的前 N 条
 * @param {number} [options.limit] 本次请求的条数上限
 * @param {string} options.timeZone
 * @param {Date} [options.now]
 */
export function buildListReply({
  items = [],
  limit = DEFAULT_LIST_LIMIT,
  timeZone,
  now = new Date(),
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '🎉 没有未完成的事项。';

  const header = `📋 未完成事项（显示 ${list.length} 条）`;
  const lines = list.map((item, position) => buildItemLine(item, position + 1, { timeZone, now }));
  const truncated = list.length >= limit;
  const hint = truncated
    ? limit < MAX_LIST_LIMIT
      ? `可能还有更多，用 /list ${MAX_LIST_LIMIT} 查看更多。`
      : `已达到单次上限 ${MAX_LIST_LIMIT} 条。`
    : null;

  const footer = ['', hint, '用 /done <序号> 标记完成。'].filter(Boolean).join('\n');
  return truncateForTelegram(`${header}\n${lines.join('\n')}\n${footer}`);
}

/**
 * `/next` 回复（最近 N 个未完成截止）。
 * 同样不声称"共 N 条未完成"—— count 只是本次返回条数。
 */
export function buildNextReply({ items = [], timeZone, now = new Date(), limit = NEXT_COUNT } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, limit);
  if (list.length === 0) return '🎉 近期没有未完成的截止。';
  const header = `⏰ 最近 ${list.length} 个未完成截止`;
  const lines = list.map((item, position) => buildItemLine(item, position + 1, { timeZone, now }));
  return truncateForTelegram(`${header}\n${lines.join('\n')}\n\n用 /done <序号> 标记完成。`);
}

/**
 * 把长文本切成 ≤ max 的若干条（Telegram 单条上限 4096）。
 *
 * 优先在**换行**处切（不把一句话/一段代码从中间劈开），找不到换行才硬切；
 * 硬切时避开 UTF-16 代理对，防止 emoji 变成乱码。切分本身不添加"第 N 条"标记，
 * 保持 LLM 原本的 Markdown 结构。
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitForTelegram(text, max = CHAT_CHUNK_LENGTH) {
  const value = String(text ?? '');
  if (!value) return [];
  if (value.length <= max) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    let cut = -1;
    const floor = Math.max(1, Math.floor(max / 2));
    for (let i = Math.min(max, rest.length - 1); i >= floor; i -= 1) {
      if (rest[i] === '\n') {
        cut = i;
        break;
      }
    }
    if (cut <= 0) {
      cut = max;
      // 不把代理对劈开（High surrogate 结尾 → 往前退一位）
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    if (cut <= 0) cut = 1; // 理论上到不了；防死循环
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function buildHelpReply() {
  return [
    '🤖 dsh-tg 命令',
    '/next — 最近 5 个未完成截止',
    `/list [n] — 未完成清单（默认 ${DEFAULT_LIST_LIMIT}，最多 ${MAX_LIST_LIMIT}）`,
    '/done <序号> — 把清单里的第 N 项标记完成',
    '/ready — 登录 noVNC 后确认会话是否恢复',
    '/status — 两个服务的健康状况',
    '/help — 这条帮助',
    '',
    '直接发普通文本就能对话（例如「我现在最急的事是什么？」）。',
  ].join('\n');
}

export function buildUnknownCommandReply(name) {
  return `未知命令 /${name}。\n\n${buildHelpReply()}`;
}

/**
 * `/ready` 回复：会话已恢复 / 仍需登录。
 * @param {object} options
 * @param {boolean} options.needsUser
 * @param {string|null} [options.reason]
 * @param {string|null} [options.okSince]
 * @param {string} [options.timeZone]
 */
export function buildReadyReply({ needsUser, reason = null, okSince = null, timeZone } = {}) {
  if (!needsUser) {
    const since = okSince ? `（自 ${formatDue(okSince, timeZone)}）` : '';
    return `✅ 已登录，会话正常${since}。`;
  }
  return `⚠️ 仍未登录（reason=${reason ?? 'unknown'}），请完成登录后再发 /ready。`;
}

function shortDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * `/status` 回复：本服务运行时 + assistant 可达性。
 * 不打印 token，只打印 assistant 的地址与统计。
 */
export function buildStatusReply({ tg = {}, assistant = {}, timeZone, now = new Date() } = {}) {
  const startedMs = Date.parse(tg.startedAt ?? '');
  const uptime = Number.isFinite(startedMs) ? shortDuration(now.getTime() - startedMs) : '未知';
  const lastPoll = tg.lastPollOkAt
    ? `${formatDue(tg.lastPollOkAt, timeZone)} ${tg.consecutiveFailures > 0 ? '⚠️ 最近一轮失败' : '✅'}`
    : '尚未成功（启动中或 token/网络异常）';
  const lastMessage = tg.lastUpdateAt ? formatDue(tg.lastUpdateAt, timeZone) : '暂无';
  const failures = Number(tg.consecutiveFailures) || 0;

  const lines = [
    '🩺 dsh-tg',
    `· 运行时长 ${uptime}`,
    `· 长轮询 ${tg.running ? '运行中' : '已停止'}（超时 ${tg.pollTimeoutSec ?? '?'}s，offset ${tg.offset ?? '无'}）`,
    `· 最近成功轮询 ${lastPoll}`,
    `· 最近收到消息 ${lastMessage}`,
    failures > 0 ? `· ⚠️ 连续失败 ${failures} 次：${tg.lastError?.message ?? '未知错误'}` : '· 最近错误 无',
    '',
    '🩺 assistant',
    `· 地址 ${assistant.baseUrl ?? '未配置'}`,
  ];

  if (assistant.reachable) {
    const parts = [
      `未完成 ${assistant.open ?? 0}`,
      `已提醒待发 ${assistant.pending ?? 0}`,
    ];
    if (Number.isFinite(assistant.latencyMs)) parts.push(`延迟 ${assistant.latencyMs}ms`);
    lines.push(`· 状态 ✅ 可达（${parts.join(' / ')}）`);
    if (assistant.lastSyncAt) lines.push(`· 最近同步 ${formatDue(assistant.lastSyncAt, timeZone)}`);
    if (assistant.lastTickAt) lines.push(`· 最近轮询 ${formatDue(assistant.lastTickAt, timeZone)}`);
  } else {
    const error = assistant.error ?? {};
    const detail = error.status ? `HTTP ${error.status} ${error.message ?? ''}` : error.message ?? '未知错误';
    lines.push(`· 状态 ❌ 不可达：${detail}`);
    lines.push('· 提示：检查 dsh-assistant 容器是否在跑、两侧 x-dsh-token 是否一致。');
  }

  return truncateForTelegram(lines.join('\n'));
}
