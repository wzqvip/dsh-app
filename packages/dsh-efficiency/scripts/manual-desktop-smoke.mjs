/**
 * 用真实契约拉起桌面 Electron helper（宠物小窗），验证 vendored 的桌面链路。
 *
 * 为什么需要：宿主是通过 HelperProcess 拉 helper 的，而那条路径要跑在
 * 一个完整的 DSH 宿主要进程里。这个脚本按**同一份契约**（同命令、同环境变量）
 * 直接拉起，好处是不用等宿主、也能拿到 helper 的 stdout 诊断。
 *
 * ⚠️ 这是**手动验证工具**，不属于 npm test / deploy 门禁：
 *    它需要图形环境、需要 DSH 实例在跑、还要占用真实屏幕。
 *
 * 用法：
 *   node scripts/manual-desktop-smoke.mjs [--port 3097] [--token <t>] [--out shot.png]
 *                                       [--after 9000] [--keep]
 * 不传 token 时会尝试从沙箱日志里读。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const port = arg('port', '3097');
const after = arg('after', '9000');
const out = arg('out', join(pkgRoot, 'build', 'desktop-smoke.png'));
const keep = flag('keep');

// ---- 找 Electron ----
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const electronCandidates = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(home, 'dsh-sandbox', 'electron', 'electron.exe'),
  join(home, '.dsh', 'electron', 'electron.exe'),
].filter(Boolean);
const electronPath = electronCandidates.find((p) => existsSync(p));
if (!electronPath) {
  console.error('[desktop-smoke] 找不到 Electron。候选：');
  for (const c of electronCandidates) console.error(`   ${c}`);
  console.error('   设 DSH_PET_ELECTRON_PATH 指定，或先让 dsh-pet 下载过 Electron。');
  process.exit(1);
}

// ---- 找 helper 入口（就是我们 lib/runtime 里那份）----
const helperMain = join(pkgRoot, 'lib', 'runtime', 'electron-helper', 'main.js');
if (!existsSync(helperMain)) {
  console.error(`[desktop-smoke] 找不到 ${helperMain} —— 先跑 node scripts/build-runtime.mjs`);
  process.exit(1);
}

// ---- token：没给就从沙箱日志里捞 ----
let token = arg('token', '');
if (!token) {
  const log = join(home, 'dsh-sandbox', 'logs', 'out.txt');
  const log2 = join(home, 'dsh-sandbox', 'logs', 'out.log');
  const f = existsSync(log) ? log : existsSync(log2) ? log2 : null;
  if (f) {
    const m = readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/);
    if (m) token = m[1];
  }
}

const origin = `http://127.0.0.1:${port}${token ? `/?token=${token}` : ''}`;
const configUrl = `http://127.0.0.1:${port}/dsh-pet-7340/config${token ? `?token=${token}` : ''}`;

console.log('[desktop-smoke] 启动参数');
console.log(`  electron : ${electronPath}`);
console.log(`  helper   : ${helperMain}`);
console.log(`  configUrl: ${configUrl}`);
console.log(`  截图     : ${out}`);
console.log(`  延迟     : ${after}ms`);
console.log('');

// ⚠️ 必须删掉 ELECTRON_RUN_AS_NODE：它的【存在】就会让 Electron 进纯 Node 模式，
//    那样 require('electron') 直接 MODULE_NOT_FOUND（上游 issue #63，注释里写得很清楚）。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  DSH_PET_CONFIG_URL: configUrl,
  DSH_PET_SCALE: '1',
  // 不开 bridge：本脚本没有宿主侧的管道对端；helper 会退回直接 HTTP 取配置与素材，
  // 这正是"手动 start-desktop / 开发流"支持的路径。
  DSH_PET_BRIDGE: '0',
  DSH_PET_SMOKE: '1',
  DSH_PET_SMOKE_OUT: out,
  DSH_PET_SMOKE_AFTER_MS: after,
});

const child = spawn(electronPath, [helperMain], {
  cwd: dirname(helperMain),
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: false,
});

const lines = [];
const onData = (buf) => {
  const s = String(buf);
  lines.push(s);
  process.stdout.write(s);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);

child.on('error', (e) => {
  console.error(`[desktop-smoke] ❌ spawn 失败: ${e.code} ${e.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  const all = lines.join('');
  console.log('');
  console.log(`[desktop-smoke] helper 退出码 ${code}`);
  // 从输出里挑出关键信号，给一个可读的结论
  const signals = [
    ['渲染端桥已注入', /hasBridge"?\s*:\s*true/],
    ['宠物 sprite 已渲染', /sprites"?\s*:\s*([1-9]\d*)/],
    ['没有可见错误', /errorVisible"?\s*:\s*false/],
    ['截图已写盘', () => existsSync(out)],
  ];
  for (const [label, test] of signals) {
    const ok = typeof test === 'function' ? test() : test.test(all);
    console.log(`  ${ok ? '✅' : '⚠️ '} ${label}`);
  }
  if (existsSync(out)) {
    console.log(`  截图: ${out}`);
  }
  if (!keep) process.exit(0);
});

console.log('[desktop-smoke] 已拉起，等待 helper 自己退出（smoke 模式会截图后退出）…');
