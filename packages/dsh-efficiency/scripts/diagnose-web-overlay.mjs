/**
 * 网页浮层诊断：查清"客户端插件为什么没 apply"。
 *
 * 只做取证，不下结论：把 boot 清单、脚本加载情况、模块装载器的注册表、
 * 网络请求与失败原因全部倒出来。
 *
 * 用法：node scripts/diagnose-web-overlay.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const port = process.env.PROBE_PORT || '3097';
const cdpPort = process.env.PROBE_CDP_PORT || '9445';
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';

const electronPath = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(home, 'dsh-sandbox', 'electron', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!electronPath) {
  console.error('找不到 Electron');
  process.exit(1);
}

let token = '';
for (const f of [join(home, 'dsh-sandbox', 'logs', 'out.log')]) {
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
    if (m) token = m[1];
  }
}

const probeDir = join(tmpdir(), 'dsh-web-diag');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.PROBE_CDP_PORT || '9445');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1440, height: 900, webPreferences: { partition: 'persist:diag' } });
  w.webContents.on('console-message', (e) => {
    console.log('[page:' + e.level + '] ' + String(e.message).slice(0, 400));
  });
  try { await w.loadURL(process.env.PROBE_URL); } catch (err) { console.log('[probe] load err ' + err.message); }
  console.log('[probe] loaded');
  setTimeout(() => app.quit(), 120000);
});
`,
  'utf8',
);
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-web-diag', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { PROBE_URL: `http://127.0.0.1:${port}/?token=${token}`, PROBE_CDP_PORT: String(cdpPort) });
const browser = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', (b) => process.stdout.write(String(b)));
browser.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) events.push(m);
  });
  return {
    events,
    ready: new Promise((res, rej) => {
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', (e) => rej(new Error(`CDP ${e.message ?? e.type}`)));
    }),
    send(method, params) {
      const myId = ++id;
      return new Promise((res, rej) => {
        pending.set(myId, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
  };
}

let list = [];
for (let i = 0; i < 40; i++) {
  await sleep(700);
  try {
    list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {
    /* wait */
  }
}
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('没有页面 target');
  process.exit(1);
}
const ws = cdp(page.webSocketDebuggerUrl);
await ws.ready;
await ws.send('Runtime.enable');
await ws.send('Network.enable');
await ws.send('Log.enable');
await sleep(12000);

console.log('=== 1) boot 配置 ===');
const boot = await ws.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
    bootKeys: window.__DSH_BOOT__ ? Object.keys(window.__DSH_BOOT__) : null,
    bootSnippet: window.__DSH_BOOT__ ? JSON.stringify(window.__DSH_BOOT__).slice(0, 1500) : null
  })`,
  returnByValue: true,
});
console.log(String(boot.result.value).slice(0, 2200));

console.log('');
console.log('=== 2) 已加载的 script ===');
const scripts = await ws.send('Runtime.evaluate', {
  expression: `JSON.stringify(Array.from(document.querySelectorAll('script[src]')).map(function(s){return s.src.replace(location.origin,'')}))`,
  returnByValue: true,
});
console.log(String(scripts.result.value).slice(0, 1500));

console.log('');
console.log('=== 3) 模块装载器的注册表 ===');
const registry = await ws.send('Runtime.evaluate', {
  expression: `(function(){
    var L = window.__ModuleLoader__;
    if (!L) return 'no-loader';
    var out = { keys: Object.keys(L), loadCacheType: L.loadCache ? (L.loadCache.constructor||{}).name : null };
    try { out.cacheKeys = L.loadCache && L.loadCache.keys ? Array.from(L.loadCache.keys()).slice(0,60) : null; } catch(e){ out.cacheKeysErr = String(e); }
    try { out.factories = L.factories && L.factories.keys ? Array.from(L.factories.keys()).slice(0,60) : null; } catch(e){ out.factoriesErr = String(e); }
    for (var k of out.keys) {
      try { out['type_' + k] = typeof L[k]; } catch(e) {}
    }
    return JSON.stringify(out);
  })()`,
  returnByValue: true,
});
console.log(String(registry.result.value).slice(0, 2000));

console.log('');
console.log('=== 4) efficiency 相关网络请求 ===');
const reqs = ws.events
  .filter((e) => e.method === 'Network.requestWillBeSent')
  .map((e) => e.params.request.url)
  .filter((u) => /efficiency|pet/i.test(u));
console.log(reqs.length ? reqs.join('\n') : '(没有任何 efficiency/pet 请求！)');

console.log('');
console.log('=== 5) 失败/非 200 的响应 ===');
const bad = ws.events
  .filter((e) => e.method === 'Network.responseReceived' && e.params.response.status >= 400)
  .map((e) => `${e.params.response.status} ${e.params.response.url.replace(location?.origin ?? '', '')}`);
console.log(bad.length ? bad.slice(0, 20).join('\n') : '(无)');

console.log('');
console.log('=== 6) 页面控制台（后 20 条）===');
const logs = ws.events
  .filter((e) => e.method === 'Log.entryAdded')
  .map((e) => `[${e.params.entry.level}] ${String(e.params.entry.text).slice(0, 200)}`);
console.log(logs.length ? logs.slice(-20).join('\n') : '(无)');

console.log('');
console.log('=== 7) efficiency 客户端 bundle 是否被加载 ===');
const loaded = await ws.send('Runtime.evaluate', {
  expression: `(function(){
    var found = [];
    try {
      for (var i = 0; i < performance.getEntriesByType('resource').length; i++) {
        var n = performance.getEntriesByType('resource')[i].name;
        if (/efficiency|pet/i.test(n)) found.push(n.replace(location.origin,''));
      }
    } catch(e) { return 'err ' + e; }
    return JSON.stringify(found);
  })()`,
  returnByValue: true,
});
console.log(String(loaded.result.value).slice(0, 1200));

try {
  browser.kill();
} catch {
  /* ignore */
}
setTimeout(() => process.exit(0), 500);
