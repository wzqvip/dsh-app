/**
 * 入站消息 → 命令分发 → 回复文案（纯编排层：不直接碰 Telegram HTTP，方便单测）。
 *
 * 安全：
 *   · **只回复配置里那个 chat**。bot 如果被拉进别的群，机器人不能替别人查你的课程数据。
 *   · 所有 assistant 的错误消息都由 assistant.js 脱敏过，这里只做展示。
 */
import {
  NEXT_COUNT,
  buildHelpReply,
  buildListReply,
  buildNextReply,
  buildStatusReply,
  buildTextReply,
  buildUnknownCommandReply,
  parseCommand,
  parseIndex,
  parseLimit,
} from './commands.js';

/**
 * 从 Telegram update 里取出可处理的私聊消息。
 * 兼容 message / edited_message（编辑过的命令也回一次，避免用户改了命令没反应）。
 * @returns {{message:object, chatId:string, text:string}|null}
 */
export function extractMessage(update) {
  const message = update?.message ?? update?.edited_message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.text !== 'string') return null;
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return null;
  return { message, chatId: String(chatId), text: message.text };
}

function formatAssistantError(error, action) {
  if (error?.kind === 'unreachable' || error?.kind === 'timeout') {
    return `⚠️ ${action}失败：assistant 服务暂时不可用（${error.message}）。\n发 /status 查看两个服务的健康状况。`;
  }
  if (error?.status === 401 || error?.status === 403) {
    return `⚠️ ${action}失败：assistant 拒绝了共享密钥（HTTP ${error.status}）。\n请检查两侧的 token 文件是否一致。`;
  }
  if (error?.kind === 'invalid_response') {
    return `⚠️ ${action}失败：assistant 返回了无法识别的响应（${error.message}）。`;
  }
  return `⚠️ ${action}失败：${error?.message ?? error}`;
}

/**
 * @param {object} options
 * @param {object} options.assistant assistant 客户端（listItems/setStatus/probe）
 * @param {object} options.seq 序号映射存储（assign/resolve）
 * @param {object} options.config loadConfig() 的结果
 * @param {object} [options.logger]
 * @param {() => Date} [options.now]
 * @param {() => object} [options.runtime] 返回 poller.status，供 /status 用
 */
export function createCommandHandler({
  assistant,
  seq,
  config,
  logger = console,
  now = () => new Date(),
  runtime = () => ({}),
} = {}) {
  if (!assistant) throw new Error('handler: assistant 客户端必填');
  if (!seq) throw new Error('handler: seq 存储必填');
  if (!config?.telegram?.chatId) throw new Error('handler: config.telegram.chatId 必填');

  const expectedChatId = String(config.telegram.chatId);
  const timeZone = config.timeZone;
  const chatId = config.telegram.chatId;

  async function loadOpen(limit) {
    return assistant.listItems({ status: 'open', limit });
  }

  function remember(items, source) {
    try {
      seq.assign(items, { source, at: now().toISOString() });
    } catch (error) {
      // 落盘失败不该阻断回复：本次序号仍可用，只是重启后解析不了
      logger.error?.(`[handler] 序号映射持久化失败：${error?.message ?? error}`);
    }
  }

  async function handleNext() {
    let payload;
    try {
      payload = await loadOpen(NEXT_COUNT);
    } catch (error) {
      return { handled: true, replies: [{ text: formatAssistantError(error, '取未完成清单') }] };
    }
    const items = payload.items.slice(0, NEXT_COUNT);
    remember(items, 'next');
    return {
      handled: true,
      replies: [{ text: buildNextReply({ items, timeZone, now: now() }) }],
    };
  }

  async function handleList(args) {
    const parsed = parseLimit(args);
    if (parsed.error) {
      return { handled: true, replies: [{ text: `⚠️ ${parsed.error}` }] };
    }
    let payload;
    try {
      payload = await loadOpen(parsed.limit);
    } catch (error) {
      return { handled: true, replies: [{ text: formatAssistantError(error, '取未完成清单') }] };
    }
    const items = payload.items.slice(0, parsed.limit);
    remember(items, 'list');
    return {
      handled: true,
      replies: [
        {
          text: buildListReply({
            items,
            limit: parsed.limit,
            timeZone,
            now: now(),
          }),
        },
      ],
    };
  }

  async function handleDone(args) {
    const parsed = parseIndex(args);
    if (parsed.error) {
      return { handled: true, replies: [{ text: `⚠️ ${parsed.error}` }] };
    }

    const target = seq.resolve(parsed.index);
    if (!target || !target.id) {
      return {
        handled: true,
        replies: [
          {
            text: `⚠️ 找不到第 ${parsed.index} 项。\n序号只在最近一次 /list 或 /next 的回复里有效，请先发一次清单命令。`,
          },
        ],
      };
    }

    try {
      await assistant.setStatus(target.id, 'done');
    } catch (error) {
      if (error?.status === 404) {
        return {
          handled: true,
          replies: [
            {
              text: `⚠️ 第 ${parsed.index} 项已不存在（可能来源里被删了），请 /list 刷新清单。`,
            },
          ],
        };
      }
      return { handled: true, replies: [{ text: formatAssistantError(error, `标记「${target.title}」完成`) }] };
    }

    const course = target.course ? `（${target.course}）` : '';
    logger.info?.(`[handler] 已标记完成 id=${target.id}`);
    return {
      handled: true,
      replies: [
        {
          text: `✅ 已标记完成：${target.title}${course}\n（发 /list 查看最新清单）`,
        },
      ],
    };
  }

  async function handleStatus() {
    const tgStatus = runtime() ?? {};
    const probe = await assistant.probe();
    return {
      handled: true,
      replies: [
        {
          text: buildStatusReply({
            tg: { ...tgStatus, pollTimeoutSec: config.poller?.pollTimeoutSec },
            assistant: { baseUrl: assistant.baseUrl, ...probe },
            timeZone,
            now: now(),
          }),
        },
      ],
    };
  }

  async function handleCommand(parsed) {
    switch (parsed.name) {
      case 'next':
        return handleNext();
      case 'list':
        return handleList(parsed.args);
      case 'done':
        return handleDone(parsed.args);
      case 'status':
        return handleStatus();
      case 'help':
        return { handled: true, replies: [{ text: buildHelpReply() }] };
      default:
        return { handled: true, replies: [{ text: buildUnknownCommandReply(parsed.name) }] };
    }
  }

  /**
   * @param {object} update Telegram update
   * @returns {Promise<{handled:boolean, reason?:string, replies?:{text:string,format?:string}[]}>}
   */
  async function handleUpdate(update) {
    const extracted = extractMessage(update);
    if (!extracted) return { handled: false, reason: 'no_text' };
    if (extracted.chatId !== expectedChatId) {
      logger.warn?.(`[handler] 忽略非配置 chat 的消息 chat=${extracted.chatId} update=${update?.update_id}`);
      return { handled: false, reason: 'foreign_chat' };
    }

    const parsed = parseCommand(extracted.text);
    logger.info?.(`[handler] 收到 ${parsed.kind === 'command' ? `/${parsed.name}` : '文本'} update=${update?.update_id} chat=${chatId}`);

    if (parsed.kind === 'empty') {
      return { handled: true, replies: [{ text: buildHelpReply() }] };
    }
    if (parsed.kind === 'text') {
      return { handled: true, replies: [{ text: buildTextReply() }] };
    }
    return handleCommand(parsed);
  }

  return { handleUpdate, expectedChatId };
}
