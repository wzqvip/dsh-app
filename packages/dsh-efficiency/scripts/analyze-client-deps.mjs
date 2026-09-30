/**
 * 一次性分析脚本：搞清 vendor 客户端源码的依赖形态。
 * 用 Node 而不是 PowerShell —— 正则里的引号/方括号在 PS 里反复出错。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'build', 'vendor');

function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const clientFiles = walk(join(root, 'client'));
const sharedFiles = walk(join(root, 'shared'));
const all = [...clientFiles, ...sharedFiles];

const externals = new Map();
const relativeCount = { clientToShared: 0, sameDir: 0 };
let jsxSuspects = [];

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

for (const f of all) {
  const src = readFileSync(f, 'utf8');
  const short = f.replace(root, '').replace(/\\/g, '/');

  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      if (spec.includes('/shared/')) relativeCount.clientToShared += 1;
      else relativeCount.sameDir += 1;
    } else {
      externals.set(spec, (externals.get(spec) ?? 0) + 1);
    }
  }

  // JSX 粗筛：真正的 JSX 元素形如 <Tag ...> 或 </Tag> 或 <Tag/>
  // 排除 TS 泛型（Promise<boolean> 这类）—— 泛型后面紧跟 , 或 > 或 ) 或 ;
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释
    if (/<\/[A-Za-z]/.test(line) || /\/>\s*[),;]?\s*$/.test(line)) {
      jsxSuspects.push(`${short}:${i + 1}: ${line.trim().slice(0, 90)}`);
    }
  });
}

console.log('=== 文件数 ===');
console.log(`  client: ${clientFiles.length}   shared: ${sharedFiles.length}   合计: ${all.length}`);

console.log('\n=== 相对 import ===');
console.log(`  同目录:        ${relativeCount.sameDir}`);
console.log(`  跨目录 shared: ${relativeCount.clientToShared}`);

console.log('\n=== 外部依赖（裸模块名）===');
for (const [spec, n] of [...externals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${spec}   (${n} 次)`);
}

console.log('\n=== JSX 可疑行（若为空说明全用 h() 调用）===');
if (jsxSuspects.length === 0) console.log('  （无）✅');
else for (const s of jsxSuspects.slice(0, 12)) console.log('  ' + s);
