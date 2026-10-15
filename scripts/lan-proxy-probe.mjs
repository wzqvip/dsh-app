/**
 * 最小 TCP/HTTP 转发代理 —— 用来验证"DSH 只绑回环时，能否经代理让局域网访问"。
 *
 * 为什么需要这个实验：DSH 的 `/api` 有一道 **DNS-rebinding 围栏**
 * （`isTrustedApiRequest`）：它检查请求的 `Host` 是否属于
 * 「回环」或「`trustedHosts` 里的 authority」。
 * 所以"代理能不能用"取决于**代理是否改写 Host**，而这必须实测，不能想当然。
 *
 * 用法：
 *   node scripts/lan-proxy-probe.mjs --listen 192.168.2.183:3095 --target 127.0.0.1:3096 --mode keep
 *   node scripts/lan-proxy-probe.mjs --listen 192.168.2.183:3095 --target 127.0.0.1:3096 --mode rewrite
 *
 * mode=keep    保留客户端发来的 Host（这正是 `--trusted-host` 要解决的场景）
 * mode=rewrite 把 Host 改写成 target（回环），围栏天然放行
 *
 * 这是**诊断工具**，不是产品代码 —— 没有 TLS、没有访问控制。
 */
import { createServer, request as httpRequest } from 'node:http';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const listen = arg('listen', '127.0.0.1:3095');
const target = arg('target', '127.0.0.1:3096');
const mode = arg('mode', 'keep');

const [listenHost, listenPort] = listen.split(':');
const [targetHost, targetPort] = target.split(':');

const server = createServer((req, res) => {
  const headers = { ...req.headers };
  const originalHost = headers.host;
  const originalOrigin = headers.origin;
  if (mode === 'rewrite') {
    headers.host = `${targetHost}:${targetPort}`;
    // ⚠️ **Origin 也必须跟着改写**，否则真实浏览器的 POST 会被围栏拒绝：
    //    围栏要求 `Origin` 与 `Host` 同源（`new URL(origin).host === hostUrl.host`）。
    //    浏览器发的是 `Origin: http://192.168.2.183:3095`，而我们把 Host 改成了回环
    //    → 两者不一致 → 403。GET 不受影响（浏览器对同源 GET 不发 Origin），
    //    所以这个坑只在**写操作**（发消息、改设置）时才暴露 —— 极易漏测。
    const targetAuthority = `${targetHost}:${targetPort}`;
    if (originalOrigin) headers.origin = `http://${targetAuthority}`;
    headers['x-forwarded-host'] = originalHost ?? '';
    if (originalOrigin) headers['x-forwarded-origin'] = originalOrigin;
  }

  const upstream = httpRequest(
    { host: targetHost, port: Number(targetPort), method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(upstream);

  // 打印一行，便于对照 —— 这行就是"围栏判定要用到的 Host"
  console.log(
    `[proxy:${mode}] ${req.method} ${req.url}  host=${originalHost} -> ${headers.host}  sec-fetch-site=${req.headers['sec-fetch-site'] ?? '-'} origin=${req.headers.origin ?? '-'}`,
  );
});

server.on('upgrade', (req, socket, head) => {
  // WebSocket（DSH 的实时通道）也必须转发，否则只有静态页能开
  const headers = { ...req.headers };
  if (mode === 'rewrite') headers.host = `${targetHost}:${targetPort}`;
  const up = httpRequest({
    host: targetHost,
    port: Number(targetPort),
    method: req.method,
    path: req.url,
    headers,
  });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')}\r\n\r\n`,
    );
    if (upHead?.length) socket.unshift(upHead);
    socket.pipe(upSocket).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  up.end();
  console.log(`[proxy:${mode}] UPGRADE ${req.url}  host=${req.headers.host}`);
});

server.listen(Number(listenPort), listenHost, () => {
  console.log(`[proxy:${mode}] listening on http://${listenHost}:${listenPort}  ->  http://${targetHost}:${targetPort}`);
});
