/**
 * 统计会话日志里的关键事件，用于验证"提问是否真的发生"。
 * 用法：node scripts/session-probe.mjs <session.v4.jsonl.zstd> [...]
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { basename, dirname } from 'node:path';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node scripts/session-probe.mjs <session.v4.jsonl.zstd> [...]');
  process.exit(1);
}

for (const p of paths) {
  let plain = '';
  try {
    const buf = readFileSync(p);
    const M = 0xfd2fb528;
    const st = [];
    for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === M) st.push(i);
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      const e = i + 1 < st.length ? st[i + 1] : buf.length;
      try { plain += zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* 末帧未写完 */ }
    }
  } catch (err) {
    console.log(`  读取失败 ${p}: ${err.message}`);
    continue;
  }

  const counts = {};
  const questions = [];
  for (const line of plain.split('\n').filter(Boolean)) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const n = o.event ?? o;
    const t = n.type ?? '?';
    counts[t] = (counts[t] ?? 0) + 1;
    if (t === 'tool/call' && n.data?.name === 'ask_user_question') {
      questions.push({ seq: o.seq ?? n.seq, time: n.time ?? o.time });
    }
  }

  const sessionId = basename(dirname(p));
  console.log(`\n=== ${sessionId} ===`);
  console.log(`  事件总数 ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
  console.log(`  turn/start       : ${counts['turn/start'] ?? 0}`);
  console.log(`  user/message     : ${counts['user/message'] ?? 0}`);
  console.log(`  assistant/message: ${counts['assistant/message'] ?? 0}`);
  console.log(`  tool/call        : ${counts['tool/call'] ?? 0}`);
  console.log(`  ask_user_question: ${questions.length}  <-- 关键`);
  for (const q of questions.slice(-3)) {
    const when = q.time ? new Date(q.time).toISOString() : '?';
    console.log(`      seq=${q.seq} ${when}`);
  }
}
