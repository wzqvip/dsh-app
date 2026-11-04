/**
 * 登录 OSU Canvas（Shibboleth SSO），供 skill/canvas-quiz 使用。
 *
 * 维护者 2026-11-04 授权：Canvas 与 Outlook 用同一套 OSU 账号密码；
 * Duo 2FA 会 push 到他手机，他会点"信任此设备"。
 *
 * 边界（与 login.js 一致，不许放松）：
 *   · 只填账号密码；**验证码/2FA 永不填**
 *   · 凭据只从 /data/osu.json 读，不写日志、不进 state
 *   · 遇到 mfa_required / captcha 就停手，把控制权交还给人
 *
 * 用法：
 *   node scripts/canvas-login.mjs [--url https://osu.instructure.com/] [--deadline-sec 180]
 */

import { existsSync, readFileSync } from 'node:fs';

import { actOnBrowser, snapshotBrowser } from '../src/browser/client.js';
import { attemptPasswordLogin } from '../src/session/login.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const browserBase = arg('browser', process.env.DSH_BROWSER_BASE ?? 'http://dsh-browser:8789');
const tokenPath = arg('token-file', '/data/token.txt');
const credPath = arg('creds', '/data/osu.json');
const startUrl = arg('url', 'https://osu.instructure.com/');
const deadlineSec = Number(arg('deadline-sec', 180));

const apiToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
if (!existsSync(credPath)) {
  console.error(`[canvas-login] 找不到凭据：${credPath}（需要 {"email":"...","password":"..."}）`);
  process.exit(2);
}
const creds = JSON.parse(readFileSync(credPath, 'utf8'));

const log = (msg) => console.log(`[canvas-login] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snapshot = () => snapshotBrowser({ baseUrl: browserBase, token: apiToken });
const act = (action, payload) =>
  actOnBrowser({ baseUrl: browserBase, token: apiToken, action, ...payload });

/**
 * 校验快照确实来自目标站点。
 *
 * 踩过的坑（2026-11-04）：浏览器服务会为新页面开新标签，但 `/snapshot` 仍读旧标签，
 * 于是"打开 Canvas 后读到的是 Outlook" → 被判成已登录，Duo 根本没触发。
 * 任何"看起来成功"的判断都必须先确认 host。
 */
function assertTargetPage(snap, allowedHosts) {
  const url = String(snap?.url ?? '');
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  const ok = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  return { ok, host, url };
}

const ALLOWED_HOSTS = ['osu.instructure.com', 'webauth.service.ohio-state.edu'];

log(`入口=${startUrl}  浏览器=${browserBase}`);

// 先确认浏览器读到的是 OSU 相关页面（不是别的标签）
const pre = await snapshot();
const preCheck = assertTargetPage(pre, ALLOWED_HOSTS);
if (!preCheck.ok) {
  log(`⚠️ 快照来自 ${preCheck.host || '(空)'} 而不是 OSU：${preCheck.url.slice(0, 90)}`);
}

const result = await attemptPasswordLogin({
  profile: 'osu',
  url: startUrl,
  creds,
  open: (url) => act('open', { url }),
  snapshot,
  type: (selector, text) => act('type', { selector, text }),
  click: (selector) => act('click', { selector }),
  log,
});

log(`步骤：${result.steps.join(' → ')}`);

if (result.ok) {
  // ⚠️ 不能只信 ok —— 必须再确认一次页面真的在 osu.instructure.com 上
  const after = await snapshot();
  const check = assertTargetPage(after, ALLOWED_HOSTS);
  if (!check.ok) {
    log(`❌ 判定失败：登录流程报成功，但当前页面是 ${check.host || '(空)'}`);
    log(`   这说明浏览器读到了别的标签页（${check.url.slice(0, 100)}）。`);
    log('   需要 browser-agent 修「/open 新开标签、/snapshot 读旧标签」的问题。');
    process.exit(4);
  }
  if (!/^osu\.instructure\.com$/.test(check.host)) {
    log(`⚠️ 还在 SSO 页（${check.host}），可能卡在 Duo。请手机批准后重跑。`);
    process.exit(3);
  }
  log('✅ 已登录 Canvas（页面确认在 osu.instructure.com）');
  process.exit(0);
}

// 2FA：Duo 会 push 到维护者手机，这里给一段时间等他自己点
if (result.reason === 'mfa_required' || result.needsUser) {
  log(`需要人工（${result.reason ?? 'unknown'}）。`);
  log('如果手机上收到了 Duo 推送，请点"信任此设备"并批准；我这就在等…');

  const deadline = Date.now() + deadlineSec * 1000;
  let snap = await snapshot();

  while (Date.now() < deadline) {
    await sleep(5000);
    snap = await snapshot();
    if (!snap?.needsUser) {
      log('✅ Duo 已通过，Canvas 登录成功');
      process.exit(0);
    }
    log(`  仍在等待…（${snap?.reason ?? 'unknown'}，${snap?.chars ?? 0} 字符）`);
  }

  log(`⏱️ 等了 ${deadlineSec}s 仍未通过。请在 noVNC 里手动完成，然后重新跑这个脚本。`);
  process.exit(3);
}

log(`❌ 登录失败（${result.reason ?? 'unknown'}）`);
process.exit(1);
