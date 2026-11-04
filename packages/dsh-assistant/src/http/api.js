/**
 * assistant 侧 HTTP API —— 供 tg 网关查询与回写。
 *
 * 契约（与 tg-agent 约定的稳定接口）：
 *   GET  /health                        → { ok, items, pending, lastTickAt }
 *   GET  /items?status=open&limit=N     → { items: [{id,title,course,dueAt,status,revision}] }
 *   POST /items/{id}/status {status}    → { ok:true, id, status }
 *
 * 鉴权：请求头 `x-dsh-token` 必须等于共享密钥（文件或 env）。
 * 缺省只监听 127.0.0.1；Docker 里由 publish 到宿主机，tg 服务经 host.docker.internal 访问。
 *
 * 为什么把 store 做成注入的回调：
 *   daemon 持有内存 state 与磁盘持久化，HTTP 层不该自己去读写文件 ——
 *   否则会出现"HTTP 读到旧快照、daemon 又覆盖回去"的竞态。
 */

import { createServer } from 'node:http';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 生成 HTTP 请求处理器。
 *
 * @param {object} deps
 * @param {string} deps.token 共享密钥（空字符串表示不校验，仅限本机调试）
 * @param {(status?:string, limit?:number)=>object[]} deps.listItems
 * @param {(id:string, status:string)=>{ok:boolean,error?:string}} deps.setItemStatus
 * @param {()=>object} deps.stats
 */
export function createRequestHandler({ token, listItems, setItemStatus, stats, chat, checkSession }) {
  const authorized = (req) => {
    if (!token) return true;
    const provided = req.headers['x-dsh-token'];
    return typeof provided === 'string' && provided === token;
  };

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...(stats?.() ?? {}) });
      }

      if (!authorized(req)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (path === '/items' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? 'open';
        const limitRaw = Number(url.searchParams.get('limit') ?? 50);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
        const items = listItems(status, limit).map((item) => ({
          id: item.id,
          title: item.title,
          course: item.course ?? null,
          dueAt: item.dueAt ?? null,
          status: item.status,
          revision: item.revision ?? 1,
        }));
        return sendJson(res, 200, { ok: true, count: items.length, items });
      }

// 立即做一次会话检查（tg 的 /ready 用它：人刚登录完，别等下一个 15 分钟）
      if (path === '/session/check' && req.method === 'POST') {
        if (typeof checkSession !== 'function') {
          return sendJson(res, 503, { ok: false, error: 'session check 未启用' });
        }
        try {
          const result = await checkSession();
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 对话：tg 网关把用户的普通文本转发到这里
      if (path === '/chat' && req.method === 'POST') {
        if (typeof chat !== 'function') {
          return sendJson(res, 503, { ok: false, error: 'chat 未启用（缺 LLM 凭据）' });
        }
        let body;
        try {
          body = await readJsonBody(req, 32 * 1024);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error.message ?? error) });
        }
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' });
        try {
          const result = await chat(text);
          return sendJson(res, 200, { ok: true, reply: result.reply, usage: result.usage ?? null });
        } catch (error) {
          return sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const statusMatch = /^\/items\/([^/]+)\/status$/.exec(path);
      if (statusMatch && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error.message ?? error) });
        }
        const nextStatus = body?.status;
        if (!['open', 'done', 'dropped'].includes(nextStatus)) {
          return sendJson(res, 400, { ok: false, error: 'status must be open|done|dropped' });
        }
        const id = decodeURIComponent(statusMatch[1]);
        const result = setItemStatus(id, nextStatus);
        if (!result.ok) return sendJson(res, 404, result);
        return sendJson(res, 200, { ok: true, id, status: nextStatus });
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

/**
 * 启动 HTTP 服务。返回 { server, port, close() }。
 * 端口传 0 时由系统分配（测试用）。
 */
export function startApiServer({ port = 8787, host = '127.0.0.1', ...deps }) {
  const handler = createRequestHandler(deps);
  const server = createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
