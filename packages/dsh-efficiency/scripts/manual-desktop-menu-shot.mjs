/**
 * 截「桌面小窗 + 右键菜单打开」的图 —— 供 README 展示「设置…」入口。
 *
 * 为什么单独写：helper 的 smoke 模式会自己派发 contextmenu 做自检，
 * 但那是**校验用**的，截图时机不保证菜单还开着。这里自己派发 + 立刻截图，
 * 不改 helper 的代码。
 *
 * 用法：node scripts/manual-desktop-menu-shot.mjs [--port 3097] [--cdp 9455]
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
const cdpPort = arg('cdp', '9455');
const out = arg('out', join(pkgRoot, 'docs', 'screenshots', 'desktop-menu.png'));
const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

let token = '';
for (const f of [join(home, 'dsh-sandbox', 'logs', 'out.log')]) {
  if (!existsSync(f)) continue;
  const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
  if (m) token = m[1];
}
const electronPath = join(home, '.dsh', 'electron', 'electron.exe');
if (!existsSync(electronPath)) {
  console.error('[menu-shot] 找不到 electron');
  process.exit(1);
}

// 直接拉 helper（与沙箱用的是同一份），带 CDP 端口
const helperMain = join(
  home,
  'dsh-sandbox',
  'profiles',
  'web',
  'node_modules',
  'dsh-efficiency',
  'lib',
  'runtime',
  'electron-helper',
  'main.js',
);
if (!existsSync(helperMain)) {
  console.error('[menu-shot] 找不到 helper:', helperMain);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  DSH_PET_ELECTRON_PATH: electronPath,
  DSH_PET_CDP_PORT: String(cdpPort),
  ELECTRON_ENABLE_LOGGING: '0',
});

// helper 主进程自己创建窗口；用 NODE_OPTIONS 注入调试端口最稳
const args = [helperMain, `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*'];
const browser = spawn(electronPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', () => {});
browser.stderr.on('data', () => {});
browser.on('error', (e) => {
  console.error('[menu-shot] ❌', e.message);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    page = list.find((t) => t.type === 'page') ?? null;
    if (page) break;
  } catch {
    /* 未就绪 */
  }
}
if (!page) {
  console.log('[menu-shot] 拿不到页面（helper 可能没起 CDP）');
  browser.kill();
  process.exit(1);
}
console.log('[menu-shot] 页面:', page.url.slice(0, 90));

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
await send('Page.enable');
await sleep(6000); // 等宠物渲染

// 派发 contextmenu 打开菜单，然后**等一小会就截图**（别等它自动关）
const r = await send('Runtime.evaluate', {
  expression: `(function(){
    var hit = document.querySelector('.pet-hit') || document.body;
    var rect = hit.getBoundingClientRect();
    hit.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    }));
    return { hit: !!document.querySelector('.pet-hit'), w: Math.round(rect.width), h: Math.round(rect.height) };
  })()`,
  returnByValue: true,
});
console.log('[menu-shot] contextmenu 已派发:', JSON.stringify(r?.result?.value));

await sleep(900);
const menuOk = await send('Runtime.evaluate', {
  expression: `(function(){
    var t = document.body.innerText || '';
    return { hasSettings: t.indexOf('设置…') >= 0, len: t.length, head: t.replace(/\\s+/g,' ').slice(0, 120) };
  })()`,
  returnByValue: true,
});
console.log('[menu-shot] 菜单状态:', JSON.stringify(menuOk?.result?.value));

let png = await send('Page.captureScreenshot', { format: 'png' });
if (png?.data) {
  // 透明窗口截图可能全透明：再取一次带背景的
  const buf = Buffer.from(png.data, 'base64');
  writeFileSync(out, buf);
  console.log(`[menu-shot] 截图已写盘 ${out} （${Math.round(buf.length / 1024)} KB）`);
}
// 窗口很小，另存一张「宠物 + 菜单」都完整包含的裁剪版。
// ⚠️ 第一版只并集了 hit 区与菜单，结果宠物和菜单各被切掉一半 ——
//    因为菜单是 fixed 定位、getBoundingClientRect 在滚动/变换下不一定等于视觉位置。
//    改为取所有相关元素的包围盒（宠物 sprite、气泡、菜单），并向外留足边距。
const box = await send('Runtime.evaluate', {
  expression: `(function(){
    var sels = ['.pet-sprite', '.pet-hit', '.pet-bubble', '[class*=bubble]', '[class*=menu]', '[role=menu]'];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    sels.forEach(function(s){
      document.querySelectorAll(s).forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
        minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
        n++;
      });
    });
    if (!n) return null;
    var pad = 24;
    return {
      x: Math.max(0, Math.floor(minX - pad)),
      y: Math.max(0, Math.floor(minY - pad)),
      width: Math.ceil(maxX - minX + pad * 2),
      height: Math.ceil(maxY - minY + pad * 2),
      counted: n,
    };
  })()`,
  returnByValue: true,
});
const clip = box?.result?.value;
if (clip && clip.width > 40 && clip.height > 40) {
  const png2 = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 },
    captureBeyondViewport: true,
  });
  if (png2?.data) {
    const o2 = out.replace(/\.png$/, '-crop.png');
    writeFileSync(o2, Buffer.from(png2.data, 'base64'));
    console.log(`[menu-shot] 裁剪版已写盘 ${o2}  clip=${JSON.stringify(clip)}`);
  }
}

ws.close();
browser.kill();
process.exit(0);
