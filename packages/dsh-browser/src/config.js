/**
 * 配置装载：token 只从**文件 / env** 读，绝不硬编码、绝不回显。
 *
 * 生产（ubuntu 容器）里的挂载与 env 见 docker-compose.yml：
 *   /data/api-token.txt   ← 只读挂 ~/dsh-assistant/data/token.txt（与 assistant/tg 共用同一份）
 *   /profile              ← Chromium 持久 profile（登录一次长期有效）
 *
 * 校验策略跟 dsh-tg 保持一致：缺什么就早失败并说清是哪个文件/变量，
 * 但**永远不打印 token 内容**。
 */
import { readFileSync } from 'node:fs';

export const DEFAULTS = Object.freeze({
  host: '0.0.0.0',
  port: 8789,
  sharedTokenFile: '/data/api-token.txt',
  cdpUrl: 'http://127.0.0.1:9222',
  snapshotMaxChars: 48_000,
  openTimeoutMs: 30_000,
  actionTimeoutMs: 20_000,
  maxActionTimeoutMs: 60_000,
  connectTimeoutMs: 5_000,
  settleMs: 1_500,
  // /eval：默认 10s 超时、上限 30s；脚本 200KB、结果序列化后 64KB
  evalTimeoutMs: 10_000,
  maxEvalTimeoutMs: 30_000,
  evalScriptMaxBytes: 200 * 1024,
  evalResultMaxBytes: 64 * 1024,
  publicVncUrl: '',
});

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function numberFrom(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw new Error(`环境变量 ${name} 不是合法数字：${value}`);
  return parsed;
}

function positiveInt(value, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = numberFrom(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min}..${max} 的整数：${value}`);
  }
  return parsed;
}

/**
 * 读共享密钥（与 dsh-assistant / dsh-tg 同一份）。
 * env SHARED_TOKEN 优先，其次文件；内容 trim 后使用。
 * @returns {{token:string, source:string}}
 */
export function loadSharedToken({ env = process.env, readFile = readTextFile } = {}) {
  const path = env.SHARED_TOKEN_FILE || DEFAULTS.sharedTokenFile;
  let value = env.SHARED_TOKEN;
  let source = 'env SHARED_TOKEN';
  if (value === undefined || String(value).trim() === '') {
    // 注入的 readFile 可能直接抛（真实实现返回 null），两种都当成"文件不存在"
    try {
      value = readFile(path);
    } catch {
      value = null;
    }
    source = path;
  }
  if (value === null || value === undefined) {
    throw new Error(`共享密钥缺失：设置 SHARED_TOKEN，或把密钥写入 ${path}（权限 600）`);
  }
  const token = String(value).trim();
  if (token === '') throw new Error(`共享密钥为空：${source}`);
  if (token.length < 8) throw new Error(`共享密钥过短（${token.length} 字符）：${source}`);
  return { token, source };
}

function normalizeHttpUrl(raw, name) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${name} 不能为空`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} 不是合法 URL：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} 只支持 http/https：${value}`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * 完整配置。
 * @param {{env?:Record<string,string|undefined>, readFile?:Function}} [options]
 */
export function loadConfig({ env = process.env, readFile = readTextFile } = {}) {
  const { token, source } = loadSharedToken({ env, readFile });

  const port = positiveInt(env.PORT, DEFAULTS.port, 'PORT', { min: 1, max: 65535 });

  const maxActionTimeoutMs = positiveInt(
    env.MAX_ACTION_TIMEOUT_MS,
    DEFAULTS.maxActionTimeoutMs,
    'MAX_ACTION_TIMEOUT_MS',
    { min: 1_000, max: 600_000 },
  );
  const actionTimeoutMs = positiveInt(
    env.ACTION_TIMEOUT_MS,
    DEFAULTS.actionTimeoutMs,
    'ACTION_TIMEOUT_MS',
    { min: 1_000, max: maxActionTimeoutMs },
  );

  // /eval：脚本跑在页面里，超时与体积都必须有硬上限，否则一个死循环就能把服务拖住
  const maxEvalTimeoutMs = positiveInt(
    env.EVAL_MAX_TIMEOUT_MS,
    DEFAULTS.maxEvalTimeoutMs,
    'EVAL_MAX_TIMEOUT_MS',
    { min: 1_000, max: 120_000 },
  );
  const evalTimeoutMs = positiveInt(env.EVAL_TIMEOUT_MS, DEFAULTS.evalTimeoutMs, 'EVAL_TIMEOUT_MS', {
    min: 100,
    max: maxEvalTimeoutMs,
  });

  return {
    host: String(env.HOST ?? DEFAULTS.host).trim() || DEFAULTS.host,
    port,
    token,
    tokenSource: source,
    cdpUrl: normalizeHttpUrl(env.CDP_URL ?? DEFAULTS.cdpUrl, 'CDP_URL'),
    snapshotMaxChars: positiveInt(env.SNAPSHOT_MAX_CHARS, DEFAULTS.snapshotMaxChars, 'SNAPSHOT_MAX_CHARS', {
      min: 1_000,
      max: 2_000_000,
    }),
    openTimeoutMs: positiveInt(env.OPEN_TIMEOUT_MS, DEFAULTS.openTimeoutMs, 'OPEN_TIMEOUT_MS', {
      min: 1_000,
      max: 180_000,
    }),
    actionTimeoutMs,
    maxActionTimeoutMs,
    evalTimeoutMs,
    maxEvalTimeoutMs,
    evalScriptMaxBytes: positiveInt(env.EVAL_SCRIPT_MAX_BYTES, DEFAULTS.evalScriptMaxBytes, 'EVAL_SCRIPT_MAX_BYTES', {
      min: 1_024,
      max: 4_000_000,
    }),
    evalResultMaxBytes: positiveInt(env.EVAL_RESULT_MAX_BYTES, DEFAULTS.evalResultMaxBytes, 'EVAL_RESULT_MAX_BYTES', {
      min: 1_024,
      max: 4_000_000,
    }),
    connectTimeoutMs: positiveInt(env.CONNECT_TIMEOUT_MS, DEFAULTS.connectTimeoutMs, 'CONNECT_TIMEOUT_MS', {
      min: 500,
      max: 60_000,
    }),
    settleMs: positiveInt(env.SNAPSHOT_SETTLE_MS, DEFAULTS.settleMs, 'SNAPSHOT_SETTLE_MS', {
      min: 0,
      max: 30_000,
    }),
    // 维护者要打开的 noVNC 地址（由 compose 里的 PUBLIC_VNC_URL 注入）。
    // 只用于**告诉人**去哪儿登录，服务本身不依赖它。
    publicVncUrl: String(env.PUBLIC_VNC_URL ?? DEFAULTS.publicVncUrl).trim(),
  };
}
