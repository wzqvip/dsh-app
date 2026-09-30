/**
 * 用**真实的 git log** 生成一张「提交历史」预览图（SVG，自包含、可复跑）。
 *
 * 为什么生成而不是截屏：
 *   维护者要"一张写 commit 的图"。截图依赖具体工具与窗口、无法复现；
 *   而 git log 本身是权威数据源。这里把它渲染成一张深色配色的时间线图，
 *   内容与 `git log` 完全一致（含真实哈希与日期），别人可随时重跑核对。
 *
 * 用法：node scripts/make-commit-history-svg.mjs [--count 22] [--out <path>]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const count = Number(arg('count', '22'));
const out = arg('out', join(repoRoot, 'docs', 'commit-history.svg'));

const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

// 取真实提交：短哈希 / 日期 / 主题
const raw = git(['log', `-${count}`, '--date=format:%m-%d %H:%M', '--pretty=format:%h%x1f%ad%x1f%s']);
const commits = raw.split('\n').map((line) => {
  const [hash, date, subject] = line.split('\x1f');
  return { hash, date, subject };
});
const total = git(['rev-list', '--count', 'HEAD']);

// 主题前缀着色（feat/fix/docs/test/chore/refactor）
const PREFIX_COLOR = {
  feat: '#7ee787',
  fix: '#ffa657',
  docs: '#79c0ff',
  test: '#d2a8ff',
  chore: '#8b949e',
  refactor: '#ffa657',
};
const colorOf = (s) => {
  const m = /^([a-z]+)(\(|:)/.exec(s);
  return (m && PREFIX_COLOR[m[1]]) || '#c9d1d9';
};
// 主题里带（…）的部分作为范围标签
const scopeOf = (s) => {
  const m = /^[a-z]+\(([^)]+)\)/.exec(s);
  return m ? m[1] : '';
};
const kindOf = (s) => {
  const m = /^([a-z]+)/.exec(s);
  return m ? m[1] : '';
};
const bodyOf = (s) => s.replace(/^[a-z]+(\([^)]*\))?:\s*/, '');

// ---- 布局 ----
const ROW = 34;
const PAD_X = 28;
const TOP = 92;  // 留足空间，避免表头与副标题重叠（实测踩过）
const W = 980;
const H = TOP + commits.length * ROW + 46;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rows = commits
  .map((c, i) => {
    const y = TOP + i * ROW;
    const col = colorOf(c.subject);
    const scope = scopeOf(c.subject);
    const kind = kindOf(c.subject);
    // 主题过长时截断（SVG 无自动换行）
    const body = bodyOf(c.subject);
    const maxBody = 46;
    const shown = body.length > maxBody ? body.slice(0, maxBody - 1) + '…' : body;
    return `
  <g>
    <text x="${PAD_X}" y="${y}" class="hash">${esc(c.hash)}</text>
    <text x="${PAD_X + 74}" y="${y}" class="date">${esc(c.date)}</text>
    ${kind ? `<rect x="${PAD_X + 172}" y="${y - 12}" width="${Math.max(46, kind.length * 8 + 16)}" height="17" rx="4" fill="${col}22" stroke="${col}66"/>` : ''}
    ${kind ? `<text x="${PAD_X + 180}" y="${y + 1}" class="kind" fill="${col}">${esc(kind)}</text>` : ''}
    ${scope ? `<text x="${PAD_X + 262}" y="${y + 1}" class="scope">${esc(scope)}</text>` : ''}
    <text x="${PAD_X + (scope ? 348 : 300)}" y="${y + 1}" class="subject">${esc(shown)}</text>
  </g>`;
  })
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, system-ui, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0d1117"/>
      <stop offset="1" stop-color="#161b22"/>
    </linearGradient>
  </defs>
  <style>
    .title { font-size: 17px; font-weight: 600; fill: #e6edf3; }
    .sub   { font-size: 12px; fill: #8b949e; }
    .col   { font-size: 11px; fill: #6e7681; letter-spacing: .04em; }
    .hash  { font-size: 12px; fill: #58a6ff; font-family: Consolas, ui-monospace, monospace; }
    .date  { font-size: 11px; fill: #6e7681; font-family: Consolas, ui-monospace, monospace; }
    .kind  { font-size: 11px; font-weight: 600; }
    .scope { font-size: 12px; fill: #8b949e; }
    .subject { font-size: 13px; fill: #e6edf3; }
    .line  { stroke: #21262d; stroke-width: 1; }
  </style>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="${PAD_X}" y="34" class="title">dsh-app · 提交历史</text>
  <text x="${PAD_X}" y="54" class="sub">最近 ${commits.length} 条（共 ${total} 条）· 权威来源 git log · 由 scripts/make-commit-history-svg.mjs 生成</text>
  <text x="${PAD_X}" y="${TOP - 16}" class="col">HASH</text>
  <text x="${PAD_X + 74}" y="${TOP - 16}" class="col">DATE</text>
  <text x="${PAD_X + 172}" y="${TOP - 16}" class="col">TYPE</text>
  <text x="${PAD_X + 300}" y="${TOP - 16}" class="col">SUBJECT</text>
  <line x1="${PAD_X}" y1="${TOP - 6}" x2="${W - PAD_X}" y2="${TOP - 6}" class="line"/>
  ${rows}
  <line x1="${PAD_X}" y1="${H - 34}" x2="${W - PAD_X}" y2="${H - 34}" class="line"/>
  <text x="${PAD_X}" y="${H - 14}" class="sub">生成于 ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</text>
</svg>
`;

writeFileSync(out, svg, 'utf8');
console.log(`[commit-svg] 已写盘 ${out}`);
console.log(`[commit-svg] 含 ${commits.length} 条提交（共 ${total} 条），最新：${commits[0]?.hash} ${commits[0]?.subject?.slice(0, 40)}`);
