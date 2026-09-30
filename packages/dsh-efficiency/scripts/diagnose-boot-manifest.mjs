/**
 * 读页面的 boot 清单（window.__DSH_BOOT__），看 rev 与我们的模块条目。
 * 用于判断"客户端 bundle 的 URL rev 是否会随我们包的重新构建而变化"。
 *
 * 用法：node scripts/diagnose-boot-manifest.mjs [--port 3097] [--cdp 9452]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const port = arg('port', '3097');
const cdpPort = arg('cdp', '9452');
const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

let token = arg('token', '');
if (!token) {
  for (const f of [join(home, 'dsh-sandbox', 'logs', 'out.log')]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
    if (m) {
      token = m[1];
      break;
    }
  }
}

const electronPath = join(home, '.dsh', 'electron', 'electron.exe');
if (!existsSync(electronPath)) {
  console.error('[boot] 找不到 electron');
  process.exit(1);
}

const probeDir = join(tmpdir(), 'dsh-boot-probe');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.P);
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1200, height: 800, webPreferences: { partition: 'persist:bootprobe' } });
  try { await w.loadURL(process.env.U); } catch (e) {}
  console.log('loaded');
  setTimeout(() => app.quit(), 70000);
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
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', { expression: 'typeof window.__DSH_BOOT__', returnByValue: true });
  if (r?.result?.value === 'object') break;
}

const info = await send('Runtime.evaluate', {
  expression: `(function(){
    var b = window.__DSH_BOOT__;
    if (!b) return { err: 'no __DSH_BOOT__' };
    var out = { rev: b.rev, keys: Object.keys(b) };
    function namesOf(list, key){
      if (!list) return null;
      var arr = Array.isArray(list) ? list : Object.keys(list).map(function(k){return list[k]});
      var found = [];
      arr.forEach(function(e){
        var s = JSON.stringify(e);
        if (/dsh-efficiency|dsh-pet/.test(s)) found.push(s.slice(0, 260));
      });
      return { total: arr.length, found: found };
    }
    out.entries = namesOf(b.entries, 'entries');
    out.batches = namesOf(b.batches, 'batches');
    // 我们现在这个包的客户端模块 id 与实际加载的 URL
    var scripts = [].slice.call(document.querySelectorAll('script[src]')).map(function(s){return s.src});
    out.scripts = scripts.slice(0, 10);
    return out;
  })()`,
  returnByValue: true,
});
console.log('[boot] ' + JSON.stringify(info?.result?.value, null, 2).slice(0, 2400));
ws.close();
browser.kill();
process.exit(0);
