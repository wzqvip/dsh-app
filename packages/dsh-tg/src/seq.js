/**
 * 「序号 → item.id」映射的持久化（Lead 定的契约）。
 *
 * 为什么必须单独存：
 *   `/list` / `/next` 回复里展示的是 `1. 2. 3.` 这种**展示序号**，
 *   用户随后发 `/done 2`。如果重启后重新拉一次清单，列表可能已经变了，
 *   同一个序号就会指到别的事项 —— 可能把错的东西标成完成。
 *   所以每次回复时把「序号 → id」落盘，`/done N` 只认这份快照。
 *
 * 语义：
 *   · 每次 `/list` / `/next` **重新分配**序号并整体覆盖
 *   · `/done N` 解析成功后**不删**映射（重复调用幂等；且用户可能接着 /done 别的序号）
 *   · 映射文件损坏/缺失时，`/done` 明确提示"请先 /list"，而不是猜
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { silentLogger } from './log.js';

const SEQ_VERSION = 1;

function defaultFileSystem() {
  return { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync };
}

/**
 * 把一条事项裁剪成持久化需要的字段（不要把整条 item 写进去：
 * 映射文件是给 `/done` 用的，越小越不容易受上游字段变化影响）。
 */
function pick(item, index) {
  return {
    index,
    id: String(item?.id ?? ''),
    title: String(item?.title ?? ''),
    course: item?.course ?? null,
    dueAt: item?.dueAt ?? null,
  };
}

/**
 * @param {object} [options]
 * @param {string|null} [options.file]
 * @param {object} [options.fs]
 * @param {object} [options.logger]
 */
export function createSeqStore({ file = null, fs = defaultFileSystem(), logger = silentLogger } = {}) {
  const state = { version: SEQ_VERSION, at: null, source: null, items: {} };

  function load() {
    if (!file) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`[seq] 读取 ${file} 失败：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn?.(`[seq] ${file} 不是合法 JSON（忽略旧映射）`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    state.at = typeof parsed.at === 'string' ? parsed.at : null;
    state.source = typeof parsed.source === 'string' ? parsed.source : null;
    state.items = {};
    const items = parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
    for (const [key, value] of Object.entries(items)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 1) continue;
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) continue;
      state.items[String(index)] = pick(value, index);
    }
  }

  function save() {
    if (!file) return;
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      logger.error?.(`[seq] 写入 ${file} 失败：${error?.message ?? error}（映射只在内存里）`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  load();

  return {
    file,
    /**
     * 用回复里展示的顺序重新分配 1..N 并覆盖落盘。
     * @param {object[]} items 已按展示顺序排好的事项
     * @param {{source?: string, at?: string}} [meta]
     */
    assign(items, { source = null, at = new Date().toISOString() } = {}) {
      const next = {};
      const list = Array.isArray(items) ? items : [];
      list.forEach((item, position) => {
        const mapped = pick(item, position + 1);
        if (!mapped.id) return;
        next[String(position + 1)] = mapped;
      });
      state.at = at;
      state.source = source;
      state.items = next;
      save();
      return Object.keys(next).length;
    },
    /** @returns {{index:number,id:string,title:string,course?:string|null,dueAt?:string|null}|null} */
    resolve(index) {
      const key = String(index);
      return state.items[key] ?? null;
    },
    /** 完整快照（诊断/测试） */
    get() {
      return {
        version: state.version,
        at: state.at,
        source: state.source,
        items: Object.values(state.items).sort((a, b) => a.index - b.index),
      };
    },
    get size() {
      return Object.keys(state.items).length;
    },
    flush() {
      save();
    },
  };
}
