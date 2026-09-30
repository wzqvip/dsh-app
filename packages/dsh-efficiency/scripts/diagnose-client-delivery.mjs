/**
 * 诊断：客户端 bundle 的实际 URL 与缓存头。
 *
 * 背景：维护者说"你的测试是新的，我给的链接进去却是老版本桌宠"。
 * 我的测试用**全新 Electron 分区**（无缓存），维护者用**持久 profile**（有缓存）——
 * 如果客户端 bundle 被浏览器缓存，就会重现这个差异。
 * 本脚本用**持久分区**加载页面并抓网络，看真实 URL 与 Cache-Control。
 *
 * 用法：node scripts/diagnose-client-delivery.mjs [--port 3097] [--cdp 9450]
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
const cdpPort = arg('cdp', '9450');
const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

let token = arg('token', '');
if (!token) {
  for (const f of [join(home, 'dsh-sandbox', 'logs', 'out.log'), join(home, '.dsh', 'logs', 'out.log')]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
    if (m) {
      token = m[1];
      break;
    }
  }
}
if (!token) {
  console.error('[net] 拿不到 token');
  process.exit(1);
}

const electronPath = [join(home, '.dsh', 'electron', 'electron.exe')].find((p) => existsSync(p));
if (!electronPath) {
  console.error('[net] 找不到 electron');
  process.exit(1);
}

const probeDir = join(tmpdir(), 'dsh-net-probe');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.PROBE_CDP_PORT);
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 860, webPreferences: { partition: 'persist:netprobe' } });
  try { await w.loadURL(process.env.PROBE_URL); } catch (e) { console.log('load err ' + e.message); }
  console.log('[probe] loaded');
  setTimeout(() => app.quit(), 90000);
});
`,
  'utf8',
);
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-net-probe', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PROBE_CDP_PORT = String(cdpPort);
env.PROBE_URL = `http://127.0.0.1:${port}/?token=${token}`;
const browser = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', () => {});
browser.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)) ?? list.find((t) => t.type === 'page');
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
const responses = [];
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
  } else if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    const h = {};
    for (const k of Object.keys(r.headers ?? {})) h[k.toLowerCase()] = r.headers[k];
    responses.push({
      url: r.url,
      status: r.status,
      cacheControl: h['cache-control'] ?? '',
      etag: h['etag'] ?? '',
      fromDisk: !!m.params.response.fromDiskCache,
      mime: r.mimeType ?? '',
    });
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

await send('Network.enable');
await send('Page.enable');
// 先正常加载一次（可能命中缓存），再强制刷新一次做对照
await sleep(12000);
const firstLoad = responses.slice();
responses.length = 0;
await send('Page.reload', { ignoreCache: false });
await sleep(12000);
const secondLoad = responses.slice();

const interesting = (r) => /dsh-efficiency|client|module|boot|entry|\.js(\?|$)/i.test(r.url) && !/devtools|chrome-extension/i.test(r.url);

console.log('[net] 首次加载里与客户端代码相关的请求');
for (const r of firstLoad.filter(interesting).slice(0, 14)) {
  console.log(
    `  ${String(r.status).padEnd(4)} cc="${r.cacheControl}" etag="${r.etag.slice(0, 16)}" ${r.fromDisk ? '[磁盘缓存]' : ''} ${r.url.slice(0, 112)}`,
  );
}
console.log('[net] 二次加载（对照：应能看出是否走缓存）');
for (const r of secondLoad.filter(interesting).slice(0, 14)) {
  console.log(
    `  ${String(r.status).padEnd(4)} cc="${r.cacheControl}" etag="${r.etag.slice(0, 16)}" ${r.fromDisk ? '[磁盘缓存]' : ''} ${r.url.slice(0, 112)}`,
  );
}

// 找出所有 200 且 mime 是 javascript 的 URL，问页面它们是否被缓存过
const jsUrls = [...new Set(secondLoad.filter((r) => /javascript/i.test(r.mime)).map((r) => r.url))];
console.log(`[net] JS 资源共 ${jsUrls.length} 个`);
for (const u of jsUrls.slice(0, 10)) console.log(`    ${u.slice(0, 120)}`);

ws.close();
browser.kill();
process.exit(0);
