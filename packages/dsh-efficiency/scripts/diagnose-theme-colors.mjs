/**
 * 诊断：从运行中的 DSH 页面取「DeepSeek 品牌色 / 主题令牌」的**解析后色值**。
 * 用于把桌宠设置面板的配色对齐 DeepSeek 官方视觉，而不是凭印象挑色。
 *
 * 用法：node scripts/diagnose-theme-colors.mjs [--port 3097] [--cdp 9453]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const port = arg('port', '3097');
const cdpPort = arg('cdp', '9453');
const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

let token = arg('token', '');
if (!token) {
  const f = join(home, 'dsh-sandbox', 'logs', 'out.log');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
    if (m) token = m[1];
  }
}
const electronPath = join(home, '.dsh', 'electron', 'electron.exe');
if (!existsSync(electronPath)) {
  console.error('[theme] 找不到 electron');
  process.exit(1);
}

const probeDir = join(tmpdir(), 'dsh-theme-probe');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.P);
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1200, height: 800, webPreferences: { partition: 'persist:themeprobe' } });
  try { await w.loadURL(process.env.U); } catch (e) {}
  console.log('loaded'); setTimeout(() => app.quit(), 60000);
});
`,
  'utf8',
);
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'p', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.P = String(cdpPort);
env.U = `http://127.0.0.1:${port}/?token=${token}`;
const browser = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', () => {});
browser.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch {
    /* 未就绪 */
  }
}
if (!page) {
  console.log('no page');
  browser.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  let m;
  try {
    m = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});
const send = (method, params) => {
  id += 1;
  const mine = id;
  return new Promise((resolve, reject) => {
    pending.set(mine, { resolve, reject });
    ws.send(JSON.stringify({ id: mine, method, params: params ?? {} }));
  });
};
await send('Runtime.enable');
await sleep(9000);

const out = await send('Runtime.evaluate', {
  expression: `(function(){
    var cs = getComputedStyle(document.documentElement);
    var names = [];
    // 枚举样式表里所有 --dsw-* / --dsh-* 变量名
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules } catch (e) { continue }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (r.style && r.style.length) {
          for (var k = 0; k < r.style.length; k++) {
            var p = r.style[k];
            if (p.indexOf('--dsw-') === 0 || p.indexOf('--dsh-') === 0) names.push(p);
          }
        }
      }
    }
    names = names.filter(function(v, i, a){ return a.indexOf(v) === i });
    var picked = {};
    var want = /deepseek|brand|primary|bg-|text-|border-|accent/;
    names.forEach(function(n){
      if (!want.test(n)) return;
      var v = cs.getPropertyValue(n).trim();
      if (v) picked[n] = v;
    });
    return { total: names.length, picked: picked, sample: names.slice(0, 30) };
  })()`,
  returnByValue: true,
});
const v = out?.result?.value;
console.log(`[theme] 共发现 ${v?.total} 个设计令牌变量`);
const picked = v?.picked ?? {};
const interesting = Object.keys(picked).filter((k) => /deepseek|brand|primary/.test(k));
console.log('[theme] 品牌/主色相关：');
for (const k of interesting.slice(0, 24)) console.log(`    ${k} = ${picked[k]}`);
console.log('[theme] 背景/边框/文本（前 20）：');
for (const k of Object.keys(picked).filter((k) => /bg-|text-|border-/.test(k)).slice(0, 20)) {
  console.log(`    ${k} = ${picked[k]}`);
}
ws.close();
browser.kill();
process.exit(0);
