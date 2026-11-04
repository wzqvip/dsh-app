/**
 * 一次性 Google OAuth 授权（取 refresh token），在**本机**跑。
 *
 * 为什么在本机跑而不是服务器：OAuth 的桌面流必须有一个**能打开浏览器的机器**，
 * 而且回调要打到 `http://127.0.0.1:<port>`。ubuntu 上没有浏览器，
 * 所以：本机监听 → 人工点同意 → 拿到 refresh token → 再传到服务器。
 *
 * 凭据来源：环境变量（**不要把 client_secret 写进仓库**）
 *   GOOGLE_CLIENT_ID      形如 xxx.apps.googleusercontent.com
 *   GOOGLE_CLIENT_SECRET  形如 GOCSPX-...
 *
 * 用法：
 *   $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."
 *   node scripts/google-oauth.mjs --out C:\path\tokens.json --port 8912
 *
 * 注意：
 *   · 若 OAuth 客户端类型是「Web 应用」，需要把
 *     `http://127.0.0.1:8912/oauth2callback` 加到「已获授权的重定向 URI」
 *     （「桌面应用」类型不需要登记，Google 允许任意 loopback 端口）
 *   · scope 只申请 calendar（读写事件），不碰 Gmail/Drive
 */

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = Number(arg('port', 8912));
const outPath = arg('out', 'google-tokens.json');
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const scope = 'https://www.googleapis.com/auth/calendar';

if (!clientId || !clientSecret) {
  console.error('[oauth] 缺 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 环境变量');
  process.exit(2);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent', // 强制返回 refresh_token（不然第二次授权可能只给 access_token）
  }).toString();

console.log('[oauth] 请在浏览器打开下面这个链接，并用**要授权的那个 Google 账号**登录同意：');
console.log('');
console.log(authUrl);
console.log('');
console.log(`[oauth] 等待回调：${redirectUri}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end('not found');
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (error || !code) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h2>授权失败</h2><p>${error ?? '没有拿到 code'}</p>`);
    console.error(`[oauth] 授权失败：${error ?? 'no code'}`);
    return;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const body = await response.json();

    if (!response.ok || !body.refresh_token) {
      const detail = body?.error_description ?? body?.error ?? JSON.stringify(body);
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h2>换 token 失败</h2><pre>${detail}</pre>`);
      console.error(`[oauth] 换 token 失败：${detail}`);
      return;
    }

    writeFileSync(
      outPath,
      JSON.stringify(
        {
          clientId,
          clientSecret,
          refreshToken: body.refresh_token,
          scope: body.scope ?? scope,
          obtainedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ 授权成功</h2><p>可以关闭这个页面，回到终端。</p>');
    console.log(`[oauth] ✅ refresh_token 已保存到 ${outPath}`);
    console.log('[oauth] 接着把它传到服务器：ssh_upload → ~/dsh-assistant/data/google.json');
    server.close();
    setTimeout(() => process.exit(0), 200);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h2>异常</h2><pre>${String(err?.message ?? err)}</pre>`);
    console.error(`[oauth] 异常：${err?.message ?? err}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[oauth] 监听已就绪（${port}）`);
});
