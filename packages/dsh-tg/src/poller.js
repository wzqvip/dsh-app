/**
 * 长轮询循环：getUpdates → 分发 → 回复 → 前进并落盘 offset。
 *
 * 稳定性设计（每一条都有单测）：
 *   · **offset 持久化**：重启不重复回复历史消息
 *   · **指数退避**：网络抖动时不要打满 Telegram（1s → 2s → 4s … 上限可配）
 *   · **429 遵从 retry_after**：Telegram 说等多久就等多久（+250ms 余量）
 *   · **心跳告警**：用户不发消息是正常的，所以心跳只看"最近一次 getUpdates 成功"。
 *     超过 `heartbeatStaleMs` 没成功 → 给自己发一条告警；之后按 `alertThrottleMs` 限频。
 *   · **单条消息失败不毒死循环**：处理/回复异常只记录，offset 仍然前进（避免同一条无限重放）。
 *   · **可中断 sleep**：SIGTERM 时不用等满退避窗口。
 */
import { toIso } from './util.js';
import { sleep as defaultSleep } from './util.js';

/**
 * 指数退避（无抖动，便于测试断言；生产上最大值有限，抖动意义不大）。
 * @param {object} [options]
 * @param {number} [options.baseMs]
 * @param {number} [options.maxMs]
 * @param {number} [options.factor]
 */
export function createBackoff({ baseMs = 1000, maxMs = 60_000, factor = 2 } = {}) {
  let attempt = 0;
  return {
    next() {
      const raw = Math.min(maxMs, baseMs * factor ** attempt);
      attempt += 1;
      return Math.max(0, Math.round(raw));
    },
    reset() {
      attempt = 0;
    },
    get attempt() {
      return attempt;
    },
    get baseMs() {
      return baseMs;
    },
    get maxMs() {
      return maxMs;
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.telegram createTelegramClient() 的结果
 * @param {string|number} options.chatId 回复目标 chat
 * @param {object} options.state createStateStore() 的结果
 * @param {{handleUpdate:Function}} options.handler 命令处理器
 * @param {object} options.config loadConfig() 的结果（或至少含 poller 段）
 * @param {object} [options.logger]
 * @param {() => number} [options.now] 毫秒时间；测试注入
 * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [options.sleep]
 * @param {object} [options.backoff]
 */
export function createUpdatePoller({
  telegram,
  chatId,
  state,
  handler,
  config,
  logger = console,
  now = () => Date.now(),
  sleep = defaultSleep,
  backoff,
} = {}) {
  if (!telegram || typeof telegram.getUpdates !== 'function') {
    throw new Error('poller: telegram 客户端必填');
  }
  if (!state) throw new Error('poller: state 必填');
  if (!handler || typeof handler.handleUpdate !== 'function') {
    throw new Error('poller: handler 必填');
  }

  const pollerConfig = {
    pollTimeoutSec: 30,
    heartbeatStaleMs: 5 * 60 * 1000,
    alertThrottleMs: 30 * 60 * 1000,
    backoffBaseMs: 1000,
    backoffMaxMs: 60_000,
    ...(config?.poller ?? {}),
  };
  const pollTimeoutSec = pollerConfig.pollTimeoutSec;
  const heartbeatStaleMs = pollerConfig.heartbeatStaleMs;
  const alertThrottleMs = pollerConfig.alertThrottleMs;
  const backoffState =
    backoff ?? createBackoff({ baseMs: pollerConfig.backoffBaseMs, maxMs: pollerConfig.backoffMaxMs });

  const startedAt = now();
  let stopping = false;
  let loopPromise = null;
  let abortController = new AbortController();

  let lastPollOkAt = null;
  let lastUpdateAt = null;
  let lastError = null;
  let consecutiveFailures = 0;
  // 正在处理 update（可能是一次几分钟的 LLM 对话）：这期间没在长轮询是**正常**的，
  // 不能因此把 /health 标成 stale，否则长请求看起来像故障。
  let busy = false;

  /** 发一条告警给自己（限频）；失败只记日志 —— 告警发不出去不能反噬主循环 */
  async function sendAlert(key, text) {
    const lastAt = state.getAlertAt(key);
    if (lastAt !== null && now() - lastAt < alertThrottleMs) return false;
    try {
      await telegram.sendMessage({ chatId, text, format: 'plain' });
      state.setAlertAt(key, now());
      logger.warn?.(`[poller] 已发送告警（${key}）：${text}`);
      return true;
    } catch (error) {
      logger.error?.(`[poller] 告警发送失败（${key}）：${error?.message ?? error}`);
      return false;
    }
  }

  /** 按故障类型决定要不要告警；心跳只看"多久没成功轮询" */
  async function maybeAlert(error, at) {
    if (error?.status === 401 || error?.status === 403) {
      await sendAlert(
        'auth',
        `⚠️ dsh-tg：Telegram 拒绝了这个 bot（HTTP ${error.status}）。请检查 /data/telegram.json 里的 token。`,
      );
      return;
    }
    if (error?.status === 409) {
      await sendAlert(
        'conflict',
        '⚠️ dsh-tg：getUpdates 冲突（409）。可能有另一个进程在用同一个 bot token 长轮询，请确认只跑一个实例。',
      );
      return;
    }
    const since = lastPollOkAt ?? startedAt;
    const staleFor = at - since;
    if (staleFor >= heartbeatStaleMs) {
      const minutes = Math.max(1, Math.round(staleFor / 60_000));
      await sendAlert(
        'heartbeat',
        `⚠️ dsh-tg 心跳异常：已有 ${minutes} 分钟没能成功拉取 Telegram 更新。\n最近错误：${error?.message ?? '未知'}`,
      );
    }
  }

  async function processUpdates(updates) {
    for (const update of updates) {
      if (stopping) return;
      const updateId = Number(update?.update_id);

      try {
        const result = await handler.handleUpdate(update);
        if (result?.handled === false) {
          logger.info?.(`[poller] 跳过 update=${updateId}：${result.reason ?? '未处理'}`);
        } else {
          const replies = Array.isArray(result?.replies) ? result.replies : [];
          for (const reply of replies) {
            try {
              await telegram.sendMessage({
                chatId,
                text: reply.text,
                format: reply.format ?? 'plain',
              });
            } catch (error) {
              // 回复失败不影响 offset：否则一条失败消息会被无限重放
              logger.error?.(`[poller] 回复 update=${updateId} 失败：${error?.message ?? error}`);
            }
          }
          lastUpdateAt = now();
        }
      } catch (error) {
        logger.error?.(`[poller] 处理 update=${updateId} 失败：${error?.message ?? error}`);
      }

      // 无论如何都确认这条 update（at-least-once 的取舍：宁可丢一次回复，不要卡死队列）
      if (Number.isFinite(updateId)) state.setOffset(updateId + 1);
    }
  }

  /**
   * 跑一轮（含成功路径或失败后的退避等待）。测试直接调它，无需真定时器。
   * @returns {Promise<{ok:boolean,count?:number,recovered?:boolean,delay?:number,error?:Error,aborted?:boolean}>}
   */
  async function runOnce() {
    try {
      const updates = await telegram.getUpdates({
        offset: Number.isFinite(state.offset) ? state.offset : undefined,
        timeoutSec: pollTimeoutSec,
        signal: abortController.signal,
      });

      const recovered = consecutiveFailures > 0;
      lastPollOkAt = now();
      consecutiveFailures = 0;
      backoffState.reset();
      if (recovered) {
        logger.info?.('[poller] Telegram 轮询已恢复');
        state.clearAlerts();
        lastError = null;
      }

      busy = true;
      try {
        await processUpdates(updates);
      } finally {
        busy = false;
      }
      return { ok: true, count: updates.length, recovered };
    } catch (error) {
      busy = false;
      if (stopping || error?.code === 'aborted' || error?.kind === 'aborted') {
        return { ok: false, aborted: true };
      }

      consecutiveFailures += 1;
      lastError = {
        at: now(),
        kind: error?.kind ?? 'unknown',
        status: error?.status ?? null,
        message: error?.message ?? String(error),
        retryAfter: error?.retryAfter ?? null,
      };
      logger.error?.(`[poller] getUpdates 失败（第 ${consecutiveFailures} 次）：${lastError.message}`);
      await maybeAlert(error, lastError.at);

      // 429：Telegram 说等多久就等多久（+250ms 防止边界上又被拒）
      const delay =
        Number.isFinite(error?.retryAfter) && error.retryAfter > 0
          ? error.retryAfter * 1000 + 250
          : backoffState.next();
      logger.info?.(`[poller] ${(delay / 1000).toFixed(1)}s 后重试`);
      try {
        await sleep(delay, abortController.signal);
      } catch {
        return { ok: false, aborted: true };
      }
      return { ok: false, delay, error };
    }
  }

  async function loop() {
    logger.info?.(
      `[poller] 开始长轮询（timeout=${pollTimeoutSec}s，offset=${state.offset ?? '无'}，心跳阈值=${heartbeatStaleMs}ms）`,
    );
    while (!stopping) {
      const result = await runOnce();
      if (result.aborted || stopping) break;
    }
    logger.info?.('[poller] 长轮询已停止');
  }

  return {
    start() {
      if (loopPromise) return;
      stopping = false;
      abortController = new AbortController();
      loopPromise = loop().finally(() => {
        loopPromise = null;
      });
    },
    /**
     * 优雅停止：中断在途的长轮询 + 等待循环退出（有上限，避免 SIGTERM 卡住）。
     */
    async stop({ timeoutMs = pollTimeoutSec * 1000 + 5000 } = {}) {
      stopping = true;
      abortController.abort();
      if (!loopPromise) return;
      let timer = null;
      await Promise.race([
        loopPromise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
    runOnce,
    get status() {
      const since = lastPollOkAt ?? startedAt;
      return {
        running: loopPromise !== null,
        busy,
        startedAt: toIso(startedAt),
        lastPollOkAt: toIso(lastPollOkAt),
        lastUpdateAt: toIso(lastUpdateAt),
        lastError: lastError ? { ...lastError, at: toIso(lastError.at) } : null,
        consecutiveFailures,
        offset: state.offset,
        pollTimeoutSec,
        heartbeatStaleMs,
        // 正在处理长对话（busy）时不算 stale：那是**预期内**不轮询
        stale: !busy && now() - since >= heartbeatStaleMs,
      };
    },
    get _internals() {
      return { backoff: backoffState };
    },
  };
}
