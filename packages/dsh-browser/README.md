# dsh-browser

**浏览器执行服务**：容器里跑一个**人看得见**的 Chromium，登录由维护者在 noVNC 里手动完成；
agent 通过 CDP 读页面、点按钮，**遇到登录/2FA/验证码就停下来找人**。

> 维护者原话：**"必要的环节我去介入登陆，剩下的让智能体自己缺什么申请什么。"**
> 所以这个服务**永不接触密码与 2FA** —— 它只会在"需要人"时把 noVNC 地址递给你。

设计、部署、noVNC 登录步骤、API 契约、排错 → [docs/BROWSER-SERVICE.md](../../docs/BROWSER-SERVICE.md)。

## 快速开始（在 ubuntu-gpu 上）

```bash
mkdir -p ~/dsh-browser && cd ~/dsh-browser   # 源码包已经在这里
cp .env.example .env                          # 填 VNC_PASSWORD（≤8 字符）
mkdir -p profile
docker compose up -d --build
docker compose logs -f
```

然后浏览器打开 `http://<宿主机>:16080/vnc.html?autoconnect=1&resize=scale`，
输入 VNC 密码（若配了 `NOVNC_BASIC_AUTH`，HTTP 层还会先要一次）→ 在 Chromium 里登录学校邮箱。
登录态落在 `./profile`，**重启容器后仍然有效**。

## API（容器内 8789，走 `dsh-net`，服务名 `dsh-browser`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 探活（免鉴权）：`browserUp` / `loggedInHints` / `pendingUser` |
| POST | `/open` | `{url}` → 打开页面 |
| POST | `/snapshot` | `{}` → 可见文本 + `needsUser` / `reason` |
| POST | `/act` | `{action,selector,text?,timeoutMs?}`，action ∈ click / type / waitFor |
| POST | `/eval` | `{script,timeoutMs?}` → 在页面里执行 JS（Canvas 技能靠它；脚本报错返回 200 + `ok:false`） |
| POST | `/askuser` | `{reason,instructions,vncUrl}` → 记一条"要人"请求 |
| POST | `/resume` | 人做完了 → 清掉"要人"状态 |

> ⚠️ `/eval` 让 agent 能在**已登录的页面**里执行任意 JS，等于该站点账号的网页权限。
> "绝不碰密码"从能力限制变成纪律约束 —— 细节与边界见
> [docs/BROWSER-SERVICE.md §10](../../docs/BROWSER-SERVICE.md#10-安全边界必读)。

除 `/health` 外都要请求头 `x-dsh-token`，值与 assistant/tg 共用：
`~/dsh-assistant/data/token.txt`（只读挂进容器）。

`needsUser` 的 `reason` 是稳定枚举：
`login_required | mfa_required | captcha | blocked | unknown`。

## 本地测试

```bash
cd packages/dsh-browser
node --test        # 零依赖：测试只跑纯逻辑与 HTTP 层，不需要 Chromium / 网络
```

## 目录

```
src/classify.js   needsUser 判定（纯函数，单测重点）
src/pending.js    /askuser → /resume 的内存状态机
src/http.js       HTTP 路由 + 鉴权（browser 适配器注入，便于测试）
src/browser.js    playwright-core connectOverCDP 适配器
src/eval-script.js /eval 的「页面内执行 + 序列化」包装（不依赖 Playwright，可单测）
src/config.js     配置装载（token 只从文件/env 读，绝不硬编码）
docker/entrypoint.sh  Xvfb + x11vnc + noVNC + chromium 启动顺序（含崩溃退避）
Dockerfile            Debian + 发行版 chromium（**不下载** Playwright 浏览器）
docker-compose.yml    单容器，只发布 noVNC 一个端口
```
