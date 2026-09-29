# 02 · 把 DSH 嵌入桌面宠物应用的可行路径与 SDK 协议面

> 调查性质：**只读**。未启动任何服务器、未修改 `~/.dsh`、未修改 `research/` 之外的任何文件。
> 唯一执行的命令是 `dsh --help`（launcher 自身的 help 分支，不 boot profile）与只读的 `node -e` / `Get-Content` / `Get-CimInstance`。
> **没有**运行 `dsh web --help`：该路径会经 `prepareProfile()` 重写 `$DSH_HOME/profiles/web/cordis.yml`，违反"不写 `~/.dsh`"约束。

---

## 0. 路径与版本约定

安装根（下文用 `$PKG\<包名>\...` 表示）：

```
C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\
```

运行时事实：

| 变量 | 值 |
|---|---|
| `DSH_HOME` | `C:\Users\WANGZ\.dsh` |
| `DSH_PROFILE` | `web` |
| `DSH_PROFILE_DIR` | `C:\Users\WANGZ\.dsh\profiles\web` |
| 运行中的 GUI | `http://127.0.0.1:3080`（PID 127888，`node ...\dsh\lib\bin.js web`） |

### 0.1 ⚠️ 版本事实与任务简报不一致（重要）

任务简报写的是 `0.1.7-rc.2`。**磁盘上当前的包全部是 `0.2.0-rc.2`**，已用两条独立路径确认：

```
$ node -e "console.log(require('.../@deepseek-ai/dsh/package.json').version)"
0.2.0-rc.2
$ node -e "console.log(require('.../@deepseek-ai/dsh-sdk-protocol/package.json').version)"
0.2.0-rc.2
```

但 npx 的 lock 仍然钉在旧版本：

| 文件 | 内容 | mtime |
|---|---|---|
| `...\_npx\1e7f6d9597241db0\package.json` | `"@deepseek-ai/dsh": "^0.1.7-rc.2"` | 2026-09-28 13:45 |
| `...\_npx\1e7f6d9597241db0\package-lock.json` | `"version": "0.1.7-rc.2"`，integrity `sha512-SQFhriLv…` | 2026-09-28 13:45 |
| `...\node_modules\@deepseek-ai\dsh\package.json` | `"version": "0.2.0-rc.2"` | **2026-09-29 11:31:59** |
| 运行中进程 PID 127888 | `CreationDate = 2026-09-28 13:45:02` | — |

结论：
1. **正在跑的 GUI 是 0.1.7-rc.2 的内存镜像**（Node 在启动时已加载模块，之后磁盘被覆盖不影响它）。
2. **任何新启动的 dsh / 新建的嵌入方会加载 0.2.0-rc.2**。本报告的全部代码引用均取自当前磁盘（即 0.2.0-rc.2），并已对关键结论二次复核。
3. 兄弟文档 `research/03-web-lan-access.md` 基于 0.1.7-rc.2，与今后新启动的行为可能不一致。

---

## 1. SDK profile 的精确协议面

### 1.1 传输：**只有 stdio，没有网络传输**

`$PKG\dsh-sdk-protocol\lib\types\transport.d.ts:48-102` 定义了唯一的传输类：

```ts
export declare class JsonRpcLineTransport implements JsonRpcTransportPeer {
    constructor(input: Readable, output: Writable);
```

`$PKG\dsh-sdk-protocol\README.md:32`：

> Wire one JSON-RPC 2.0 message per `\n`-terminated line over byte streams you own. A frame with both `id` and `method` is a request, `id` alone is a response, and `method` alone is a notification; malformed lines are ignored.

`$PKG\dsh-sdk-jsonrpc-server\lib\index.js:260-268` 把传输接到 `process.stdin`/`process.stdout`；`input`/`output`/`exit` **仅是测试注入钩子**，README:40 明确说是 "runtime-only transport hooks for tests"。

`$PKG\dsh-sdk-jsonrpc-server\README.md:44`：**"Stdout is the protocol"** —— 部署方不得在插件树里挂 stdout logger。

→ **SDK 侧不存在 WebSocket/HTTP 选项。** 想用网络就得自己写中间层。

### 1.2 方法与通知全表（`HarnessSdkRequestMap` / `HarnessSdkNotificationMap`）

来源：`$PKG\dsh-sdk-protocol\lib\types\types.d.ts:96-117`，与 `$PKG\dsh-sdk-jsonrpc-server\lib\index.js:196-202`（`handleRequest` 的 `switch`）逐条对应。

**client → server（仅 3 个，全部是 request）**

| method | params | result |
|---|---|---|
| `initialize` | `InitializeParams` | `InitializeResult` |
| `session/prompt` | `SessionPromptParams` | `SessionPromptResult` |
| `shutdown` | 无 | `{}`（随后 dispose root 并 `process.exit(0)`） |

`InitializeParams`（types.d.ts:14-25）：`cwd: string`、`provider: string`、`model: string`、`reasoningEffort?: ReasoningEffortId`、`maxTokens?: number`。

`InitializeResult`（types.d.ts:27-33）：`{ serverInfo: { name: string; version: string } }`，`name` 硬编码为 `deepseek-harness-sdk-runtime`，`version` 硬编码为 `"0.0.1"`（`lib/index.js:133-136`）。

`SessionPromptParams`（types.d.ts:35-40）：`{ sessionId: string; contentBlocks: SdkPromptContentBlock[] }`。
`SessionPromptResult`（types.d.ts:52-55）：`{ messageId: string }`。

`SdkPromptContentBlock`（types.d.ts:42-50）= `ContentBlock | SdkEncodedImageBlock`，其中

```ts
export interface SdkEncodedImageBlock {
    type: 'image';
    data: string;             // base64
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}
```

**server → client（仅 4 个，全部是 notification）**

| method | payload |
|---|---|
| `session.event` | `{ sessionId: string; event: SessionEvent }` |
| `session.status` | `{ sessionId: string; status: 'idle' \| 'running' }` |
| `subagent.started` | `{ parentSessionId: string; childSessionId: string }` |
| `subagent.finished` | `{ provider, agentId, parentSessionId, childSessionId, status: 'ok'\|'error', stopReason, lastAssistantMessage? }` |

`lib/index.js:68-103` 显示这四个通知只订阅了四个 Cordis 事件：`session/event`、`agent/status`、`session/created`、`subagent/end`。

### 1.3 会话启动、发消息、恢复

- **启动会话**：没有 `session/create`。`session/prompt` 里给一个未知 `sessionId` 会**懒创建** agent+session（`lib/index.js:203-231` `getOrCreateSession` → `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model, reasoningEffort?, maxTokens? } })`）。
- **发用户消息**：`session/prompt` → `rec.handle.agent.followup(message)`（`lib/index.js:153`），即队列一个普通后续 turn。返回 `messageId`。
- **恢复持久化会话**：**没有显式 API**。只能靠"`sessionId` 已在持久化层存在"这一事实——`agents.create()` 用同名 id 会走恢复路径（`SessionStartSource` 里的 `'resume'`，见 `$PKG\dsh-agent\lib\types\runtime-types.d.ts:105`），但 SDK 层没有把它暴露成一个可断言的契约。**这是未验证项。**

### 1.4 能力缺口（决定性的）

`$PKG\dsh-sdk-protocol\README.md:113-115`：

> - **No protocol-version negotiation** — the handshake carries only `serverInfo.version` (`0.0.1`, unvalidated by clients)
> - **No cancel or session-close methods** — a client abandons a turn by closing the runtime process
> - **Server→client requests are a dead capability** — the transport supports them, but the server never sends one; the Python SDK's responder surface exists for future approval flows.

`$PKG\dsh-sdk-jsonrpc-server\README.md:125-126`：

> - **The wire has no per-session close or prompt-cancel method** — SDK-created agents remain live until process shutdown.
> - **There is no per-prompt result** — `MessageId` identifies inbox admission only

**推论（对桌面宠物的硬约束）：**

| 需求 | SDK 能否做到 |
|---|---|
| 取消/停止当前 turn | ❌ 只能 kill 进程 |
| 关闭单个会话 | ❌ 只能 shutdown 全部 |
| 回答审批提示（approval） | ❌ 协议里没有 server→client request 在跑，也没有应答方法 |
| 回答 `ask_user` 用户问题 | ❌ 同上 |
| 实时 reasoning（thinking）增量 | ❌ 见 §7 |
| 实时 assistant 文本增量 | ❌ 见 §7 |
| 恢复历史会话 | ⚠️ 隐式，无契约 |
| 平台订阅事件 | ✅ `session.event` / `session.status` |

> 另外 `dsh-sdk-client`（TypeScript 客户端）**不在** npx 安装里——它只是 `$PKG\dsh\package.json` 的 `devDependencies`（`"@deepseek-ai/dsh-sdk-client": "0.2.0-rc.2"`），未被安装。所以要用 SDK 路径得自己按 `.d.ts` 实现客户端。

---

## 2. 能不能走网络套接字？有没有鉴权？

**答案：SDK 不能；web host 可以，而且那正是官方 Desktop 走的通道。**

### 2.1 WebSocket：`/api/remote.mux`

`$PKG\dsh-api-gateway\lib\types\stream-protocol.d.ts:3-8`：

```ts
/** Exact WebSocket route carrying every Typert Remote stream. */
export declare const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
/** Gateway-internal logical stream carrying application-selected Cordis events. */
export declare const REMOTE_EVENT_STREAM_ENDPOINT = "$events";
```

服务端用 `ws`：`$PKG\dsh-api-gateway\lib\index.js:8` `import WebSocket, { WebSocketServer } from "ws";`，`:179` `new WebSocketServer({ noServer: true })`。

**升级请求同样过 trust fence + 认证**（`lib/index.js:632-643`）：

```js
path: REMOTE_STREAM_MUX_PATH,
const admission = webCtx.connection.admit(req);
if (...) rejectRemoteStreamUpgrade(socket, admission.rejection);
mux.handleUpgrade(req, socket, head, admission.peer);
...
yield webCtx.webServer.registerUpgrade(route);
```

**这条通道被官方明确指定给原生桌面客户端**——`$PKG\dsh-api-gateway\README.md:105`（全文最后一行）：

> The `./stream-protocol` export supplies the shared Remote stream framing and parser to **native Desktop callers**. These callers use **the same authenticated WebSocket endpoint** as the browser client.

物理帧格式（`stream-protocol.d.ts:125-160`，解析器 `parseRemoteStreamClientMessage` / `parseRemoteStreamServerMessage`）：

```
client → host : {type:'open', streamId, endpoint, payload}
                {type:'item', streamId, value?}
                {type:'end',  streamId}
                {type:'cancel', streamId}
host → client : {type:'item', streamId, value?}
                {type:'error', streamId, error:{code,message,details}}
                {type:'end',  streamId}
```

心跳：Host 每 `websocketHeartbeatIntervalMs`（默认 2000ms）发 Ping，不答 Pong 即被终止（`README.md:35, 89`）。

### 2.2 HTTP `/api` bridge（一元调用）

一元 RPC 走 `POST /api`，由 `dsh-client-connection` 的 Fetch 桥接分发（`$PKG\dsh-client-connection\README.md:32`）：

> `API Gateway owns the `/api/remote.mux` WebSocket and its logical streams` … "The browser uses HTTP POST for Remote unary calls."

### 2.3 鉴权机制：一次性 URL token → 权威绑定的签名 Cookie

来源：`$PKG\dsh-client-connection\lib\index.js:226-232, 348-451`。

```js
const TOKEN_QUERY = "token";
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION = 1;
function cookieName(authority) {
    return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
function sessionCookie(name, value, expiresAt, maxAgeSeconds) {
    return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${...}; HttpOnly; SameSite=Strict`;
}
```

流程（`authorizeIndex`，`lib/index.js:388-427`）：

1. 进程启动时随机生成一个 launch token（`processLaunchToken()`，`:244-251`，32 随机字节 base64url，存在 `WeakMap` 里，随进程生命周期）。
2. `dsh web` 打印/打开 `http://127.0.0.1:3080/?token=<launchToken>`（`$PKG\dsh-client-connection\README.md:39`：「`dsh-web-app` prints and opens its application URL with `?token=...`」）。
3. 服务端**只在 `GET /` 且恰好一个 `token` 参数**时接受它，然后 `303 → ./` 并 `Set-Cookie`。

```js
if (req.method === "GET" && url.pathname === "/" && tokens.length === 1 && authority !== void 0
    && tokenMatches(tokens.join(""), this.launchToken)) {
    ... res.writeHead(303, { "cache-control":"no-store", "location":"./", "set-cookie": sessionCookie(...) });
```

4. Cookie 载荷 `{version, authority, issuedAt, expiresAt}`，用 **HMAC-SHA256** 签名，密钥是 owner-scoped 凭据记录 `client-connection/browser-session`，持久化在 `$DSH_HOME/.credentials.yaml`（`README.md:41`：「The local provider persists it in `$DSH_HOME/.credentials.yaml`」）。
5. 校验时要求 `payload.authority === authority`（`:440`），即 **cookie 绑定 hostname:port，换端口即失效**。
6. 失败响应（`:444-450`）：`401` + `dsh web authentication required; reopen the URL printed by dsh web.`
7. 默认有效期 30 天（`cookieMaxAgeDays`）。`README.md:41` 明确指出：cookie 是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`，**故意不带 `Secure`**。

`$PKG\dsh-client-connection\README.md:39` 还有一条硬约束：

> The HTTP carrier accepts **no query token outside the root exchange** and **no Authorization-header token**.

→ 对原生客户端而言：**没有 Bearer token 机制**。唯一拿到凭据的办法是先用 `Host: 127.0.0.1:3080` 请求 `GET /?token=<launchToken>` 并从 `Set-Cookie` 里取 cookie，之后所有 `/api` 请求与 WebSocket 升级都带这个 `Cookie`。

### 2.4 Host / Origin trust fence（403 边界）

`$PKG\dsh-client-connection\lib\index.js:205-219`（完整实现）：

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
    try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
```

`:121-125` 的 loopback 判定：

```js
function isLoopbackHostname(hostname) {
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const parts = hostname.split(".");
    return parts.length === 4 && parts[0] === "127" && parts.every(...);
}
```

拒绝顺序（`:585-594`）：fence 失败 → **403**；fence 通过但未认证 → **401**。

**对桌面宠物的三条直接结论：**

| 客户端形态 | Host | Origin | 结果 |
|---|---|---|---|
| Electron BrowserWindow 载入 `http://127.0.0.1:3080/` | `127.0.0.1:3080` | `http://127.0.0.1:3080` | ✅ 通过（Origin == Host） |
| 原生 WS/HTTP 客户端（无 Origin） | `127.0.0.1:3080` | 无 | ✅ 通过（`origin === undefined → true`），但仍需 Cookie |
| `file://` 页面发 fetch | `127.0.0.1:3080` | `null` | ❌ `new URL("null")` 抛错 → 403 |
| 自定义 scheme（`app://…`）发 fetch | `127.0.0.1:3080` | `app://…` | ❌ host 不等 → 403 |
| LAN 客户端 `http://192.168.x.x:3080` | `192.168.x.x:3080` | 同 | ⚠️ 需 `--trusted-host` / `trustedHosts` |

`$PKG\dsh-client-connection\README.md:43` 原文：

> `Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries… An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused.` … "A failed Host/Origin check returns 403, while a trusted but unauthenticated request returns 401. `dsh web --host 0.0.0.0` remains unsupported.

### 2.5 「谁能监听网络」：host 只能是两个字面量

`$PKG\dsh-host-webserver\lib\index.js:142`：

```js
host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
```

`$PKG\dsh-host-webserver\README.md:39`：

> `host` accepts exactly two values: `127.0.0.1` (default posture, loopback only) and `0.0.0.0` (deliberate network exposure — **the server carries no TLS, authentication, or origin policy of its own**). `port` 0 requests an OS-assigned port.

`$PKG\dsh-web-app\README.md:158`（Known Limitations）：

> **Binding all network interfaces is not supported** — `--host 0.0.0.0` is rejected at startup for safety; use the default loopback host.

而 `$PKG\dsh-host-webserver\README.md:113`：

> **No server-wide TLS, authentication, or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy. Binding a non-loopback address still exposes unprotected routes and static assets to that network.

**实测有效配置**（`$PKG\dsh-web-app\cordis.patch.yml:169-175`）：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
```

→ 默认 `127.0.0.1:3080`，与正在运行的 GUI 一致。CLI 标志：`--host`、`--port`（`0` = OS 分配）、`--trusted-host`（可重复）、`--no-open`（`$PKG\dsh-web-app\lib\types\startup.d.ts:8-19`）。

### 2.6 平台暴露的 Remote 方法全表（这是"能做什么"的真实边界）

Typert Remote 端点名（wire 形态，来自各包 `lib/typert.remote-client.d.ts`）。与桌面宠物最相关的：

**会话（`@deepseek-ai/dsh-api-session-controller`）**

```
session/create      session/list        session/search      session/page
session/follow      session/prompt      session/cancel      session/updateQueue
session/fork        session/rename      session/selectModel session/modelCatalog
session/projections session/control     session/attachment  session/openWorkspacePath
session/canOpenWorkspacePath            session/workspacePathApplications
session/initializeDefaultModel
fileReferences/list                     skills/list
```

`session/follow` 的签名（`$PKG\dsh-api-session-controller\lib\typert.remote-client.d.ts:46`）：

```ts
'session/follow': (request: SessionFollowRequest, signal?: AbortSignal)
                    => RemoteStreamHandle<SessionFollowFrame, never>
```

**用户提问（`@deepseek-ai/dsh-user-questions`）**

```
userQuestions/answer      (agentId, callId, answer) => boolean
userQuestions/attachWait  (agentId, callId)         => stream { remainingMs: number }
```

**审批**：没有独立 Remote 方法。审批走 **Remote Event waterfall**（见 §2.7）。

**其他可用命名空间**：`workspace/*`、`workspaceFiles/*`、`terminal/*`、`settings/*`、`credentials/*`、`commands/*`、`goals/*`、`job/*`、`subagents/*`、`agentPresets/*`、`pluginManager/*`、`account/*`、`messageFeedback/*`、`fileUploads/upload`、`llm/*`、`permissionPresets/catalog`、`speech/*`（实验）、`schedule/*`、`dynamicCordisRunner/*`、`directoryPicker/*`、`officeToPdf/*`。

### 2.7 转发事件白名单（`ctx.remote.$on` 的合法 key 集合）

`$PKG\dsh-api-remotes\lib\types\remote-events.d.ts:12-93` —— 这是唯一的控制点：

```ts
export declare const API_REMOTE_FORWARDED_EVENTS: readonly [
  { event: "agent-preset/selected";              mode: "emit" },
  { event: "approval/request";                   mode: "waterfall" },   // ← 审批
  { event: "api-session/activity";               mode: "emit" },
  { event: "api-session/added";                  mode: "emit" },
  { event: "api-session/error";                  mode: "emit" },
  { event: "api-session/removed";                mode: "emit" },
  { event: "api-session/status";                 mode: "emit" },
  { event: "commands/change";                    mode: "emit" },
  { event: "deepseek-account/session-expired";   mode: "emit" },
  { event: "deepseek-account/model-sign-in-required"; mode: "emit" },
  { event: "credentials/record-updated";         mode: "emit" },
  { event: "credentials/reference-updated";      mode: "emit" },
  { event: "goal/activation-changed";            mode: "emit" },
  { event: "cordis/request-run";                 mode: "emit" },
  { event: "cordis/request-run-resolved";        mode: "emit" },
  { event: "cordis/dynamic-package";             mode: "emit" },
  { event: "cordis/dynamic-retract";             mode: "emit" },
  { event: "cordis/inspect-query";               mode: "emit" },
  { event: "cordis/inspect-query-resolved";      mode: "emit" },
  { event: "llm/adapters-updated";               mode: "emit" },
  { event: "permission-presets/catalog-changed"; mode: "emit" },
  { event: "plugin-manager/changed";             mode: "emit" },
  { event: "plugin-manager/install-log";         mode: "emit" },
  { event: "plugin-manager/install-state";       mode: "emit" },
  { event: "settings/document-updated";          mode: "emit" },
  { event: "schedule/changed";                   mode: "emit" },
  { event: "user-questions/request";             mode: "waterfall" }    // ← 用户提问
];
```

`waterfall` 类型是 **Agent-scoped 双向调用**：客户端 listener 可以 `return` 结果、`next()` 委派、或 reject；结果经 HTTP 一元通道回传（`$PKG\dsh-api-gateway\README.md:62`）。这正是桌面客户端**能够回答审批与用户提问**的机制。

`dsh-client-ui-approval\lib\client.js:355` 是官方实现的参照：

```js
ctx.remote.$on("approval/request", function(request, next) { ... })
```

**可靠性语义**（`$PKG\dsh-api-remotes\README.md:77`）：

> Only scoped waterfalls that are still pending are replayed after reconnection; ordinary one-way notifications remain isolated best-effort deliveries and are not replayed.

→ `approval/request` 与 `user-questions/request` 会在重连后重放（好消息）；`api-session/*` 之类一次性 `emit` **不会**重放。

---

## 3. `@deepseek-ai/dsh/profile-boot`：能否进程内嵌入？

### 3.1 导出面

`$PKG\dsh\package.json` 的 `exports`：

```json
"./profile-boot": { "types": "./lib/types/profile-boot.d.ts", "default": "./lib/profile-boot.js" }
```

（`Dsh` 是 **ESM-only**，`"type": "module"`。）

`$PKG\dsh\lib\types\profile-boot.d.ts` 全部导出：

| 导出 | 签名 |
|---|---|
| `runProfile` | `(options: RunProfileOptions) => Promise<{ ctx: Context; shutdown: ProcessShutdown }>` |
| `prepareProfile` | `(name, userLayer?, fromDefaultProfile?) => Profile` |
| `initializeProfileFromDefault` | `(name, fromDefaultProfile, home?) => void` |
| `homePatchPath` | `() => string` |
| `INSTALL_ANCHOR` | `const INSTALL_ANCHOR: string` |
| `PROFILE_ROOT_FILENAME` | `const = "cordis.yml"` |

`RunProfileOptions`（`.d.ts:62-78`）：

```ts
export interface RunProfileOptions {
    environment: LaunchEnvironmentSnapshot;   // dsh-launch-environment
    profile: string;
    resolvedProfile?: ResolvedProfileRuntime | undefined;  // { profile: Profile; installAnchor: string }
    fromDefaultProfile?: string | undefined;
    patchFiles: readonly string[];
    args: readonly string[];
    packageManager?: ProfileContext['packageManager'];
}
```

另有 `ResolvedProfileRuntime`（`.d.ts:56-61`）：

```ts
export interface ResolvedProfileRuntime {
    /** Profile already loaded from the application's own directory. */
    profile: Profile;
    /** Absolute package.json path of the application's dsh installation. */
    installAnchor: string;
}
```

### 3.2 `runProfile` 的真实行为（含副作用）

`$PKG\dsh\lib\profile-boot-BZ2ZjNWi.js:224-296`：

```js
async function runProfile(options) {
    const disposeProxy = await installProxyFromEnvironment(options.environment, msg => process.stderr.write(...));
    ...
    process.on("SIGTERM", () => { interrupt(0); });
    process.on("SIGINT",  () => { interrupt(130); });
    installFailLoud(NAME, process, async () => { await app.current?.fiber.dispose(); });
    ...
    const ctx = await boot(NAME, rootConfig, readProfilePatches(...), async (hostCtx) => {
        app.current = hostCtx;
        hostCtx.provide("profileContext", profileContext);
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment);
        await hostCtx.plugin(PluginPackages, { resolution: composed.resolution });
        provideCmdline(hostCtx, { args: options.args, exit: code => void shutdown.shutdown(code), ready: appReady.service });
    });
    app.current = ctx;
    if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) appReady.commit();
    return { ctx, shutdown };
}
```

**可以嵌入（Electron main 里 `await import('@deepseek-ai/dsh/profile-boot')` 后调用），但要知道这些副作用：**

| 副作用 | 代码位置 | 对 Electron 的影响 |
|---|---|---|
| 安装全局 `SIGTERM`/`SIGINT` 处理器 | `:249-254` | Windows 上 Ctrl+C 会 `process.exit(0/130)` 杀掉 Electron main |
| `installFailLoud(process, …)` | `:255-257` | 接管 `unhandledRejection`/`uncaughtException` |
| `installProxyFromEnvironment` | `:225-227` | 改全局代理设置 |
| **写盘**：`writeFileSync(join(profile.dir, "cordis.yml"), PROFILE_ROOT_CONFIG)` | `prepareProfile:189` / `composeProfile:207` | 每次 boot 重写 profile 目录下的 `cordis.yml`（**会写 `~/.dsh`**） |
| `process.cwd()` 被用作 `cwd` | `:266` | Electron main 的 cwd 可能不是用户期望的工作区 |
| `shutdown.shutdown(code)` 默认置 `process.exitCode`；`shutdown.interrupt(code)` 默认 `process.exit(code)` | `createProcessShutdown:21-25, 46-58` | `runProfile` **没有暴露** `forceExit`/`complete` 覆盖点，无法改成"只 dispose 不退进程"的 interrupt |
| `boot()` 里 Loader 需要真实 include root | `:258` | 必须有可写的 profile 目录 |

`shutdown.shutdown(code)` 路径（`forceAfterDispose = false`）只做 `process.exitCode = code`，**不会**立即退进程 —— 这是 Electron 里唯一安全的关闭方式。但 `SIGINT` 路径走 `interrupt()` → `process.exit`。

### 3.3 profile 从哪来（应用自有 profile 的官方做法）

`$PKG\dsh-app-boot\lib\types\profile.d.ts` 的 `loadProfileDirectory`：

> Load an already initialized profile directory **without resolving it through the shared Harness home**. This is used by **application-owned profiles whose package project and lifecycle belong to that application.**
> `@param installAnchor` - absolute path of the owning dsh app's package.json.

签名：`loadProfileDirectory(binName, dir, installAnchor, options?: { userLayer?: boolean }): Profile`

配合 `$PKG\dsh-app-boot\README.md:50`：

> Application-owned npm projects, such as **Electron's reserved Desktop profile**, use `loadProfileDirectory` to load an already initialized directory without exposing it through CLI profile lookup.

`$PKG\dsh-app-boot\lib\index.js` 里 `PROFILE_TEMPLATES` 只有 5 项 —— **`desktop` 不在其中**：

```js
acp:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
web:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
headless:     { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
sdk:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
"sdk-minimal":{ bundles: ["@deepseek-ai/dsh-sdk-minimal"] }
```

→ Desktop 的 profile 目录由 Electron 应用**自己创建并持有**，不走 `$DSH_HOME/profiles`。

### 3.4 官方 Desktop 的集成契约（文档级证据）

`$PKG\dsh\README.md:60`：

> The `@deepseek-ai/dsh/profile-boot` export provides the **shared profile lifecycle to the Desktop host**. A resolved application profile supplies its own installation anchor for runtime package resolution while retaining the Harness home patch, proxy environment, telemetry switch, patch reload, and bounded shutdown.

`$PKG\dsh\README.md:62`：

> Packaged installations call the same `runCli()` entry with its package-manager executable. **The Desktop carrier also enables plugin operations for its initialized profile**; npm launches omit these options.

---

## 4. 保留的 `desktop` profile：到底是什么

### 4.1 CLI 的拒绝逻辑

`$PKG\dsh\lib\bin.js:35-37`：

```js
function rejectElectronProfile(program, profile) {
    if (profile.toLowerCase() === "desktop")
        program.error("error: profile \"desktop\" is managed exclusively by the Electron application");
}
```

调用点三处（`lib/bin.js:112`、`:119`、`:123`）：

```js
rejectElectronProfile(program, profile);                        // :112  boot（含 --dump-config）
if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile);  // :119  plugin 管理
profile: options.profile.toLowerCase() === "desktop" ? "desktop" : options.profile,  // :123  归一化
```

`runCli(options = {})` 接受 `{ manageDesktopProfile }`（`lib/bin.js:207-210`）：

```js
async function runCli(options = {}) {
    const version = getDshRuntimeVersion();
    const { manageDesktopProfile, ...profileOptions } = options;
    const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile);
```

`$PKG\dsh\README.md:20`：

> The `desktop` name is reserved for the Electron-owned profile, so the CLI rejects boot and config-dump requests for it. The npm CLI also rejects its plugin-management requests; the **Desktop-installed command** can manage the initialized Desktop profile using that installation's runtime.

### 4.2 `DSH_PROFILE=desktop` 是不是由外部 Electron 进程设置？

**证据不足以下定论，但可以确定它会被读到。** 唯一直接读取 profile 名的地方是：

`$PKG\dsh-base\cordis.patch.yml:115`

```yaml
desktopPlatform: !!js "ctx.get('profileContext')?.name === 'desktop' && ['darwin', 'win32'].includes(process.platform) ? process.platform : null"
```

而 `profileContext.name` 由 `runProfile` 写入（`profile-boot-BZ2ZjNWi.js:259-270`）：`{ name: options.profile, ... }`。

→ 所以 **"是不是 desktop profile"完全由调用方传给 `runProfile({ profile })` 的值决定**，而不是由环境变量 `DSH_PROFILE` 决定。`DSH_PROFILE` 是给 agent shell 里跑的**子**命令看的（`$PKG\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md:34`：「`DSH_PROFILE` (profile name) and `DSH_PROFILE_DIR` … are set in every shell call of a profile-launched Harness」）。**没有任何证据表明 Electron 必须设置 `DSH_PROFILE=desktop`。**

### 4.3 有没有已发布的官方桌面应用？

**没有随 npx 安装发布。** 证据：

- `@deepseek-ai` 下 **没有** `dsh-desktop` / `dsh-electron` / desktop 相关包（`Get-ChildItem` 全量列举，共 300+ 包，无此名）。
- `dsh\README.md` 引用的 `../desktop/README.md` 是**仓库相对路径**，包内不存在（`files` 只发布 `lib/*.js` + `lib/types/*.d.ts`）。
- `$PKG\node_modules\.bin` 只有 `dsh`、`dsh.cmd`、`dsh.ps1` 等，无桌面可执行文件。

**但官方 Desktop 的痕迹遍布代码库**（说明它作为独立的、非 npm 发布的 artifact 存在）：

| 证据 | 位置 |
|---|---|
| `DesktopUpdateIndicator.d.ts`、`desktop-update-source.d.ts`、`DesktopOnboardingEntry.d.ts` | `$PKG\dsh-client-ui-settings-general\lib\types\client\` |
| `ShortcutRuntime = 'desktop' \| 'web'`，Desktop 用 `userData/keybindings.json` | `$PKG\dsh-client-shortcuts\lib\types\binding.d.ts:8`，`README.md:34` |
| `window.dshDesktop?.keyboard`（Electron preload 全局） | `$PKG\dsh-client-shortcuts\lib\client.js:1859-1860` |
| `if (!("dshDesktop" in globalThis)) return;` | `$PKG\dsh-client-product-analytics\lib\client.js:20` |
| `ElectronWebViewImpl` / `ElectronWebviewPresentation` / `DesktopBrowserBridge` | `$PKG\.dsh-client-ui-sidebar-browser-rtro8Xdx\lib\types\client\electron\` |
| Windows Electron 专属布局标记 `data-windows-titlebar` | `$PKG\dsh-client-ui-layout\README.md:39` |
| Desktop 用 `connection/request` waterfall 在安装期间锁新 API 工作 | `$PKG\dsh-client-connection\README.md:47` |
| "Electron loads dist over `file://` and carries fetch over an IPC bridge" | `$PKG\dsh-host-webserver\README.md:12` |
| "The renderer and Electron subscribe to the Host policy through the existing authenticated stream" | `$PKG\dsh-client-product-analytics\README.md:26` |
| Desktop composition = `bundle/web-app`（即 `dsh-web-app`） | `$PKG\dsh-client-product-analytics\README.md:30` 与 `$PKG\dsh-web-app\README.md:10-12`（"Desktop analytics follows the product collection policy… Web usage is excluded"） |
| `startSignIn(..., loginSource: 'web' \| 'desktop')` | `$PKG\dsh-api-account-controller\lib\types\index.d.ts:49` |
| `dsh-client-hmr`："Web transport only — Electron installation and backend restart handling do not use this SSE path" | `$PKG\dsh-client-hmr\README.md:118` |

**`dsh-win32-process` 与桌面应用无关**——它是 Windows ACL sandbox 与 subprocess Job runner 的底层 Koffi 绑定（`$PKG\dsh-win32-process\README.md` 全篇讲 `CreateProcessAsUserW` / Job Object / `STARTUPINFOW`）。

**`dsh-launch-environment`** 提供 `LaunchEnvironmentSnapshot`（`createLaunchEnvironmentSnapshot`, `launchEnvironmentOf`, `DSH_LAUNCH_ENVIRONMENT_KEY = "launchEnvironment"`, `launchedThroughSsh`），是 `runProfile({ environment })` 的必需入参。

**每个窗口是否连到共享 profile 进程？** 方向上是"一个 Host 进程 + 多个渲染端"，不是"多进程共享"。证据：

- `$PKG\dsh-api-gateway\README.md:35`：「Independently cancellable logical streams share that socket」。
- `$PKG\dsh-client-connection\README.md:12`：「A generation becomes visible when its source reports ready」+ `:54` 重连策略。
- `$PKG\dsh-api-gateway\README.md:37`：「When the launcher supplies `ctx.appReady`, Gateway registers the WebSocket upgrade route only after successful application startup. Earlier connection attempts remain carrier failures handled by Connection's retry policy, so **a restarting Host cannot accept streams while its controllers are still initializing**」——明确存在"Host 重启、客户端重连"的模型。
- `$PKG\dsh-client-hmr\README.md:118`：「Electron 的**安装**和**后端重启**流程不使用此 SSE 路径」——再次证实 Electron 端会经历 backend restart。

→ 结论：**官方 Desktop = Electron 外壳 + 一个 in-process 的 dsh Host（web-app 组合）+ 渲染端通过认证的 WebSocket/HTTP 连接该 Host**。渲染端用 `file://` 载入 dist，通过 preload IPC 提供 fetch/键盘/文件选择桥；WebSocket 用 `__DSH_TRANSPORT__.streamBaseUrl` 指向 Host origin（`$PKG\dsh-client-connection\README.md:28`）。

---

## 5. ACP：更简单的桌面集成路径吗？

### 5.1 启动与传输

`dsh --profile acp`（`$PKG\dsh\README.md:13`：「Serve automation clients over ACP stdio until disconnect.」）。

传输**只有 stdio**（`$PKG\dsh-acp\lib\index.js:9, 1319`）：

```js
import { PROTOCOL_VERSION, RequestError, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
...
const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
```

`config.stream` 只是测试注入点；`$PKG\dsh-acp-app\cordis.patch.yml` 全篇没有任何 host/port/WebSocket 行。`$PKG\dsh-acp\package.json` 的依赖里也没有 `ws`。

→ **dsh 的 ACP 侧不使用 `@agentclientprotocol/sdk` 的 `ws-stream` / `ws-server` / `server-sse` / `http-stream` 能力**，尽管该 SDK（1.4.0）本身支持这些。

### 5.2 协议面（`$PKG\dsh-acp\README.md:60-76`）

| call | 说明 |
|---|---|
| `initialize` | 返回 ACP v1 + `session/list`、`session/resume`、`session/close`、Streamable HTTP MCP |
| `authenticate` | **立即成功，不需要认证** |
| `session/new` | 持久化 agent + `cwd` + stdio/HTTP MCP |
| `session/list` | 最新优先分页 |
| `session/resume` | 恢复持久化非活跃会话；**不重放历史更新** |
| `session/close` | 静默取消 + drain + 释放该 Agent scope |
| `session/set_config_option` | 更新 `model` 或 `reasoning_effort` |
| `session/prompt` | 每会话一次一个 prompt |
| `session/cancel` / `$/cancel_request` | prompt 归属的取消路径 |
| `session/update` | 通知流 |
| `session/request_permission` | 一次性 allow/reject |

`initialize` 实际返回（`lib/index.js:1140-1167`）：

```js
agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, resume: {} }   // 注意：没有 load
},
authMethods: []
```

**明确不支持**（`README.md:76`）：

> Unsupported surfaces are omitted or rejected: **`session/load`**, deletion, fork, additional directories, SSE or ACP-transport MCP, **modes, commands, plans, terminals, client filesystem operations, and elicitation**.

→ `dsh-acp` **完全不支持 ACP 的 client-side 文件系统与终端能力**（`fs/read_text_file`、`fs/write_text_file`、`terminal/*`），因为 dsh 自己有工具。

### 5.3 审批映射

`$PKG\dsh-acp\lib\index.js:1116-1139`：

```js
ctx.on("approval/request", (request, next) => {
    const record = ownedRecord(request.agent);
    if (record === void 0 || request.callId === void 0) return next();
    const callId = request.callId;
    return record.drainUpdates().then(() => {
        const params = {
            sessionId: record.agent.session.id,
            toolCall: { toolCallId: callId },
            options: [
                { optionId: "allow-once",  name: "Allow once", kind: "allow_once" },
                { optionId: "reject-once", name: "Reject",     kind: "reject_once" }
            ]
        };
        return conn.request(methods.client.session.requestPermission, params);
    }).then(({ outcome }) => {
        if (outcome.outcome === "cancelled") return "cancelled";
        return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
    });
});
```

→ 审批**能**回答，但只有 allow-once / reject-once 两个选项；没有"总是允许"。

### 5.4 `sessionUpdate` 变体与 **thinking 的致命限制**

`$PKG\dsh-acp\lib\index.js:562-632` —— 全部由**已提交（committed）**的 durable session event 派生：

```js
async function assistantUpdates(ctx, session, event) {          // event: SessionEvent<'assistant/message'>
    for (const block of event.data.message.content) {
        if (block.type === "reasoning") {
            if (block.text.length > 0) updates.push({
                sessionUpdate: "agent_thought_chunk",
                messageId: event.data.message.id,
                content: { type: "text", text: block.text }      // ← 整块，一次性
            });
            continue;
        }
        const content = await assistantBlockToAcp(ctx, block);
        if (content !== void 0) updates.push({ sessionUpdate: "agent_message_chunk", ... });
    }
    const usage = usageUpdate(ctx, session, event);
    ...
}
```

触发点在 `onSessionEvent`（`:878-892`）：

```js
onSessionEvent(session, event) {
    if (event.type === "assistant/message") { ... for (const update of await assistantUpdates(...)) await this.notify({ sessionId, update }); }
    else if (event.type === "tool/call") { ... toolCallUpdate(event) ... }
    else if (event.type === "tool/result") { ... toolResultUpdate(...) ... }
}
```

枚举出的 `sessionUpdate` 值（`:567, 578, 594, 619, 632, 777`）：

```
agent_thought_chunk     agent_message_chunk     tool_call
tool_call_update        usage_update            config_option_update
```

设计声明（`README.md:92`）：

> **Standard semantic updates only.** The wire carries **committed** messages and thoughts, generic tool lifecycle, configuration, and context usage; **raw provider deltas, retry attempts, DSH presentation data, and unsupported content stay off the wire.**

`updates.d.ts:1` 的 JSDoc 同样写着：

> Standard ACP updates derived from **committed** DSH session events.

→ **ACP 没有实时 thinking 增量。** `agent_thought_chunk` 是在该 step 的模型流完全 settle、`assistant/message` 落盘之后，把整个 reasoning block 作为**一个** update 推出去。**这对"只显示 thinking 指示器"的需求是致命的**（宠物的意义就在于生成期间有反馈）。

### 5.5 ACP vs SDK 对比

| 维度 | SDK (`--profile sdk`) | ACP (`--profile acp`) |
|---|---|---|
| 传输 | stdio NDJSON-JSON-RPC | stdio NDJSON-JSON-RPC |
| 取消 turn | ❌ | ✅ `session/cancel` / `$/cancel_request` |
| 关闭会话 | ❌ | ✅ `session/close` |
| 列/恢复会话 | ❌（隐式） | ✅ `session/list`（无 `session/load`） |
| 审批 | ❌ | ✅ `session/request_permission`（仅 once） |
| 用户提问（`ask_user`） | ❌ | ❌（不在 ACP 标准面内） |
| 实时 thinking 增量 | ❌ | ❌ |
| 工具活动 | ✅ `tool/call`+`tool/result`（durable） | ✅ `tool_call` + `tool_call_update` |
| 认证 | 无 | 无（`authMethods: []`） |
| 模型/推理强度选择 | `initialize` 一次定死 | ✅ `session/set_config_option` |
| 客户端 SDK 可用性 | 需自实现（`dsh-sdk-client` 未发布） | ✅ `@agentclientprotocol/sdk` 1.4.0 已随 npx 安装 |
| 面向 | 自动化、无人值守 | 自动化、Zed 类编辑器集成 |

**结论：ACP 比 SDK 完整得多，但两者的 thinking 流式粒度是一样的（都是"死后剖检"）。** ACP 的 README 也明确劝退人类 UI：

> `Avoid it when a human needs DSH-specific presentation cards, plans, titles, todos, terminal views, or elicitation`（`$PKG\dsh-acp\README.md:32`）

---

## 6. 预编译产物 / 打包线索

| 检查项 | 结果 |
|---|---|
| `@deepseek-ai` 包列表 | 300+ 包，**无** `dsh-desktop` / Electron 包 |
| `node_modules\.bin` | `dsh`, `dsh.cmd`, `dsh.ps1`, `cordis`, `libreoffice-kit`, `pi-ai`, `semver`, `yaml`, `js-yaml`, `anthropic-ai-sdk`, `which-command`, `is-docker`, `is-inside-container` — **无可执行桌面程序** |
| Windows 安装包 / `.exe` | 未发现 |
| `dsh --help`（实测，exit 0） | 只有 `--profile` / `--from-default-profile` / `--patch` / `--dump-config` / `--dump-config-schema` / `--dump-default-config`，**无 desktop 相关入口**；`dsh plugin --profile desktop …` 会被 `rejectElectronProfile` 拒绝 |
| `dsh web --help` | **未执行**（会写 `~/.dsh`）；标志从 `$PKG\dsh-web-app\lib\types\startup.d.ts` 与 README 得出：`--host` / `--port` / `--trusted-host` / `--no-open` |
| Python runtime wheel | `$PKG\dsh\README.md:5` 提到「The Python runtime wheel packages this same command」，但**未安装** |

**唯一"官方桌面应用"的实事是：它以独立 artifact 形式存在（不在 npm 上），且 dsh 代码库为它预留了一整套契约**（reserved profile 名 + `manageDesktopProfile` flag + `profile-boot` 导出 + `loadProfileDirectory` + `stream-protocol` 原生客户端导出 + Electron preload 全局 `dshDesktop` + `file://` dist 加载模式）。

---

## 7. 流式粒度：thinking / text / tool calls 能否分离？

### 7.1 底层事实：DSH 内核**确实**有独立的 reasoning delta

`$PKG\dsh-llm\lib\types\types.d.ts:417-447`：

```ts
export type StreamChunk = {
    type: 'block-start'; index: number; blockType: ContentBlockType;
} | {
    type: 'text-delta';  index: number; text: string;
} | {
    type: 'reasoning-delta'; index: number; text: string;      // ← thinking 增量
} | {
    type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string;
} | {
    type: 'block-end'; index: number; block: ContentBlock;
} | {
    type: 'usage'; usage: TokenUsage;
} | {
    type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope;
};
```

内容块层面也有 fork（`types.d.ts:50-52`）：

```ts
/** Reasoning / thinking content, distinct from visible text. */
{ type: 'reasoning'; ... }
```

### 7.2 实时发布的 Cordis 事件：`agent/assistant-stream`

`$PKG\dsh-agent\lib\types\runtime-types.d.ts:106-137`：

```ts
export type AssistantStreamFrame = {
    readonly type: 'start';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly turn: number;
    readonly step: number;
} | {
    readonly type: 'chunk';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;      // dense zero-based
    readonly time: number;
    readonly chunk: StreamChunk; // ← 就是上面的判别联合
} | {
    readonly type: 'end';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;
    readonly outcome: { kind: 'committed'; eventType: 'assistant/message'|'assistant/attempt'; seq: SessionSeq }
                    | { kind: 'abandoned' };
};
```

绑定（`runtime-types.d.ts:357-369`）：

```ts
/**
 * Process-local assistant-stream publication. Chunk frames are transient;
 * the loop appends one final v2 `assistant/message` or `assistant/attempt`
 * with the same stream before a committed end frame.
 * @mode emit
 */
'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void;
```

发射点：`$PKG\dsh-agent-loop\lib\index.js:1068` `this.dispatch.emit("agent/assistant-stream", { frame });`

**所以"只需 thinking 指示器"完全可行**：过滤 `frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta'` 即可；`text-delta` / `tool-call-delta` 独立可辨。

### 7.3 三条通道各自能看到什么

| 通道 | live `reasoning-delta` | live `text-delta` | live `tool-call-delta` | 归档 reasoning |
|---|---|---|---|---|
| **进程内**（`ctx.on('agent/assistant-stream')`） | ✅ | ✅ | ✅ | ✅ `assistant/message.data.stream` |
| **web/API 传输**（`session/follow` + `assistantStream:true`） | ✅ | ✅ | ✅ | ✅ |
| **SDK stdio**（`session.event`） | ❌ | ❌ | ❌ | ✅ 仅 settle 后 |
| **ACP stdio**（`session/update`） | ❌ | ❌ | ❌ | ✅ 仅 settle 后 |

### 7.4 web/API 通道的精确形状（**推荐路径的关键**）

服务端订阅（`$PKG\dsh-api-session-controller\lib\index.js:1388` 与 `:1481`）：

```js
ctx.on("agent/assistant-stream", ({ agent, frame }) => { ... });
...
const disposeAssistantStream = request.assistantStream !== true ? void 0
    : this.ctx.on("agent/assistant-stream", ({ agent, frame }) => { ... type: "assistant-stream", frame ... });
```

wire 帧（`$PKG\dsh-api-session-controller\lib\types\types.d.ts:481-527`）：

```ts
/** Browser wire form of one process-local assistant frame. */
export type SessionAssistantStreamFrame = {
    readonly type: 'start';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly startedAfterSeq: SessionSeqCursor;
    readonly turn: number;
    readonly step: number;
} | {
    readonly type: 'chunk';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;
    readonly time: number;
    readonly chunk: JsonValue;        // ← StreamChunk 的 JSON 化
} | {
    readonly type: 'end';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;
    readonly outcome: { kind:'committed'; eventType:'assistant/message'|'assistant/attempt'; seq:number }
                    | { kind:'abandoned' };
};

/** Complete opening window followed by ordered durable events and opted-in assistant frames. */
export type SessionFollowFrame =
    { readonly type: 'snapshot'; readonly header: SessionWireHeader; readonly cursor: number;
      readonly records: readonly SessionHistoryRecord[]; readonly hasMore: boolean;
      readonly projections: SessionProjectionBaseline;
      readonly assistantStream?: SessionAssistantStreamBaseline }
  | SessionEventEntry
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame };
```

**必须显式 opt-in**（`types.d.ts:458-463`）：

```ts
export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
    readonly address: SessionAddress;
    /** Include process-local assistant presentation frames for the Web client. */
    readonly assistantStream?: true;
}
```

重连基线（`types.d.ts:464-479`）：

```ts
export interface SessionAssistantStreamAttempt {
    readonly attemptId: LlmAttemptId;
    readonly startedAfterSeq: SessionSeqCursor;
    readonly turn: number; readonly step: number;
    readonly nextIndex: number;
    readonly stream: readonly JsonValue[];   // 已累积的 compact stream
}
export interface SessionAssistantStreamBaseline {
    readonly revision: number;
    readonly activeAttempt?: SessionAssistantStreamAttempt;
    ...
}
```

→ 断线重连时，`snapshot.assistantStream` 会带回当前进行中的 attempt 及其已累积的 compact stream，`nextIndex` 告诉你下一个 chunk 的序号。**原生的重连语义是完整的。**

### 7.5 归档/续接用的 compact 记录（用于冷读与 resume）

`$PKG\dsh-llm\lib\types\assistant-stream.d.ts:16-40`：

```ts
export type AssistantStreamRecord = {
    readonly type: 'text-chunks';      readonly time0: number; readonly index: number;
    readonly dt: readonly number[];    readonly texts: readonly string[];
} | {
    readonly type: 'reasoning-chunks'; readonly time0: number; readonly index: number;
    readonly dt: readonly number[];    readonly texts: readonly string[];
} | {
    readonly type: 'tool-call-chunks'; readonly time0: number; readonly index: number;
    readonly dt: readonly number[];    readonly id: ToolCallId;
    readonly name?: string;            readonly args: readonly string[];
} | {
    readonly type: 'chunk';            readonly time: number; readonly chunk: StreamChunk;
};
```

即：**durable 的 `assistant/message` 事件内嵌完整流**，`reasoning-chunks` 与 `text-chunks` 分开存储，且 `dt` 保留了原始 delta 的时间间隔。所以事后也能重建"思考了多久"。

### 7.6 会话级 durable 事件名（用于 UI 状态）

`$PKG\dsh-session\lib\types\types.d.ts:255-433` 的 `SessionEventMap`：

```
turn/start   turn/end   step/start   step/end
user/message developer/message system/message
assistant/message   assistant/attempt
tool/call    tool/result
request/header  request/context  session/end-seed
```

插件还会 merge 扩展：`$PKG\dsh-session\lib\index.js:82-84` 与 `known-event-types.js:24-26` 列出 `approval/asked`、`approval/decided`、`approval/policy`。

`turn/end` 的 `reason` 是 merge-extensible 的（`types.d.ts:165-208`）：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked`。

---

## 8. 前端复用：Electron 直接载入 `http://127.0.0.1:<port>`？

### 8.1 技术上可以，但要注意三件事

**① 没有 CSP / X-Frame-Options / CORS 头**（全包 grep 结论）

```
Content-Security-Policy  → 只有 3 处，且都不在主 shell：
   $PKG\dsh-api-session-controller\lib\index.js:2342   media references: "sandbox; default-src 'none'"
   $PKG\dsh-deepseek-account-platform\lib\index.js:1115  account 页面: "default-src 'none'; script-src 'nonce-…'; frame-ancestors 'none'"
   $PKG\dsh-client-ui-sidebar-documentpreview\lib\client.js:3845  （客户端 iframe 内注入）
X-Frame-Options          → 0 处
Access-Control-Allow-*   → 0 处
Cross-Origin-*           → 0 处（除上面 3 处 CSP 里的 frame-ancestors）
```

`$PKG\dsh-host-webserver\lib\index.js` 只有一个裸 `node:http` 路由注册表：全文只有 `res.writeHead(404)`、`res.writeHead(400)` 两处写头（`:240`、`:254`）。`$PKG\dsh-host-frontend-static\lib\index.js` 只写 `403` / `404` / `200 {content-type}` / `405`（`:52, 69, 73, 89`）。

→ **无 CSP 阻断、无 frame-ancestors 阻断、不需要 CORS（同源）**。这对桌面宠物是**好消息**：转译/注入自定义 UI 不会被 CSP 挡。

**② 认证：必须做一次 token→cookie 交换**

必须让 Electron 的 session 持有 cookie。做法：

- 方案 A：`dsh web --no-open` 启动后从 stdout 抓 `dsh web: http://127.0.0.1:3080/?token=<t>` 这一行，然后 `win.loadURL(thatUrl)` → 服务端 303 + `Set-Cookie` → 之后 `win.loadURL('http://127.0.0.1:3080/')` 就带 cookie 了。
- 方案 B：不用浏览器窗口，在 Electron main 里用 `net.request({ url: 'http://127.0.0.1:3080/?token=<t>', headers: { Host: '127.0.0.1:3080' } })` 拿 `Set-Cookie`，再把这个 Cookie 手动塞进 WebSocket 与后续 `/api` 请求的 header（这就是 "native Desktop caller" 的形态，`$PKG\dsh-api-gateway\README.md:105`）。

**cookie 是 `HttpOnly; SameSite=Strict`** → 渲染端 JS 读不到它，但**不需要**读：同源 fetch/WebSocket 会自动带上。若要在渲染端手搓 WebSocket，也由 Chromium 自动带 cookie。**只有非浏览器客户端（Node main 进程）才需要手动提取并转发 cookie。**

**③ cookie 绑定 hostname:port**

`cookieName(authority)` 与 `payload.authority` 都吃 `host:port`。默认 3080 固定 → 稳定。**但如果 3080 被占用而回退到别的端口，旧 cookie 立即失效**（需重做 token 交换）。`--port 0`（OS 分配）会让每次启动的 authority 都变，必须每次走 token 交换。建议显式钉死端口。

### 8.2 官方 Desktop 走的是另一条路（值得知道）

`$PKG\dsh-host-webserver\README.md:12`：

> It serves browsers only; **Electron loads dist over `file://` and carries fetch over an IPC bridge.**

`$PKG\dsh-client-connection\README.md:28`：

> A **static desktop page** can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while HTTP transport remains independently selected. **The desktop carrier owns authentication; setting the origin alone grants no access.**

客户端实现（`$PKG\dsh-client-connection\lib\client.js:1483-1491`）：

```js
function apply(ctx) {
    const globals = globalThis;
    const pageLocation = typeof location === "undefined" ? void 0 : location;
    const transport = globals.__DSH_TRANSPORT__;
    installConnection(ctx, {
        ...transport === void 0 ? {} : { transport },
        recovery: resolveConnectionConfig(globals.__DSH_CONNECTION_RECOVERY__),
        ...pageLocation === void 0 ? {} : { location: pageLocation }
    });
}
```

`ClientTransportHooks`（`$PKG\dsh-client-connection\lib\types\client\index.d.ts:43-71`）：

```ts
export interface ClientTransportHooks {
    rpc?: ClientConnectionRpc;   // 已解码的逻辑载体：替换 HTTP 调用者（进程内 Host）
    fetch?: RpcFetch;            // 一元 RPC 通道
    openStream?: RpcStreamOpen;  // worker-local Gateway 流载体
    loadBundle?(url: string): Promise<void>;
    ownsHost?: boolean;          // 声明本页面独占 Host
    streamBaseUrl?: string;      // Host 的 HTTP origin（WebSocket 用它）
}
```

`dsh-api-gateway` 使用它的位置（`$PKG\dsh-api-gateway\lib\client.js:730`）：

```js
const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI);
```

→ 一个 `file://` 页面提供 `window.__DSH_TRANSPORT__ = { fetch, openStream, streamBaseUrl: 'http://127.0.0.1:3080', ownsHost: true }`，就可以**完全绕开 Host/Origin fence**（因为请求由 IPC 桥发出，带什么 header 由你决定），这是官方 Desktop 的模型。**但这条路意味着你要自己实现 `fetch`/`openStream`/认证三个 hook，工作量远大于方案 (a1)。**

### 8.3 透明/置顶窗口本身的问题

Electron 的 `alwaysOnTop`、`transparent: true`、`frame: false`、`skipTaskbar`、`setIgnoreMouseEvents(true, { forward: true })` 都是标准能力，**与 dsh 无关，不存在服务端阻碍**。唯一需要注意的是：**透明窗口 + 载入远程页面**时，Chromium 的 `transparent` 需要 `backgroundColor: '#00000000'`，且远程页面的 `body` 背景需由注入 CSS 覆盖（dsh 前端有自己的主题背景）。

---

## 9. 四条集成路径对比

| 维度 | **(a) Electron webview over `dsh web`** | **(b) 进程内 `profile-boot` 嵌入** | **(c) SDK JSON-RPC 客户端** | **(d) ACP 客户端** |
|---|---|---|---|---|
| **进程模型** | 子进程 `dsh web` + BrowserWindow 载入其 URL | Electron main 里 in-process 挂载整个 Cordis 树 | 子进程 `dsh --profile sdk` + stdio | 子进程 `dsh --profile acp` + stdio |
| **传输** | HTTP `/api` + WS `/api/remote.mux` | 直接 `ctx.on(...)` | NDJSON JSON-RPC over stdio | NDJSON ACP over stdio |
| **实时 `reasoning-delta`** | ✅ `session/follow {assistantStream:true}` → `{type:'assistant-stream', frame:{chunk:{type:'reasoning-delta'}}}` | ✅ `ctx.on('agent/assistant-stream')` | ❌ 仅 settle 后整块 | ❌ 仅 settle 后整块 |
| **取消 turn** | ✅ `session/cancel` | ✅ `agent.cancel({kind:'user'})` | ❌ | ✅ `session/cancel` |
| **审批提示** | ✅ `$on('approval/request')` waterfall | ✅ `ctx.on('approval/request')` | ❌ | ✅ `session/request_permission`（仅 once） |
| **用户提问** | ✅ `$on('user-questions/request')` + `userQuestions/answer` | ✅ `ctx.userQuestions` | ❌ | ❌ |
| **恢复会话** | ✅ `session/list` + `session/follow`（含 `page` 分页） | ✅ 全量 Session API | ⚠️ 隐式、无契约 | ✅ `session/list` + `session/resume`（无 `load`） |
| **现成 UI** | ✅ 官方前端（可注入/覆写样式） | ✅ 同一前端（需自己起 webserver 或走 IPC） | ❌ 全部自建 | ❌ 全部自建 |
| **认证工作量** | 低（token→cookie 交换一次；同源自动带） | 无（进程内） | 无（stdio） | 无（`authMethods: []`） |
| **协议实现工作量** | 最低（几乎零） | 低（但要处理副作用） | 中（需自写 TS client，`dsh-sdk-client` 未发布） | 低（`@agentclientprotocol/sdk` 1.4.0 已就位） |
| **官方支持度** | ⚠️ 非官方用法（官方 Desktop 走 `file://` + IPC） | ✅ 官方 Desktop 正是这么做（`dsh/README.md:60`） | ✅ 官方 | ✅ 官方（但定位为"自动化"） |
| **打包体积/原生模块** | 最小（Electron 只当浏览器） | 最大（整个 dsh 树 + `node-pty`/`sharp`/`koffi`/… 进 Electron） | 中（子进程，但需带一份 dsh 安装） | 中（同上） |
| **已知阻碍** | 需抓 token；端口变更使 cookie 失效；`file://` 页面不能直连 `/api` | `runProfile` 装全局信号处理器 / `installFailLoud` / 改代理 / **写 `~/.dsh`**；`interrupt()` 会 `process.exit`；ESM-only；Loader 需可写 profile 目录 | 无取消、无审批、无实时 thinking | 无实时 thinking；无 `session/load`；无 plan/command/terminal；仅 allow-once |
| **证据** | §2.1–2.6, §7.4, §8 | §3.1–3.4 | §1 | §5 |
| **未知项** | 端口冲突回退时 token 交换的自动化稳健性；Electron 持久 session 分区策略 | `boot()` 在 Electron 打包环境下对 `require`/ESM 解析的兼容性；`node-pty` 等原生模块是否需要 rebuild | SDK 是否可在 `sessionId` 命中持久化会话时可靠恢复 | ACP 客户端对 `agent_thought_chunk` 的"整块到达"能否做打字机动画掩盖 |

---

## 10. 推荐路径

### 10.1 首选：**(a) Electron 载入 `dsh web` + 同源注入的自定义宠物 UI**

理由（按权重排序）：

1. **唯一同时满足"实时 thinking 增量"与"低实现成本"的路径。** §7.3 的表说明了：只有进程内事件与 web/API 传输有 `reasoning-delta`；而 web/API 传输已经有现成的服务端、认证、重连、基线补齐、审批与用户提问的 waterfall（§2.7、§7.4）。要"只显示 thinking 指示器"，只需在渲染端过滤 `frame.chunk.type === 'reasoning-delta'`——甚至不用自己解析，直接在载入的官方前端上注入一段脚本订阅即可。
2. **协议零实现。** `session/follow`、`session/prompt`、`session/cancel`、`approval/request`、`user-questions/request` 全部已经由官方前端在用；你复用它就等于复用了协议实现与重连逻辑。
3. **认证只需一次交换。** Host 是 `127.0.0.1:3080`，Origin 同源，Host/Origin fence（§2.4）自动通过。
4. **风险面最小。** 不碰 Electron 的原生模块打包地狱，不碰 `runProfile` 的全局副作用。

**建议的具体做法：**

- 主进程用 `child_process.spawn` 起 `dsh web --no-open --port <固定端口>`，从 stdout 解析 `dsh web:` 行拿 `?token=`。
- 创建一个**持久 partition** 的 `BrowserWindow`（`webPreferences.partition = 'persist:dsh-pet'`），先 `loadURL(tokenizedUrl)` 完成 303 + `Set-Cookie`，再 `loadURL('http://127.0.0.1:<port>/')`。
- 用 `webPreferences.preload` 注入宠物 UI 的桥，用 `insertCSS` / `executeJavaScript` 把主 UI 收起、只留 thinking 指示器（或直接用一个 query 参数让前端进入紧凑模式）。
- 窗口：`transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000'`，需要穿透时 `setIgnoreMouseEvents(true, { forward: true })`。
- 想更彻底地把宠物 UI 做成独立页面，就把它作为**同源资源**提供——两条路：① 由你自己的 `dsh` 插件在 `127.0.0.1:3080` 上注册一个 exact route（`ctx.webServer.register` + `ctx.connection.fetch.register`）返回宠物页；② 在你的 dsh profile 里加一条 `--patch` 覆盖 `host-frontend-static` 的 `distIndex`。**不要把宠物页做成 `file://` 或自定义 scheme**——那样 Origin 检查会 403（§2.4 表）。

### 10.2 次选：**(b) 进程内 profile-boot 嵌入**

只有当"必须单进程 / 不想额外起子进程 / 要做官方 Desktop 那种深度集成"时才选。这时照抄官方 Desktop 的配方：

```js
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';

const installAnchor = /* 你的 dsh 安装的 package.json 绝对路径 */;
const profile = loadProfileDirectory('my-desktop-app', myAppOwnedProfileDir, installAnchor);

const { ctx, shutdown } = await runProfile({
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]),
  profile: 'desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: [],
  packageManager: /* 你的包管理器运行时 */,
});
// 之后 ctx.agents / ctx.get('llm') / ctx.on('agent/assistant-stream') 全部可用
// 关闭：shutdown.shutdown(0)  ← 只置 process.exitCode，不会 process.exit
```

必须处理的副作用（§3.2）：`SIGINT`/`SIGTERM` handler、`installFailLoud`、代理安装、`process.cwd()`、以及 `prepareProfile` 每次 boot 对 profile 目录 `cordis.yml` 的写盘。

### 10.3 不推荐 SDK 路径（除非只做无人值守自动化）

`(c)` 缺 cancellation、缺 approval、缺 user questions、缺实时 delta，且 TypeScript 客户端没发布。做桌面宠物会立刻撞墙。

### 10.4 ACP 作为"第二条腿"是可选的

`(d)` 比 `(c)` 完整得多（有 cancel / list / resume / permission / model 选择，SDK 现成），而且 **`@agentclientprotocol/sdk` 1.4.0 已经躺在这个 npx 安装里**。但 **thinking 只在 step 结束后整块到达**，与"生成期间给反馈"的宠物诉求相冲突。可用于：无人值守任务、脚本化测试，或作为"深度工作模式"（此时宠物只需显示"忙碌"状态）。

---

## 11. 未验证 / 风险

### 11.1 未验证（本次只读调查无法确证）

| # | 项 | 为什么未验证 | 建议的验证方式 |
|---|---|---|---|
| U1 | 官方 Electron 桌面应用的**实际协议**（是否真的用 `file://` + IPC；`dshDesktop` preload 的确切 API 形状） | 该应用**不在 npx 安装里**；`../desktop/README.md` 未发布 | 找官方 Desktop 安装包，检查其 `app.asar` 的 preload |
| U2 | `DSH_PROFILE=desktop` 是否**必须**由外部 Electron 设置 | 全库没有任何代码读 `DSH_PROFILE` 来决定 composition；`desktopPlatform` 读的是 `profileContext.name`（由 `runProfile` 入参决定）。**推断为"不必"**，但没有官方文档明说 | 反编译官方 Desktop，或询问维护者 |
| U3 | SDK 的 `session/prompt` 传入**已持久化**的 `sessionId` 是否可靠地走恢复路径 | `ctx.agents.create()` 内部逻辑未逐行读；SDK 层无契约文档 | 用 `dsh --profile sdk` 起进程，先建会话，kill，再以同名 id prompt |
| U4 | `boot()`（`dsh-app-boot`）在 Electron 打包后的 ESM/`require` 解析行为 | 未在 Electron 环境实测；`createRuntimeResolution` 的细节未读完 | 最小 Electron 骨架里 `await import('@deepseek-ai/dsh/profile-boot')` 试跑 |
| U5 | `dsh web` 在 3080 被占用时是否会回退到别的端口 | `webserver` 配置是 `!!js ctx.webStartup.port ?? 3080`，`port: 0` 才由 OS 分配；EADDRINUSE 会把 listen 失败变成插件初始化拒绝（`$PKG\dsh-host-webserver\README.md:55`）。**推断为"不回退，直接启动失败"** | 占住 3080 再 `dsh web` |
| U6 | Electron 的 `transparent` 窗口 + 载入 dsh 前端时的实际渲染表现（背景、圆角、点击穿透） | 需要实际运行 GUI 才能看 | 起一个最小 Electron 原型 |
| U7 | 前端是否有"紧凑模式"或可复用的 thinking 指示器组件 | 未审阅 `dsh-web-frontend\dist` 与 `dsh-client-ui-chat` 的完整组件树 | 抓 `http://127.0.0.1:3080` 页面并搜索 DOM/CSS |
| U8 | ACP `session/resume` 与 `session/list` 是否覆盖"用户上次的会话" | README 说 "deterministic newest-first pages of persisted, resumable root sessions"，但未实测 | 用 `@agentclientprotocol/sdk` 写 20 行客户端实测 |
| U9 | 哪些 `session/*` Remote 端点在没有活跃 Agent 时会 cold-resume | `SessionController.prompt` 的 JSDoc 说 "Admit one prompt after explicitly resuming its Session"；resolver 行为未逐行读 | 读 `$PKG\dsh-api-session-controller\lib\index.js` 的 resolver 段 |

### 11.2 风险

| # | 风险 | 严重度 | 证据 / 缓解 |
|---|---|---|---|
| R1 | **版本漂移**：npx lock 钉 `0.1.7-rc.2`，磁盘已是 `0.2.0-rc.2`，正在跑的 GUI 是旧版内存镜像 | 中 | §0.1。缓解：嵌入方**显式依赖一个确定版本**（`package.json` 里钉死，或在 profile 里钉 bundle 版本），不要依赖 npx 的 `^` 范围 |
| R2 | **认证 token 只能从 stdout 抓**（没有 API、没有 Bearer） | 中 | §2.3。缓解：`--no-open` + 解析 stdout 的 `dsh web:` 行；或自己实现 `GET /?token=` 的 303 → `Set-Cookie` 交换（需要 launch token，仍来自 stdout） |
| R3 | **Cookie 绑定 host:port**：端口变了 cookie 全废 | 中 | §2.3 / `lib/index.js:440`。缓解：钉死端口；端口不可用时重新走 token 交换 |
| R4 | **`file://` / 自定义 scheme 页面不能直连 `/api`**（`Origin: null` → 403） | 高（若走错路会白做） | §2.4。缓解：宠物 UI 必须同源提供，或走官方 Desktop 的 IPC transport hook |
| R5 | **`SameSite=Strict` + `HttpOnly` + 无 `Secure`** | 低-中 | §2.3 / `$PKG\dsh-client-connection\README.md:41,75`。同源场景无碍；但**同一 Cookie 在明文网络上会泄露** —— 因此**绝不要把 Host 绑到 `0.0.0.0`** |
| R6 | **`dsh web` 的 `--host 0.0.0.0` 被 CLI 拒绝**（但 crdis 配置层允许 `0.0.0.0`） | 低 | `$PKG\dsh-web-app\README.md:158` vs `$PKG\dsh-host-webserver\lib\index.js:142`。走 CLI 就用不了 LAN；要有心绕过可以直接写 profile patch，但 webserver README 明确说那时静态资源无保护 |
| R7 | **`runProfile` 的全局副作用会污染 Electron 进程** | 高（选路径 b 时） | §3.2。`process.on('SIGTERM'/'SIGINT')`、`installFailLoud`、`installProxyFromEnvironment` 都不可关闭；`shutdown.interrupt()` 会 `process.exit`。缓解：只用 `shutdown.shutdown(code)`；在调用前先 `process.removeAllListeners('SIGINT')` 并在之后重装自己的 |
| R8 | **`runProfile` 会写 `~/.dsh`**（profile 目录的 `cordis.yml`） | 中 | `profile-boot-BZ2ZjNWi.js:189, 207`。如果宠物 app 要"不污染用户 home"，需要用 `resolvedProfile` + 应用自有目录（`loadProfileDirectory`），但 `runProfile` 仍会 `writeFileSync` 到那个目录 |
| R9 | **ESM-only + 原生模块**：`dsh` 是 `"type": "module"`；依赖树含 `node-pty`、`sharp`、`koffi`、`sherpa-onnx-node`、`libreoffice-kit` | 高（选路径 b 时） | 打包进 Electron 需要 asarUnpack + 可能的 rebuild；路径 a 完全规避 |
| R10 | **SDK stdout 纯净性是"部署强制"的** | 中（选路径 c 时） | `$PKG\dsh-sdk-jsonrpc-server\README.md:127`："a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers"。任何用户插件打一行 stdout 就毁掉整个通道 |
| R11 | **审批只有 allow-once / reject-once**（ACP），且 SDK 完全无法应答 | 中 | §1.4 / §5.3。宠物 UI 若需要"以后都允许"，必须走 web/API 路径的 approval waterfall，或改 `permission-presets` |
| R12 | **`websocketHeartbeatIntervalMs` 默认 2s**：Host 会在下一个 interval 前终止不应答 Pong 的 peer | 低 | `$PKG\dsh-api-gateway\README.md:89`。浏览器自动答 Pong；**手写原生 WebSocket 客户端必须自己处理 Ping/Pong**（`ws` 库默认自动答） |
| R13 | **`emit` 类转发事件重连后不重放** | 低-中 | `$PKG\dsh-api-remotes\README.md:77`。宠物 UI 不能只靠 `$on('api-session/status')` 维护状态；需要重连后主动 `session/list` 对账 |
| R14 | **`Sibling docs 03/04/05 基于 0.1.7-rc.2`** | 低 | §0.1。跨文档引用时要标注版本 |
| R15 | **`streamInboxBytes` 默认 262144**：uplink 溢出会 `gateway/uplink-overflow` 失败该流 | 低 | `$PKG\dsh-api-gateway\README.md:39`。宠物 UI 的上行很小，基本不会触发 |

---

## 12. 一页速查

**能拿到实时 thinking 增量的事件名（三个层面各一个）**

```
进程内 Cordis 事件 : 'agent/assistant-stream'  →  frame.chunk.type === 'reasoning-delta'
web/API 传输帧     : SessionFollowFrame { type: 'assistant-stream', frame }   （需 session/follow { assistantStream: true }）
归档 compact 记录  : AssistantStreamRecord { type: 'reasoning-chunks', texts[], dt[] }
```

**与 text / tool 的判别**

```
frame.chunk.type === 'reasoning-delta'   → thinking
frame.chunk.type === 'text-delta'        → assistant 可见文本
frame.chunk.type === 'tool-call-delta'   → 工具参数增量（id / name / argumentsDelta）
frame.chunk.type === 'block-start'|'block-end'|'usage'|'finish'  → 结构/计量/终止
```

**桌面宠物最小可行栈（推荐）**

```
Electron(main)
  └─ spawn: dsh web --no-open --port 3080
  └─ 解析 stdout: "dsh web: http://127.0.0.1:3080/?token=<t>"
  └─ BrowserWindow(partition:'persist:dsh-pet', transparent, frame:false, alwaysOnTop, skipTaskbar)
       ├─ loadURL(tokenizedUrl)      → 303 + Set-Cookie (HttpOnly, SameSite=Strict, 绑定 127.0.0.1:3080)
       ├─ loadURL('http://127.0.0.1:3080/')
       ├─ preload: 宠物 UI 桥 + 注入 CSS
       └─ 同源渲染端 -> ws://127.0.0.1:3080/api/remote.mux  (Cookie 自动携带)
            ├─ open logical stream: endpoint 'session/follow', payload { address, assistantStream: true }
            ├─ 过滤 { type:'assistant-stream', frame:{ type:'chunk', chunk:{ type:'reasoning-delta' } } }
            ├─ 发送: POST /api  'session/prompt'
            ├─ 停止: POST /api  'session/cancel'
            └─ 审批: $events logical stream 上的 waterfall 'approval/request'
```
