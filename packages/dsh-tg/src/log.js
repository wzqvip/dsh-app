/**
 * 极简日志：带时间戳与级别，且**永远**过一遍 token 脱敏。
 *
 * 为什么不用第三方：本项目约定零依赖；console 的默认输出又容易被
 * `fetch` 异常里夹带的 URL（含 token）污染。
 */
import { maskToken } from './telegram.js';

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

/**
 * @param {object} [options]
 * @param {'error'|'warn'|'info'|'debug'} [options.level]
 * @param {string} [options.token] 需要从所有输出里抹掉的 token
 * @param {{log?:Function, info?:Function, error?:Function}} [options.sink]
 * @param {() => Date} [options.clock] 仅用于时间戳（测试可注入）
 */
export function createLogger({ level = 'info', token = null, sink = console, clock = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const scrub = (value) => {
    const text = String(value ?? '');
    if (typeof token !== 'string' || token.length < 8) return text;
    return text.split(token).join(maskToken(token));
  };

  const write = (levelName, args) => {
    if (LEVELS[levelName] > threshold) return;
    const line = `[dsh-tg] ${clock().toISOString()} ${levelName.toUpperCase()} ${args.map(scrub).join(' ')}`;
    const out = levelName === 'error' ? sink.error ?? sink.log : sink.log ?? sink.info;
    if (typeof out === 'function') out.call(sink, line);
  };

  return {
    level,
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
  };
}

/** 测试 / 无日志场景用的空实现 */
export const silentLogger = Object.freeze({
  level: 'silent',
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});
