/**
 * 校验仓库内 markdown 的**相对链接是否都真实存在**。
 *
 * 为什么需要：文档重构（搬进 docs/）会重写几十处相对链接，
 * 而**写错的链接在 GitHub 上只是 404，不会报错** —— 只能靠人点。
 * 这个脚本把所有 .md 里的相对链接抽出来逐个 Test-Path。
 *
 * 用法：node scripts/check-doc-links.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'release', 'dist', 'vendor', '.plugin-manager']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(p, out);
    } else if (name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(repoRoot);
let checked = 0;
const broken = [];

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  // ⚠️ 先**屏蔽行内代码**（反引号包住的内容），再找链接。
  //    否则文档里作为"写法示例"的 `![alt](../url)` 会被当成真链接，
  //    报出假坏链（实测 COMMIT-IDENTITY.md 就有一条）。
  //    屏蔽方式是把代码段替换成等长空白，保持行号/位置不变。
  const src = raw.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  const dir = dirname(f);
  // 匹配 markdown 链接与图片
  for (const m of src.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (!target || target.startsWith('#') || /^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    checked += 1;
    const abs = resolve(dir, decodeURIComponent(path));
    if (!existsSync(abs)) {
      broken.push({ file: relative(repoRoot, f), target, line: raw.slice(0, m.index).split('\n').length });
    }
  }
}

console.log(`[doc-links] 扫描 ${files.length} 个 .md，检查 ${checked} 个相对链接`);
if (broken.length === 0) {
  console.log('[doc-links] PASS：全部指向真实存在的文件');
  process.exit(0);
}
console.log(`[doc-links] FAIL：${broken.length} 个链接指向不存在的文件`);
for (const b of broken.slice(0, 40)) {
  console.log(`  ${b.file}:${b.line}  →  ${b.target}`);
}
process.exit(1);
