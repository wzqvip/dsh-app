/**
 * 核心价值链路的端到端验证：**提问到达 → 面板弹出**。
 *
 * 目标里有一句：「桌宠只是为了不需要打开网页就能看到询问请求和进度」。
 * 也就是说"提问能被看到"才是核心，而这条链路此前**从没在浏览器里端到端验过**
 * （只验过"插件 apply 完成、插槽注册"这类结构事实）。
 *
 * 做法：
 *   1) 宿主侧 /api/dev/inject 注入一条合成提问（需要 DSH_EFFICIENCY_DEV_TOOLS=1）
 *   2) 真实 Chromium 打开沙箱页面，CDP 断言我们的 overlay 里出现了提问面板
 *   3) 点一个选项 → 断言宿主 /api/answer 收到（answered 递增）
 *   4) /api/dev/clear 清理
 *
 * ⚠️ 手动验证工具，不进 npm test / deploy 门禁（要图形环境 + 在跑的沙箱）。
 *
 * 用法：node scripts/manual-question-flow.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const port = process.env.PROBE_PORT || '3097';
const cdpPort = process.env.PROBE_CDP_PORT || '9451';
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const shot = join(pkgRoot, 'docs', 'screenshots', 'question-panel.png');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
let token = arg('token', '');
if (!token) {
  for (const f of [join(home, 'dsh-sandbox', 'logs', 'out.log')]) {
    if (existsSync(f)) {
      const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
      if (m) token = m[1];
    }
  }
}
if (!token) {
  console.error('[q-flow] 拿不到沙箱 token');
  process.exit(1);
}

const api = (path) => `http://127.0.0.1:${port}${path}`;
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};

// ---- 1) 确认 dev 工具开着 ----
const health0 = await (await fetch(api('/dsh-efficiency/api/health'), { headers: H })).json();
check('沙箱开了 dev 工具（DSH_EFFICIENCY_DEV_TOOLS=1）', health0.devTools === true, JSON.stringify(health0));

if (health0.devTools !== true) {
  console.log('\n[q-flow] 需要带 DSH_EFFICIENCY_DEV_TOOLS=1 重启沙箱后重跑。');
  process.exit(1);
}

// ---- 2) 注入合成提问 ----
const callId = `q-flow-${Date.now()}`;
const inject = await (
  await fetch(api('/dsh-efficiency/api/dev/inject'), {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      callId,
      questions: [
        {
          header: '端到端验证',
          question: '这条提问应该在宠物面板里弹出来（manual-question-flow 注入）',
          options: [
            { label: '选项 A：确认可见' },
            { label: '选项 B：也可见' },
          ],
        },
      ],
    }),
  })
).json();
check('合成提问注入成功', inject.ok === true, JSON.stringify(inject));

const h1 = await (await fetch(api('/dsh-efficiency/api/health'), { headers: H })).json();
check('宿主 pending 里有这条提问', h1.pending >= 1, `pending=${h1.pending}`);

// ---- 3) 真实浏览器打开页面 ----
const electronPath = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(home, 'dsh-sandbox', 'electron', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!electronPath) {
  console.error('[q-flow] 找不到 Electron');
  process.exit(1);
}

const dir = join(tmpdir(), 'dsh-q-flow');
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'main.js'),
  [
    "const { app, BrowserWindow } = require('electron');",
    `app.commandLine.appendSwitch('remote-debugging-port','${cdpPort}');`,
    "app.commandLine.appendSwitch('remote-allow-origins','*');",
    'app.whenReady().then(async () => {',
    "  const w = new BrowserWindow({ width: 1440, height: 900, webPreferences: { partition: 'persist:qflow' } });",
    '  await w.loadURL(process.env.U).catch(()=>{});',
    '  setTimeout(() => app.quit(), 120000);',
    '});',
  ].join('\n'),
  'utf8',
);
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-q-flow', version: '1.0.0', main: 'main.js' }), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.U = `http://127.0.0.1:${port}/?token=${token}`;
const br = spawn(electronPath, [dir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
br.stdout.on('data', () => {});
br.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
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
      ws.addEventListener('error', (e) => rej(new Error(String(e.message ?? e.type))));
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

try {
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
  check('浏览器页面已打开', !!page, page?.title);
  if (!page) throw new Error('没有页面 target');

  const ws = cdp(page.webSocketDebuggerUrl);
  await ws.ready;
  await ws.send('Runtime.enable');
  await ws.send('Page.enable');

  // 等面板出现（插件 apply 要几秒，然后才会渲染待答提问）
  let panel = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const r = await ws.send('Runtime.evaluate', {
      expression: [
        '(function(){',
        // ⚠️ 面板用【内联样式】+ 一个 data 标记，**没有 class**：
        //    容器是 [data-dsh-efficiency="questions"]（见 panel.js 的 h('div', {...})）。
        //    我最初查 [class*=efficiency]，永远匹配不到，于是把"面板已经渲染"
        //    误判成"面板没出来"（踩过）。
        '  var root = document.querySelectorAll("[data-dsh-efficiency=\\"questions\\"]");',
        '  var btns = Array.from(document.querySelectorAll("button"));',
        '  var optBtns = btns.filter(function(b){ return /选项\\s*A/.test(b.textContent || ""); });',
        '  return JSON.stringify({',
        '    panelRoots: root.length,',
        '    optionBtns: optBtns.length,',
        '    rootText: (root[0] ? (root[0].innerText || "") : "").slice(0, 300),',
        // 容器在但内容为空时，必须看它到底渲染了什么 —— 只报"没看到按钮"
        // 会把"面板没渲染"与"渲染了但结构不同"混为一谈（踩过）。
        '    rootHtmlLen: root[0] ? (root[0].innerHTML || "").length : -1,',
        '    rootHtmlHead: root[0] ? (root[0].innerHTML || "").slice(0, 300) : "",',
        '    rootKids: root[0] ? Array.from(root[0].children).map(function(c){ return c.tagName + "/" + (c.children||[]).length; }) : [],',
        '    rootDisplay: root[0] ? getComputedStyle(root[0]).display : "",',
        '    allButtons: btns.length,',
        '    buttonTexts: btns.map(function(b){ return (b.textContent||"").trim().slice(0,16); }).filter(Boolean).slice(0,10)',
        '  });',
        '})()',
      ].join('\n'),
      returnByValue: true,
    });
    panel = JSON.parse(r?.result?.value ?? '{}');
    if ((panel?.optionBtns ?? 0) > 0) break;
  }
  console.log(`     面板探测: ${JSON.stringify(panel).slice(0, 500)}`);
  check('提问面板里出现了选项按钮', (panel?.optionBtns ?? 0) > 0, `optionBtns=${panel?.optionBtns}`);

  const png = await ws.send('Page.captureScreenshot', { format: 'png' });
  if (png?.data) {
    writeFileSync(shot, Buffer.from(png.data, 'base64'));
    check('截图已写盘', existsSync(shot), shot);
  }

  // 点选项 → 再点 Submit → 断言宿主收到答案。
  // ⚠️ 点选项只是 toggle 选中态，**不会**提交；必须再点 Submit（踩过一次）。
  if ((panel?.optionBtns ?? 0) > 0) {
    const clicked = await ws.send('Runtime.evaluate', {
      expression: [
        '(function(){',
        '  var btns = Array.from(document.querySelectorAll("button"));',
        '  var opt = btns.filter(function(x){ return /选项\\s*A/.test(x.textContent || ""); })[0];',
        '  if (!opt) return "no-option";',
        '  opt.click();',
        '  return "option-clicked";',
        '})()',
      ].join('\n'),
      returnByValue: true,
    });
    console.log(`     选项点击: ${clicked?.result?.value}`);

    // 选中后 Submit 才可用
    await sleep(1200);
    const submitted = await ws.send('Runtime.evaluate', {
      expression: [
        '(function(){',
        '  var b = Array.from(document.querySelectorAll("button")).filter(function(x){',
        '    return /^\\s*Submit\\s*$/.test(x.textContent || "");',
        '  })[0];',
        '  if (!b) return "no-submit";',
        '  if (b.disabled) return "submit-disabled";',
        '  b.click();',
        '  return "submitted";',
        '})()',
      ].join('\n'),
      returnByValue: true,
    });
    console.log(`     提交: ${submitted?.result?.value}`);

    let sawExplicitFailure = false;
    // 提交后把面板上的状态文案读出来 —— 成功/失败要能区分
    // （只断言 answered 会把"选项没选中"和"POST 失败"混为一谈，踩过）
    for (let i = 0; i < 8; i++) {
      await sleep(800);
      const st = await ws.send('Runtime.evaluate', {
        expression:
          '(function(){ var r = document.querySelector(\'[data-dsh-efficiency="questions"]\'); return r ? (r.innerText||"").slice(0,300) : "(no-panel)"; })()',
        returnByValue: true,
      });
      const txt = String(st?.result?.value ?? '');
      if (/no-live-agent-for-call/.test(txt)) {
        // ⚠️ 断言要写对：合成提问**没有真实 agent**，宿主必然回
        //    `no-live-agent-for-call` —— 答案无处投递，这是【正确行为】。
        //    这一步真正验证的是：面板执行了答案路径，并且**如实报错而不是静默**。
        //    我最初断言 "answered 递增"，那是在要求一件逻辑上不可能的事（踩过）。
        console.log(`     面板状态（如实报错、未静默）: ${JSON.stringify(txt.slice(-110))}`);
        sawExplicitFailure = true;
        break;
      }
    }
    check('提交后面板如实报出原因（合成提问无 agent，属正确行为）', sawExplicitFailure);
  }

  // 把错误**完整**打出来（含堆栈）—— 截断过的错误信息会误导排查（踩过）
  const errs = ws.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
    .map((e) =>
      (e.params.args || [])
        .map((a) => a.value ?? a.description ?? JSON.stringify(a))
        .join(' '),
    );
  if (errs.length) {
    console.log('     --- 页面错误全文 ---');
    for (const t2 of errs) console.log('     ' + String(t2).replace(/\\n/g, '\\n     '));
  }
  check('页面无 console 错误', errs.length === 0, String(errs.length) + ' 条');
} catch (err) {
  console.error(`[q-flow] ❌ ${String(err)}`);
  failures += 1;
} finally {
  // 清理合成提问，别留在宿主里
  try {
    await fetch(api('/dsh-efficiency/api/dev/clear'), { method: 'POST', headers: H, body: '{}' });
  } catch {
    /* ignore */
  }
  try {
    br.kill();
  } catch {
    /* ignore */
  }
}

console.log('');
console.log(failures === 0 ? '[q-flow] PASS' : `[q-flow] FAIL: ${failures} 项未通过`);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 600);
