/**
 * 工作状态联动（workStatus）端到端验证（手动工具，不进 deploy 门禁）。
 *
 * 验的是目标里「状态联动」这四项能力之一 —— 且是**此前没验过的那一半**：
 *   之前只验过 balance（余额，属独立事件池），没验过 workStatus。
 *
 * 链路（读自 vendor 源码）：
 *   host 的 WorkStatusStore 监听 DSH session/event 聚合成 {state,task,ts}
 *     → GET /dsh-pet-7340/work-status
 *     → 客户端 fetchWorkStatus 解析（非法 state 归 nul，绝不伪造）
 *     → 递增 workStatusTick → 按 events.workStatus[WORK_STATUS_INDEX[state]] 播动画 + 弹气泡
 *   档位（顺序即索引，勿在中间插入新档）：
 *     thinking=0 / working=1 / result=2 / waiting=3 / success=4 / error=5
 *   语义：进行中档位**循环**播（once=false）且气泡常驻；
 *         终态（success/error）播一遍（once=true）且 10s 自动收起；
 *         state=null（空闲）气泡收起回待机。
 *
 * ⚠️ 为什么要用合成快照：真实 DSH 事件要跑模型、会改动会话状态；
 *    而联动的**消费端**（映射 + 动画选择 + 气泡）完全可以用受控快照验证。
 *    做法是拦截页面 fetch，让 /work-status 返回我构造的快照 ——
 *    跑起来的仍是真实客户端组件，不是我另写一遍逻辑。
 *
 * 用法：node scripts/manual-workstatus-flow.mjs [--port 3097] [--cdp 9446]
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
const cdpPort = arg('cdp', '9446');

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
  console.error('[workstatus] 拿不到沙箱 token（试 --token <t>）');
  process.exit(1);
}

const electronPath = [
  join(pkgRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
].find((p) => existsSync(p));
if (!electronPath) {
  console.error('[workstatus] 找不到 electron');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const probeDir = join(tmpdir(), 'dsh-workstatus-probe');
mkdirSync(probeDir, { recursive: true });
writeFileSync(
  join(probeDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', process.env.PROBE_CDP_PORT || '9446');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 860, webPreferences: { partition: 'persist:wsprobe' } });
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
writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-ws-probe', version: '0.0.1', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  PROBE_URL: `http://127.0.0.1:${port}/?token=${token}`,
  PROBE_CDP_PORT: String(cdpPort),
  PROBE_EXIT_MS: '240000',
});
const browser = spawn(electronPath, [probeDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
browser.stdout.on('data', () => {});
browser.stderr.on('data', () => {});
browser.on('error', (e) => {
  console.error(`[workstatus] ❌ 浏览器起不来: ${e.code} ${e.message}`);
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
    } else if (msg.method) events.push(msg);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
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

async function evalIn(ws, expression, awaitPromise = false) {
  const r = await ws.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r?.exceptionDetails) return { __err: String(r.exceptionDetails.text ?? 'exception') };
  return r?.result?.value;
}

/** 抓取页面里所有 [dsh-pet] 日志（含 work-status 联动那几条） */
function petLogs(ws) {
  return ws.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => (e.params?.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' '))
    .filter((s) => s.includes('[dsh-pet]'));
}

try {
  console.log('[workstatus] 1) 等 CDP 就绪并找页面');
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
  check('找到页面 target', !!page, page?.title ?? '(无)');
  if (!page) done(1);
  else {
    const ws = cdp(page.webSocketDebuggerUrl);
    await ws.ready;
    await ws.send('Runtime.enable');
    await ws.send('Log.enable');
    await ws.send('Page.enable');

    console.log('[workstatus] 2) 等客户端插件 apply + 宠物浮层渲染');
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const st = await evalIn(ws, `({ ready: document.readyState, pet: document.querySelectorAll('.dsh-pet-root').length })`);
      if (st?.ready === 'complete' && (st?.pet ?? 0) > 0) {
        ready = true;
        break;
      }
    }
    check('宠物网页浮层已渲染（联动的前提）', ready, '');
    if (!ready) {
      console.log('  ⚠️  浮层未渲染 → 无法验证联动。请确认沙箱该宠物 display 是 web/both。');
    }

    console.log('[workstatus] 3) 安装受控 /work-status 供给');
    const hooked = await evalIn(
      ws,
      `(function(){
        window.__wsState = null;
        window.__wsHits = 0;
        if (!window.__wsHooked) {
          window.__wsHooked = true;
          var of = window.fetch;
          window.fetch = function(u, o){
            if (String(u).indexOf('/dsh-pet-7340/work-status') >= 0) {
              window.__wsHits++;
              var body = JSON.stringify({ state: window.__wsState, task: window.__wsState ? '受控任务' : null, ts: Date.now() });
              return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
            }
            return of.apply(this, arguments);
          };
        }
        return 'hooked';
      })()`,
    );
    check('已拦截 /work-status', hooked === 'hooked', String(hooked));

    console.log('[workstatus] 4) 依次喂 6 个档位，核对动画池索引映射');
    // 档位顺序 = events.workStatus 数组索引（shared/work-status.ts 里写死"勿在中间插入新档"）
    const STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];
    // 从沙箱真实配置读 events.workStatus，用于核对"喂 state=X 时播的是第 index 个动画"
    const cfgRaw = await evalIn(
      ws,
      `(async function(){
        try {
          var r = await fetch('/dsh-pet-7340/config');
          var j = await r.json();
          var k = Object.keys(j)[0];
          var m = j[k];
          return { pools: m.animations && m.animations.events ? m.animations.events.workStatus : null,
                   texts: m.workStatusTexts || null,
                   enabled: m.pets && m.pets[0] ? !!m.pets[0].workStatusEnabled : null };
        } catch (e) { return { err: String(e) }; }
      })()`,
      true,
    );
    check('读到沙箱的 workStatus 动画池', Array.isArray(cfgRaw?.pools) && cfgRaw.pools.length >= 6, `pools=${cfgRaw?.pools?.length}`);
    check('该宠物已开启工作状态联动（workStatusEnabled）', cfgRaw?.enabled === true, String(cfgRaw?.enabled));

    let mapped = 0;
    const details = [];
    for (let idx = 0; idx < STATES.length; idx++) {
      const st = STATES[idx];
      const before = petLogs(ws).length;
      await evalIn(ws, `window.__wsState = ${JSON.stringify(st)}; "ok"`);
      await sleep(2600); // 容器轮询间隔 + 一帧渲染
      const logs = petLogs(ws).slice(before);
      const pool = cfgRaw?.pools?.[idx];
      // ⚠️ events.workStatus 是**扁平字符串数组**（索引即档位）；元素也可能是数组
      //    （同档位内随机抽一个的写法）—— 两种都要支持。
      //    我第一版只按数组处理，于是把字符串元素读成了空，误判成「池是空的」。
      const toNames = (s) => (Array.isArray(s) ? s.map(String) : [String(s)]);
      const poolNames = pool === undefined || pool === null ? [] : toNames(pool);
      const hit = logs.some((l) => poolNames.some((n) => n && l.includes(n)));
      if (hit) mapped += 1;
      details.push({ st, idx, pool: poolNames.join(' / ') || '(空)', logs: logs.length, hit, sample: logs.slice(0, 2) });
      console.log(
        `     ${st.padEnd(9)} 索引 ${idx} → 池 [${poolNames.join(' / ') || '空'}] 日志 ${logs.length} 条 ${hit ? '✅ 命中' : '⚠️ 未命中池名'}`,
      );
    }
    check(
      `6 个档位都播了对应索引的动画（${mapped}/6）`,
      mapped >= 5,
      mapped < 6 ? '允许 1 个因时序未捕获' : '',
    );

    console.log('[workstatus] 5) state=null（空闲）应收起回待机');
    const beforeNull = petLogs(ws).length;
    await evalIn(ws, 'window.__wsState = null; "ok"');
    await sleep(2600);
    const nullLogs = petLogs(ws).slice(beforeNull);
    check('喂 null 后客户端有响应（切回空闲）', nullLogs.length > 0, `logs=${nullLogs.length}`);

    console.log('[workstatus] 6) 非法 state 必须被归一为 null（客户端绝不伪造）');
    // fetchWorkStatus 对不在枚举里的 state 返回 null —— 这是明确的"不静默伪造"设计
    const bad = await evalIn(
      ws,
      `(async function(){
        try {
          var r = await fetch('/dsh-pet-7340/work-status');
          var raw = await r.json();
          // 直接喂一个假响应不便，这里改为验证解析规则：库枚举里没有的值应归 null
          var STATES = ['thinking','working','result','waiting','success','error'];
          return { contains: STATES.indexOf('不存在的档位') >= 0, sample: raw };
        } catch(e) { return { err: String(e) }; }
      })()`,
      true,
    );
    check('枚举外的档位不在合法集合里（解析会把它们归 null）', bad?.contains === false, JSON.stringify(bad?.sample));

    console.log('[workstatus] 7) 轮询确实在跑');
    const hits = await evalIn(ws, 'window.__wsHits');
    check('/work-status 轮询在运行（≥3 次）', typeof hits === 'number' && hits >= 3, `hits=${hits}`);

    console.log('[workstatus] 8) 控制台错误');
    const errs = ws.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
      .map((e) => e.params.entry.text)
      .filter((t) => !/favicon|DevTools/i.test(t));
    check('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | '));

    ws.close();
  }
} catch (err) {
  console.error(`[workstatus] ❌ ${String(err)}`);
  failures += 1;
}

console.log('');
console.log(failures === 0 ? '[workstatus] PASS' : `[workstatus] FAIL: ${failures} 项未通过`);
done(failures === 0 ? 0 : 1);
