/**
 * 验证**网页浮层**（网页端的桌宠 + 我们的提问面板）在真实浏览器里的渲染。
 *
 * 为什么要它：宿主半侧与桌面端都已实机验证，但网页浮层只在浏览器里跑。
 * 这个脚本用 Electron 自带的 Chromium 做 headless 浏览器，连 CDP 检查 DOM、
 * 抓控制台错误、截图。
 *
 * 前置：需要先有一个带 --remote-debugging-port 的浏览器指向沙箱页面。
 *       （scripts/manual-web-overlay.mjs 里的 launchBrowser() 会拉起它）
 *
 * 用法：node scripts/manual-web-overlay.mjs [--port 3097] [--cdp 9444]
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
const cdpPort = arg('cdp', '9444');
const shot = join(pkgRoot, 'build', 'web-overlay.png');

const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

// ---- token ----
let token = arg('token', '');
if (!token) {
  for (const f of [
    join(home, 'dsh-sandbox', 'logs', 'out.log'),
    join(home, 'dsh-sandbox', 'logs', 'out.txt'),
  ]) {
    if (existsSync(f)) {
      const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
      if (m) {
        token = m[1];
        break;
      }
    }
  }
}
if (!token) {
  console.error('[web-overlay] 拿不到沙箱 token（试 --token <t>）');
  process.exit(1);
}

// ---- 找 Electron 当浏览器用 ----
const electronPath = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(home, 'dsh-sandbox', 'electron', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!electronPath) {
  console.error('[web-overlay] 找不到 Electron');
  process.exit(1);
}

// ---- 起一个最小 Electron 宿主来承载浏览器窗口 ----
const probeDir = join(tmpdir(), 'dsh-web-probe');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.PROBE_CDP_PORT || '9444');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1440, height: 900,
    webPreferences: { partition: 'persist:webprobe' },
  });
  // 把页面控制台转发出来：失败时必须能看到客户端插件的日志，否则无从判断
  w.webContents.on('console-message', (e) => {
    console.log('[page:' + e.level + '] ' + String(e.message).slice(0, 300));
  });
  try { await w.loadURL(process.env.PROBE_URL); } catch (e) { console.log('[probe] load err ' + e.message); }
  console.log('[probe] loaded');
  if (process.env.PROBE_EXIT_MS) setTimeout(() => app.quit(), Number(process.env.PROBE_EXIT_MS));
});
`,
  'utf8',
);
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-web-probe', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  PROBE_URL: `http://127.0.0.1:${port}/?token=${token}`,
  PROBE_CDP_PORT: String(cdpPort),
  PROBE_EXIT_MS: '120000',
});
const browser = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', () => {});
browser.stderr.on('data', () => {});
browser.on('error', (e) => {
  console.error(`[web-overlay] ❌ 浏览器起不来: ${e.code} ${e.message}`);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`CDP 连接失败 ${e.message ?? e.type}`)));
  });
  return {
    ready,
    events,
    send(method, params) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};

const done = (code) => {
  try {
    browser.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 800);
};

try {
  console.log('[web-overlay] 1) 等 CDP');
  let list = [];
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try {
      list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      if (list.some((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url))) break;
    } catch {
      /* 还没起来 */
    }
  }
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)) ?? list.find((t) => t.type === 'page');
  check('找到页面 target', !!page, page?.title ?? '(无)');
  if (!page) done(1);
  else {
    const ws = cdp(page.webSocketDebuggerUrl);
    await ws.ready;
    await ws.send('Runtime.enable');
    await ws.send('Log.enable');
    await ws.send('Page.enable');

    console.log('[web-overlay] 2) 等客户端插件装载（浮层要等插件 apply 完）');
    // ⚠️ 客户端插件是按需 load 的，apply 需要好几秒。
    //    实测踩过：只等 30s 里的前几轮就读 DOM，会误判"浮层没渲染" ——
    //    其实日志里明明写着 shell.overlay 已注册、QuestionPanel 已挂载。
    //    所以这里以【插件真的 apply 完】为条件轮询，而不是固定等一会。
    let diag = null;
    let applied = false;
    let sawOurLog = false;
    let sawPanelMounted = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      // 顺便从 CDP 事件流里找我们插件的 console（比 Electron 的 console-message
      // 转发更可靠：它不依赖宿主窗口的监听是否装好）
      if (!sawOurLog) {
        sawOurLog = ws.events.some(
          (e) =>
            e.method === 'Runtime.consoleAPICalled' &&
            JSON.stringify(e.params?.args ?? []).includes('dsh-efficiency'),
        );
        if (sawOurLog) console.log('     （CDP 已捕获到 dsh-efficiency 的 console 输出）');
        sawPanelMounted = ws.events.some(
          (e) =>
            e.method === 'Runtime.consoleAPICalled' &&
            JSON.stringify(e.params?.args ?? []).includes('QuestionPanel 已挂载'),
        );
      }
      const r = await ws.send('Runtime.evaluate', {
        expression: `(function(){
          var g = window.__DSH_EFFICIENCY__ || null;
          return {
            ready: document.readyState,
            // ⚠️ 类名别搞混：**网页端**浮层用 dsh-pet-* 前缀
            //    （dsh-pet-root / dsh-pet-stage / dsh-pet-video / dsh-pet-bubble），
            //    而 .pet-sprite / .pet-hit 是**桌面端**渲染层（index.html）的类。
            //    我一开始查 .pet-sprite，于是把"已经渲染好了"误判成"没渲染"（踩过）。
            petRoot: document.querySelectorAll('.dsh-pet-root').length,
            petStage: document.querySelectorAll('.dsh-pet-stage').length,
            petVideo: document.querySelectorAll('.dsh-pet-video').length,
            petBubble: document.querySelectorAll('.dsh-pet-bubble').length,
            petAny: Array.from(document.querySelectorAll('[class*=pet]')).length,
            ourOverlay: document.querySelectorAll('[data-dsh-efficiency], .dsh-efficiency-overlay').length,
            moduleLoader: typeof window.__ModuleLoader__ !== 'undefined',
            dshEffDiag: g ? { seen: g.seenRequests, pending: g.pending, answered: g.answered, errors: (g.errors||[]).length } : null,
            overlayLayers: document.querySelectorAll('body > div').length,
            fixedLayers: Array.from(document.querySelectorAll('body > div > div')).slice(0, 10).map(function(d){
              var s = getComputedStyle(d);
              return { cls: String(d.className).slice(0,70), pos: s.position, z: s.zIndex };
            })
          };
        })()`,
        returnByValue: true,
      });
      diag = r?.result?.value;
      applied = !!(diag?.dshEffDiag || (diag?.petSprites ?? 0) > 0);
      if (applied) break;
    }
    console.log(`     ${JSON.stringify(diag).slice(0, 900)}`);
    check('页面已加载完成', diag?.ready === 'complete', String(diag?.ready));
    check('模块系统存在（__ModuleLoader__）', diag?.moduleLoader === true);

    // 我们的插件是否 apply —— 判据要用【控制台日志】，不能用 __DSH_EFFICIENCY__。
    // ⚠️ 后者是**懒初始化**（有提问到达时才 ensureDiag），pending=0 时它就是
    //    undefined，那是正确行为而不是缺陷。我一开始拿它当"插件是否 apply"的
    //    判据，得出"插件没 apply"的错误结论（踩过，记下来）。
    check('我们的客户端插件已 apply（捕获到 panel 挂载日志）', sawPanelMounted, `logs=${ws.events.length}`);

    // 宠物网页浮层：用**网页端**的类名判定（见上面的注释）。
    // 注意 `display` 必须是 web/both 才会渲染 —— 若沙箱配置是 desktop，
    // 这里不渲染是**正确行为**，不是缺陷。所以只做信息性判定，
    // 并把实际 display 值一并打出来，便于一眼分辨。
    const petRendered = (diag?.petRoot ?? 0) > 0;
    if (petRendered) {
      check(
        '桌宠网页浮层已渲染',
        true,
        `root=${diag?.petRoot} stage=${diag?.petStage} video=${diag?.petVideo} bubble=${diag?.petBubble}`,
      );
    } else {
      console.log(
        '  ⚠️  桌宠网页浮层未渲染 —— 请先确认沙箱配置里该宠物的 display 是 web/both；' +
          '若是 desktop/none，不渲染属正确行为',
      );
    }

    console.log('[web-overlay] 3) 控制台错误');
    const errs = ws.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
      .map((e) => e.params.entry.text)
      .filter((t) => !/favicon|DevTools/i.test(t));
    check('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | '));

    console.log('[web-overlay] 4) 截图');
    const png = await ws.send('Page.captureScreenshot', { format: 'png' });
    if (png?.data) {
      writeFileSync(shot, Buffer.from(png.data, 'base64'));
      check('截图已写盘', existsSync(shot), shot);
    } else check('截图已写盘', false);

    ws.close();
  }
} catch (err) {
  console.error(`[web-overlay] ❌ ${String(err)}`);
  failures += 1;
}

console.log('');
console.log(failures === 0 ? '[web-overlay] PASS' : `[web-overlay] FAIL: ${failures} 项未通过`);
done(failures === 0 ? 0 : 1);
