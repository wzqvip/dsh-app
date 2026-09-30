/**
 * 文档结构重构：把次要文档移进 docs/，并**重写全部交叉引用**。
 *
 * 为什么写成脚本而不是手工搬：
 *   根目录 15 个 .md，彼此之间有几十处相对链接（实测 ARCHITECTURE 被引用 19 处、
 *   plan 17 处、NOTICE 13 处…）。手工搬必然漏改，而漏改的链接在 GitHub 上是 404，
 *   且**不会报错**——只能靠人点。所以用一个脚本一次性做完，并且可复跑（幂等）。
 *
 * 规则：
 *   · 留在根目录：README.md（GitHub 门面）、plan.md / todo.md / STATUS.md（用户点名）、
 *     AGENTS.md（agent 每次会话要读，根目录最省事）、NOTICE.md（许可义务，上游 MIT
 *     与素材禁商用的声明必须显眼）
 *   · 移进 docs/：其余
 *   · 链接重写：
 *       - 从根目录指向被移动文件：`X.md` → `docs/X.md`
 *       - 从 docs/ 指向根目录文件：`README.md` → `../README.md`
 *       - 从 docs/ 指向同目录文件：`X.md` → `X.md`（不变）
 *       - 从 docs/ 指向仓库其他路径（如 packages/…）：前面加 `../`
 *       - 从根目录指向 docs/ 内的文件：`X.md` → `docs/X.md`
 *
 * 用法：node scripts/restructure-docs.mjs [--dry]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const dry = process.argv.includes('--dry');

/** 留在仓库根目录的文档（其余 .md 移进 docs/） */
const KEEP_AT_ROOT = new Set([
  'README.md',
  'plan.md',
  'todo.md',
  'STATUS.md',
  'AGENTS.md',
  'NOTICE.md',
]);

const docsDir = join(repoRoot, 'docs');

/** 收集根目录所有 .md */
const rootMds = (await import('node:fs')).readdirSync(repoRoot).filter((f) => f.endsWith('.md'));
const toMove = rootMds.filter((f) => !KEEP_AT_ROOT.has(f)).sort();
const keep = rootMds.filter((f) => KEEP_AT_ROOT.has(f)).sort();

console.log('[restructure] 留在根目录:', keep.join(', '));
console.log('[restructure] 移进 docs/ :', toMove.join(', '));
if (dry) {
  console.log('[restructure] --dry：只打印，不动文件');
  process.exit(0);
}

// ---- 1) 移动文件 ----
mkdirSync(docsDir, { recursive: true });
const moved = [];
for (const f of toMove) {
  const from = join(repoRoot, f);
  const to = join(docsDir, f);
  if (existsSync(to)) {
    console.log(`  = docs/${f} 已存在，跳过移动（可能是重跑）`);
  } else if (existsSync(from)) {
    renameSync(from, to);
    console.log(`  + ${f} → docs/${f}`);
  }
  moved.push(f);
}
// 已经在 docs/ 里的（重跑场景）也算作"已移动"
for (const f of (await import('node:fs')).readdirSync(docsDir)) {
  if (f.endsWith('.md') && !moved.includes(f)) moved.push(f);
}

const movedSet = new Set(moved);
const keptSet = new Set(keep);

/**
 * 把一个 markdown 链接目标按"源文件在根还是 docs/"重写。
 * 只处理**仓库内相对链接**（跳过 http(s)、锚点、绝对路径）。
 */
function rewriteTarget(target, sourceIsInDocs) {
  const t = target.trim();
  if (!t || t.startsWith('#') || /^[a-z]+:/i.test(t) || t.startsWith('/')) return target;

  // 拆出路径与锚点
  const hashAt = t.indexOf('#');
  const path = hashAt >= 0 ? t.slice(0, hashAt) : t;
  const hash = hashAt >= 0 ? t.slice(hashAt) : '';
  if (!path) return target;

  // 仓库根下的 .md（可能带 ./ 前缀）
  const bare = path.replace(/^\.\//, '');
  const rootMd = rootMds.includes(bare);
  const alreadyDocs = bare.startsWith('docs/');
  const docsMd = !alreadyDocs && movedSet.has(bare);

  let out = path;
  if (sourceIsInDocs) {
    // 源在 docs/：指向根目录文件要加 ../；指向同目录文件保持；指向仓库其他路径加 ../
    if (rootMd && keptSet.has(bare)) out = `../${bare}`;
    else if (alreadyDocs) out = bare.slice('docs/'.length);
    else if (docsMd) out = bare;
    else out = `../${bare}`;
  } else {
    // 源在根目录：指向被移动的文件要加 docs/
    if (docsMd) out = `docs/${bare}`;
    else out = path;
  }
  return out + hash;
}

const mdLink = /\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

let changedFiles = 0;
let changedLinks = 0;
const allTargets = [
  ...keep.map((f) => ({ abs: join(repoRoot, f), inDocs: false })),
  ...moved.map((f) => ({ abs: join(docsDir, f), inDocs: true })),
];

for (const { abs, inDocs } of allTargets) {
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  let hits = 0;
  const out = src.replace(mdLink, (whole, target, title) => {
    const next = rewriteTarget(target, inDocs);
    if (next !== target) hits += 1;
    return `](${next}${title ?? ''})`;
  });
  if (hits > 0) {
    writeFileSync(abs, out, 'utf8');
    changedFiles += 1;
    changedLinks += hits;
    console.log(`  ~ ${relative(repoRoot, abs)}: 重写 ${hits} 处链接`);
  }
}

console.log('');
console.log(`[restructure] 完成：移动 ${moved.length} 个文件，重写 ${changedLinks} 处链接（${changedFiles} 个文件）`);
console.log('[restructure] 记得核对：packages/ 内文档若引用根目录文档，也要跟着改。');
