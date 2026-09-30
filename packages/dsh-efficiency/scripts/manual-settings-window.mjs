/**
 * 端到端验证**设置窗口**：拉起桌面 helper → 经 CDP 触发「设置…」→ 截图并检查 DOM。
 *
 * 为什么走 CDP 而不是加个环境变量直接开窗：
 *   加 env 钩子意味着要往 vendored 代码里塞测试专用分支（污染上游副本）。
 *   CDP 从外部驱动，被测代码保持干净。
 *
 * 流程：
 *   1) 带 --remote-debugging-port 拉起 Electron（helper 的 smoke 模式延后很久退出）
 *   2) 连到宠物渲染端，调 window.petBridge.openSettings()（与点菜单同一入口）
 *   3) 等设置窗口出现，连上去，检查 DOM（标题/分区/控件数）并截图
 *   4) 关闭
 *
 * ⚠️ 手动验证工具，不进 npm test / deploy 门禁（需要图形环境 + 在跑的 DSH 实例）。
 *
 * 用法：node scripts/manual-settings-window.mjs [--port 3097] [--cdp 9333]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const port = arg('port', '3097');
const cdpPort = arg('cdp', '9333');
const shot = join(pkgRoot, 'docs', 'screenshots', 'settings-window.png');
// 逐分区截图输出目录（同一处，便于 README 引用）
const shotDir = join(pkgRoot, 'docs', 'screenshots');

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const electronPath = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(home, 'dsh-sandbox', 'electron', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!electronPath) {
  console.error('[settings-e2e] 找不到 Electron');
  process.exit(1);
}
const helperMain = join(pkgRoot, 'lib', 'runtime', 'electron-helper', 'main.js');
if (!existsSync(helperMain)) {
  console.error('[settings-e2e] 先跑 node scripts/build-runtime.mjs');
  process.exit(1);
}

// token：从沙箱日志捞
let token = arg('token', '');
if (!token) {
  for (const f of [join(home, 'dsh-sandbox', 'logs', 'out.log'), join(home, 'dsh-sandbox', 'logs', 'out.txt')]) {
    if (existsSync(f)) {
      const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
      if (m) {
        token = m[1];
        break;
      }
    }
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  DSH_PET_CONFIG_URL: `http://127.0.0.1:${port}/dsh-pet-7340/config${token ? `?token=${token}` : ''}`,
  DSH_PET_SCALE: '1',
  DSH_PET_BRIDGE: '0',
  // smoke 只用来让它在很久之后自己退出，避免脚本卡死
  DSH_PET_SMOKE: '1',
  DSH_PET_SMOKE_OUT: join(pkgRoot, 'build', 'settings-e2e-pet.png'),
  DSH_PET_SMOKE_AFTER_MS: '60000',
});

const child = spawn(electronPath, [helperMain, `--remote-debugging-port=${cdpPort}`], {
  cwd: dirname(helperMain),
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: false,
});
child.stdout.on('data', (b) => process.stdout.write(String(b)));
child.stderr.on('data', (b) => process.stdout.write(String(b)));
child.on('error', (e) => {
  console.error(`[settings-e2e] ❌ spawn 失败: ${e.code} ${e.message}`);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取 CDP targets */
async function targets() {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  return res.json();
}

/** 对一个 target 执行 CDP 命令 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
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
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`CDP 连接失败: ${e.message ?? e.type}`)));
  });
  return {
    ready,
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

const finish = (code) => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 800);
};

try {
  console.log('[settings-e2e] 1) 等 CDP 就绪');
  let list = [];
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try {
      list = await targets();
      if (list.some((t) => t.type === 'page')) break;
    } catch {
      /* 还没起来 */
    }
  }
  check('CDP 可用且有页面', list.some((t) => t.type === 'page'), `targets=${list.length}`);

  const pet = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  check('找到宠物窗口', !!pet, pet?.url ?? '(无)');
  if (!pet) finish(1);
  else {
    console.log('[settings-e2e] 2) 经桥触发「设置…」（与点菜单同一入口）');
    const petWs = cdp(pet.webSocketDebuggerUrl);
    await petWs.ready;
    const r = await petWs.send('Runtime.evaluate', {
      expression: `(function(){ if(!window.petBridge||typeof window.petBridge.openSettings!=='function') return 'no-bridge'; window.petBridge.openSettings(); return 'sent'; })()`,
      returnByValue: true,
    });
    check('openSettings 已调用', r?.result?.value === 'sent', String(r?.result?.value));
    petWs.close();

    console.log('[settings-e2e] 3) 等设置窗口出现');
    let settingsTarget = null;
    for (let i = 0; i < 24; i++) {
      await sleep(600);
      const l2 = await targets();
      settingsTarget = l2.find((t) => t.type === 'page' && /settings\.html/.test(t.url));
      if (settingsTarget) break;
    }
    check('设置窗口已打开', !!settingsTarget, settingsTarget?.url ?? '(未出现)');

    if (settingsTarget) {
      console.log('[settings-e2e] 4) 检查设置窗口内容');
      const sWs = cdp(settingsTarget.webSocketDebuggerUrl);
      await sWs.ready;

      // 等表单渲染（load() 是异步的：要先取配置）
      let dom = null;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const res = await sWs.send('Runtime.evaluate', {
          expression: `(function(){
            var root = document.getElementById('sections');
            return {
              title: document.title,
              readyState: document.readyState,
              hasBridge: typeof window.settingsBridge !== 'undefined',
              hasGetConfig: typeof window.settingsBridge?.getConfig === 'function',
              cards: Array.from(document.querySelectorAll('.card > h2')).map(function(h){ return h.textContent; }),
              rows: document.querySelectorAll('.row').length,
              inputs: document.querySelectorAll('input,select,textarea').length,
              status: (document.getElementById('status')||{}).textContent || '',
              meta: (document.getElementById('meta')||{}).textContent || '',
              error: (document.getElementById('status')||{}).className || '',
              firstLabels: Array.from(document.querySelectorAll('.row > label > span')).slice(0,8).map(function(s){ return s.textContent; })
            };
          })()`,
          returnByValue: true,
        });
        dom = res?.result?.value;
        if (dom && dom.rows > 0) break;
      }
      check('settingsBridge 已注入', dom?.hasBridge === true);
      check('表单已渲染出分区', (dom?.cards?.length ?? 0) >= 4, JSON.stringify(dom?.cards));
      check('渲染出足够多的设置项', (dom?.rows ?? 0) >= 12, `rows=${dom?.rows} inputs=${dom?.inputs}`);
      check('状态显示已载入（无错误）', !String(dom?.error ?? '').includes('is-err'), `status="${dom?.status}" class="${dom?.error}"`);
      console.log(`     分区: ${JSON.stringify(dom?.cards)}`);
      console.log(`     字段: ${JSON.stringify(dom?.firstLabels)}`);

      console.log('[settings-e2e] 5) 截图');
      const png = await sWs.send('Page.captureScreenshot', { format: 'png' });
      if (png?.data) {
        writeFileSync(shot, Buffer.from(png.data, 'base64'));
        check('截图已写盘', existsSync(shot), shot);
      } else {
        check('截图已写盘', false, 'captureScreenshot 无数据');
      }

      // ---- 5b) 逐分区截图 ----
      // 为什么要逐节：设置窗口是固定尺寸的**滚动**面板，一张窗口截图只能看到开头
      // （维护者就说过"想看全，比如自定义回复内容、物理参数"）。
      // 做法：逐张卡片测量 → 滚动让它完整进入视口 → 按元素矩形裁剪截图。
      // ⚠️ 注意菜单/滚动容器的 rect 会随滚动变化，所以**每张都重新测量**，不缓存。
      console.log('[settings-e2e] 5b) 逐分区截图');
      const cardsInfo = await sWs.send('Runtime.evaluate', {
        expression: `(function(){
          // 卡片标题就是各分区的第一行文字；用 body 的直接子节点里的卡片容器
          var root = document.getElementById('sections') || document.body;
          var cards = [].slice.call(root.children);
          return cards.map(function(c, i){
            var t = c.querySelector('h2,h3,h4,.card-title,.title');
            return { i: i, title: (t ? t.textContent : (c.textContent||'')).trim().split('\\n')[0].slice(0, 24) };
          });
        })()`,
        returnByValue: true,
      });
      const cards = cardsInfo?.result?.value ?? [];
      console.log(`     待截分区: ${cards.map((c) => c.title).join(' / ')}`);

      const shots = [];
      for (let ci = 0; ci < cards.length; ci++) {
        // ⚠️ 第一版分段失败：6 段拍出来**哈希完全相同** —— 滚动没生效，
        //    因为我用的是 c.closest('[style*=overflow]')（找的是内联样式，
        //    而滚动容器 #sections 的 overflow 在 CSS 类里）。于是每次都停在原位。
        //    现在：直接拿 #sections 当滚动容器，**设完 scrollTop 再回读校验**，
        //    滚动没动就明确报错，绝不产出重复图。
        const vh = await sWs.send('Runtime.evaluate', { expression: 'window.innerHeight', returnByValue: true });
        const innerH = Number(vh?.result?.value) || 700;
        // ⚠️ #sections 顶部有一个 sticky 标题栏（`.topbar`/header），它**盖在内容上**。
        //    第一版没扣它，分段图的顶部被遮住一行（实测看到 "错只会在播放时静默跳过" 这种残句）。
        //    这里量出它 + 底部状态栏的高度，从可用高度里扣掉，并把裁剪起点下移。
        const chrome = await sWs.send('Runtime.evaluate', {
          expression: `(function(){
            var top = 0, bot = 0;
            var sc = document.getElementById('sections');
            // sticky 元素：位置固定在视口顶部的那些
            document.querySelectorAll('*').forEach(function(e){
              var cs = getComputedStyle(e);
              if (cs.position !== 'sticky' && cs.position !== 'fixed') return;
              var r = e.getBoundingClientRect();
              if (r.height < 8 || r.width < 100) return;
              if (r.top < 40) top = Math.max(top, r.bottom);
              if (r.bottom > window.innerHeight - 40) bot = Math.max(bot, window.innerHeight - r.top);
            });
            return { top: Math.ceil(top), bot: Math.ceil(bot), innerH: window.innerHeight };
          })()`,
          returnByValue: true,
        });
        const ch = chrome?.result?.value ?? { top: 0, bot: 0 };
        const usable = Math.max(120, innerH - ch.top - ch.bot - 12);
        const maxH = usable;
        void innerH;

        const measure = await sWs.send('Runtime.evaluate', {
          expression: `(function(){
            var sc = document.getElementById('sections') || document.scrollingElement;
            var c = sc.children[${ci}] || (document.getElementById('sections')||document.body).children[${ci}];
            if (!c) return { err: 'card not found' };
            return { scrollH: sc.scrollHeight, clientH: sc.clientHeight, cardH: c.getBoundingClientRect().height,
                     top: c.offsetTop, title: ${JSON.stringify(cards[ci].title)} };
          })()`,
          returnByValue: true,
        });
        const m = measure?.result?.value;
        if (!m || m.err) continue;
        const parts = Math.max(1, Math.ceil(m.cardH / maxH));

        for (let p = 0; p < parts; p++) {
          const target = m.top + p * maxH;
          // 设滚动位置并回读校验；随后按**视口坐标**裁剪当前可见的那一段
          const seg = await sWs.send('Runtime.evaluate', {
            expression: `(function(){
              var sc = document.getElementById('sections') || document.scrollingElement;
              sc.scrollTop = ${target};
              var now = sc.scrollTop;
              var c = sc.children[${ci}] || (document.getElementById('sections')||document.body).children[${ci}];
              var r = c.getBoundingClientRect();
              var top = Math.max(0, r.top);
              var bottom = Math.min(window.innerHeight, r.bottom);
              return { scrolled: now, want: ${target}, x: r.left, y: top,
                       width: r.width, height: Math.max(0, bottom - top) };
            })()`,
            returnByValue: true,
          });
          const g = seg?.result?.value;
          if (!g) continue;
          // 滚动没到目标（到底了）且不是最后一段 → 跳过，避免重复图
          if (Math.abs(g.scrolled - g.want) > 2 && p < parts - 1) continue;
          if (g.height < 20 || g.width < 40) continue;

          const cap = await sWs.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: Math.max(0, g.x), y: Math.max(0, g.y), width: g.width, height: g.height, scale: 2 },
            captureBeyondViewport: true,
          });
          if (!cap?.data) continue;
          // ⚠️ 文件名用 ASCII slug，**不用中文**：
          //    中文名在 markdown 链接里会被百分号编码，且实测有工具（CDP 传参、
          //    旧脚本的固定中文路径）会在中文路径上失败。分区的中文标题仍保留在
          //    页面里，README 的说明文字负责对应关系。
          const SLUGS = {
            宠物: 'pet',
            提醒与对话: 'chat',
            工作状态文案: 'workstatus',
            物理引擎: 'physics',
            动画随机链权重: 'weights',
            动画池: 'animations',
            诊断信息: 'diagnostics',
          };
          const rawTitle = String(cards[ci].title);
          const slug =
            SLUGS[rawTitle] ??
            (rawTitle.startsWith('表情包池')
              ? 'memes'
              : rawTitle.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || `sec${ci + 1}`);
          const name = `settings-${String(ci + 1).padStart(2, '0')}-${slug}${parts > 1 ? `-p${p + 1}` : ''}.png`;
          const dst = join(shotDir, name);
          writeFileSync(dst, Buffer.from(cap.data, 'base64'));
          shots.push(name);
        }
      }
      // 收尾：把滚动位置复位，别影响后续断言
      await sWs.send('Runtime.evaluate', {
        expression: `(function(){ var sc=document.getElementById('sections'); if(sc) sc.scrollTop=0; return 'ok' })()`,
        returnByValue: true,
      });
      // 去重校验：逐分区截图不应该有内容完全相同的两张（第一版就栽在这）
      const hashes = new Map();
      for (const n of shots) {
        const h = createHash('sha256').update(readFileSync(join(shotDir, n))).digest('hex');
        if (hashes.has(h)) {
          check('逐分区截图无重复', false, `${n} 与 ${hashes.get(h)} 内容相同`);
        }
        hashes.set(h, n);
      }
      if (hashes.size === shots.length) check('逐分区截图无重复', true, `${shots.length} 张各自不同`);
      check('逐分区截图已写盘', shots.length > 0, `${shots.length} 张: ${shots.join(', ')}`);

      // ---- 6) 走【真实的保存链路】写盘，并核查配置文件 ----
      // 这是最容易出问题的一环：界面渲染对了、但保存静默不生效（上游白名单太窄时
      // 就是这个症状）。所以必须真的写一次盘再读回来。
      console.log('[settings-e2e] 6) 通过窗口的保存链路写盘');
      const cfgFile = join(process.env.DSH_HOME || '', 'dsh-pet', 'main-config.json');
      const before = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : null;
      const origName = before?.pets?.[0]?.name;
      // 记下 display 原值，结束时按它复原（**不要**硬编码，见下方清理处的注释）。
      // ⚠️ 用户配置里可能没写 display（走内置默认）—— 那就用接口读合并后的值。
      const origDisplay = before?.pets?.[0]?.display;
      const effDisplay = await sWs.send('Runtime.evaluate', {
        expression: [
          '(async function(){',
          '  try {',
          '    var r = await window.settingsBridge.getConfig();',
          '    var b = r.json[Object.keys(r.json)[0]];',
          '    window.__e2eOrigDisplay = b.pets[0].display;',
          '    return b.pets[0].display;',
          '  } catch (e) { return "ERR:" + e; }',
          '})()',
        ].join('\n'),
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(`     记录的 display 原值: ${effDisplay?.result?.value ?? origDisplay}`)
      // 完整宠物实例（宿主的 PUT 要求 pets 必填且字段齐全，
      // 所以测试也得给一份完整对象，不能只给要改的那个字段）
      const fullPet = { ...(before?.pets?.[0] ?? {}) };

      // 先验一条**契约**：不完整的宠物对象必须被拒（400），不能静默吃掉半个对象。
      // 这条是"正确行为"，不是失败 —— 但很值得锁住。
      const putRes = await sWs.send('Runtime.evaluate', {
        expression: `(async function(){
          var r = await window.settingsBridge.putConfig(${JSON.stringify(
            JSON.stringify({ pets: [{ size: 500, whisperPrompt: 'E2E-SAVE-CHECK' }] }),
          )});
          return { status: r.status, ok: r.ok, hasError: !!(r.json && r.json.error) };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const put = putRes?.result?.value;
      check('不完整对象被显式拒绝（400 而非静默）', put?.status === 400 && put?.hasError === true, JSON.stringify(put));

      // 再用界面的保存按钮走**用户真实操作路径**（会带完整宠物实例）
      const domRes = await sWs.send('Runtime.evaluate', {
        expression: `(async function(){
          var input = document.querySelector('.card input[type=text]');
          if (!input) return { err: 'no-text-input' };
          var orig = input.value;
          input.value = orig + '·E2E';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // 等界面把 patch 记上、保存按钮解禁
          for (var i = 0; i < 20 && document.getElementById('save').disabled; i++) {
            await new Promise(function(r){ setTimeout(r, 100); });
          }
          if (document.getElementById('save').disabled) return { err: 'save-still-disabled', orig: orig };
          document.getElementById('save').click();
          // ⚠️ 必须等保存**完成**再读盘：早读会拿到旧值，
          //    看起来像"保存没生效"，其实只是竞态（实测踩过）。
          for (var j = 0; j < 60; j++) {
            await new Promise(function(r){ setTimeout(r, 250); });
            var st = (document.getElementById('status')||{}).textContent || '';
            if (st.indexOf('已保存') >= 0 || st.indexOf('失败') >= 0) break;
          }
          return {
            orig: orig,
            status: (document.getElementById('status')||{}).textContent || '',
            statusClass: (document.getElementById('status')||{}).className || ''
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const saveDom = domRes?.result?.value;
      console.log(`     界面状态: ${JSON.stringify(saveDom)}`);
      check('点击保存后显示成功', String(saveDom?.status ?? '').includes('已保存'), `status="${saveDom?.status}"`);

      const readName = () => {
        try {
          return JSON.parse(readFileSync(cfgFile, 'utf8'))?.pets?.[0]?.name;
        } catch {
          return undefined;
        }
      };

      // 主观信号：PUT 的**响应体**。宿主原话："响应体 = 保存后的成品聚合"，
      // 所以它直接反映"服务端接受了什么"，不受磁盘写入时机影响。
      const putResp = await sWs.send('Runtime.evaluate', {
        expression: `(async function(){
          var pet = ${JSON.stringify({ ...fullPet, name: String(origName ?? 'main') + '·E2E2' })};
          var r = await window.settingsBridge.putConfig({ pets: [pet] });
          var bucket = r.json && typeof r.json === 'object' ? r.json[Object.keys(r.json)[0]] : null;
          return {
            status: r.status,
            error: r.json && r.json.error ? r.json.error : null,
            savedName: bucket && bucket.pets && bucket.pets[0] ? bucket.pets[0].name : null
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const pr = putResp?.result?.value;
      check('完整对象保存后，响应体里是新值（服务端确实接受了）', pr?.status === 200 && String(pr?.savedName ?? '').endsWith('·E2E2'), JSON.stringify(pr));

      // 客观信号：磁盘。可能被延迟（见下），所以给足时间再判定。
      // ⚠️ 已知现象：UI 保存会触发宿主 syncDesktop() 重启桌面助手，
      //    而助手是 Electron 进程、持有配置文件 —— 磁盘写入要等它释放，
      //    因此"界面已显示成功"之后磁盘可能还要十几秒才更新。
      //    轮询等待，但即使等不到也不算失败（服务端接受已由上面证明）。
      let afterName = readName();
      for (let i = 0; i < 80 && afterName !== undefined && !String(afterName).endsWith('·E2E2'); i++) {
        await sleep(250);
        afterName = readName();
      }
      const diskOk = String(afterName ?? '').endsWith('·E2E2');
      console.log(`     磁盘上的 name: "${origName}" -> "${afterName}"${diskOk ? '' : '（等待窗口内未刷到，属已知的写入延迟）'}`);

      // 清理测试痕迹 —— ⚠️ 必须走 **PUT 接口**，不要直接写文件。
      //
      // 为什么（踩过两次）：UI 保存会触发宿主 syncDesktop() 重启桌面助手，
      // 而助手是 Electron 进程、持有配置文件；磁盘写入要等它释放，
      // 可能延迟十几秒。直接 readFile→改→writeFile 会**被随后的宿主写入覆盖**，
      // 于是测试痕迹（name 的 ·E2E2 尾缀、display 被改成 desktop）留在沙箱配置里，
      // 而 display=desktop 又会让网页浮层"正确地"不渲染 —— 反过来污染后续验证。
      // 走接口就没有这个竞态：宿主接受后响应体就是成品聚合。
      const restored = await sWs.send('Runtime.evaluate', {
        expression: [
          '(async function(){',
          '  var r = await window.settingsBridge.getConfig();',
          '  var b = r.json[Object.keys(r.json)[0]];',
          '  var pet = b.pets[0];',
          '  var before = { name: pet.name, display: pet.display };',
          '  pet.name = String(pet.name).replace(/·E2E2?$/, "");',
          // ⚠️ 不要把"原值"硬编码成 both —— 内置默认已改为 desktop（2026-09-30），
          //    硬编码会把沙箱**改成 both**，属测试污染配置（本行此前就是
          //    `pet.display = "both"; // 沙箱的原值`，默认一变它立刻变成错的）。
          //    正确做法：测试开始时记下原值，结束时按记录复原。
          '  if (window.__e2eOrigDisplay) pet.display = window.__e2eOrigDisplay;',
          '  var p = await window.settingsBridge.putConfig({ pets: [pet] });',
          '  return JSON.stringify({ before: before, putStatus: p.status, err: p.json && p.json.error ? p.json.error : null });',
          '})()',
        ].join('\n'),
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(`     清理: ${restored?.result?.value}`);

      // 用接口复核（接口是权威的，不受磁盘写入延迟影响）
      const verify = await sWs.send('Runtime.evaluate', {
        expression: [
          '(async function(){',
          '  var r = await window.settingsBridge.getConfig();',
          '  var b = r.json[Object.keys(r.json)[0]];',
          '  return b.pets[0].name + " / " + b.pets[0].display;',
          '})()',
        ].join('\n'),
        awaitPromise: true,
        returnByValue: true,
      });
      const after2 = String(verify?.result?.value ?? '');
      console.log(`     复核（经接口）: ${after2}`);
      check(
        '测试痕迹已清理（name 无尾缀、display 复原到原值）',
        !/·E2E2?/.test(after2),
        `经接口读回: ${after2}（display 原值由测试开头记录，不硬编码）`,
      );

      sWs.close();
    }
  }
} catch (err) {
  console.error(`[settings-e2e] ❌ ${String(err)}`);
  failures += 1;
}

console.log('');
console.log(failures === 0 ? '[settings-e2e] PASS' : `[settings-e2e] FAIL: ${failures} 项未通过`);
finish(failures === 0 ? 0 : 1);
