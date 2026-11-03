/**
 * 小工具：可中断的 sleep + 时长/时间格式化。
 *
 * 为什么单独抽出来：poller 的退避重试需要「可被 SIGTERM 打断的 sleep」，
 * 否则优雅停机要等满一个退避窗口（最长 60s）。测试里则注入假的 sleep 来断言退避序列。
 */

/**
 * 睡 `ms` 毫秒；`signal` 中断时以 `code: 'aborted'` 的 Error reject。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const error = new Error('aborted');
      error.code = 'aborted';
      reject(error);
    };
    function cleanup() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 把毫秒时长格式化成 `1h2m` / `5m12s` / `42s` */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${restMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/** 毫秒时间戳 → ISO 字符串；null/非法值保持 null（HTTP 返回体里不出现 NaN） */
export function toIso(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 人类可读的日期时间（`11/5 23:59`）。
 * 时区非法时退回 ISO —— 宁可难看，不给错时间。
 */
export function formatDateTime(iso, timeZone) {
  if (!iso) return '无';
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
