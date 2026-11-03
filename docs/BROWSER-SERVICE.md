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

- ❌ 不接触密码、不碰 2FA、不存任何凭据 → 服务里根本没有"输入密码"的入口
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

### 4.1 三种访问方式（默认是第 1 种）

| 方式 | compose 里 `ports:` 改成 | 维护者打开 |
|---|---|---|
| **局域网（默认）** | `"16080:6080"`（= `0.0.0.0`） | `http://192.168.3.30:16080/vnc.html?autoconnect=1&resize=scale` |
| **Tailscale（更严）** | `"100.121.250.110:16080:6080"` | `http://100.121.250.110:16080/vnc.html?autoconnect=1&resize=scale` |
| **SSH 隧道（最严）** | `"127.0.0.1:16080:6080"` | 先 `ssh -N -L 16080:127.0.0.1:16080 192.168.3.30`，再开 `http://127.0.0.1:16080/vnc.html` |

- **绑定范围**：默认 `0.0.0.0:16080` 意味着**同局域网可达**（这台机器在 NAT 后面，
  没有公网端口映射，也**不要**给它加）。要收紧就按上表改一行再
  `docker compose up -d`。改前请确认目标地址真的存在（Tailscale 退出登录后，
  绑它的 IP 会让容器**起不来**：`cannot assign requested address`）。
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
→ { "ok": true, "title": "Mail - …", "finalUrl": "https://outlook.office.com/mail/inbox", "timedOut": false, "httpStatus": 200 }
```

- 只接受 `http(s)` 绝对地址，其它 → 400
- 等 `domcontentloaded`（默认 30s，`OPEN_TIMEOUT_MS`），超时返回 `timedOut:true` 但 **`ok` 仍为 true**
  ——接着 `/snapshot` 才能判断到底是不是登录页
- 非超时的网络错误（`ERR_NAME_NOT_RESOLVED` 等）→ 502

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
→ { "ok": true, "action": "click", "selector": "…" }
```

- `selector` 用 **Playwright 选择器语法**：CSS（`#id`、`a[href*=x]`）默认；
  也支持 `text=Sign in`、`role=button[name="Sign in"]`、`xpath=//…`
- `action=type` 时 `text` 必填（可为空字符串 = 清空）；先 `click` 再 `fill`，
  `fill` 不被支持时自动退回逐字符输入
- `waitFor` 等的是**可见**（`state: visible`）
- 超时 → 408；其它失败 → 500；参数不合法 → 400
- ⚠️ **选择器依赖真实页面**：本服务只提供机制，具体文本框/按钮的 selector
  必须对着真实 Outlook/Canvas 页面验一次（见 §9）

### 5.5 `POST /askuser` 与 `POST /resume`

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

### 5.6 典型调用序列（assistant 侧）

```
open(收件箱 URL)
  └─ snapshot → needsUser:true, reason:login_required
       ├─ askuser(reason, instructions, vncUrl)      # 记录
       ├─ （经 dsh-tg 推送 Telegram）                  # Lead/tg-agent 的地盘
       └─ 等维护者说"好了" → resume → snapshot 重试
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
- 路径段：`/login`、`/signin`、`/auth`、`/authorize`、`/oauth2`、`/sso`、`/saml`、
  `/adfs`、`/cas`，以及 `Login.aspx` 这类带扩展名的形式
- **刻意不误伤**：`/authors`、`/logins`、`/login-help`、`/articles/auth-in-design`

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
| 容器起不来：`cannot assign requested address` | `ports:` 绑了一个本机没有的 IP（常见：Tailscale 退出登录）。改回 `0.0.0.0:16080:6080` 或先登录 Tailscale |
| 容器起不来：`VNC_PASSWORD` 未设置 | compose 用了 `${VNC_PASSWORD:?…}`；`cp .env.example .env` 并填值 |

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
6. **多标签页**：服务用"最后一个打开的标签页"。若人在 noVNC 里手动切到别的标签，
   agent 也会跟着切过去 —— 并发操作没有互斥。**不要一边人工登录一边让 agent 跑**。

## 10. 安全边界（必读）

- `./profile` = 学校邮箱的登录态。**等同密码**。不入库（`.gitignore` 已覆盖）、
  不打包进镜像（`.dockerignore`）、不放共享目录。
- API 只在 `dsh-net` 内可达，鉴权用与 assistant/tg 共享的 token；
  拿到 token 就能读**你登录后的所有页面**，所以 token 按密码对待。
- noVNC 端口只发布一个，且有两层密码（VNC + 可选 HTTP Basic）。
  绑 `0.0.0.0` 时同局域网可达 —— 房间/网络不可信时按 §4.1 收紧。
- 是否允许自动化访问学校邮箱，**由维护者按学校 AUP 自行判断**；
  本服务只提供机制，不改变学校的使用条款。
