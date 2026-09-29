/**
 * 统计 DSH 会话的 LLM 缓存命中率。
 *
 * 为什么需要它：
 *   长对话的提示会涨到几十万 token，其中绝大部分是缓存命中。
 *   一旦某个改动破坏了「提示前缀稳定性」（换 key、改系统提示、切换模型的
 *   reasoning 档位等），命中率会掉下来，费用随之上升 —— 但这个变化在界面上
 *   几乎看不出来。本脚本把它量化出来。
 *
 * 数据来源：会话日志里每条 assistant/message 的 data.usage：
 *   { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 *   其中 inputTokens 是【未缓存】的输入。因此：
 *     提示总量 = inputTokens + cacheReadTokens
 *     命中率   = cacheReadTokens / (inputTokens + cacheReadTokens)
 *
 * DSH 的会话日志是【拼接多帧 zstd 容器】，不是单个 zstd 流，
 * 所以这里按帧魔数 0xFD2FB528 切分后逐帧解压；最后一个不完整的帧会被跳过
 * （与 DSH 读取器 scanZstdFrames 的行为一致）。
 *
 * 用法：
 *   node scripts/cache-stats.mjs <session.v4.jsonl.zstd>
 *   node scripts/cache-stats.mjs <已解压的 .jsonl>
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/cache-stats.mjs <session.v4.jsonl.zstd | session.jsonl>');
  process.exit(1);
}

const raw = readFileSync(path);

/** 把「拼接多帧 zstd」或纯文本统一成明文 */
function toPlain(buf) {
  // 纯文本（.jsonl）直接返回
  if (buf.length > 0 && buf[0] === 0x7b /* '{' */) return buf.toString('utf8');

  const MAGIC = 0xfd2fb528;
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === MAGIC) starts.push(i);
  }
  if (starts.length === 0) throw new Error('不是 zstd 拼接容器，也不是 JSONL 纯文本');

  let plain = '';
  let ok = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      plain += zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
      ok++;
    } catch {
      /* 末帧可能未写完：跳过，与 DSH 读取器一致 */
    }
  }
  console.error(`[cache-stats] zstd 帧 ${starts.length} 个，解压成功 ${ok} 个`);
  return plain;
}

const plain = toPlain(raw);
const lines = plain.split('\n').filter(Boolean);

const samples = [];
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  const node = o.event ?? o;
  const usage = node?.data?.usage;
  if (!usage || typeof usage.inputTokens !== 'number') continue;
  samples.push({
    seq: o.seq ?? node.seq,
    input: usage.inputTokens,
    read: usage.cacheReadTokens ?? 0,
    write: usage.cacheWriteTokens ?? 0,
    out: usage.outputTokens ?? 0,
  });
}

if (samples.length === 0) {
  console.log('未找到 usage 样本（该会话可能还没跑过模型）');
  process.exit(0);
}

const sum = (k) => samples.reduce((a, s) => a + s[k], 0);
const input = sum('input'), read = sum('read'), write = sum('write'), out = sum('out');
const promptTotal = input + read;
const hitRate = promptTotal > 0 ? (read / promptTotal) * 100 : 0;

console.log(`=== ${samples.length} 次 LLM 调用 ===`);
console.log(`  未缓存输入 inputTokens : ${input.toLocaleString()}`);
console.log(`  缓存读取  cacheRead    : ${read.toLocaleString()}`);
console.log(`  缓存写入  cacheWrite   : ${write.toLocaleString()}`);
console.log(`  输出      outputTokens : ${out.toLocaleString()}`);
console.log('');
console.log(`  提示总量               : ${promptTotal.toLocaleString()}`);
console.log(`  ★ 缓存命中率           : ${hitRate.toFixed(1)}%`);
console.log('');

const mid = Math.floor(samples.length / 2);
const rate = (arr) => {
  const i = arr.reduce((a, s) => a + s.input, 0);
  const r = arr.reduce((a, s) => a + s.read, 0);
  return i + r > 0 ? (r / (i + r)) * 100 : 0;
};
console.log('=== 分段对比（看缓存是否稳定）===');
console.log(`  前 ${mid} 次 : ${rate(samples.slice(0, mid)).toFixed(1)}%`);
console.log(`  后 ${samples.length - mid} 次 : ${rate(samples.slice(mid)).toFixed(1)}%`);
console.log('');

console.log('=== 最近 10 次 ===');
for (const s of samples.slice(-10)) {
  const t = s.input + s.read;
  console.log(`  seq=${s.seq}  prompt=${t}  read=${s.read}  命中=${t > 0 ? ((s.read / t) * 100).toFixed(0) : 0}%`);
}
