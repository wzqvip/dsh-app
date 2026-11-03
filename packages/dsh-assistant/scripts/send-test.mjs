/**
 * 连通性自检：往配置好的 Telegram chat 发一条测试消息。
 *
 * 凭据从**仓库之外**读取（默认 `~/.dsh-assistant/telegram.json`）：
 *   { "token": "<bot token>", "chatId": "<chat id>" }
 *
 * 也可以用环境变量覆盖：`DSH_ASSISTANT_TG_TOKEN` / `DSH_ASSISTANT_TG_CHAT`。
 * ⚠️ token 不会出现在任何输出里（只打印掩码）。
 *
 * 用法：
 *   node scripts/send-test.mjs
 *   node scripts/send-test.mjs --text "自定义测试内容"
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { maskToken, sendTelegramMessage } from '../src/notify/telegram.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const configPath = arg('config', join(homedir(), '.dsh-assistant', 'telegram.json'));

let token = process.env.DSH_ASSISTANT_TG_TOKEN ?? '';
let chatId = process.env.DSH_ASSISTANT_TG_CHAT ?? '';

if ((!token || !chatId) && existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  token = token || config.token || '';
  chatId = chatId || String(config.chatId ?? '');
}

if (!token || !chatId) {
  console.error('[tg] 缺少凭据。');
  console.error(`     写入 ${configPath}：{"token":"<bot token>","chatId":"<chat id>"}`);
  console.error('     或设置环境变量 DSH_ASSISTANT_TG_TOKEN / DSH_ASSISTANT_TG_CHAT');
  process.exit(2);
}

const text =
  arg('text', '') ||
  [
    '🤖 dsh-assistant 连通性自检',
    '',
    '收到这条说明投递链路可用。后续你会收到：',
    '· 🆕 新截止（Canvas 新课业/测验）',
    '· 🔄 截止改期',
    '· ⏰ 到期提醒（T-3d / T-1d / T-4h）',
    '',
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'America/New_York' })}`,
  ].join('\n');

console.log(`[tg] bot=${maskToken(token)}  chat=${chatId}`);
try {
  const result = await sendTelegramMessage({ token, chatId, text });
  console.log(`[tg] ✅ 已发送  messageId=${result.messageId}  chat=${result.chatId}`);
} catch (error) {
  console.error(`[tg] ❌ ${error.message}`);
  console.error('[tg] 常见原因：还没在 Telegram 里对该 bot 点过 Start（bot 不能主动开启私聊）');
  process.exit(1);
}
