# 浏览器执行服务（dsh-browser）

> 2026-11-03 起，`ubuntu-gpu` 上多了一个 `dsh-browser` 容器：
> **人可见的 Chromium + noVNC 人工登录 + agent 经 CDP 执行**。
> 相关：[OUTLOOK-WITHOUT-API.md](OUTLOOK-WITHOUT-API.md)（为什么要做这条路）·
> [UBUNTU-DEPLOYMENT.md](UBUNTU-DEPLOYMENT.md)（宿主机拓扑）·
> [TELEGRAM-GATEWAY.md](TELEGRAM-GATEWAY.md)（"找人"的通知通道）

## 1. 它解决什么、不做什么

学校邮箱（Outlook 网页版）、Canvas 这些站点**没有可用的 API/OAuth**，
而且经常要 2FA。维护者的要求是：

> **"必要的环节我去介入登陆，剩下的让智能体自己缺什么申请什么。"**

于是这个服务的分工是：

| 谁 | 干什么 |
|---|---|
| **维护者（人）** | 在 noVNC 里登录、过 2FA、点验证码。**只有人能碰密码** |
| **dsh-browser** | 打开页面、读可见文本、点按钮/输入文本，**发现"需要人"就停下来** |
| **assistant / tg** | 收到 `needsUser` 后把 noVNC 链接推给维护者，`/resume` 后继续 |

**它不做的事**（都是刻意的）：

- ❌ 不主动接触密码、不碰 2FA、不存任何凭据 → 服务**没有**"输入密码"的专用接口，
  登录只能由人在 noVNC 里做
  - ⚠️ **`POST /eval` 之后这条要说得更准确**：agent 拿到页面 JS 执行权，
    *技术上*可以往任何输入框写值（包括 password 框）。剩下的边界其实只有一条：
    技能/政策的约束（见 §10）。有能力 ≠ 该用，别把这件事交给运气。
  - ⚠️ **"agent 不知道密码"这条防线已经不成立了**：2026-11-04 起仓库里有
    `packages/dsh-assistant/scripts/canvas-login.mjs`，它从
    `~/dsh-assistant/data/osu.json`（600，仓库外）读 OSU 账号密码并**填进 SSO 登录页**，
    只把 Duo/2FA 留给维护者。这跟维护者最初的要求（"绝不能碰密码，只在需要人时停下来"）
    是有张力的取舍，**需要维护者拍板**；dsh-browser 侧不评判，只如实记录：
    只要那台机器上有密码文件，agent 就有能力用它 —— 拦住它的是流程与纪律，不是权限。

- ❌ 不用无头浏览器。登录、过验证码都需要**看到屏幕**
- ❌ 不下载 Playwright 自带的 Chromium：人和 agent 必须看同一个浏览器
- ❌ 不把 API 发布到宿主机（只走 `dsh-net` 服务名 `dsh-browser:8789`）

## 2. 架构

```
┌─ docker: dsh-browser（容器内 8789）────────────────────────────────────┐
│                                                                        │
│  Chromium (headed)  ──CDP 127.0.0.1:9222──►  Node 服务 (:8789)  ◄──────┼── dsh-net
│      │ 持久 profile /profile                 playwright-core           │   dsh-assistant
│      │                                      connectOverCDP             │   经服务名访问
│      ▼                                                                 │
│  Xvfb :99  ──►  x11vnc 127.0.0.1:5900  ──►  websockify/noVNC :6080  ◄──┼── 宿主机 16080
│                   （只监听回环）              （对外唯一入口）           │   （维护者的浏览器）
└────────────────────────────────────────────────────────────────────────┘
```

几个关键决定和**理由**：

| 决定 | 为什么 |
|---|---|
| Chromium 用**发行版 deb**（Debian bookworm）而不是 Ubuntu 的 `chromium` | Ubuntu 24.04 的 chromium 是 snap 包装 deb，apt 里 Candidate 是 `(none)`，容器里装不上。Debian 有真包（实测 156.x） |
| 镜像基于 `node:22-bookworm-slim` | 与 dsh-assistant / dsh-tg 一致；且 Debian 的 chromium 是真 deb |
| `x11vnc` 只监听 `127.0.0.1:5900`，`websockify` 才是对外入口 | VNC 协议本身没有现代加密；只让本机 websockify 连它，外面只暴露一个 HTTP 端口 |
| profile 挂 `./profile` volume | 登录一次长期有效；容器重建不丢 cookie |
| 装 `fonts-noto-cjk` | 学校邮箱/2FA 页面有中文，缺字体时 noVNC 里是"豆腐块"，人没法确认点的是哪个按钮 |
| `--password-store=basic` | 否则 Chromium 会去找 gnome-keyring，弹出**没人能填**的对话框挡住整个屏幕 |
| entrypoint 强制 `HOME=/tmp/dsh-browser-home`，**不用** `${HOME:-…}` | docker 以 `user: 1001:1001` 跑镜像里不存在的 uid 时会把 `HOME` 设成 **`/`**（不是空！）。于是 Chromium 写 `/.config/…` 被拒 → crashpad 起不来 → 浏览器 SIGTRAP 崩溃，日志里只有一句 `chrome_crashpad_handler: --database is required`。这个坑实测排查了一轮，别再踩 |
| 每次启动 Chromium 前清 `SingletonLock/Socket/Cookie`，compose 固定 `hostname` | profile 锁里存的是 `hostname-pid`；容器重建后 hostname 变了，Chromium 会判成"另一台电脑正在用"而拒绝启动 |
| `/health` 免鉴权 | docker healthcheck 与上层探活要用；它只回"活没活/要不要人"，不回页面内容 |

## 3. 部署

### 3.1 一次性准备（已在本仓库完成，换机器时照做）

```bash
# 1) 源码（从 Windows 打包上传，或 git clone 后进 packages/dsh-browser）
mkdir -p ~/dsh-browser && cd ~/dsh-browser

# 2) 环境变量（.env 不入库）
cp .env.example .env
#    必填 VNC_PASSWORD（x11vnc 的 RFB 密码**最多 8 字符**，超出部分会被静默忽略）
#    NOVNC_BASIC_AUTH 留空即可 —— 实测它只拦 WS 握手，反而会让 noVNC 连不上（§4.1）
VNC_PW=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 8)
sed -i "s/^VNC_PASSWORD=.*/VNC_PASSWORD=$VNC_PW/" .env
chmod 600 .env && echo "VNC 密码：$VNC_PW"

# 3) profile 目录必须 taco(1001) 可写 —— 容器以 1001 运行
mkdir -p profile

# 4) 把启动页设成学校邮箱（可选但推荐）：容器一起来浏览器就停在登录页，
#    维护者打开 noVNC 直接输账号，/snapshot 也立刻给出 login_required
sed -i 's|^START_URL=.*|START_URL=https://outlook.office.com/mail/|' .env

# 5) 共享网络（已存在则跳过）
docker network create dsh-net

# 6) 构建 + 启动
docker compose up -d --build
docker compose logs -f
```

### 3.2 与 assistant / tg 共享的凭据

| 宿主机 | 容器内 | 用途 |
|---|---|---|
| `~/dsh-assistant/data/token.txt` | `/data/api-token.txt`（**只读**） | HTTP 鉴权头 `x-dsh-token`，三服务共用一份 |

容器以 `user: "1001:1001"` 运行（与 `dsh-tg` 一致），否则读不了 `chmod 600` 的 token。

## 4. noVNC：维护者怎么进去

### 4.1 绑定范围与三种访问方式

绑定地址由 `.env` 里的 **`VNC_BIND`** 控制（compose 里是 `${VNC_BIND:-0.0.0.0}:16080:6080`），
改完 `docker compose up -d` 生效：

| 方式 | `.env` 里的 `VNC_BIND` | 维护者打开 |
|---|---|---|
| **只绑局域网网卡（生产用）** | `192.168.3.30` | `http://192.168.3.30:16080/vnc.html?autoconnect=1&resize=scale` |
| 所有网卡（默认值） | `0.0.0.0` | 同上，但**连 WSL / VMware / docker 网桥也一起暴露** |
| Tailscale（更严） | `100.121.250.110` | `http://100.121.250.110:16080/vnc.html?autoconnect=1&resize=scale` |
| SSH 隧道（最严） | `127.0.0.1` | 先 `ssh -N -L 16080:127.0.0.1:16080 192.168.3.30`，再开 `http://127.0.0.1:16080/vnc.html` |

- **生产只绑局域网网卡**（`VNC_BIND=192.168.3.30`）。这台机器在 NAT 后面，没有公网端口映射，
  也**不要**给它加。`0.0.0.0` 是兜底默认值，代价是 docker/WSL/VMware 那些虚拟网卡也能进来
  （2026-11-04 维护者按此收紧并写进了 `.env.example`）。
- 改前请确认目标地址真的存在：Tailscale 退出登录后绑它的 IP，容器会**起不来**
  （`cannot assign requested address`）。
- **密码**：`VNC_PASSWORD`（x11vnc 的 RFB 密码，**≤8 字符**）—— noVNC 页面会提示输入。
  这就是主门槛：页面本身能打开，但**连不上 VNC**（实测：无凭据的 WS 握手返回 401）。
- **`NOVNC_BASIC_AUTH=用户名:密码` 默认不推荐开**。实测（2026-11-03）websockify 的
  `BasicHTTPAuth` **只校验 WebSocket 握手**，`/vnc.html` 静态页照常返回 200；而浏览器
  第一次访问这个站点时没有凭据缓存，握手不会带 `Authorization` → noVNC 直接
  `Failed to connect`。要它真正生效，得先让浏览器缓存该站点的 Basic 凭据（很别扭）。
  安全边界用 **VNC 密码 + 绑定范围** 就够，别为它绕路。
- `ufw` 目前是 **inactive**。若同网段不可信，建议
  `sudo ufw allow from 192.168.3.0/24 to any port 16080`（而不是直接信任 0.0.0.0）。

### 4.2 维护者的操作步骤（登录学校邮箱）

1. 打开 **`http://192.168.3.30:16080/vnc.html?autoconnect=1&resize=scale`**
   （`resize=scale` 让画面自适应浏览器窗口）
2. 先过 HTTP Basic（若配了），再输 **VNC 密码**
3. 看到容器里的 Chromium（整个桌面就它一个窗口）后，地址栏输入
   `https://outlook.office.com/mail/`，正常登录 + 过 2FA
4. 登录成功后**不用做别的**：cookie 已经写进 `./profile`，agent 下一次
   `/snapshot` 就能读到收件箱
5. 回到 Telegram / 对话里说一声"登好了"，上层会调 `POST /resume` 让 agent 继续

> **登录一次能撑多久**：取决于学校会话策略（通常几天到几周）。会话过期时
> `/snapshot` 会重新给出 `needsUser:true, reason:login_required`，
> 上层会再推一次 noVNC 链接 —— 不会静默失败。

### 4.3 让 agent 知道"去哪儿登录"

`PUBLIC_VNC_URL`（`.env` 里）会出现在：

- `GET /health` → `vncUrl`
- `POST /snapshot` → `vncUrl`
- `POST /askuser` 不传 `vncUrl` 时的默认值

上层（assistant → tg）把这条链接直接推给维护者即可，不用自己记地址。

## 5. HTTP API

容器内 `0.0.0.0:8789`，经 `dsh-net` 用服务名访问：`http://dsh-browser:8789`。
**不 publish 到宿主机**。

鉴权：除 `GET /health` 外，所有请求必须带 `x-dsh-token: <token.txt 的内容>`。
不匹配 → `401 {"ok":false,"error":"unauthorized"}`。

### 5.0 页面语义：只有一个受管页（**先读这个**）

> 2026-11-04 出过一次很严重的 bug：`/open` 与 `/snapshot` 落到了不同标签，
> Canvas 登录脚本读到的却是 Outlook 页面 → 误判"已登录"，Duo 都没触发。
> 根因是选页策略当时是"取 `context.pages()` 的**最后一个**"，
> 页面被关掉或服务重连时会静默换页。现在的语义是明确的：

1. **一个受管页**：`/open` 永远在同一个 page 上 `goto`，**不新开标签**；
   `/snapshot` `/act` `/eval` 都作用在同一页。
2. **所有响应都回 `url`**，调用方应校验它（`canvas-login.mjs` 就是这么做的）：
   `/open`（`url` 与 `finalUrl` 同值）、`/snapshot`、`/act`、`/eval`、`/health.page`。
3. **选页策略**（`src/page-select.js`，有单测）：
   - 优先用**带标记的页**：受管页的 `window.name` 会被写成 `dsh-browser-managed`，
     服务重连 / 容器重启后靠它找回同一页，而不是靠"第几个标签"
   - **刚连上**浏览器时，如果只有**一个**标签 → 采用它（那通常就是 entrypoint 用
     `START_URL` 开出来、维护者登录用的那一页，不必多开）
   - 其它情况（多标签、或受管页被关掉后只剩别人的标签）→ **新建**一个受管页，
     **绝不**劫持维护者的标签
4. **受管页被关掉 / 浏览器重启**：下一次调用会重新认页 —— 浏览器重启后按上一条"刚连上"处理；
   只是受管页被关（浏览器还在）则**直接新建**，不会顺手接管人仅剩的那个标签
   （这一点实测踩过：第一版实现会接管，已修）。**不会再静默读到别的标签**。
5. 已知限制：`/open` 导航时如果站点自己 `window.open` 出弹窗（某些 SSO），
   那个弹窗不是受管页，服务不会自动切过去；需要的话得显式 `/open`。

> 调用方的正确姿势：**永远看响应里的 `url`**，别假设"我刚 open 过，
> 所以 snapshot 一定是那个站"。域名校验是最后一道防线，不是多余。

### 5.1 `GET /health`（免鉴权）

```json
{
  "ok": true,
  "service": "dsh-browser",
  "browserUp": true,
  "browserError": null,
  "loggedInHints": {
    "lastReason": "login_required",
    "lastSnapshotAt": "2026-11-03T19:42:10.123Z",
    "passwordFieldPresent": true,
    "loginUrl": true,
    "mfaText": false,
    "captchaMarkers": false
  },
  "lastActionAt": "2026-11-03T19:42:10.123Z",
  "uptimeSec": 120,
  "pendingUser": { "id": 1, "reason": "login_required", "instructions": "…", "vncUrl": "…", "since": "…", "knownReason": true },
  "vncUrl": "http://192.168.3.30:16080/vnc.html?autoconnect=1&resize=scale",
  "page": { "url": "https://login.microsoftonline.com/…", "title": "Sign in to your account", "pageCount": 1 }
}
```

- `browserUp:false` **不代表服务挂了**：CDP 没连上（Chromium 正在重启）时它会是 false，
  上层应把 `/open`、`/snapshot` 当作**可重试**（它们会返回 503）。
- `loggedInHints` 只是线索，**不要用它判断要不要人** —— 判断看 `/snapshot` 的 `needsUser`。

### 5.2 `POST /open`

```json
{ "url": "https://outlook.office.com/mail/" }
→ { "ok": true, "navigationApplied": true, "title": "Mail - …",
    "finalUrl": "https://outlook.office.com/mail/inbox",
    "url": "https://outlook.office.com/mail/inbox", "timedOut": false, "httpStatus": 200 }

# 导航被 beforeunload 拦住（2026-11-04 现场）
→ HTTP 502
  { "ok": false, "navigationApplied": false, "code": "navigation_not_applied",
    "url": "https://osu.instructure.com/courses/…/quizzes/1503007/take",
    "error": "导航没有发生：页面仍停在 …（请求 https://example.com），可能被 beforeunload 拦截" }
```

- 在**受管页**上 `goto`（不新开标签，见 §5.0）；SSO 中转后 `url`/`finalUrl` 是**重定向后**的地址
- `url` 与 `finalUrl` 同值（后者是历史字段，保留兼容）
- 只接受 `http(s)` 绝对地址，其它 → 400
- 等 `domcontentloaded`（默认 30s，`OPEN_TIMEOUT_MS`）
- 非超时的网络错误（`ERR_NAME_NOT_RESOLVED` 等）→ 502

**`navigationApplied`：导航到底有没有发生**

判据：最终 URL 与导航前**不同** → 发生了（含 SSO 跨域跳转）；
或最终 URL 与请求 URL **同 host** → 发生了（重新加载同一页）。
否则 = 没发生。

- `navigationApplied:true` → HTTP 200（即使 `timedOut:true`：页面可能还在加载，但确实换页了）
- `navigationApplied:false` → **HTTP 502 + ok:false**，`url` 如实报告**还停在哪一页**
  （没有假装成功 —— 这就是之前 Canvas 登录被误判的根源）
- 上层**不要**只看 HTTP 200 就认为到了目标站：`url` 的 host 才是事实（`canvas-login.mjs` 已经这么做）

**弹框 / beforeunload**

服务在每个受管页上注册了 `page.on('dialog')`：

| 弹框类型 | 处理 | 为什么 |
|---|---|---|
| `beforeunload` | **accept**（离开） | 否则 Playwright 默认 dismiss = "留在本页"，`goto` 被取消却看起来像成功 |
| `alert` / `confirm` / `prompt` | dismiss | 与 Playwright 默认行为一致，**不替使用者确认**（避免自动确认"删除/提交"这类操作） |

日志记 `dialog_handled`（类型、动作、弹框文案前 160 字）。导航被取消时会额外记一条
`navigation_not_applied`，带请求/导航前/最终 URL 三者（去掉查询串，避免把 token 写进日志）。

### 5.3 `POST /snapshot`

```json
→ {
  "ok": true,
  "url": "https://login.microsoftonline.com/…",
  "title": "Sign in to your account",
  "text": "Sign in\nEnter your email, phone, or Skype…",
  "truncated": false,
  "chars": 4213,
  "needsUser": true,
  "reason": "login_required",
  "signals": ["login_url", "password_field"],
  "hints": { "passwordFieldPresent": true, "loginUrl": true, "mfaText": false, "captchaMarkers": false },
  "readyState": "complete",
  "httpStatus": 200,
  "at": "2026-11-03T19:42:10.123Z",
  "vncUrl": "http://192.168.3.30:16080/vnc.html?…"
}
```

- `text` 是**可见文本**（`document.body.innerText`），截断到 `SNAPSHOT_MAX_CHARS`（默认 48 000 字符），
  `truncated=true` 时说明还有更多；`chars` 是截断前长度
- 浏览器不可用 → **503**（可重试）；不要把 503 当成"页面没内容"

### 5.4 `POST /act`

```json
{ "action": "click",   "selector": "a[href*='inbox']" }
{ "action": "type",    "selector": "input[name='loginfmt']", "text": "…", "timeoutMs": 10000 }
{ "action": "waitFor", "selector": "#MailList", "timeoutMs": 20000 }
→ { "ok": true, "action": "click", "selector": "…", "url": "https://outlook.cloud.microsoft/mail/" }
```

- 响应里的 `url` 是**动作执行后**受管页的地址（点击可能触发跳转），调用方可据此校验
- `selector` 用 **Playwright 选择器语法**：CSS（`#id`、`a[href*=x]`）默认；
  也支持 `text=Sign in`、`role=button[name="Sign in"]`、`xpath=//…`
- `action=type` 时 `text` 必填（可为空字符串 = 清空）
- `waitFor` 等的是**可见**（`state: visible`）
- 超时 → 408；其它失败 → 500；参数不合法 → 400
- ⚠️ **选择器依赖真实页面**：本服务只提供机制，具体文本框/按钮的 selector
  必须对着真实 Outlook/Canvas 页面验一次（见 §9）

#### `type` 的输入顺序与降级（2026-11-05 改）

```
① click（聚焦）  ──成功──►  fill  ──失败──►  pressSequentially（逐字符）
      │                         │                        │
      失败（浮层遮挡/超时）       成功                     都失败
      ↓                         ↓                        ↓
   记 degraded，跳 ②          ok:true                  ok:false → HTTP 408/500
```

1. **先 click 聚焦**（保持原语义）；点不动就**不中断**，直接进入下一步
2. `fill`（不需要命中点，直接设值 + 派发 input 事件）
3. `fill` 也不支持（`contenteditable` / 自定义控件）→ `pressSequentially` 逐字符敲
   —— 这条**需要**真正的焦点，所以 click 不能永远跳过
4. 三步全失败才报错

为什么改：Microsoft 登录页在输入框上盖了 `#footerLinks` 浮层，`click()` 会被判
"subtree intercepts pointer events" 直到超时；旧实现"先 click 再 fill"于是**整条失败**，
而 `type` 是登录脚本唯一的输入通道。

**响应里的结构化标记**（只有 `type` 会有）：

| 字段 | 含义 |
|---|---|
| `inputMode` | `fill`（正常）或 `press`（退到逐字符） |
| `degraded` | `true` = 没抢到焦点，靠 fill/逐字符完成；上层可据此决定要不要复核页面 |
| `reason` | `click_failed`（点不动）或 `fill_failed`（fill 不支持） |

日志里只记 `selector` / `inputMode` / `reason` / 错误摘要，**绝不记录输入内容**
（那可能是密码）。单测里有一条专门断言这件事。

### 5.5 `POST /eval`（在页面里执行 JS）

Canvas 技能（`packages/dsh-assistant/skills/canvas-quiz/`）的每一步都靠它：
读题干结构、按 `input[name]` 分组批量勾选、提取 `media_attachments_iframe` 里的 mediaId、
两步提交。没有它就只剩 click/type/waitFor，逐题点会慢到不可用。

```json
{ "script": "(() => ({ title: document.title }))()", "timeoutMs": 10000 }
→ { "ok": true, "result": { "title": "Example Domain" }, "durationMs": 42, "url": "https://example.com/" }

{ "script": "throw new Error('x')" }
→ { "ok": false, "code": "script_error", "error": "x", "stack": "Error: x\n…", "durationMs": 3,
    "url": "https://example.com/" }
```

> 成功和失败都会回 `url`（受管页地址），调用方可以顺手校验"脚本跑在我以为的那一页"。

**执行模型**

- `script` 在**受管页的主帧上下文**里执行（`new Function` + 页面 `eval` 语义），
  所以能读到、改到该页面自己的 DOM / 变量 —— 这正是需要的
- 先按**表达式**构造（`return (script)`）：`document.title`、`(() => …)()`、
  `Array.from(document.querySelectorAll('input[name]')).length`
- 表达式语法不合法时自动退回**语句块**：`throw new Error('x')`、`const a = 1; a + 1`
  ⚠️ 只做"构造"不做"试跑"，同一段脚本**绝不会执行两遍**
- 返回 Promise 会 `await`；返回函数会自动调用一次（所以 `() => 1` 也能直接用）
- 结果用**页面里的** `JSON.stringify` 序列化；`undefined` → `result:null` + `undefinedResult:true`

**边界（都是硬上限，改不了就报错）**

| 项 | 默认 | 环境变量 | 超了会怎样 |
|---|---|---|---|
| 脚本大小 | 200 KB | `EVAL_SCRIPT_MAX_BYTES` | 400 `script 过长`（带 `scriptBytes`） |
| 执行超时 | 10 s | `EVAL_TIMEOUT_MS` | 200 + `ok:false, code:"timeout"` |
| 超时上限 | 30 s | `EVAL_MAX_TIMEOUT_MS` | 传入更大的 `timeoutMs` 会被夹到上限 |
| 结果大小 | 64 KB（序列化后） | `EVAL_RESULT_MAX_BYTES` | 200 + `truncated:true`，`result` 是**JSON 前缀字符串**（不可再解析） |

**状态码约定（和 `/act` 不同，别混）**

| 情况 | HTTP | 身体 |
|---|---|---|
| 成功 | 200 | `{ok:true, result, durationMs, url}` |
| 脚本抛错 / 语法错 | **200** | `{ok:false, code:"script_error", error, stack?, url}` |
| 结果不可序列化（循环引用/BigInt/Symbol） | **200** | `{ok:false, code:"not_serializable", error, url}` |
| 超时 | **200** | `{ok:false, code:"timeout", error, url}` |
| 请求不合法（缺 script/太长/timeoutMs 非法） | 400 | `{ok:false, code:"bad_request", error}` |
| 浏览器不可用 | 503 | `{ok:false, code:"browser_unavailable"}` |

> 为什么脚本报错是 200：上层要能区分「页面里的脚本挂了（改脚本重试）」和
> 「服务挂了（等会儿重试）」。用 500 会把两者混在一起。

**安全边界（当前策略：可用优先，不做内容审查）**

- JS 只能碰到**这个页面自己**的东西；拿不到 Node 进程、读不了服务端文件
- 刻意**没有**做"脚本里出现 `fetch(` / `localStorage` 就拒绝"这类过滤 ——
  先保证技能能跑，策略以后再收紧（见任务记录）
- 日志只记 `scriptBytes` / `durationMs` / `ok` / `code`，**不打印脚本内容**
  （脚本可能很长、可能含个人信息）
- ⚠️ 页面内的**同步死循环**无法被中断：页面里的定时器不会触发，只能靠 Node 侧硬超时
  放弃等待，此时页面已不可用 —— 需要 `/open` 重新加载。异步挂起（`await` 不返回）
  则会按 `timeoutMs` 正常超时，页面不受影响
- ⚠️ 只在**主帧**执行。跨域 iframe（比如 Canvas 的 `media_attachments_iframe` 内部）
  读不到；需要 iframe 内执行的话得另加能力（本期没做）

### 5.6 `POST /askuser` 与 `POST /resume`

```json
POST /askuser { "reason": "login_required", "instructions": "请在 noVNC 里登录学校邮箱", "vncUrl": "http://…" }
→ { "ok": true, "pending": { "id": 1, "reason": "login_required", "instructions": "…", "vncUrl": "…", "since": "2026-11-03T19:42:10.123Z", "knownReason": true } }

POST /resume {}
→ { "ok": true, "cleared": true }
```

- `reason` 建议直接用枚举值；非枚举也接受（`knownReason:false`），便于记"策略拒绝"这类情况
- 上限：`reason` 200 / `instructions` 2000 / `vncUrl` 500 字符（超长截断或 400）
- `<pending>` 只存内存：容器重启后为空，但 `/snapshot` 随时能重新给出 `needsUser`
  ——**不要**把它当持久队列

### 5.7 典型调用序列（assistant 侧）

```
open(收件箱 URL)
  └─ snapshot → needsUser:true, reason:login_required
       ├─ askuser(reason, instructions, vncUrl)      # 记录
       ├─ （经 dsh-tg 推送 Telegram）                  # Lead/tg-agent 的地盘
       └─ 等维护者说"好了" → resume → snapshot 重试

Canvas 作业页（已登录，不需要人）
  └─ open(作业页) → eval(读题干/媒体列表) → snapshot 校对
       → act(click 提交) 或 eval(按 name 分组批量勾选) → 再 eval 校验
```

## 6. "需要人"的判定（`src/classify.js`）

`/snapshot` 把页面观察（URL、标题、正文、password 框、captcha DOM、iframe URL、
HTTP 状态、加载错误）交给一个**纯函数**判定。优先级从高到低：

| # | `reason` | 判据 | 典型信号 |
|---|---|---|---|
| 1 | `login_required` | 当前 URL 或任一 iframe 的 URL 命中登录宿主/路径；或页面上有 `input[type=password]` | `login_url` / `password_field` |
| 2 | `captcha` | DOM 里有 recaptcha / hcaptcha / turnstile / `[data-sitekey]` / `*captcha*`；或文案命中（"not a robot"、"人机验证"、"滑块"…） | `captcha_dom` / `captcha_text` |
| 3 | `mfa_required` | 文案命中 2FA 关键词（"verification code"、"Authenticator"、"verify your identity"、"验证码"、"双重验证"…） | `mfa_text` |
| 4 | `blocked` | 封禁文案（"Access denied"、"unusual traffic"…）/ HTTP 401·403·407·429·451·503 / 正文近空（< 40 字符且无可交互元素） | `blocked_text` / `http_403` / `empty_text` / `load_error_empty` |
| 5 | `unknown` | 加载出错但页面仍有内容 —— 说不清，如实升级给人 | `load_error` |

登录页的识别范围（`looksLikeLoginUrl`）：

- 宿主：`login.microsoftonline.com`、`login.live.com`、`accounts.google.com`、
  任意 `login.` / `signin.` / `sso.` / `idp.` / `auth.` / `adfs.` / `sts.` 子域、
  `mysignins.microsoft.com`
- 路径段：`/login`、`/signin`、`/auth`、`/authn`、`/idp`、`/authorize`、`/oauth2`、
  `/sso`、`/saml`、`/adfs`、`/cas`，以及 `Login.aspx` 这类带扩展名的形式
- **刻意不误伤**：`/authors`、`/logins`、`/login-help`、`/articles/auth-in-design`

**顶层 URL 与 iframe 用不同严格度**（2026-11-04 实测修的一处误判）：

| 位置 | 判据 | 为什么 |
|---|---|---|
| 顶层 URL | 宽（含 `sso.*` 这类宿主通配） | 学校门户常常就是 `sso.school.edu`，宽一点更稳 |
| **iframe** | **严格**：只认明确登录域名（微软/谷歌/AWS）+ 登录路径 | iframe 经常是第三方小工具。实测 Canvas 答题页里有 `https://sso.canvaslms.com/post_message_forwarding`（Instructure 自家的 LTI 消息转发），宽判据命中 `sso.` → **已登录的答题页被报成 `needsUser:true`**，触发假告警 |

signal 也分开记：顶层命中是 `login_url`，iframe 命中是 `login_iframe`（便于排错时区分）。

> **为什么 captcha 排在 mfa 前面**（任务书里 2FA 写在验证码前面）：
> 验证码页面的文案几乎都含 "verify"（"Verify you are human"），而 2FA 关键词里
> 包含裸的 `verify`。先判 mfa 会把所有验证码误报成 `mfa_required`，维护者按提示
> 去"输验证码"却看到"拖滑块"。captcha 的判据不会命中真正的 2FA 页面，所以更准。

判定结果同时给出 `signals`（数组，稳定字符串），用于排错与上层做更细的分支。

## 7. 运维

```bash
cd ~/dsh-browser

docker compose ps                    # 状态（healthcheck 会显示 healthy/unhealthy）
docker compose logs --tail 50        # 容器日志（JSON 行 + entrypoint/x11vnc/chromium 的中文提示）
docker compose restart               # 只重启本容器（**不会**动 dsh-assistant / dsh-tg）
docker compose up -d --build         # 改代码后重建

# 容器里的 API 调试（8789 不发布到宿主机，进容器打）
docker compose exec browser node -e \
  "fetch('http://127.0.0.1:8789/health').then(r=>r.text()).then(console.log)"

# 带 token 调 /snapshot（token 与 assistant 共用）
TOKEN=$(cat ~/dsh-assistant/data/token.txt)
docker compose exec browser node -e "
  fetch('http://127.0.0.1:8789/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': process.env.TOKEN },
    body: '{}'
  }).then(r=>r.text()).then(console.log)
" 
# （把 TOKEN 传进容器：docker compose exec -e TOKEN="$TOKEN" browser node -e …）
```

### 7.1 登录态备份 / 迁移

`./profile` 目录**就是登录态**（等价于凭据）：

- 备份：`tar czf ~/profile-backup-$(date +%F).tgz -C ~/dsh-browser profile`，**别传 GitHub**
- 迁移到新机器：连同 `profile/` 一起搬过去，`docker compose up -d --build` 后免登录
- 想清空登录态：`docker compose down && rm -rf profile && mkdir profile && docker compose up -d`

## 8. 排错

| 症状 | 原因 / 处理 |
|---|---|
| 浏览器打开 noVNC 是**空白页/无法连接** | 端口没发布或绑到了不存在的 IP。`docker compose ps` 看 PORTS；`ss -lntp \| grep 16080` |
| noVNC 提示 `Failed to connect to server` | websockify 挂了或 x11vnc 没起来：`docker compose logs \| grep -E 'websockify\|x11vnc'` |
| 画面是**豆腐块**（中文显示成方框） | 字体缺失（镜像已带 `fonts-noto-cjk`）；若是旧镜像请重建 |
| Chromium 窗口里弹出**钥匙串/密码库**对话框 | 缺 `--password-store=basic`（entrypoint 已带）；旧镜像请重建 |
| `/health` 一直 `browserUp:false` | CDP 没起来：`docker compose logs \| grep -i chromium`；常见是 profile 权限（必须 1001 可写）或 `/dev/shm` 太小（compose 已设 1gb） |
| Chromium 反复崩，日志只有 `chrome_crashpad_handler: --database is required` / `Trace/breakpoint trap (core dumped)` | **HOME 不可写**（docker 对 `user: 1001:1001` 会把 HOME 设成 `/`）。entrypoint 已强制 `HOME=/tmp/dsh-browser-home`；改入口脚本时别退回 `${HOME:-…}` |
| 日志报 `The profile appears to be in use by another Chromium process … on another computer` | profile 里的 `SingletonLock` 记着旧 hostname（容器重建后变了）。entrypoint 每次启动前会清锁，compose 也固定了 `hostname: dsh-browser`；若仍出现就 `docker compose restart` |
| `docker compose restart` 之后容器起不来，日志 `Server is already active for display 99` | 容器重启保留 `/tmp`，上次被 SIGKILL 的 Xvfb 留下 `/tmp/.X99-lock`。entrypoint 现在会在启动前清锁、并在 SIGTERM 时优雅收尾；老镜像请重建 |
| 宿主机上 `curl 127.0.0.1:8789` 连不上 | **8789 故意不发布**。调试请 `docker compose exec` 进容器打（§7），容器间用 `http://dsh-browser:8789` |
| `/snapshot` 一直 `blocked` + `empty_text` | 页面还没渲染完或有反爬挑战；先人工在 noVNC 里打开看一眼 |
| 登录后仍报 `login_required` | 看 `finalUrl`：可能被重定向回登录页（会话没保存）→ 确认 `./profile` 挂载正常且容器以 1001 运行 |
| 容器起不来：`cannot assign requested address` | `ports:` 绑了本机没有的 IP（`VNC_BIND` 指向的网卡不存在，常见：Tailscale 退出登录）。改回 `VNC_BIND=0.0.0.0` 或先登录 Tailscale |
| 容器起不来：`VNC_PASSWORD` 未设置 | compose 用了 `${VNC_PASSWORD:?…}`；`cp .env.example .env` 并填值 |
| `/eval` 超时，之后 `/snapshot` 也卡住 | 脚本里有**同步死循环**（页面里的定时器永远不会触发）。只能 `/open` 重新加载页面。异步 `await` 不返回的情况会正常按 `timeoutMs` 超时，页面不受影响 |
| `/open` 返回了但 `/snapshot` 还在旧页面 | 看 `/open` 的 `navigationApplied`：`false` 说明被 `beforeunload`/站点拦住了（HTTP 也是 502）。日志搜 `dialog_handled` / `navigation_not_applied`。常见于 Canvas 答题页、未保存的表单页 |
| 已登录的页面仍报 `needsUser:true` | 先看 `/snapshot` 的 `signals`：`login_iframe` = 是**iframe** 命中的（iframe 用严格判据，但若某个小工具真的在登录域名下仍会误判，把那个 URL 记下来告诉我补规则）；`login_url` = 顶层 URL 命中；`mfa_text`/`captcha_text` = 文案命中 |
| 日志刷 `Chromium 退出（连续第 N 次，本次运行 Xs），D 秒后重启` 且 D 越来越大 | 这正是 2026-11-04 那次事故的现场（17 万次崩溃 → 9.5 万僵尸 → 宿主 fork 耗尽）。退避是**故意**的：把"每 2 秒造一次进程"压到 60 秒一次，给看门狗留反应时间。配合 `docs/HOST-WATCHDOG.md` 的 "近 10 分钟 traps 计数" 告警查根因 |

## 9. 没验证到 / 需要真实页面才能定的部分

诚实标注（**接受这些风险再用**）：

1. **具体选择器**：Outlook 收件箱列表、未读邮件、Canvas 作业列表的 DOM selector
   必须对着真实登录后的页面抓一次。本服务只保证"点/输/等"这套机制可用，
   **不保证**任何具体选择器长期有效 —— 页面改版即失效。
2. **学校会话能撑多久**：取决于租户的会话策略，没有实测多个过期周期。
3. **2FA 的具体形态**：Authenticator 推送/短信/电话各有不同页面，
   文案判据覆盖了常见英文/中文措辞，但**新形态需要补关键词**（改 `src/classify.js` 的
   `MFA_PATTERNS`，单测里加一条用例）。
4. **反爬**：`navigator.webdriver` 为 false（没有 `--enable-automation`），
   但没有做过针对性的反检测验证；学校若有严格风控，可能需要人工介入更频繁。
5. **noVNC 的 TLS**：默认是 `http://`。经局域网/SSH 隧道够用，
   但如果要经公网访问，**必须**自己加 TLS 反向代理（不要直接暴露 16080）。
6. **多标签页**：服务只操作**一个受管页**（§5.0）。人在 noVNC 里另开的标签不会被劫持，
   但也**不会**被 agent 读到 —— 想让 agent 看某页，必须用 `/open`。并发仍然没有互斥：
   **不要一边人工登录一边让 agent 跑**（同一个受管页，会互相打断）。
7. **`/eval` 只在主帧**：跨域 iframe（Canvas 的 `media_attachments_iframe` 内部）读不到。
   如果某个技能必须在 iframe 里执行 JS，需要另加能力（本期没做）。
8. **`/eval` 的策略**：目前**不做**内容审查（不拦 `fetch`/`localStorage` 等），
   只限制大小、超时与结果体积。这是刻意的取舍（先可用），
   但意味着"agent 能在这个页面里做页面本身能做的一切"——见 §10。
9. **Canvas 技能本身**：`packages/dsh-assistant/skills/canvas-quiz/` 的完整流程
   （读题干 → 按指纹选题 → 批量勾选 → 两步提交）是 Lead 写的，本服务只提供了
   它需要的 `/eval` 原语；端到端跑一遍真实 quiz 还没做过。

## 10. 安全边界（必读）

- `./profile` = 学校邮箱的登录态。**等同密码**。不入库（`.gitignore` 已覆盖）、
  不打包进镜像（`.dockerignore`）、不放共享目录。
- API 只在 `dsh-net` 内可达，鉴权用与 assistant/tg 共享的 token；
  拿到 token 就能读**你登录后的所有页面**，所以 token 按密码对待。
- noVNC 端口只发布一个，门槛是 **VNC 密码 + `VNC_BIND` 绑定的网卡**（生产绑局域网网卡，
  见 §4.1）。绑 `0.0.0.0` 时 docker/WSL/VMware 的虚拟网卡也会一起暴露。
- ⚠️ **`/eval` 把"能做什么"放大了一档**：持有 token 的一方可以在**你已登录的页面**里
  执行任意 JS —— 读页面、改表单、点按钮、发同源请求都行。也就是说：
  - 拿 token 的人 = **该站点账号的完整网页权限**（比 `/snapshot` 更宽）；
  - **"绝不碰密码"从"能力限制"变成了"纪律约束"**：服务不再拦得住"往 password 框里写值"。
  - 更进一步：**这台机器上已经有能读到学校密码的东西** ——
    `packages/dsh-assistant/scripts/canvas-login.mjs` 会读
    `~/dsh-assistant/data/osu.json`（600）并把账号密码填进 SSO 页（只把 Duo 留给人）。
    所以"agent 不知道密码"这条兜底**已经不成立**了，剩下的是流程约束。
    这是维护者要拍板的取舍（他最初的要求是"绝不碰密码"），本文档只记录现状。
  - 所以：不要给模型喂密码；不要让它读 `input[type=password]` 的值；
    凡是能从"人工登录 + 复用会话"做成的，就别用自动填密码（会话在 `./profile` 里，
    登录一次能撑几天到几周，见 §4.2）。
  - 后续若要收紧，可在 `/eval` 加脚本静态检查（如拒绝 `input[type=password]`、
    拒绝 `fetch(`），但那会牺牲可用性，目前按任务要求**先不限制**。
- 是否允许自动化访问学校邮箱，**由维护者按学校 AUP 自行判断**；
  本服务只提供机制，不改变学校的使用条款。
