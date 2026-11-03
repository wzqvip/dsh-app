/**
 * 运行状态的持久化：**Telegram offset** + 告警限频时间戳。
 *
 * 为什么 offset 必须落盘：
 *   Telegram 的 `getUpdates` 用 offset 确认"我已消费到哪"。重启后如果从 0 开始，
 *   会把最近的消息**全部重复回复一遍**；如果 offset 丢了又没重放，则会漏消息。
 *   落盘后重启从上次确认的位置继续。
 *
 * 写入策略：**同步 + 原子 rename**（先写 `.tmp` 再 rename）。
 *   · 同步：offset 必须在下一次长轮询前落盘，异步写会与进程退出竞争
 *   · 原子：断电/被 kill 时不会留下半截 JSON（最坏是把旧值再用一次）
 *
 * 失败不阻断服务：写盘失败只记日志并把状态留在内存里 —— 宁可重复消费，
 * 不要因为磁盘满了把网关打死。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { silentLogger } from './log.js';

/** state 文件的结构版本（未来改结构时据此迁移） */
const STATE_VERSION = 1;

function defaultFileSystem() {
  return {
    readFileSync,
    writeFileSync,
    renameSync,
    mkdirSync,
    rmSync,
  };
}

function normalizeOffset(value) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

/**
 * @param {object} [options]
 * @param {string|null} [options.file] null = 纯内存（测试/无盘环境）
 * @param {object} [options.fs]
 * @param {object} [options.logger]
 */
export function createStateStore({ file = null, fs = defaultFileSystem(), logger = silentLogger } = {}) {
  const state = {
    version: STATE_VERSION,
    offset: null,
    alerts: {},
    lastError: null,
    updatedAt: null,
  };

  function load() {
    if (!file) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`[state] 读取 ${file} 失败：${error?.message ?? error}（按空状态启动）`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn?.(`[state] ${file} 不是合法 JSON（按空状态启动）`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn?.(`[state] ${file} 结构不对（按空状态启动）`);
      return;
    }
    state.offset = normalizeOffset(parsed.offset);
    state.alerts = parsed.alerts && typeof parsed.alerts === 'object' ? { ...parsed.alerts } : {};
    state.lastError = parsed.lastError ?? null;
    state.updatedAt = parsed.updatedAt ?? null;
  }

  function save() {
    if (!file) return;
    state.updatedAt = new Date().toISOString();
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      logger.error?.(`[state] 写入 ${file} 失败：${error?.message ?? error}（状态只在内存里，继续运行）`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败无所谓 */
      }
    }
  }

  load();

  return {
    file,
    get offset() {
      return state.offset;
    },
    /** 只前进：小于当前值的写回被忽略（避免并发/重放把 offset 拉回去） */
    setOffset(value) {
      const next = normalizeOffset(value);
      if (next === null) return state.offset;
      if (state.offset !== null && next < state.offset) return state.offset;
      state.offset = next;
      save();
      return state.offset;
    },
    getAlertAt(key) {
      const value = Number(state.alerts?.[key]);
      return Number.isFinite(value) ? value : null;
    },
    setAlertAt(key, ms) {
      const value = Number(ms);
      if (!Number.isFinite(value)) return;
      state.alerts = { ...state.alerts, [key]: value };
      save();
    },
    clearAlert(key) {
      if (!state.alerts || !(key in state.alerts)) return;
      const next = { ...state.alerts };
      delete next[key];
      state.alerts = next;
      save();
    },
    clearAlerts() {
      if (!state.alerts || Object.keys(state.alerts).length === 0) return;
      state.alerts = {};
      save();
    },
    get lastError() {
      return state.lastError;
    },
    set lastError(value) {
      state.lastError = value ?? null;
    },
    /** 立即落盘（停机前用；正常情况下每次变更已经写过） */
    flush() {
      save();
    },
    /** 只读快照（测试/诊断用） */
    toJSON() {
      return {
        version: state.version,
        offset: state.offset,
        alerts: { ...state.alerts },
        lastError: state.lastError,
        updatedAt: state.updatedAt,
      };
    },
  };
}
