/**
 * 配置装载：凭据只从**文件 / env** 读，绝不硬编码进仓库。
 *
 * 三条硬规则：
 *   1. 错误信息里只描述"哪个文件/哪个变量缺了"，**不回显 token 内容**
 *   2. Telegram 凭据的合法形状要早失败（形状不对时连轮询都没必要开始）
 *   3. 端口/时长这类数值要在启动时校验，避免跑起来才发现 NaN
 *
 * 生产（ubuntu 容器）里的挂载与 env 见 docker-compose.yml：
 *   /data/telegram.json       ← 只读挂 ~/dsh-assistant/data/telegram.json
 *   /data/api-token.txt       ← 只读挂 ~/dsh-assistant/data/token.txt
 *   /state/tg-state.json      ← 可写挂 ~/dsh-tg/state
 *   /state/seq.json
 */
import { readFileSync } from 'node:fs';

import { isValidToken } from './telegram.js';

export const DEFAULTS = Object.freeze({
  host: '0.0.0.0',
  port: 8788,
  telegramConfig: '/data/telegram.json',
  sharedTokenFile: '/data/api-token.txt',
  stateFile: '/data/tg-state.json',
  seqFile: '/data/seq.json',
  assistantBaseUrl: 'http://127.0.0.1:8787',
  timeZone: 'America/New_York',
  pollTimeoutSec: 30,
  heartbeatStaleMs: 5 * 60 * 1000,
  alertThrottleMs: 30 * 60 * 1000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60 * 1000,
  logLevel: 'info',
});

function readTextFile(path, readFile = readFileSync) {
  try {
    return readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function readJsonFile(path, readFile = readFileSync) {
  const raw = readTextFile(path, readFile);
  if (raw === null) return { missing: true };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { invalid: true };
  }
}

function numberFrom(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw new Error(`环境变量 ${name} 不是合法数字：${value}`);
  return parsed;
}

/**
 * 读 Telegram 凭据（只取 token 与 chatId；文件里其余字段忽略）。
 * @returns {{token:string, chatId:string, source:string}}
 */
export function loadTelegramCredentials({ env = process.env, readFile = readFileSync } = {}) {
  if (env.TELEGRAM_TOKEN) {
    const token = String(env.TELEGRAM_TOKEN).trim();
    const chatId = String(env.TELEGRAM_CHAT_ID ?? '').trim();
    if (!isValidToken(token)) {
      throw new Error('telegram: TELEGRAM_TOKEN 形状不对（应为 <数字>:<30+ 字符>）');
    }
    if (!chatId) throw new Error('telegram: 设置 TELEGRAM_TOKEN 时也必须设置 TELEGRAM_CHAT_ID');
    return { token, chatId, source: 'env' };
  }

  const path = env.TELEGRAM_CONFIG || DEFAULTS.telegramConfig;
  const { value, missing, invalid } = readJsonFile(path, readFile);
  if (missing) {
    throw new Error(`telegram: 找不到凭据文件 ${path}（应为 {token, chatId}，权限 600）`);
  }
  if (invalid) throw new Error(`telegram: 凭据文件 ${path} 不是合法 JSON`);

  const token = typeof value?.token === 'string' ? value.token.trim() : '';
  const chatId = value?.chatId === undefined || value?.chatId === null ? '' : String(value.chatId).trim();
  if (!isValidToken(token)) {
    throw new Error(`telegram: 凭据文件 ${path} 里的 token 形状不对（应为 <数字>:<30+ 字符>）`);
  }
  if (!chatId) throw new Error(`telegram: 凭据文件 ${path} 缺少 chatId`);
  return { token, chatId, source: path };
}

/**
 * 读共享密钥（assistant ↔ tg 双向鉴权）。
 * 内容经 trim 后使用；不打印、不入返回体。
 */
export function loadSharedToken({ env = process.env, readFile = readFileSync } = {}) {
  const path = env.SHARED_TOKEN_FILE || DEFAULTS.sharedTokenFile;
  let value = env.SHARED_TOKEN;
  let source = 'env SHARED_TOKEN';
  if (value === undefined || String(value).trim() === '') {
    value = readTextFile(path, readFile);
    source = path;
  }
  if (value === null || value === undefined) {
    throw new Error(`共享密钥缺失：设置 SHARED_TOKEN，或把密钥写入 ${path}（权限 600）`);
  }
  const trimmed = String(value).trim();
  if (trimmed === '') throw new Error(`共享密钥为空：${source}`);
  if (trimmed.length < 8) throw new Error(`共享密钥过短（${trimmed.length} 字符）：${source}`);
  return trimmed;
}

function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('ASSISTANT_BASE_URL 不能为空');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`ASSISTANT_BASE_URL 不是合法 URL：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`ASSISTANT_BASE_URL 只支持 http/https：${value}`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * 完整配置。
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.readFile]
 */
export function loadConfig({ env = process.env, readFile = readFileSync } = {}) {
  const telegram = loadTelegramCredentials({ env, readFile });
  const sharedToken = loadSharedToken({ env, readFile });

  const port = numberFrom(env.PORT, DEFAULTS.port, 'PORT');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 不是合法端口：${port}`);
  }

  const pollTimeoutSec = numberFrom(env.POLL_TIMEOUT_SEC, DEFAULTS.pollTimeoutSec, 'POLL_TIMEOUT_SEC');
  if (!Number.isFinite(pollTimeoutSec) || pollTimeoutSec < 1 || pollTimeoutSec > 60) {
    throw new Error(`POLL_TIMEOUT_SEC 必须在 1..60（长轮询上限）：${pollTimeoutSec}`);
  }

  const heartbeatStaleMs = numberFrom(env.HEARTBEAT_STALE_MS, DEFAULTS.heartbeatStaleMs, 'HEARTBEAT_STALE_MS');
  const alertThrottleMs = numberFrom(env.ALERT_THROTTLE_MS, DEFAULTS.alertThrottleMs, 'ALERT_THROTTLE_MS');
  const backoffBaseMs = numberFrom(env.BACKOFF_BASE_MS, DEFAULTS.backoffBaseMs, 'BACKOFF_BASE_MS');
  const backoffMaxMs = numberFrom(env.BACKOFF_MAX_MS, DEFAULTS.backoffMaxMs, 'BACKOFF_MAX_MS');

  const logLevel = String(env.LOG_LEVEL ?? DEFAULTS.logLevel).trim().toLowerCase();
  if (!['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    throw new Error(`LOG_LEVEL 只支持 error|warn|info|debug：${logLevel}`);
  }

  return {
    host: String(env.HOST ?? DEFAULTS.host).trim() || DEFAULTS.host,
    port,
    timeZone: String(env.TG_TIMEZONE ?? env.TZ ?? DEFAULTS.timeZone).trim() || DEFAULTS.timeZone,
    logLevel,
    telegram,
    sharedToken,
    assistant: {
      baseUrl: normalizeBaseUrl(env.ASSISTANT_BASE_URL ?? DEFAULTS.assistantBaseUrl),
      token: String(env.ASSISTANT_TOKEN ?? '').trim() || sharedToken,
      timeoutMs: numberFrom(env.ASSISTANT_TIMEOUT_MS, 10_000, 'ASSISTANT_TIMEOUT_MS'),
    },
    stateFile: String(env.STATE_FILE ?? DEFAULTS.stateFile).trim() || DEFAULTS.stateFile,
    seqFile: String(env.SEQ_FILE ?? DEFAULTS.seqFile).trim() || DEFAULTS.seqFile,
    poller: {
      pollTimeoutSec,
      heartbeatStaleMs,
      alertThrottleMs,
      backoffBaseMs,
      backoffMaxMs,
    },
  };
}
