# 03 · `dsh web` 的绑定方式与 LAN 暴露安全分析

> 调查性质：**只读**。未启动任何服务器、未修改 `~/.dsh`、未修改 `research/` 之外的任何文件。
> 唯一执行的命令是 `dsh web --help`（`dsh-cmdline` 在 help 分支会让进程直接退出，不会进入 `webserver` 挂载阶段；实测输出后进程立即结束，未打印 `dsh web:` URL 行，也没有监听端口）。

## 0. 路径与版本约定

安装根：

```
C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\
```

下文用 `$PKG\<包名>\...` 表示该根下的路径。运行时事实（来自会话环境）：

| 变量 | 值 |
|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:3080` |
| `DSH_PROFILE` | `web` |
| `DSH_PROFILE_DIR` | `C:\Users\WANGZ\.dsh\profiles\web` |
| `DSH_HOME` | `C:\Users\WANGZ\.dsh` |

版本：`@deepseek-ai/dsh` 0.1.7-rc.2（npx 安装，仅有预构建 `lib/*.js` + `lib/types/**/*.d.ts` + README；`src/`、`docs/`、`.agents/notes/` 均**未随包发布**，README 中的相对链接指向不存在的文件）。

---

## 1. `dsh web` 的全部命令行标志

### 1.1 权威来源：`$PKG\dsh-web-app\lib\startup.js:21-28`（`webCommand()`）

```js
function webCommand() {
	return new Command().name("dsh --profile web").description("Serve the DeepSeek Harness browser UI.").helpOption("-h, --help", "show this help").option("--host <host>", "bind host").option("--no-open", "do not open the Web UI in the default browser").option("--port <port>", "listen port; pass 0 to let the OS pick a free one").option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)").addHelpText("after", `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
`);
}
```

### 1.2 实测 `dsh web --help` 输出（逐字）

```
Usage: dsh --profile web [options]

Serve the DeepSeek Harness browser UI.

Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free
                                 one
  --trusted-host <authority...>  extra authority the /api browser-trust fence
                                 accepts (host or host:port; repeatable)
  -h, --help                     show this help
```

### 1.3 标志总表

| 标志 | 取值 | 默认 | 含义 | 证据 |
|---|---|---|---|---|
| `--host <host>` | 见 §2（实际只接受 `127.0.0.1`/`0.0.0.0`，且 `0.0.0.0` 被显式拒绝） | `127.0.0.1`（来自 bundle patch，非 commander 默认） | 绑定地址 | `startup.js:22`；`dsh-web-app\cordis.patch.yml:167` |
| `--port <port>` | 十进制数字串；`0` = 由 OS 分配 | `3080`（来自 bundle patch） | 监听端口 | `startup.js:22,45`；`cordis.patch.yml:168` |
| `--trusted-host <authority...>` | `host` 或 `host:port`，可重复（variadic） | `[]` | 追加到 `/api` 浏览器信任围栏（Host/Origin 校验）的额外 authority。**不影响 socket 绑定** | `startup.js:22,46`；`dsh-web-app\lib\index.js:37,83-89` |
| `--no-open` | 布尔（negatable，即 `--open` 也语法上存在但未声明描述） | `openBrowser: true` | 不自动打开默认浏览器 | `startup.js:22,43`；`dsh-web-app\lib\index.js:34` |
| `-h, --help` | — | — | 打印 `dsh web` 帮助 | `startup.js:22` |

**不存在的标志（明确排除）**：

- ❌ `--listen`、`--base-path` / `--baseurl`、`--open`（有 `--no-open` 但无正向 `--open`）、`--tls` / `--https` / `--cert` / `--key`、`--dangerous` / `--insecure` / `--allow-remote`、`--auth` / `--token` / `--password`、`--cors`、`--proxy`。
- 全仓库 grep `createSecureServer|https.createServer|tls.createServer` → **0 命中**：整个 web 栈没有任何 TLS 服务端实现。

### 1.4 启动器自身（`dsh`）的相关标志 —— 这是绕过限制的关键

`$PKG\dsh\lib\bin.js:104`（逐字）：

```js
.option("--profile <name>", "the profile under $DSH_HOME/profiles to boot", selectProfile)
.option("--from-default-profile <name>", "initialize a new custom profile from a shipped profile template")
.option("--patch <path>", "extra patch-list overlay applied after the profile layer (repeatable)", collect)
.option("--dump-config", "print the composed profile tree and exit")
.option("--dump-config-schema", "print JSON Schema for profile entries and patches without mounting")
.option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit")
```

`--patch` 是**可重复的单值收集器**，且 `resolveBoot` 的 `patches` 会按 argv 顺序追加为最后一个 patch 层（`$PKG\dsh-app-boot\README.md:41-46`）：

> 层序：每个 bundle 的 patch（按 `dsh.profile.bundles` 顺序）→ profile 的 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。

启动器只解析自己的标志，遇到第一个不认识的 token 就把其后所有内容原样交给被启动的 app（`$PKG\dsh\lib\types\args.d.ts:1-16`）。因此：

```sh
dsh web --help          # = web app 的帮助，不是启动器的
dsh --profile web --host 0.0.0.0   # 报错（见 §2.3）
```

---

## 2. HTTP 服务器如何创建与绑定

### 2.1 `$PKG\dsh-host-webserver` —— 唯一的 `node:http` 服务器

Config schema（`$PKG\dsh-host-webserver\lib\index.js:141-147`，逐字）：

```js
static Config = z.object({
	host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
	port: z.natural().max(65535).required(),
	compression: z.union([z.const("none"), z.const("gzip")]).default(DEFAULT_COMPRESSION),
	compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
	compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES)
});
```

监听点（`lib\index.js:295-305`）：

```js
await new Promise((resolve, reject) => {
	this.server.once("error", reject);
	this.server.listen(this.config.port, this.config.host, () => { ... this.listenedPort = this.server.address().port; resolve(); });
});
```

**没有硬编码 `127.0.0.1`**：绑定地址完全来自 config。`host` 只接受两个字面量 —— `127.0.0.1` 与 `0.0.0.0`（**不接受**具体 LAN IP、`::`、主机名）。

README 对这两个值的定性（`$PKG\dsh-host-webserver\README.md:39`，逐字）：

> `host` accepts exactly two values: `127.0.0.1` (default posture, loopback only) and `0.0.0.0` (deliberate network exposure — the server carries no TLS, authentication, or origin policy of its own). `port` 0 requests an OS-assigned port; `ctx.webServer.port` reads the listening port afterwards.

以及 `README.md:113`：

> **No server-wide TLS, authentication, or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy. Binding a non-loopback address still exposes unprotected routes and static assets to that network.

其他 config 键（`lib\types\index.d.ts`）：仅上述 5 个；另有路由注册 API `register` / `registerUpgrade` / `registerFallback` / `tapIndex` / `renderIndex`（非 config）。

### 2.2 组合层：bundle patch 如何喂给 webserver

`$PKG\dsh-web-app\cordis.patch.yml:163-171`（逐字）：

```yaml
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      inject: [webStartup]
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3080
        compression: gzip
        compressionLevel: 1
        compressionThresholdBytes: 1024
```

即：CLI 标志 **只**通过 `webStartup` 服务注入这一行 config；默认 loopback / 3080 是 patch 里的 fallback，不在 commander 里。

### 2.3 CLI 对 `0.0.0.0` 的硬拒绝

`$PKG\dsh-web-app\lib\startup.js:40`（逐字）：

```js
if (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");
```

`lib\startup.js:41`：

```js
if (options.port !== void 0 && !/^\d+$/.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
```

README 也把它写进 Known Limitations（`dsh-web-app\README.md:154` / `README.zh.md:158`）：

> **Binding all network interfaces is not supported** — `--host 0.0.0.0` is rejected at startup for safety; use the default loopback host.

**注意反差点**：`dsh-client-connection\README.md:43` 与 `README.zh.md:43` 同样写着 “`dsh web --host 0.0.0.0` remains unsupported / 仍不受支持”。但 `dsh-web-app\lib\index.js` 里已经存在完整的 `0.0.0.0` 分支（`resolveLanTrust`，`lib\index.js:41-89`）：

```js
const LOOPBACK_HOST = "127.0.0.1";
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = "0.0.0.0";
...
function resolveLanTrust(bindHost, extra) {
	const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces()).flat().filter(...).map((iface) => iface.address) : [];
	return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] };
}
...
console.log(`dsh web: ${authenticatedUrl}${lanUrl === undefined ? "" : ` (LAN: ${lanUrl})`}`);
```

**结论**：`0.0.0.0` 在**插件/config 层是被完整支持并已有实现**的（自动采样 LAN IPv4 字面量、自动放进信任围栏、自动打印带 token 的 LAN URL）；被挡住它的**只有 CLI 那一行字符串检查**。这是一个"策略闸门"，不是能力缺口。

---

## 3. 安全模型（最重要）

### 3.1 三层防线总览

| 层 | 位置 | 作用 | 是否防火墙 |
|---|---|---|---|
| ① 绑定 | `dsh-host-webserver` config `host` | 决定 socket 是否可达 | 是（唯一真正的边界） |
| ② Host/Origin 围栏 | `$PKG\dsh-client-connection\lib\index.js:205-219` | 防 DNS rebinding / 跨站请求 | 否，"never establish identity" |
| ③ 浏览器会话认证 | `lib\index.js:221-460` (`BrowserAuth`) | 进程 launch token → 签名 cookie | 是（对 `/api` 与 index；静态资源除外） |

### 3.2 ② Host/Origin 围栏（逐字代码）

`$PKG\dsh-client-connection\lib\index.js:110-125`：

```js
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
```

`lib\index.js:205-219`：

```js
function isTrustedApiRequest(request, trustedHosts) {
	const host = header$1(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header$1(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
```

语义：

- `Host` 必须是 loopback（`localhost` / `[::1]` / `127.0.0.0/8` 任意地址），或命中 `trustedHosts`：带端口则精确匹配 `host:port`，不带端口则匹配该主机名的**任意端口**（`lib\index.js:192-198`）。
- `sec-fetch-site: cross-site` → 拒绝。
- 若带 `Origin`，必须与 `Host` 完全相等。
- `trustedHosts` 条目在插件加载时会被 `assertTrustedAuthority` 严格校验（`lib\index.js:169-173`）：必须是裸 authority、WHATWG 规范化后不变，否则**加载失败**。文档说明（`lib\types\api-request-trust.d.ts:17-30`）拒绝 `harness.internal/path`、`user@harness.internal`、悬空冒号、零填充端口、`0x7f.0.0.1`、百分号编码、未加括号的 IPv6。

围栏的自我定性（`lib\types\api-request-trust.d.ts:1-14`，逐字）：

> Network reachability and authentication stay out of scope: binding policy belongs to the webserver config, and **this fence is not an auth layer**.

`lib\index.js:585-594`：

```js
	requestRejection(request) {
		if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
		return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
	}
	admit(request) {
		const rejection = this.requestRejection(request);
		return rejection === void 0 ? { peer: this.operator } : { rejection };
	}
```

→ 403 = Host/Origin 不可信；401 = Host 可信但未认证。

### 3.3 ③ 浏览器认证：进程 token + 签名 cookie

`$PKG\dsh-client-connection\lib\index.js:223-231`：

```js
const AUTH_RECORD_KEY = credentialKey("client-connection", "browser-session");
const DAY_MILLISECONDS = 1440 * 60 * 1e3;
const SECRET_BYTES = 32;
const TOKEN_QUERY = "token";
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION = 1;
const STORED_SECRET_VERSION = 1;
const PROCESS_LAUNCH_TOKENS = /* @__PURE__ */ new WeakMap();
```

机制（README `$PKG\dsh-client-connection\README.md:39-41` 是最好的一手描述）：

> Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. Each process mints a random launch token. `dsh-web-app` prints and opens its application URL with `?token=...`, preserving the caller's authority and mount; `frontend-static` delegates root and index requests to `ctx.connection.authorizeIndex`, which accepts that token only on `GET /`, writes an authority-bound signed cookie, and redirects to clean `./` ... A missing, expired, malformed, or wrong-authority cookie returns 401 before RPC dispatch. **Static assets remain public.** The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token.
>
> The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`. The local provider persists it in `$DSH_HOME/.credentials.yaml` ... Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`; **they deliberately omit `Secure` because the shipped server uses loopback HTTP.**

实现细节（逐字）：

- token 生成：`lib\index.js:244-250`，`encodeBase64Url(randomBytes(32))` → 256 bit，每进程一次，`WeakMap` 挂在 `ctx.root` 上（进程内跨 Connection reload 稳定）。
- cookie 名：`cookieName(authority) = "dsh-auth-" + base64url(sha256(authority))`（`lib\index.js:284-286`）。
- cookie 序列化（`lib\index.js:296-298`）：

```js
function sessionCookie(name, value, expiresAt, maxAgeSeconds) {
	return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
}
```

- token 兑换入口（`lib\index.js:388-411`）——**只在 `GET /` 且恰好一个 token 参数时有效**：

```js
		const tokens = url.searchParams.getAll(TOKEN_QUERY);
		if (tokens.length > 0) {
			const authority = requestAuthority(req.headers);
			if (req.method === "GET" && url.pathname === "/" && tokens.length === 1 && authority !== void 0 && tokenMatches(tokens.join(""), this.launchToken)) {
				...
				res.writeHead(303, {
					"cache-control": "no-store",
					"location": "./",
					"referrer-policy": "no-referrer",
					"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3))
				});
```

- 校验用 HMAC-SHA256 + `timingSafeEqual`（`lib\index.js:299-324`）；payload 含 `{version, authority, issuedAt, expiresAt}`。
- 签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录（`lib\index.js:325-342`）→ **重启不失效**（cookie 可用 30 天），但**每进程的 launch token 会变**。
- 无 logout、无会话列表、无按客户端撤销；README `README.md:76`：清 cookie 只结束一个浏览器会话，要全局吊销必须删除该 credential 记录并重启 `dsh`。

### 3.4 WebSocket 的准入

`$PKG\dsh-api-gateway\lib\index.js:12`：

```js
const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
```

`lib\index.js:626-643`：

```js
			const listen = () => {
				const mux = new RemoteStreamMuxServer(...);
				webCtx.effect(function* () {
					yield () => mux.close();
					const route = {
						path: REMOTE_STREAM_MUX_PATH,
						handler: (req, socket, head) => {
							const admission = webCtx.connection.admit(req);
							if ("rejection" in admission) {
								rejectRemoteStreamUpgrade(socket, admission.rejection);
								return;
							}
							mux.handleUpgrade(req, socket, head, admission.peer);
						}
					};
					yield webCtx.webServer.registerUpgrade(route);
```

→ **WS upgrade 走同一个 `admit()`**（Host/Origin 围栏 + cookie 认证），被拒时在裸 socket 上写 `401 Unauthorized` / `403 Forbidden`（`lib\index.js:525-541`）。`ws` 的 `WebSocketServer({ noServer: true })`（`lib\index.js:179`）——没有独立的 origin 选项，也没有独立的校验，一切依赖 `admit`。

服务端每 2 秒发 Ping，未在下一个间隔前回 Pong 的 peer 会被终止（`lib\index.js:551` + README `dsh-api-gateway\README.md:35,89`）。这对代理/隧道意味着：**必须允许 WS 帧双向流动，且不能有 >2s 的停顿**（否则连接被踢，客户端会按指数退避重连——`dsh-client-connection\README.md:54`，上限 10s）。

### 3.5 `/api` 暴露面清单

`/api` 是一个 **prefix 路由**（`dsh-client-connection\lib\index.js:829-843`），所有子路由在同一 `admit()` 之后分发：

```js
		const fetchHandler = connection.createSharedFetchHandler(API_PATH);
		const route = {
			kind: "prefix",
			path: API_PATH,
			handler: async (req, res) => {
				const admission = connection.admit(req);
				if ("rejection" in admission) { res.writeHead(admission.rejection); ... return; }
				await webCtx.waterfall("connection/request", req, res, () => bridge(req, res, fetchHandler, maxRequestBodyBytes));
			}
		};
```

| 端点 | 方法 | 认证 | 内容 / 授予的能力 | 证据 |
|---|---|---|---|---|
| `/api/<endpoint>` | POST (JSON) | ✅ admit | Typert Remote unary 分发（见下表 controller） | `dsh-client-connection\lib\index.js:673-702` |
| `/api/remote.mux` | WS upgrade | ✅ admit | 全部 Remote stream + `$events` 推送 | `dsh-api-gateway\lib\index.js:632-642` |
| `/api/file?path=<绝对路径>` | GET/HEAD | ✅ admit | **读任意绝对路径的普通文件**（不限定工作区，`isAbsolute` 即可）；上限 `attachments.imageLimits.maxImageBytes`（默认 20 MiB）；响应带 `nosniff` + `Content-Security-Policy: sandbox; default-src 'none'` | `dsh-api-session-controller\lib\index.js:2334-2401` |
| `/api/session/uploadFileBinary` | POST (raw bytes) | ✅ admit | 原始字节上传到 Host 附件服务 | `dsh-client-file-upload\lib\index.js:73,171-172` |

**受认证后可达的 Remote 命名空间（= 攻击者拿到 cookie 后能干的事）：**

| 包 | 命名空间 | 关键能力 |
|---|---|---|
| `dsh-api-session-controller` | `session`, `skills`, `fileReferences` | **`prompt`**（提交任意文本/附件 → 驱动 Agent）、`create`/`fork`/`resume`、`cancel`、队列编辑、模型切换、`rename`、读完整历史、`openWorkspacePath` |
| `dsh-api-workspace-files` | `workspaceFiles` | `stat`/`read`/`readBytes`/`list`/`changes`；**`read`/`readBytes`/`stat` 接受绝对路径且不受工作区约束**（`README.md:12,40`："File reads and watches may target paths outside the workspace"; "The service exposes no mutation operation"） |
| `dsh-api-terminal-controller` | `terminal` | `create`/`write`/`resize`/`follow`/`close`：在 Session 工作区里开**交互式 shell**（默认 `pwsh`/`bash`），"run with the execution environment's system-user permissions, independently of the Agent's sandbox mode and approval policy"（`README.md:30`） |
| `dsh-api-workspace-controller` | `workspace`, `directoryPicker` | 创建/重命名/删除/排序 Workspace，归档/取消归档 Session，跟随投影，目录选择 |
| `dsh-api-settings-controller` | `settings`, `credentials` | 读（脱敏的）设置与凭据元数据；**写设置与凭据**（不返回明文）；在 Host 桌面打开 provider 设置页 |
| `dsh-api-job-controller` | `job` | `job.list` / `job.follow`（读 job 保留输出） / `job.kill` |
| `dsh-api-account-controller` | account | 登录状态、快照流；不返回 token / PKCE secret |
| `dsh-api-remotes` | — | 转发事件的装配（BFF） |

**未认证即可访问的端点（静态资源公开）**：

| 端点 | 说明 | 证据 |
|---|---|---|
| `GET /assets/*` | 前端 bundle（含 `dist/assets/*.js`；`.map` 若存在也会按 `application/json` 发出） | `dsh-host-frontend-static\lib\index.js:24-33,63-66` |
| `GET /plugins/<id>/client.js` | 每个 client 插件的 bundle（`PLUGIN_ROUTE` prefix 路由，**无 admit**） | `dsh-client-modules\lib\index.js:545-551` |
| `GET /plugins/events` | **HMR SSE 流，无 admit、无 Host/Origin 围栏** → 未认证 LAN 客户端可读取 client 模块图（模块 id、被监视路径） | `dsh-client-hmr\lib\index.js:5,140-152` |
| `GET /`（index.html） | 需要认证（cookie 或 token 兑换） | `dsh-host-frontend-static\lib\index.js:59-62,95` |
| `GET /open-in-app/*` | 需要 `connection.requestRejection` | `dsh-host-open-in-app\lib\index.js:1263-1282` |
| `GET /oauth/callback` | 仅在用户主动发起账号登录时临时注册；校验 PKCE `state`（`timingSafeEqual`）+ 单值校验 | `dsh-deepseek-account-platform\lib\index.js:970-995` |

### 3.6 `dsh-authorization` / `dsh-credentials` **不是** HTTP 认证

- `$PKG\dsh-authorization\README.md:12`：它是"human-guided sign-in, code entry, or question"的**凭据获取流程注册表**（OAuth / API key 引导），与 HTTP 客户端身份无关。
- `$PKG\dsh-credentials` 是持久凭据存储（`$DSH_HOME/.credentials.yaml`），它的角色是给 `BrowserAuth` **存 cookie 签名密钥**，不是给 HTTP 客户端发凭据。
- **没有任何 bearer token / API key / pairing 机制用于 HTTP 或 WebSocket 客户端**。唯一的凭据是"进程 token → 签名 cookie"，且**不存在方法级的 loopback tier**（`dsh-client-connection\README.md:39`）。

### 3.7 CSRF / CSP / DNS-rebinding 小结

| 风险 | 状态 | 证据 |
|---|---|---|
| DNS rebinding | ✅ 防住 | Host 必须是 loopback 或 `trustedHosts` 条目；注释明确指出 Host 是"rebinding 唯一无法伪造的头"（`api-request-trust.d.ts:1-14`） |
| CSRF | ✅ 多层防住 | ① `SameSite=Strict` cookie；② `sec-fetch-site: cross-site` 拒绝；③ `Origin` 必须等于 `Host`；④ 非简单请求需 CORS 预检，而服务端**不返回任何 CORS 头**（grep `access-control-allow` 仅命中前端 bundle 内部的 modulepreload 属性处理，`lib/*.js` 零命中） |
| CSP（主应用） | ❌ 无 | 全仓库 grep `content-security-policy` 只命中 `/api/file` 响应与 `deepseek-account-platform` 的 OAuth 页；index.html 与静态资源**没有任何 CSP / HSTS / X-Frame-Options** |
| TLS | ❌ 完全没有 | §1.3 的 grep；且 cookie 明确**不带 `Secure`**（`README.md:75`） |
| 限流 / 锁定 | ❌ 无 | 无任何失败计数或速率限制；但 token 是 256 bit，不构成暴力破解风险 |

---

## 4. 威胁模型：无认证的 LAN 客户端能做什么（按严重度排序）

前提：假设攻击者能从 LAN 访问到服务器端口（无论通过 loopback→proxy 还是 `0.0.0.0` 绑定）。

| # | 严重度 | 攻击 | 前置条件 | 证据 |
|---|---|---|---|---|
| 1 | **致命（等价 RCE）** | 直接驱动 Agent：`session.create` + `session.prompt` 提交任意 prompt → Agent 用 `pwsh`/`bash`/文件工具执行任意命令。这**正是 CLI 拒绝 `0.0.0.0` 时给出的理由**："it would expose remote code execution to the network" | 有 cookie（或 token URL） | `dsh-web-app\lib\startup.js:40`；`dsh-api-session-controller` README `description: "create, resume, prompt..."` |
| 2 | **致命** | 直接开交互式 shell：`remote.terminal.create/write` → 以**系统用户权限**运行（'independently of the Agent's sandbox mode and approval policy'） | 有 cookie | `dsh-api-terminal-controller\README.md:28,30` |
| 3 | **严重（任意文件读）** | `GET /api/file?path=C:\Users\WANGZ\.dsh\.credentials.yaml`（或 `%USERPROFILE%\.ssh\id_rsa`、浏览器 cookie 库…）逐块读取任意可读文件 | 有 cookie | `dsh-api-session-controller\lib\index.js:2349-2371`（绝对路径即可，无包含性检查；20 MiB/请求限制） |
| 4 | **严重（任意文件读，Remote 版）** | `workspaceFiles.read/readBytes/stat` 用绝对路径读工作区之外的文件；`workspaceFiles.changes` 目录监视限工作区 | 有 cookie | `dsh-api-workspace-files\README.md:12,40,54` |
| 5 | **严重（凭据写入/持久化）** | `remote.settings` / `remote.credentials` 写设置与凭据（明文不回传，但可覆盖 LLM API key、转向攻击者端点 → 后续 prompt 全部流向攻击者） | 有 cookie | `dsh-api-settings-controller\README.md:12` |
| 6 | **高（会话/工作区破坏）** | `workspace.create/rename/remove`、`session.fork/cancel/rename`、`job.kill`、任意 Session 历史（含工具参数、结果、文件内容）全文读取 | 有 cookie | `dsh-api-workspace-controller` / `dsh-api-job-controller` / `dsh-api-session-controller` READMEs |
| 7 | **高（凭据窃取 → 升级为 1–6）** | 明文 HTTP 上窃听 `dsh-auth-*` cookie（**无 `Secure`**、SameSite 只防跨站不防同站窃听）或启动日志/浏览器历史里的 `?token=...`；token 是 256 bit 不可猜但可**被读到** | 能嗅探同网段（ARP/热点/镜像端口） | `dsh-client-connection\README.md:75`（"exposing the same authority over plaintext networking can expose the bearer cookie in transit"）；`lib\index.js:296-298` |
| 8 | 中（未认证信息泄露） | `GET /plugins/events`（SSE，无 admit、无围栏）泄露 client 模块图与监视路径；`GET /plugins/<id>/client.js`、`/assets/*` 泄露全部前端代码（含 `.map` 若有） | 仅需网络可达 | `dsh-client-hmr\lib\index.js:5,140-152`；`dsh-client-modules\lib\index.js:545-551`；`dsh-host-frontend-static\lib\index.js:13`（"Non-index assets stay public"） |
| 9 | 中（跨站请求） | 恶意页面 `fetch("http://<lan-ip>:3080/api/...")` | **被防住**：Origin/Host 不等 → 403；`sec-fetch-site: cross-site` → 403；SameSite=Strict 不带 cookie | `dsh-client-connection\lib\index.js:205-219` |
| 10 | 低（DNS rebinding） | 攻击者域名解析到 192.168.x.x | **被防住**：Host 不在 loopback / trustedHosts → 403 | 同上 |
| 11 | 中（DoS / 资源耗尽） | 未认证客户端可无限建立 SSE 连接（`/plugins/events`）；`maxRequestBodyBytes` 默认 300 MiB（`dsh-client-connection\lib\index.js:816`）→ 认证后可用内存打满 | 网络可达 | `dsh-host-frontend-static` / `dsh-client-connection\lib\index.js:816` |
| 12 | 低 | `/api/file` 的 `Content-Security-Policy: sandbox; default-src 'none'` 阻止直接打开的 HTML/SVG 在 API origin 执行 | — | `dsh-api-session-controller\lib\index.js:2339-2343` |

**重要判断**：3.1 的"三层防线"里**第 ② 层不是认证**（作者自己写明），第 ③ 层本身设计良好（256 bit token、HMAC-SHA256、timing-safe、host+port 绑定、SameSite=Strict、HttpOnly、30 天）。真正的薄弱点是：

1. **传输层没有 TLS，且 cookie 刻意不带 `Secure`** —— 任何能嗅探 LAN 明文流量的人都能直接窃取 cookie，然后获得与真人完全等同的权限（含 RCE）。
2. **`--trusted-host` 只放宽围栏，不放宽 socket** —— 单独用它做不了 LAN 访问。
3. **静态资源与 HMR SSE 无认证** —— 不致命，但攻击面扩大。

---

## 5. `dsh-http-proxy` 是什么？（**不是**反向代理）

`$PKG\dsh-http-proxy\README.md:12`：

> Use this package to apply one **outbound** HTTP proxy policy to Harness requests that use Node's built-in `fetch`, including LLM, web-search, and HTTP MCP traffic.

它是**出站**代理策略（读 `http_proxy` / `https_proxy` / `no_proxy` / `all_proxy`，安装 undici 全局 dispatcher），并**强制绕过 loopback**（`README.md:52`）。它**不监听端口、不做入站转发、不做 TLS 终止**。因此：

> **仓库内不存在任何"入站反向代理/隧道"组件。** 反向代理方案必须用外部软件（Caddy / nginx / Tailscale / Cloudflare Tunnel / `ssh -L`）。

仓库内**唯一**被文档化的远程访问方式是 SSH 转发（`dsh-web-app\README.md:60-62`）：

> When you launch `dsh --profile web` over SSH, the URL line still prints but the browser is not opened for you: the SSH client or editor owns the local forwarding address. Open the forwarded URL on your machine yourself; the printed URL names the remote host's loopback endpoint.

---

## 6. WebSocket 细节（对代理/隧道的要求）

| 项 | 值 | 证据 |
|---|---|---|
| 服务端库 | `ws`（`import WebSocket, { WebSocketServer } from "ws"`），`noServer: true` | `dsh-api-gateway\lib\index.js:8,179` |
| 路径 | `/api/remote.mux`（**精确匹配**，`upgrades.get(pathname)`） | `dsh-api-gateway\lib\index.js:12`；`dsh-host-webserver\lib\index.js:274` |
| 客户端如何拼 URL | `new URL("api/remote.mux", __DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)`，再把 `https:` → `wss:`（否则 `ws:`） | `dsh-api-gateway\lib\client.js:728-733` |
| 页面 base | index.html 被注入 `<base href="./">`（`dsh-host-frontend-static\lib\index.js:85`），所以 `document.baseURI` = 页面目录 URL | 同上 |
| origin 校验 | **无独立校验**；完全复用 `connection.admit(req)`（Host/Origin 围栏 + cookie） | `dsh-api-gateway\lib\index.js:634-639` |
| 心跳 | Host 每 `websocketHeartbeatIntervalMs`（默认 2000 ms）发 Ping；未回 Pong 的 peer 在下一个间隔被终止 | `dsh-api-gateway\lib\index.js:551`；`README.md:35,89` |
| 重连 | 客户端指数退避 500 ms → 10 s + 50%–100% jitter；`offline` 暂停，`online` 从 500 ms 重启 | `dsh-client-connection\README.md:54-56` |
| 粘性会话 | **不需要**：单个 dsh 进程只有一个 WS 端点，所有逻辑流多路复用在一个物理 socket 上（`mux`） | `dsh-api-gateway\README.md:35` |
| 会话绑定 | cookie 的 authority = `hostname:port`（`cookieName` + 签名 payload 双重绑定），**因此代理必须让浏览器看到稳定的 host:port**；换端口 = 换 cookie | `dsh-client-connection\lib\index.js:256-265,284-286` |
| **路径挂载限制** | token 兑换**只在 `url.pathname === "/"` 时生效**，因此**不支持挂在子路径下**（如 `https://host/dsh/`）。必须挂在 authority 根 | `dsh-client-connection\lib\index.js:394` |

对代理的最小要求：

1. 转发 `Upgrade: websocket` + `Connection: Upgrade` 到 `/api/remote.mux`（nginx 需 `proxy_http_version 1.1`、`proxy_set_header Upgrade $http_upgrade`、`proxy_set_header Connection "upgrade"`）。
2. **保留原始 `Host`**（`proxy_set_header Host $host`），否则 `Origin != Host` → 403。
3. 不要缓冲 SSE/WS；`proxy_read_timeout` 必须远大于 2 s，否则心跳 Pong 被判超时。
4. 只挂在根路径。
5. 把代理对外使用的 authority 加进 `--trusted-host`（不带端口则覆盖任意端口）。

---

## 7. 移动端 / 安全上下文（Secure Context）相关

| 能力 | 明文 HTTP + LAN IP 下是否可用 | 证据 |
|---|---|---|
| `crypto.randomUUID` | ❌ 不可用 → **但已有内置 fallback**：`crypto.getRandomValues` 实现，全仓库统一。注释明确写出这个 LAN 场景："a page or worker served over **plain HTTP on a LAN address** has no such method" | `$PKG\dsh-util-crypto\lib\index.js:4-16`；`dsh-client-connection\lib\client.js:1187` |
| 剪贴板 | ⚠️ 部分可用：`dsh-client-ui-primitives` 的 `writeClipboard()` 优先 `navigator.clipboard.writeText`，失败/缺失时回退 `execCommand('copy')`（注释点名 "insecure contexts"）。但 `dsh-client-ui-settings-account\lib\client.js:1041` **直接调用** `navigator.clipboard.writeText(...)`（无回退） | `dsh-client-ui-primitives\lib\index.js:4543-4574`；`dsh-client-ui-settings-account\lib\client.js:1041` |
| 语音输入（实验性） | ❌ **完全不可用**：`navigator.mediaDevices.getUserMedia` 需要 secure context；代码会抛 `RecordingError("unavailable")` | `$PKG\dsh-experimental-client-ui-voice-input\lib\client.js:4673-4675` |
| 终端里的 webview 类编辑器 | ❌ 依赖 `crypto.subtle`，有明确报错文案 "not running in a secure context" | `dsh-client-ui-sidebar-terminal\lib\client.terminal.js:8184` |
| PWA / Service Worker | ⚠️ 有 manifest（`display: "fullscreen"`、`start_url: "./"`、`scope: "./"`），**但全仓库 grep `serviceWorker.register` = 0 命中** → 没有 SW、没有离线能力，Chrome 的"安装"提示条件不满足 | `dsh-web-frontend\dist\index.html:6`；`dist\manifest.webmanifest` |
| 移动端 viewport | ✅ 有 `<meta name="viewport" content="width=device-width, initial-scale=1">` | `dsh-web-frontend\dist\index.html:5` |
| 响应式布局 | ⚠️ 有"窄屏"逻辑，但**是桌面三栏自适应的窄屏，不是 phone/tablet/foldable 形态分类**：`SIDEBAR_AUTO_COLLAPSE = 1024`、右栏 `viewportWidth < 768` 自动全屏、`computeColumns(viewport, ...)` 保留 center ≥400px 与 rightbar ≥300px 的最低要求 → 手机上会是"折叠侧栏 + 单列" | `dsh-client-ui-layout\lib\client.js:13,15,38-44,236-243`；`dsh-client-ui-sidebar-right\lib\client.js:5727` |
| 触摸适配 | ⚠️ 有零星 `@media (pointer:coarse)` / `(hover:none)`（删除按钮常显、缩放面板常显），但**没有** `viewport-segments` / Device Posture API / `screen.orientation` 处理 → **折叠屏（foldable）无专门支持** | `dsh-client-ui-attachment\lib\client.js:27,360,593`；`dsh-client-ui-sidebar-documentpreview\lib\client.js:4201` |

**结论（移动端）**：手机/平板在 **HTTP 明文 LAN** 下可以基本可用（UUID 有 fallback、剪贴板多数有 fallback、布局会收成单列），但**语音输入不可用**、**账号设置页的复制按钮会静默失败**、**无 PWA 安装/离线**、**无折叠屏适配**。要拿到完整能力（语音、剪贴板、可安装），**必须 HTTPS**（或在 `localhost` 上访问）。

---

## 8. 直接回答："能不能只设一个 bind flag？"

**不能。** 证据链：

1. `dsh web --host 0.0.0.0` 被 `startup.js:40` 立刻 `program.error(...)` 拒绝；错误文案自己说明了理由是 RCE 风险。
2. `--host` 传任何**具体 LAN IP**（如 `--host 192.168.1.5`）虽然**过得了 CLI**（只有 `"0.0.0.0"` 被字符串比较拦截），但会撞上 `WebServer.Config` 的 `z.union([z.const("127.0.0.1"), z.const("0.0.0.0")])`（`dsh-host-webserver\lib\index.js:142`）→ **启动失败**。
3. `--trusted-host` **不改变 socket 绑定**，只放宽 `/api` 的 Host/Origin 围栏（`dsh-web-app\lib\index.js:83-89` + `dsh-client-connection\lib\index.js:205-219`）。默认 loopback 绑定下，LAN 客户端**连 TCP 都建不起来**，`--trusted-host` 毫无作用。
4. **但是**：`dsh-host-webserver` 的 config **原生支持** `0.0.0.0`，`dsh-web-app` 也已实现完整的 LAN 分支（LAN IPv4 采样 → 自动进 `trustedHosts` → 打印带 token 的 LAN URL）。所以这是**一个策略闸门，不是能力缺失**。

因此三条可行路径：

- **A（推荐，零改动）**：保持 loopback 绑定，用外部反向代理 / SSH 隧道在本机终结；用 `--trusted-host` 把外部 authority 放进围栏。**不需要 patch、不需要改代码。**
- **B（需要 patch，不改代码）**：用 `--patch` 或 `$DSH_PROFILE_DIR\cordis.patch.yml` **覆盖 `webserver` 行的 config**，把 `host` 改成 `'0.0.0.0'`，绕过 CLI 检查。这是"改配置"，不是"改代码"。
- **C（需要写插件/改预构建产物）**：真正需要的额外能力（TLS、密码门、mTLS、CORS 收紧、给静态资源加认证）**仓库里都不存在**，必须自己写一个 Cordis 插件挂在 `webServer` 上，或者用外部代理实现。

---

## 9. 启用 LAN 访问的可行方案（按推荐度排序）

### 方案 1 ★★★★★　SSH 隧道 / VPN 覆盖网 + 保持 loopback 绑定

- **做法**
  - 单机对单机：`ssh -N -L 3080:127.0.0.1:3080 user@host`，本地浏览器打开**启动日志里那条 `http://127.0.0.1:3080/?token=...`**（Host 是 loopback → 天然过围栏，cookie authority = `127.0.0.1:3080`）。
  - 手机/平板：用 Tailscale / WireGuard 把设备接入同一覆盖网，然后在覆盖网内做**跳板端口转发**（例如 Tailscale 的 `tailscale serve --bg 3080`，它会终止 TLS 并反代到 `127.0.0.1:3080`），此时需要 `--trusted-host <tailnet 域名>`。
- **工作量**：低（一条命令 / 一次 `tailscale serve`）。
- **风险**：**低**。传输被 SSH/WireGuard 加密；socket 仍只在 loopback 上；不需要 patch、不改任何文件。
- **触及的代码/配置**：无（可能加 `--trusted-host`）。
- **代价**：手机端要装 VPN 客户端；`tailscale serve` 的域名必须进 `trustedHosts`；启动日志里的 token 需要人工传一次（30 天 cookie 期内不必重复）。

### 方案 2 ★★★★☆　本机反向代理（Caddy/nginx）+ TLS + 保持 loopback 绑定

- **做法**
  ```sh
  dsh web --no-open --trusted-host dsh.lan          # 仍绑 127.0.0.1:3080
  ```
  Caddy（自动 HTTPS，若用内网自签需把根证书装到手机）：
  ```
  dsh.lan {
      reverse_proxy 127.0.0.1:3080 {
          header_up Host {host}          # 必须保留 Host，否则 Origin != Host → 403
      }
  }
  ```
  浏览器访问 `https://dsh.lan/?token=<从启动日志复制的 token>`，兑换 cookie 后重定向到 `https://dsh.lan/`。
- **工作量**：中（装代理、证书信任、`--trusted-host`）。
- **风险**：**中**。TLS 解决了 §4 第 7 条（cookie 明文嗅探），代理本身成为唯一入口，可用 `basic_auth` 或 mTLS 再加一道门。**但**代理必须只挂根路径（§6 限制），且要正确转发 WS upgrade。
- **触及的代码/配置**：`--trusted-host`；外部 Caddy/nginx 配置。**不改 dsh 任何文件。**
- **注意**：Windows 上 Caddy 是单个 exe，比 nginx 省事；手机需要信任内网 CA（否则 HTTPS 报错）。

### 方案 3 ★★★☆☆　patch 覆盖 `webserver.config.host = 0.0.0.0`（直连 LAN，可选叠加代理）

- **做法**（不改 `~/.dsh`，用 `--patch` 一次性覆盖层）
  ```yaml
  # lan.yml
  - id: webserver
    config:
      host: '0.0.0.0'                              # 绕过 startup.js 的 CLI 检查
      port: !!js ctx.webStartup.port ?? 3080        # 保留 --port 生效
      compression: gzip
      compressionLevel: 1
      compressionThresholdBytes: 1024
  ```
  ```sh
  dsh web --patch .\lan.yml --no-open
  ```
  或写进 `$DSH_PROFILE_DIR\cordis.patch.yml`（`C:\Users\WANGZ\.dsh\profiles\web\cordis.patch.yml`）永久生效。
  **必须重述整个 config**——id 定向 patch **不做深合并**（`$PKG\dsh-app-boot\README.md:205`："A user patch replaces the whole matched config — an id-targeted patch does not deep-merge, so a profile override restates the bundle fields it keeps."）。
  启动后 `web-app` 会自动采样 LAN IPv4、加入 `trustedHosts`、并打印 `dsh web: http://127.0.0.1:3080/?token=... (LAN: http://192.168.x.x:3080/?token=...)`（`dsh-web-app\lib\index.js:194-210`）。
- **工作量**：低（一个 YAML）。
- **风险**：**高**。明文 HTTP 直接暴露在 LAN 上；cookie 无 `Secure`；任何拿到/嗅到 token 或 cookie 的人 = 完全操作员权限（RCE）。**不推荐在不受信任的网络上使用**（公司 WiFi、宿舍、咖啡馆）。仅在完全可信的隔离网络 + 强烈的物理/网络访问控制下可接受。
- **触及的配置**：新增 `lan.yml` 或改 `~/.dsh/profiles/web/cordis.patch.yml`（**本次调查未做，仅为方案**）。
- **替代变体**：把 `host: '0.0.0.0'` 与方案 2 的代理**分开端口**并存——`0.0.0.0` 仅绑到一个只被代理访问的接口上是做不到的（schema 只允许两个字面量），所以这个变体不成立。

### 方案 4 ★★☆☆☆　自写 Cordis 插件：在 `webServer` 上加真正的认证/加固层

- **做法**：写一个 out-of-tree 插件（`dsh plugin --profile web add <pkg>` 装进 `$DSH_PROFILE_DIR`），在 `apply(ctx)` 里：
  - 用 `ctx.inject(["webServer"], ...)` 抢 `registerFallback`（会与 `frontend-static` **冲突**——只有一个 fallback 席位，`dsh-host-webserver\lib\index.js:206-212` 明确 throw "fallback already registered"），所以更实际的是：在 `ctx.on("webserver/index-inject")` 注入一个登录前脚本，或用 `ctx.connection.rpc.intercept("/api", ...)`（`registerInterceptor`，`dsh-client-connection\lib\index.js:658-671`）**在共享 `/api` 通道上插一层自己的授权检查**——注意 `intercept` 只在**没有 exact route 命中**时被调用（`lib\index.js:614-623`），而 `/api/file`、`/api/session/uploadFileBinary` 都是 exact route，所以拦截器覆盖不到它们；要给全部端点加门，需要在 `connection/request` waterfall 上挂监听（`lib\index.js:840`，`ctx.waterfall("connection/request", req, res, next)`；README `dsh-client-connection\README.md:47`）——这是**唯一一个覆盖所有已认证 API 请求的钩子**。
  - 也可以顺带 terminate TLS（`node:https`）——但现有 webserver 没有这个能力，需要自己建第二个服务器并反代到 `ctx.webServer.port`，等于在插件里做方案 2 的事。
- **工作量**：高（要懂 Cordis 生命周期、waterfall、Disposable、invariant）。
- **风险**：中（自己写的门禁可能被绕过；`connection/request` 只在**认证之后**触发，所以它解决不了"未认证的静态资源与 `/plugins/events`"）。
- **触及的代码**：新增第三方插件包；`$DSH_PROFILE_DIR\package.json` 的 bundle 列表。

### 方案排序总表

| 方案 | 工作量 | 风险 | 是否需要 patch/代码 | 传输加密 | 手机可用 |
|---|---|---|---|---|---|
| 1 SSH/VPN + loopback | 低 | 低 | 否 | ✅ | 需装 VPN 客户端 |
| 2 反代 + TLS + loopback | 中 | 中 | 否 | ✅ | ✅（需信任 CA） |
| 3 patch → `0.0.0.0` | 低 | **高** | 是（仅 YAML） | ❌ | ✅ |
| 4 自写认证插件 | 高 | 中 | 是（新包） | 需自己实现 | ✅ |

**推荐组合**：方案 1（笔记本 + 手机用 Tailscale）或方案 2（Caddy + 内网域名 + 自签 CA），**永远保持 `host=127.0.0.1`**。方案 3 只应作为临时/隔离网络下的应急手段。

---

## 10. 未验证 / 风险

以下内容**没有实测**（本次为只读调查，未启动服务器、未改 `~/.dsh`、未安装代理），属于推断或待验证项：

1. **patch 覆盖 `webserver.config.host` 是否真的能生效** —— 未实测。依据是 `dsh-app-boot\README.md:61,205`（"replace one entry's whole config"、"an id-targeted patch does not deep-merge"）与 `dsh-host-webserver\lib\index.js:142` 的 schema；但 patch 的 id/name 匹配细节（是否允许只给 `id`、`name` 不匹配时是否算 "entry does not exist" 而只打印警告）**未逐行验证**。建议先用 `dsh web --patch .\lan.yml --dump-config`（**不启动服务器**）确认 `webserver` 行真的变成 `host: '0.0.0.0'` 再做别的。
2. **`--host <具体 LAN IP>` 的行为** —— 依据是 schema 的 `z.union([z.const, z.const])`，推断会启动失败；未实测（且实测会真的尝试绑定，所以刻意没做）。
3. **反代下 `SameSite=Strict` 是否影响任何流程** —— 同源访问不受影响；但如果用户从聊天软件点开 `https://dsh.lan/?token=...`，Chrome 的 "Strict" 语义在**顶级导航**下仍会带上已存在的 cookie（导航不受 SameSite=Strict 限制），所以重复兑换 token 时应能正常；**未实测**任意浏览器组合。
4. **`document.baseURI` → WS URL 在子路径场景下的行为** —— 已确认 token 兑换硬要求 pathname `/`（`dsh-client-connection\lib\index.js:394`），所以子路径挂载**肯定不可用**；但"挂在根 + 反代在 `/`"的完整链路（含 `wss` 升级、`<base href="./">`、SSE）**未做端到端实测**。
5. **未认证端点的实际可达性** —— `/plugins/events`（`dsh-client-hmr`）和 `/plugins/<id>/client.js`（`dsh-client-modules`）的 handler 里**没有** `admit`/`requestRejection` 调用（已逐行读过）；但它们在**默认 loopback 绑定**下从 LAN 不可达，只有在方案 3 或方案 2 之后才成为真实暴露面。未实测。
6. **`/api/file` 的沙箱边界** —— 是否被 `ctx.fs` 的沙箱策略限制取决于 composition。本会话文件策略是 `danger-full-access`，所以本会话下无限制。**web profile 默认的 fs/sandbox 配置未核验**（`dsh-fs-sandbox`、`dsh-sandbox-policy` 未逐一展开）。README 明确写 "File reads and watches may target paths outside the workspace"，所以即使有沙箱，工作区外读取在多数配置下也是允许的。
7. **HMR 相关行为** —— `dsh-hmr` 会 watch profile manifest 与两个用户 patch 文件（`dsh-app-boot\README.md:63`）。也就是说 **patch 文件的改动可能在不重启的情况下被应用**（`dsh-web-app` 的 web profile "uses live reload"）。这对方案 3 是双刃剑：改 patch 可能立即生效，也可能触发一次完整重载并**短暂重启监听**。未实测 web profile 的 HMR 是否开启（`$DSH_PROFILE_DIR\cordis.yml` 是空 `[]`，未见 `dsh-hmr` 行，但 bundle 层可能有）。
8. **移动端浏览器差异** —— 剪贴板 fallback、manifest 的 `display: fullscreen` 在 iOS Safari 上是否需要额外的 `apple-mobile-web-app-capable` meta（**没有**）以获得全屏，未实测。
9. **`README.md` 中引用的决策记录**（`.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md`、`2026-08-24-browser-token-authentication.md`）以及 `docs/user/guide/network-proxy.md`、`docs/config-catalog.md` **均未随 npm 包发布**，无法引用其原始设计意图；本文所有结论均来自已发布的 `lib/*.js`、`.d.ts` 与 README 本身。
10. **`dsh-authorization` / `dsh-credentials` 的其余能力**（OAuth 流程、凭据记录的完整 schema）只读了 Summary 与部分正文，未穷尽；但可以确定**它们不参与 HTTP/WS 客户端的身份认证**。

---

## 附：关键源码位置速查

| 关注点 | 位置 |
|---|---|
| `dsh web` 标志定义 + `0.0.0.0` 拒绝 | `$PKG\dsh-web-app\lib\startup.js:21-49` |
| LAN 信任采样 + LAN URL 打印 | `$PKG\dsh-web-app\lib\index.js:41-89,194-210` |
| webserver config schema + listen | `$PKG\dsh-host-webserver\lib\index.js:141-147,295-305` |
| Host/Origin 围栏 | `$PKG\dsh-client-connection\lib\index.js:110-219` |
| token / cookie / HMAC | `$PKG\dsh-client-connection\lib\index.js:221-460` |
| `/api` prefix 路由 + admit | `$PKG\dsh-client-connection\lib\index.js:812-848` |
| WS upgrade + admit | `$PKG\dsh-api-gateway\lib\index.js:12,626-643` |
| WS URL 拼接（客户端） | `$PKG\dsh-api-gateway\lib\client.js:728-733` |
| 任意文件读 `/api/file` | `$PKG\dsh-api-session-controller\lib\index.js:2334-2401` |
| 静态资源公开 + index 需认证 | `$PKG\dsh-host-frontend-static\lib\index.js:13,59-62,87-96` |
| 无认证的 HMR SSE | `$PKG\dsh-client-hmr\lib\index.js:5,140-152` |
| 启动器 `--patch` | `$PKG\dsh\lib\bin.js:104`；`$PKG\dsh-app-boot\README.md:41-46,61,205` |
| 移动端安全上下文注释 | `$PKG\dsh-util-crypto\lib\index.js:4-16` |
| 语音输入的 secure-context 依赖 | `$PKG\dsh-experimental-client-ui-voice-input\lib\client.js:4673-4675` |
| 布局断点 | `$PKG\dsh-client-ui-layout\lib\client.js:13,15,38-44,236-243` |
