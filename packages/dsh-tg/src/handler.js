/**
 * 入站消息 → 命令分发 → 回复文案（纯编排层：不直接碰 Telegram HTTP，方便单测）。
 *
 * 安全：
 *   · **只回复配置里那个 chat**。bot 如果被拉进别的群，机器人不能替别人查你的课程数据。
 *   · 所有 assistant 的错误消息都由 assistant.js 脱敏过，这里只做展示。
 *   · 对话是**无状态转发**：LLM/上下文/历史都在 assistant 侧，本服务不存聊天内容。
 */
import {
  NEXT_COUNT,
  buildHelpReply,
  buildListReply,
  buildNextReply,
  buildReadyReply,
  buildStatusReply,
  buildUnknownCommandReply,
  parseCommand,
  parseIndex,
  parseLimit,
  splitForTelegram,
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
 * 对话失败的用户可见文案。
 * 注意：只说"原因 + 怎么办"，**不回显栈/请求体**；具体错误进容器日志。
 *
 * ⚠️ 超时**不等于**服务挂了：工具轮次放开后一次请求可能跑几分钟，
 * 所以超时文案要说"可能还在跑"，而不是"暂时不可用"。
 */
function formatChatError(error, { timeoutSec = null } = {}) {
  const reason = error?.description || error?.message || '未知错误';
  if (error?.kind === 'timeout') {
    const seconds = Math.max(
      1,
      Math.round((Number(error?.timeoutMs) || (Number(timeoutSec) * 1000) || 600_000) / 1000),
    );
    return `⏳ 这个请求比较久（超过 ${seconds} 秒），可能还在跑；稍等一会儿再问我一次结果。\n（如果一直没回应，发 /status 看服务状态。）`;
  }
  if (error?.kind === 'unreachable') {
    return '⚠️ 对话服务暂时不可用（assistant 不可达）。\n发 /status 查看两个服务的健康状况。';
  }
  if (error?.status === 503) {
    return `⚠️ 对话服务暂时不可用（后台未启用：${reason}）。`;
  }
  if (error?.status === 502) {
    return `⚠️ 对话服务暂时不可用（${reason}）。`;
  }
  if (error?.status === 401 || error?.status === 403) {
    return `⚠️ 对话服务暂时不可用（共享密钥被拒绝，HTTP ${error.status}）。\n请检查两侧的 token 文件是否一致。`;
  }
  return `⚠️ 对话服务暂时不可用（${reason}）。`;
}

/**
 * @param {object} options
 * @param {object} options.assistant assistant 客户端（listItems/setStatus/probe）
 * @param {object} options.seq 序号映射存储（assign/resolve）
 * @param {object} options.config loadConfig() 的结果
 * @param {object} [options.logger]
 * @param {() => Date} [options.now]
 * @param {() => object} [options.runtime] 返回 poller.status，供 /status 用
 * @param {{send: (text:string)=>Promise<void>}} [options.progress]
 *   长对话的"正在处理"提示通道（由 poller 之外的直发通道提供；不影响最终回复）
 */
export function createCommandHandler({
  assistant,
  seq,
  config,
  logger = console,
  now = () => new Date(),
  runtime = () => ({}),
  progress = null,
} = {}) {
  if (!assistant) throw new Error('handler: assistant 客户端必填');
  if (!seq) throw new Error('handler: seq 存储必填');
  if (!config?.telegram?.chatId) throw new Error('handler: config.telegram.chatId 必填');

  const expectedChatId = String(config.telegram.chatId);
  const timeZone = config.timeZone;
  const chatId = config.telegram.chatId;
  const progressDelayMs = Number.isFinite(Number(config.chatProgressDelayMs))
    ? Math.max(0, Number(config.chatProgressDelayMs))
    : 0;
  const chatTimeoutSec = Number.isFinite(Number(config.assistant?.chatTimeoutMs))
    ? Number(config.assistant.chatTimeoutMs) / 1000
    : null;

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

  async function handleReady() {
    try {
      const session = await assistant.checkSession();
      return {
        handled: true,
        replies: [
          {
            text: buildReadyReply({
              needsUser: session.needsUser,
              reason: session.reason,
              okSince: session.okSince,
              timeZone,
            }),
          },
        ],
      };
    } catch (error) {
      logger.error?.(
        `[handler] /session/check 失败：${error?.kind ?? 'unknown'}${error?.status ? ` HTTP ${error.status}` : ''} ${error?.message ?? error}`,
      );
      return { handled: true, replies: [{ text: formatAssistantError(error, '检查登录状态') }] };
    }
  }

  /**
   * 普通文本 → assistant `/chat`（无状态转发），长回复按换行切成多条。
   * 日志只记长度与耗时，**不记聊天内容**。
   *
   * 进度提示：超过 `CHAT_PROGRESS_DELAY_MS` 还没返回时，先发一句"正在处理"，
   * 让用户知道请求没丢（工具轮次放开后可能跑几分钟）。最终回复仍由 poller 统一发送，
   * 两者不会互相打断。
   */
  async function handleChat(text) {
    const startedAt = Date.now();
    let finished = false;
    let progressTimer = null;

    if (progress?.send && progressDelayMs > 0) {
      progressTimer = setTimeout(() => {
        if (finished) return;
        Promise.resolve()
          .then(() => progress.send('⏳ 正在处理（要调工具，可能几十秒甚至几分钟）…'))
          .catch((error) => logger.warn?.(`[handler] 进度提示发送失败：${error?.message ?? error}`));
      }, progressDelayMs);
      if (typeof progressTimer.unref === 'function') progressTimer.unref();
    }

    try {
      const payload = await assistant.chat({ text });
      const reply = typeof payload?.reply === 'string' ? payload.reply.trim() : '';
      if (!reply) {
        logger.warn?.('[handler] /chat 返回空回复');
        return {
          handled: true,
          replies: [{ text: '🤖 对话服务返回了空回复，请再试一次。' }],
        };
      }
      const chunks = splitForTelegram(reply);
      logger.info?.(
        `[handler] /chat 成功：输入 ${text.length} 字 → 回复 ${reply.length} 字（${chunks.length} 条），${Date.now() - startedAt}ms`,
      );
      return { handled: true, replies: chunks.map((chunk) => ({ text: chunk })) };
    } catch (error) {
      logger.error?.(
        `[handler] /chat 失败：${error?.kind ?? 'unknown'}${error?.status ? ` HTTP ${error.status}` : ''} ${error?.message ?? error}`,
      );
      return { handled: true, replies: [{ text: formatChatError(error, { timeoutSec: chatTimeoutSec }) }] };
    } finally {
      finished = true;
      if (progressTimer) clearTimeout(progressTimer);
    }
  }

  async function handleCommand(parsed) {
    switch (parsed.name) {
      case 'next':
        return handleNext();
      case 'list':
        return handleList(parsed.args);
      case 'done':
        return handleDone(parsed.args);
      case 'ready':
        return handleReady();
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
      return handleChat(extracted.text);
    }
    return handleCommand(parsed);
  }

  return { handleUpdate, expectedChatId };
}
