# 沙箱实测指南

> 目的：在**不动生产**的前提下，把 `dsh-efficiency` 装到一个独立 DSH 实例里跑起来，
> 亲手验证桌宠与提问面板。所有命令都实测过。

---

## 0. 前置

| 需要 | 说明 |
|---|---|
| Node.js | **24+**（我们用 `module.stripTypeScriptTypes` 在构建期剥离类型） |
| DSH | `@deepseek-ai/dsh`。不是全局命令时用 `node <...>/lib/bin.js` 代替 `dsh` |
| Electron | 仅**桌面小窗**需要。缺失时插件会走下载；也可用 `DSH_PET_ELECTRON_PATH` 指向已有 `electron.exe` |
| 上游 `dsh-pet` | **素材来源，必须装**（我们不含素材）。见 §1 |

**全程不碰生产**：下面所有命令都用 `DSH_HOME` 指向沙箱目录，
生产 `~/.dsh` 不受影响。

---

## 1. 装上游 `dsh-pet`（素材来源）

我们的宠物**立绘/表情包/字体**都从已安装的 `dsh-pet` 读（上游素材禁商用，不能进我们仓库）。

```sh
# 装到沙箱 profile 里（作为依赖，不启用为 bundle）
DSH_HOME=~/dsh-sandbox dsh plugin --profile web add dsh-pet
```

> ⚠️ **`dsh-pet` 只当素材来源**。稍后要把它从 `bundles` 里移出（见 §3），
> 否则它和我们打包的宠物都会注册 `/dsh-pet-7340/*` 路由，互相抢。

---

## 2. 构建并安装本插件

```sh
git clone https://github.com/wzqvip/dsh-app.git
cd dsh-app/packages/dsh-efficiency
npm install
npm run deploy          # 跑五道门禁并产出 release/
```

`npm run deploy` 会依次跑：`build` → `smoke-client` → `test-placement` →
`test-client-materialize` → `test-config-write`，**全绿才写 `release/`**。

然后把它装进沙箱：

```sh
DSH_HOME=~/dsh-sandbox dsh plugin --profile web add \
  file:/绝对路径/dsh-app/packages/dsh-efficiency/release
```

> 装 `release/` 还是包根都行（两者 `lib/` 内容一致）。
> **推荐 `release/`** —— 那是门禁把关后的成品，也是部署时用的同一个目录。

### 想先检查一遍再装？

```sh
node scripts/preflight.mjs     # 只读，约 1.3 秒，34 项检查
```

它会核对：工作区是否干净、vendor 是否只含代码且带 MIT LICENSE、有没有混进素材、
署名材料是否齐、五道门禁是否全绿、release 产物是否完整、
**生产是否仍未加载本插件**、沙箱素材是否来自已安装的 `dsh-pet`。

---

## 3. 调整沙箱 profile

编辑 `~/dsh-sandbox/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-pet": "^0.2.12",          // ✅ 保留：素材来源
    "dsh-efficiency": "file:/…/packages/dsh-efficiency/release"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-efficiency"            // ✅ 我们的包
        // ❌ 不要在这里留 "dsh-pet"：会和我们的宠物抢路由
      ]
    }
  }
}
```

---

## 4. 启动沙箱

**开两个终端。** 第二个用来注入测试提问（可选，见 §6）。

```sh
# 终端 1：启动
export DSH_HOME=~/dsh-sandbox
export DSH_EFFICIENCY_DEV_TOOLS=1      # 只为实测：启用 /api/dev/* 注入端点
dsh web --port 3097 --no-open
```

> `DSH_EFFICIENCY_DEV_TOOLS=1` **不设时那些端点根本不会注册** ——
> 所以生产（不设该变量）永远不会暴露它们。
> 不打算注入测试提问的话可以不加，其余功能照常。
>
> **实测确认**（不是推断）：不设该变量时，`POST /api/dev/inject` **不产生任何效果**
> —— 注入一条后 `pending.count` 仍为 `0`。设了它就变成 `1`。
> `api/health` 里的 `devTools` 字段也会跟着 `false` / `true`。
>
> ⚠️ **别用状态码当判据**（我一开始就搞错了）：
> 未启用时 `GET /api/dev/inject` 是 **404**；
> 启用后它仍是 **405**，因为该路由只接受 POST。
> 而 `POST` 一个**根本不存在**的路由也是 **405** ——
> 所以 405 完全无法区分"路由不存在"和"方法不对"。
> **权威判据是 `health.devTools` 字段，或"注入后 pending 是否真的变了"。**

> ⚠️ **关于鉴权**：我们的 HTTP 路由**不做自己的 token/鉴权**，依赖 DSH 只监听
> `127.0.0.1`（实测沙箱与生产都只绑本机）。所以上面那些 curl **不需要带 token**，
> `?token=` 与 `Authorization` 头也都可用（都实测 200）。
> **但如果哪天把 DSH 暴露到局域网，这些端点（含 dev 注入）就会跟着暴露** ——
> 届时必须补鉴权。另见 [SECURITY.md](SECURITY.md)。

启动后终端会打印一行带 token 的 URL：

```
dsh web: http://127.0.0.1:3097/?token=XXXXXXXX
```

**浏览器打开这个 URL**（带 token，否则会被拒）。

> ⚠️ 终端不能关，关了服务就停。

---

## 5. 应该看到什么（逐一核对）

| # | 看什么 | 期望 |
|---|---|---|
| 1 | 桌宠 | 网页上出现宠物浮层（会呼吸/待机动画） |
| 2 | 余额气泡 | 宠物上方偶尔出现 `余额（…）¥xx.xx` |
| 3 | 桌面小窗 | 另一个独立的透明小窗，宠物在里面，可拖动 |
| 4 | 右键菜单 | **右键点宠物** → 菜单里有「**设置…**」 |
| 5 | 设置窗口 | 点「设置…」→ 打开独立设置窗口，**8 个分区**：<br>`宠物 / 提醒与对话 / 工作状态文案 / 物理引擎 / 动画随机链权重 / 动画池 / 表情包池 / 诊断信息` |
| 6 | 设置页分区 | DSH 自己的设置页里，导航栏有 **Efficiency**（我们的）和 **Pet Config**（上游的，管宠物实例与卸载）—— **两个都在是有意为之**，各司其职 |
| 7 | 提问面板 | 见 §6 |

**设置窗口里改一项 → 保存** → 状态栏显示「已保存 ✓」，宠物立即套用
（改大小/位置/显示方式会重开桌面小窗，属预期）。

---

## 6. 验证提问链路（核心功能）

这是本插件存在的理由：**agent 问你问题时，不用切回网页**。

### 方式 A：注入一条合成提问（不需要真 agent）

前提：启动时设了 `DSH_EFFICIENCY_DEV_TOOLS=1`。

```sh
TOKEN=<URL 里的 token>
curl -X POST "http://127.0.0.1:3097/dsh-efficiency/api/dev/inject?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"questions":[{"id":"q1","header":"实测","question":"这条应该出现在宠物下方的面板里","options":[{"label":"选项甲"},{"label":"选项乙"}]}]}'
```

**期望**：宠物**正下方**弹出提问面板，含问题正文、两个选项按钮、一个输入框、
以及 `Submit` / `Skip (use official)`。

点一个选项 → 点 `Submit` → 会显示
`Failed: no-live-agent-for-call`。

> ⚠️ **这是正确行为，不是 bug** —— 合成提问没有真实 agent，答案无处投递，
> 宿主如实报错而不是静默吞掉。要验真正的作答，请用方式 B。

清掉合成提问：

```sh
curl -X POST "http://127.0.0.1:3097/dsh-efficiency/api/dev/clear?token=$TOKEN"
```

### 方式 B：真实 agent 提问（完整往返）

在 DSH 里开一个会话，让它用 `ask_user_question` 问你（或触发任何需要提问的工具）。
**期望**：面板弹出 → 你在面板里点选项 → 提交 → **agent 收到你的答案继续干活**。

这才是这个项目要解决的问题，值得亲手试一次。

### 顺带验通知

提问/回合结束时，若**页面失焦**（切到别的窗口），右下角应弹系统通知。
页面在前台时**不弹**（不打扰）—— 这是聚焦门，属设计。

---

## 7. 自动化验证（想跑脚本就往下看）

`packages/dsh-efficiency/scripts/` 下有 6 个端到端脚本，都会自己拉起 Electron
并用 CDP 驱动真实页面，**不需要你操作浏览器**。跑之前沙箱要在运行（§4）。

```sh
cd packages/dsh-efficiency

node scripts/manual-web-overlay.mjs      # 桌宠网页浮层是否渲染
node scripts/manual-desktop-smoke.mjs    # 桌面小窗（截图到 build/desktop-smoke.png）
node scripts/manual-question-flow.mjs    # 提问面板：注入 → 渲染 → 提交（截图）
node scripts/manual-settings-window.mjs  # 设置窗口：开窗 → DOM → 保存（截图）
node scripts/manual-notify-flow.mjs      # 通知：帧→文案→弹出 + 聚焦门
node scripts/manual-workstatus-flow.mjs  # 工作状态 6 档位联动
```

截图会写到 `build/*.png`，可直接打开看。

> ⚠️ 这些脚本会临时改沙箱配置再**自动复原**（走 PUT 接口回滚，不是直接改文件）。
> 若中途被打断，检查 `~/dsh-sandbox/dsh-pet/main-config.json` 里的
> `name` 有没有 `·E2E2` 尾缀、`display` 是否还是你设的值。
> 清理合成提问：`/api/dev/clear`（见 §6）。

---

## 8. 排查

| 现象 | 原因 / 处理 |
|---|---|
| 网页里没有宠物 | 该宠物的 `display` 必须是 `web` 或 `both`。`desktop`/`none` 时**网页端不渲染是正确行为**。设置窗口「显示方式」里改 |
| 桌面小窗没出现 | `display` 要是 `desktop`/`both`；且 Electron 可用。找不到时宿主日志会写明原因，可设 `DSH_PET_ELECTRON_PATH` 指向 `electron.exe` |
| 宠物没有立绘/表情包 | 素材来自已安装的 `dsh-pet`。确认它在 profile 的 `dependencies` 里（§3），且 `node_modules/dsh-pet/assets` 存在 |
| 设置保存了但没生效 | 看设置窗口底部的状态栏：失败会红字给出原因。**注意有些字段宿主只接受完整对象**（`physics` 要全 6 键、`animations` 要完整结构），U 界面提交的本来就是完整对象，所以正常路径不会遇到 |
| 提问面板不出现 | 确认提问真的到了宿主：`curl ".../dsh-efficiency/api/pending?token=$TOKEN"`。面板只在有提问时挂载 |
| 通知不弹 | 需要浏览器**通知权限**（设置窗口「提醒与对话」里有申请按钮）。且页面必须在**失焦**状态 |
| 想彻底重来 | 删掉 `~/dsh-sandbox` 重做 §1–§4。它和生产 `~/.dsh` 完全隔离 |
| 想确认 dev 端点是否启用 | **看 `api/health` 里的 `devTools` 字段**（`true`/`false`），或看注入后 `pending.count` 有没有变。**不要看状态码**：未启用时 GET 是 404，启用后 GET 仍是 405（该路由只收 POST），而 POST 一个瞎编的路由**也是 405** —— 405 区分不了这两种情况 |

**看日志**：宿主侧日志在终端里；桌面助手的日志前缀是 `[dsh-pet]`；
设置窗口右上角有「重新载入」，载入失败会在状态栏显示原因。

---

## 9. 这个沙箱与生产的关系

- 沙箱 `DSH_HOME=~/dsh-sandbox`，生产是 `~/.dsh` —— **两者完全隔离**
- 本项目所有改动**只在沙箱验证**；生产要等维护者明确同意后才重启
- 部署步骤见 [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md)，
  其中**最容易搞错的一点**：
  > 上游 `dsh-pet` 要**留依赖、移 bundle** —— 留在 `dependencies` 当素材来源，
  > 移出 `bundles` 避免与我们的宠物抢 `/dsh-pet-7340/*` 路由。
