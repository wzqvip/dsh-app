#!/usr/bin/env node
/**
 * dsh-tg 入口：装配置 → 起 HTTP（/health、/notify）→ 起长轮询 → 优雅停机。
 *
 * 启动失败（凭据缺失/形状不对）直接退出并打印**不含 token**的原因：
 * 容器 restart: unless-stopped 会把明显配置错误变成重启循环，所以宁可一次说清楚。
 */
import { pathToFileURL } from 'node:url';

import { createAssistantClient } from './assistant.js';
import { loadConfig } from './config.js';
import { createCommandHandler } from './handler.js';
import { createLogger } from './log.js';
import { createUpdatePoller } from './poller.js';
import { createSeqStore } from './seq.js';
import { SERVICE_NAME, SERVICE_VERSION, createHttpServer } from './server.js';
import { createStateStore } from './state.js';
import { createTelegramClient, maskToken } from './telegram.js';

/**
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @returns {Promise<{server:import('node:http').Server, poller:object, state:object, seq:object, config:object, logger:object, shutdown:(signal?:string)=>Promise<void>}|null>}
 */
export async function main({ env = process.env } = {}) {
  let config;
  try {
    config = loadConfig({ env });
  } catch (error) {
    // 配置错误只打印原因，绝不打印 token
    console.error(`[dsh-tg] 启动失败：${error.message}`);
    process.exitCode = 1;
    return null;
  }

  const logger = createLogger({ level: config.logLevel, token: config.telegram.token });
  const startedAt = Date.now();

  let telegram;
  let assistant;
  let state;
  let seq;
  try {
    telegram = createTelegramClient({ token: config.telegram.token, chatId: config.telegram.chatId });
    assistant = createAssistantClient({
      baseUrl: config.assistant.baseUrl,
      token: config.assistant.token,
      timeoutMs: config.assistant.timeoutMs,
      // 对话超时单独放宽（DeepSeek 长回复可能 20s+）
      chatTimeoutMs: config.assistant.chatTimeoutMs,
    });
    state = createStateStore({ file: config.stateFile, logger });
    seq = createSeqStore({ file: config.seqFile, logger });
  } catch (error) {
    console.error(`[dsh-tg] 启动失败：${error.message}`);
    process.exitCode = 1;
    return null;
  }

  const poller = createUpdatePoller({
    telegram,
    chatId: config.telegram.chatId,
    state,
    handler: {
      // 延迟绑定：handler 的 runtime() 需要 poller.status，而 poller 需要 handler
      handleUpdate: (update) => handler.handleUpdate(update),
    },
    config,
    logger,
  });

  const handler = createCommandHandler({
    assistant,
    seq,
    config,
    logger,
    runtime: () => poller.status,
  });

  const server = createHttpServer({
    config,
    telegram,
    state,
    runtime: () => poller.status,
    logger,
    startedAt,
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  logger.info(
    `${SERVICE_NAME} v${SERVICE_VERSION} 监听 ${config.host}:${config.port}，bot=${maskToken(config.telegram.token)}，chat=${config.telegram.chatId}`,
  );
  logger.info(
    `assistant=${config.assistant.baseUrl}，状态文件=${config.stateFile}，序号文件=${config.seqFile}，时区=${config.timeZone}`,
  );

  poller.start();

  let shuttingDown = false;
  async function shutdown(signal = 'manual') {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[dsh-tg] 收到 ${signal}，开始停机`);

    const force = setTimeout(() => {
      logger.error('[dsh-tg] 停机超时，强制退出');
      process.exit(1);
    }, 15_000);
    if (typeof force.unref === 'function') force.unref();

    try {
      await poller.stop();
    } catch (error) {
      logger.error(`[dsh-tg] 停止轮询出错：${error?.message ?? error}`);
    }
    try {
      await new Promise((resolve) => server.close(() => resolve()));
    } catch (error) {
      logger.error(`[dsh-tg] 关闭 HTTP 出错：${error?.message ?? error}`);
    }
    try {
      state.flush();
      seq.flush();
    } catch {
      /* 已尽力 */
    }
    logger.info('[dsh-tg] 已停机');
    clearTimeout(force);
  }

  return { server, poller, state, seq, config, logger, shutdown };
}

/** 只有直接 `node src/index.js` 时才启动（被测试 import 时不会起服务） */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then((app) => {
      if (!app) return;
      const stop = (signal) => {
        app
          .shutdown(signal)
          .then(() => process.exit(0))
          .catch((error) => {
            console.error(`[dsh-tg] 停机失败：${error?.message ?? error}`);
            process.exit(1);
          });
      };
      process.once('SIGTERM', () => stop('SIGTERM'));
      process.once('SIGINT', () => stop('SIGINT'));
      process.on('unhandledRejection', (reason) => {
        app.logger.error(`[dsh-tg] 未处理的 Promise 拒绝：${reason?.stack ?? reason}`);
      });
    })
    .catch((error) => {
      console.error(`[dsh-tg] 启动失败：${error?.message ?? error}`);
      process.exit(1);
    });
}
