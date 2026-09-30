/**
 * 把 SVG 渲染成 PNG。
 *
 * 实现说明（踩过两版才通）：
 *   第一版走 CDP 的 Page.captureScreenshot + 隐藏窗口 —— **不回包**，
 *   8 秒超时；而且 Runtime.evaluate 也返回 undefined（没先 Runtime.enable）。
 *   第二版改用 **Electron 原生 `webContents.capturePage()`**：
 *   它是主进程 API，不依赖 CDP 的渲染管线，对 `show:false` 的窗口同样有效。
 *
 * 用法：node scripts/svg-to-png.mjs [--in docs/commit-history.svg] [--out docs/commit-history.png] [--scale 2]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const inPath = resolve(repoRoot, arg('in', 'docs/commit-history.svg'));
const outPath = resolve(repoRoot, arg('out', 'docs/commit-history.png'));
const scale = Number(arg('scale', '2'));
const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

if (!existsSync(inPath)) {
  console.error('[svg2png] 找不到', inPath);
  process.exit(1);
}

// 从 SVG 自身读尺寸
const svgText = readFileSync(inPath, 'utf8');
const wAttr = /\bwidth="([\d.]+)"/.exec(svgText);
const hAttr = /\bheight="([\d.]+)"/.exec(svgText);
const vb = /viewBox="([\d.\s-]+)"/.exec(svgText);
let W = wAttr ? Number(wAttr[1]) : 0;
let H = hAttr ? Number(hAttr[1]) : 0;
if ((!W || !H) && vb) {
  const p = vb[1].trim().split(/\s+/).map(Number);
  W = W || p[2];
  H = H || p[3];
}
if (!W || !H) {
  console.error('[svg2png] 读不出 SVG 尺寸');
  process.exit(1);
}

const electronPath = [
  join(home, '.dsh', 'electron', 'electron.exe'),
  join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
].find((p) => existsSync(p));
if (!electronPath) {
  console.error('[svg2png] 找不到 electron');
  process.exit(1);
}

const probeDir = join(tmpdir(), 'dsh-svg2png');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const W = Number(process.env.W), H = Number(process.env.H), S = Number(process.env.S || '1');
  const w = new BrowserWindow({
    width: W, height: H, show: false, frame: false, backgroundColor: '#0d1117',
    webPreferences: { partition: 'persist:svg2png', offscreen: false },
    useContentSize: true,
  });
  try {
    await w.loadURL(process.env.U);
  } catch (e) {
    console.log('ERR load ' + e.message);
  }
  // 等字体/样式就绪
  await new Promise((r) => setTimeout(r, 1200));
  try {
    const img = await w.webContents.capturePage();
    const png = S === 1 ? img.toPNG() : img.resize({ width: Math.round(W * S), height: Math.round(H * S) }).toPNG();
    fs.writeFileSync(process.env.OUT, png);
    console.log('OK ' + png.length + ' bytes ' + W + 'x' + H + ' @' + S + 'x');
  } catch (e) {
    console.log('ERR capture ' + e.message);
  }
  app.quit();
});
`,
  'utf8',
);
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-svg2png', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  U: pathToFileURL(inPath).href,
  OUT: outPath,
  W: String(Math.ceil(W)),
  H: String(Math.ceil(H)),
  S: String(scale),
});

const child = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (d) => {
  out += String(d);
});
child.stderr.on('data', () => {});
child.on('exit', () => {
  const line = out.split('\n').find((l) => l.startsWith('OK ') || l.startsWith('ERR ')) ?? '(无输出)';
  if (line.startsWith('OK')) {
    console.log(`[svg2png] ${inPath} → ${outPath}  ${line.slice(3)}`);
    process.exit(existsSync(outPath) ? 0 : 1);
  }
  console.error(`[svg2png] 失败：${line}`);
  process.exit(1);
});
