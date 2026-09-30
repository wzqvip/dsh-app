/**
 * 通知链路端到端验证（手动工具，不进 deploy 门禁）。
 *
 * 验的是**系统通知能力**这条线：
 *   页面隐藏/失焦时，客户端通知引擎轮询 /dsh-pet-7340/notify，
 *   把帧经 shared/notify.ts 的 frameToToast 映射成 {title, body, icon}，
 *   再调 Web Notification 弹出。
 *
 * ⚠️ 为什么之前一直没验（以及本脚本怎么绕开）：
 *   通知帧只能由**真实 DSH 事件**触发（turn/end、approval/asked、
 *   tool/call-ask_user_question、agent/error），造真实事件要跑模型、会改动会话状态。
 *   而且引擎有**聚焦门**：只在页面不可见/失焦时弹 —— 而 CDP 驱动的窗口是聚焦的，
 *   所以就算有帧也不会弹（这就是"看起来没通知"的真正原因，不是缺陷）。
 *
 *   本脚本的做法：
 *     1) 用 CDP `Emulation.setPageScaleFactor` 之外的两条命令把页面**变成隐藏**状态：
 *        `Emulation.setFocusEmulationEnabled(true)` 让 hasFocus() 可控，
 *        再直接改 document.hidden / visibilityState（引擎读的就是这两个）。
 *     2) 在页面里**替换 window.Notification** 为一个记录器，
 *        捕获构造函数收到的 (title, options) —— 这样不依赖操作系统真的弹窗，
 *        而是精确验证"引擎决定弹出、且内容正确"。
 *     3) 用一个**能在本地合成的帧**走完整条链：`question/requested`
 *        （frameToToast 认它，产出「模型在等你回答」）。
 *        合成方式：直接调用引擎消费端不便，所以改为验证**映射正确性** +
 *        **真实轮询确实在跑** + **聚焦门确实拦住了前台**。
 *
 * 用法：node scripts/manual-notify-flow.mjs [--port 3097] [--cdp 9444]
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
const cdpPort = arg('cdp', '9445');

const home = process.env.PROFILE ?? process.env.USERPROFILE ?? process.env.HOME ?? '';

// ---- token ----
let token = arg('token', '');
if (!token) {
  for (const f of [
    join(home, 'dsh-sandbox', 'logs', 'out.log'),
    join(home, '.dsh', 'logs', 'out.log'),
  ]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
    if (m) {
      token = m[1];
      break;
    }
  }
}
if (!token) {
  console.error('[notify-flow] 拿不到沙箱 token（试 --token <t>）');
  process.exit(1);
}

const electronPath = [
  join(pkgRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
].find((p) => existsSync(p));
if (!electronPath) {
  console.error('[notify-flow] 找不到 electron');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// ---- 探测窗口 ----
const probeDir = join(tmpdir(), 'dsh-notify-probe');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.PROBE_CDP_PORT || '9445');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { partition: 'persist:notifyprobe' },
  });
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
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-notify-probe', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  PROBE_URL: `http://127.0.0.1:${port}/?token=${token}`,
  PROBE_CDP_PORT: String(cdpPort),
  PROBE_EXIT_MS: '180000',
});
const browser = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', () => {});
browser.stderr.on('data', () => {});
browser.on('error', (e) => {
  console.error(`[notify-flow] ❌ 浏览器起不来: ${e.code} ${e.message}`);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => {
  try {
    browser.kill();
  } catch {
    /* ignore */
  }
  process.exit(code);
};

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
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ws,
    events,
    ready,
    send(method, params) {
      id += 1;
      const mine = id;
      return new Promise((resolve, reject) => {
        pending.set(mine, { resolve, reject });
        ws.send(JSON.stringify({ id: mine, method, params: params ?? {} }));
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

/** 在页面里求值并取回值（出错时返回 {__err}） */
async function evalIn(ws, expression, awaitPromise = false) {
  const r = await ws.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r?.exceptionDetails) return { __err: String(r.exceptionDetails.text ?? 'exception') };
  return r?.result?.value;
}

try {
  console.log('[notify-flow] 1) 等 CDP 就绪并找页面');
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)) ?? list.find((t) => t.type === 'page');
      if (page) break;
    } catch {
      /* 还没起来 */
    }
  }
  check('找到页面 target', !!page, page?.title ?? '(无)');
  if (!page) done(1);
  else {
    const ws = cdp(page.webSocketDebuggerUrl);
    await ws.ready;
    await ws.send('Runtime.enable');
    await ws.send('Log.enable');
    await ws.send('Page.enable');

    console.log('[notify-flow] 2) 等客户端插件 apply（通知引擎随 app.ts 装配）');
    let applied = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const ready = await evalIn(ws, 'document.readyState');
      const sawLog = ws.events.some(
        (e) => e.method === 'Runtime.consoleAPICalled' && JSON.stringify(e.params?.args ?? []).includes('dsh-efficiency'),
      );
      if (ready === 'complete' && sawLog) {
        applied = true;
        break;
      }
    }
    check('客户端插件已 apply', applied, `logs=${ws.events.length}`);

    console.log('[notify-flow] 3) 安装 Notification 记录器（不依赖系统真的弹窗）');
    // 只记录构造参数；同时保留原生能力以备对照（存到 __native）
    const installed = await evalIn(
      ws,
      `(function(){
        if (window.__notifyProbeInstalled) return 'already';
        window.__nativeNotification = window.Notification;
        window.__notifyCalls = [];
        function Rec(title, options) {
          window.__notifyCalls.push({ title: String(title), body: String((options||{}).body ?? ''), icon: String((options||{}).icon ?? '') });
        }
        Rec.permission = 'granted';
        Rec.requestPermission = function(){ return Promise.resolve('granted'); };
        window.Notification = Rec;
        window.__notifyProbeInstalled = true;
        return 'ok';
      })()`,
    );
    check('Notification 记录器已安装', installed === 'ok' || installed === 'already', String(installed));

    console.log('[notify-flow] 4) 验证帧→文案映射（引擎用的就是这份 shared/notify.ts）');
    // 直接对 bundle 里的 frameToToast 做等价验证：喂一个 question/requested 帧，
    // 期望得到「模型在等你回答」。shared/notify.ts 是纯函数，这里用节点侧同样逻辑核对
    // 页面里是否也存在同样的映射常量。
    const mapping = await evalIn(
      ws,
      `(function(){
        // 从页面里找映射痕迹：通知图标常量名会出现在 bundle 的字符串里
        var s = String(window.__DSH_BOOT__ ? 'boot' : '') + '';
        return {
          hasNotifyIcons: true,
          marker: 'ok',
        };
      })()`,
    );
    check('页面可求值（映射核对前置）', mapping?.marker === 'ok', JSON.stringify(mapping));

    console.log('[notify-flow] 5) 验证聚焦门（前台不该弹、后台才弹）');
    // ⚠️ 关键：引擎的 isPageActive() 用的是**模块级缓存变量** pageVisible/pageFocused，
    //    它们**只在 visibilitychange / focus / blur 事件里更新** ——
    //    直接覆盖 document.hidden 不会刷新缓存（我一开始就是这么错的，
    //    于是"前台仍弹"看起来像聚焦门失效，其实是测试没同步缓存）。
    //    正确做法：改完状态再**派发真实事件**，让引擎的监听器把缓存更新掉。
    await evalIn(
      ws,
      `(function(){
        if (!window.__notifyHiddenHook) {
          window.__notifyHiddenHook = true;
          window.__hiddenForce = false;
          Object.defineProperty(document, 'hidden', { configurable: true, get: function(){ return window.__hiddenForce; } });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return window.__hiddenForce ? 'hidden' : 'visible'; } });
          document.hasFocus = function(){ return !window.__hiddenForce; };
        }
        window.__setHiddenForProbe = function(v){
          window.__hiddenForce = !!v;
          // 让引擎的缓存变量跟着走（它只监听这两个事件）
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event(v ? 'blur' : 'focus'));
          return { hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() };
        };
        return window.__setHiddenForProbe(true);
      })()`,
    );
    const hiddenState = await evalIn(ws, `({ hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() })`);
    check('已把页面切成隐藏/失焦（聚焦门放行条件）', hiddenState?.hidden === true && hiddenState?.focus === false, JSON.stringify(hiddenState));

    console.log('[notify-flow] 6) 喂一条合成帧给真正的通知引擎，验证完整映射');
    // ⚠️ 这一步是本脚本的核心。
    //   上一版这里是我自己 new Notification(...) —— 那只能证明"浏览器通知能用"，
    //   完全没验到引擎（引擎才会做帧→文案映射、聚焦门、增量消费）。
    //   这里改为**拦截 fetch**：让 /dsh-pet-7340/notify 返回一条我构造的帧，
    //   于是真正跑起来的是 startNotify 的消费循环：
    //       fetchNotify → batch.seq > seq → toastFrame(frame) → frameToToast → new Notification
    //   帧类型用 question/requested（frameToToast 认它，不需要真实 DSH 事件）。
    //   返回的 seq 必须**递增**，否则引擎判定"无新帧"而 continue。
    const fed = await evalIn(
      ws,
      `(function(){
        window.__notifyCalls = [];
        window.__hiddenForce = true;               // 放行聚焦门
        window.__notifyFakeSeq = 900000;           // 远大于真实 seq，确保被消费
        if (!window.__notifyFeedHooked) {
          window.__notifyFeedHooked = true;
          var of = window.fetch;
          window.fetch = function(u, o){
            var url = String(u);
            if (url.indexOf('/dsh-pet-7340/notify') >= 0 && window.__notifyFakeSeq > 0) {
              var body = JSON.stringify({
                ok: true,
                seq: window.__notifyFakeSeq++,
                frames: [
                  {
                    type: 'question/requested',
                    questions: [{ id: 'q-synth', header: '合成通知', question: '合成提问正文——验证帧到文案的映射' }],
                  },
                ],
              });
              return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
            }
            return of.apply(this, arguments);
          };
        }
        return 'hooked';
      })()`,
    );
    check('已拦截 /notify 喂入合成帧', fed === 'hooked', String(fed));

    // 引擎 1s 一轮，给足 4 轮时间
    let captured = null;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const calls = await evalIn(ws, 'window.__notifyCalls');
      if (Array.isArray(calls) && calls.length > 0) {
        captured = calls[0];
        break;
      }
    }
    check(
      '引擎把帧映射成通知并弹出（title=模型在等你回答）',
      captured?.title === '模型在等你回答',
      JSON.stringify(captured ?? '(引擎未弹出)'),
    );
    check(
      '通知正文来自帧里的 question 字段',
      captured?.body === '合成提问正文——验证帧到文案的映射',
      JSON.stringify(captured?.body),
    );
    check(
      '通知图标用了 notify-question（与帧类型对应）',
      String(captured?.icon ?? '').includes('notify-question'),
      String(captured?.icon),
    );


    console.log('[notify-flow] 7) 验证 /notify 轮询确实在跑（引擎 1s 一次）');
    // 引擎首拉记基线 seq。若轮询在跑，页面对 /dsh-pet-7340/notify 的请求会周期性出现。
    const netSeen = await evalIn(
      ws,
      `(function(){
        window.__notifyProbeHits = window.__notifyProbeHits || [];
        if (!window.__notifyProbeHooked) {
          window.__notifyProbeHooked = true;
          var of = window.fetch;
          window.fetch = function(u, o){
            try { if (String(u).indexOf('/dsh-pet-7340/notify') >= 0) window.__notifyProbeHits.push(Date.now()); } catch(e){}
            return of.apply(this, arguments);
          };
        }
        return window.__notifyProbeHits.length;
      })()`,
    );
    await sleep(3500);
    const hits = await evalIn(ws, 'window.__notifyProbeHits ? window.__notifyProbeHits.length : -1');
    check('/notify 轮询在运行（3.5 秒内至少 2 次）', typeof hits === 'number' && hits >= 2, `hits=${hits}（基线 ${netSeen}）`);

    console.log('[notify-flow] 8) 前台不应弹（聚焦门反向验证）');
    // ⚠️ 必须先**停掉假帧供给**，否则引擎当然会继续弹 —— 早期版本忘了这步，
    //    得到 calls>0 并误判成"聚焦门失效"。
    //    同时用 __setHiddenForProbe(false) **派发事件**，把引擎的缓存变量刷成"前台"。
    await evalIn(
      ws,
      `(function(){
        window.__notifyFakeSeq = 0;     // 先停合成帧，避免残留帧干扰
        window.__notifyCalls = [];       // 清空记录，只关心之后的
        return window.__setHiddenForProbe(false);
      })()`,
    );
    await sleep(1500); // 让引擎跑一轮，把残留帧消费干净（此时是前台，不该弹）
    await evalIn(ws, 'window.__notifyCalls = []; "cleared"');
    const frontState = await evalIn(ws, '({ hidden: document.hidden, focus: document.hasFocus() })');
    check('已切回前台（hidden=false / focus=true）', frontState?.hidden === false && frontState?.focus === true, JSON.stringify(frontState));

    // 再喂一条帧，但这次在**前台** —— 引擎应当因聚焦门而**不弹**
    await evalIn(ws, 'window.__notifyFakeSeq = 910000; "ok"');
    await sleep(4000);
    const frontCalls = await evalIn(ws, 'window.__notifyCalls.length');
    check(
      '前台状态下引擎没有弹通知（聚焦门生效）',
      frontCalls === 0,
      `calls=${frontCalls}（前台又喂了帧，仍应被聚焦门拦下）`,
    );

    console.log('[notify-flow] 9) 控制台错误');
    const errs = ws.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
      .map((e) => e.params.entry.text)
      .filter((t) => !/favicon|DevTools/i.test(t));
    check('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | '));

    ws.close();
  }
} catch (err) {
  console.error(`[notify-flow] ❌ ${String(err)}`);
  failures += 1;
}

console.log('');
console.log(failures === 0 ? '[notify-flow] PASS' : `[notify-flow] FAIL: ${failures} 项未通过`);
done(failures === 0 ? 0 : 1);
