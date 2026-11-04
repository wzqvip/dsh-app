/**
 * 服务入口：装载配置 → 建 CDP 适配器 → 起 HTTP。
 *
 * 进程模型：本进程只管 HTTP + CDP；Xvfb / x11vnc / websockify / chromium
 * 由 docker/entrypoint.sh 负责拉起（chromium 挂了会自己重启）。
 * 所以这里**不**在退出时去关浏览器：容器停止会把它们一起带走。
 *
 * 日志一律 JSON 行（方便 docker logs | jq）——不打印 token、不打印页面正文。
 */
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { createBrowserController } from './browser.js';
import { createRequestHandler, startHttpServer } from './http.js';
import { createPendingRegistry } from './pending.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  return function log(severity, message, extra = {}) {
    const rank = LEVELS[severity] ?? LEVELS.info;
    if (rank > threshold) return;
    const line = { at: new Date().toISOString(), level: severity, msg: message };
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) line[key] = value;
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  };
}

export async function main() {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger('error', 'config_invalid', { error: String(error?.message ?? error) });
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const browser = createBrowserController({
    cdpUrl: config.cdpUrl,
    actionTimeoutMs: config.actionTimeoutMs,
    maxActionTimeoutMs: config.maxActionTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    settleMs: config.settleMs,
    evalTimeoutMs: config.evalTimeoutMs,
    maxEvalTimeoutMs: config.maxEvalTimeoutMs,
    evalResultMaxBytes: config.evalResultMaxBytes,
    logger,
  });
  const pending = createPendingRegistry();

  const handler = createRequestHandler({
    token: config.token,
    browser,
    pending,
    logger,
    snapshotMaxChars: config.snapshotMaxChars,
    evalScriptMaxBytes: config.evalScriptMaxBytes,
    publicVncUrl: config.publicVncUrl,
  });

  const server = await startHttpServer({ port: config.port, host: config.host, handler });
  logger('info', 'listening', {
    host: config.host,
    port: server.port,
    cdpUrl: config.cdpUrl,
    tokenSource: config.tokenSource,
    vncUrl: config.publicVncUrl || null,
  });

  const shutdown = async (signal) => {
    logger('info', 'shutdown', { signal });
    try {
      await server.close();
    } catch {
      // 忽略
    }
    browser.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 启动即探一次，日志里能立刻看出 CDP 通不通（不通也不退出：Chromium 可能稍后才起来）
  const health = await browser.health();
  logger(health.browserUp ? 'info' : 'warn', 'browser_probe', health);
}

// 只有直接 `node src/server.js` 时才跑（被 import 时保持纯净，便于测试）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'fatal', error: String(error?.message ?? error) }));
    process.exit(1);
  });
}
