# 启动器设计（`dsh-app` Desktop Launcher）

> 配套：[README.md](README.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [plan.md](plan.md) · [todo.md](todo.md)
>
> 状态：**设计阶段**。本文定义"解压即用"的启动器 exe 的职责、启动时序、跨平台策略与失败处理。

---

## 1. 为什么需要启动器

### 1.1 现状摩擦（实测）

```powershell
PS> dsh --version
# 本机实测：dsh 只存在于 npx 缓存目录
# dsh -> C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.ps1
# 并且：%APPDATA%\npm 下没有任何全局 dsh 安装
```

**问题**：今天要使用 DSH，你必须：

1. 自己装 Node.js
2. 自己 `npm install -g @deepseek-ai/dsh`（或会用 `npx`）
3. 自己在终端敲 `dsh web`
4. 等它打印出带 `?token=` 的 URL，浏览器自动打开
5. **保持那个终端不关** —— 关了服务就停

> 对非开发者（或只想"用一下"的人）这是四道坎。对开发者，这也是每天重复的仪式。

### 1.2 启动器要消除的摩擦

| 现状 | 目标 |
|---|---|
| 装 Node / npm / dsh | **解压运行 exe**，自动检测 + 引导 |
| 终端敲命令 | 双击图标 |
| 手动复制 token URL | 自动抓取并内嵌 |
| 终端不能关 | 托盘/窗口管理，退出时优雅关闭 |
| 装在哪儿、怎么更新 | 解压即可，`$DSH_HOME` 共享现有配置 |

**核心价值：把"配环境 + 敲命令"压缩成"双击"。**

---

## 2. 职责边界（重要：不做成另一个 DSH 客户端）

社区已有多个 Electron/Tauri 桌面客户端（`MochiNek0/dsh-desktop`、`anywhere-labs`、`RyensX/dsh-app` 等）。
**本启动器不与之竞争**，它只做**引导 + 承载**，不重写 DSH 的 UI：

| 做 | 不做 |
|---|---|
| 检测/引导环境（Node、npm、dsh） | ❌ 不重写会话 UI、工具卡片、轨迹视图 |
| 拉起 `dsh web` 并抓 token | ❌ 不实现自己的模型/会话协议 |
| 提供窗口（复用现有 web UI） | ❌ 不做多 profile 管理面板 |
| 与 `dsh-pet` 的常驻层协作 | ❌ 不做插件市场（已有 `dshmarket`） |

> 换句话说：**启动器是"能双击的 `dsh web`"，不是"新的 DSH 前端"。**

---

## 3. 启动时序

```
① 启动
   │
   ▼
② 环境检测（不通过则进入引导）
   ├─ Node.js 存在？版本 ≥ 20？
   ├─ npm / npx 可用？
   ├─ dsh 可用？（全局 或 npx 缓存）
   └─ 端口 3080 是否已被占用？
   │
   ├── 任一失败 ──► ③ 环境引导（§4）
   │
   ▼ 全部通过
④ 拉起 DSH
   npx --yes @deepseek-ai/dsh web --no-open [--port <port>]
   （优先用已装的 dsh，缺失则 fallback 到 npx）
   │
   ▼
⑤ 抓取 token（从 stdout）
   等 "dsh web: http://127.0.0.1:3080/?token=<t>" 出现
   ⚠️ 带超时（例如 90s）；超时进失败处理（§5）
   │
   ▼
⑥ 载入界面
   用【持久 partition】先 loadURL(tokenizedUrl) → 服务端 303 + Set-Cookie
   再载入 http://127.0.0.1:3080/
   ⚠️ 必须同源，绝不能用 file://（Origin: null → 403）
   │
   ▼
⑦ 与 dsh-pet 协作（可选）
   若装有 dsh-pet，桌面模式会自行拉起它自己的透明小窗
   │
   ▼
⑧ 运行时
   托盘图标 · 子进程监控 · 崩溃重启提示
   │
   ▼
⑨ 退出
   优雅关闭 dsh 子进程（不能留孤儿进程）
```

**关键约束（来自 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [plan.md](plan.md)）**：

| 约束 | 原因 |
|---|---|
| **必须同源加载**，禁止 `file://` | `isTrustedApiRequest` 对 `Origin: null` 会抛错 → 403 |
| **端口要么钉死 3080，要么整条链路用同一端口** | cookie 名与载荷绑定 `host:port`，换端口 cookie 全废 |
| **token 只在 `GET /` 兑换**，且硬要求 `pathname === "/"` | 不支持子路径挂载 |
| **退出必须杀子进程** | 否则留下占用 3080 的孤儿 `node` |

---

## 4. 环境检测与引导

### 4.1 检测项

| 项 | 检测方式 | 失败处理 |
|---|---|---|
| Node.js | `node --version`，解析 semver ≥ 20 | 引导安装，给官方下载链接 |
| npm / npx | `npm --version` | 提示随 Node 一起安装 |
| dsh | `dsh --version` → 失败则试 `npx --yes @deepseek-ai/dsh --version` | 引导安装（见 4.3） |
| 版本兼容 | 解析 `dsh --version` 输出 | **仅提示，不阻断**（见 4.2） |
| 端口占用 | 尝试监听 3080 | 提示换端口或结束占用进程 |
| 网络可达 | 需要时探测 registry | 提示代理/镜像 |

### 4.2 ⚠️ 版本兼容：只提示，不阻断

本机实测出现过**版本双镜像**：磁盘包是 `0.2.0-rc.2`，而**运行中的进程是更早启动的旧版内存镜像**。

→ 启动器**不应**因为版本号不"完美匹配"就拒绝启动。
→ 正确做法：**检测并提示**（"检测到 DSH x.y.z，本启动器在 a.b.c 上测试过"），把决定权交给用户。

### 4.3 dsh 缺失时的两条路（需给出选择，不能替用户决定）

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. `npx --yes @deepseek-ai/dsh`** | 零安装，不污染全局 | 首次下载慢；依赖网络 |
| **B. `npm install -g @deepseek-ai/dsh`** | 后续启动快 | 改动全局环境，需要权限 |

> 建议默认 **A**（无侵入），并把 B 作为显式选项。
> ⚠️ 本机实测：`npx` 偶发 `ECOMPROMISED: Lock compromised` → 必须有**重试与清晰报错**。

### 4.4 引导 UI 的最低要求

- 用人话说明**缺什么**（不是抛 stack trace）
- 给出**可点击的官方下载链接**
- 提供**"我已装好，重新检测"**按钮
- 显示**原始命令与原始输出**（可折叠），便于求助时贴出来
- 允许**跳过检测**直接尝试启动（高级用户）

---

## 5. 失败处理

| 场景 | 处理 |
|---|---|
| 环境缺失 | 进引导页（§4） |
| `npx` 下载失败 / 锁冲突 | 重试（退避）+ 显示原始错误 + 建议改用方案 B |
| token 抓取超时 | 提示"服务启动超时"+ 展示已捕获的 stdout + 提供"打开浏览器手动查看" |
| 端口被占用 | 提示 + 换端口选项（⚠️ 换端口要注意 cookie 绑定） |
| 子进程崩溃 | 提示 + 一键重启；保留日志 |
| 界面加载 401/403 | 说明 token 兑换失败，提示重试（多半是端口或 authority 变化） |

**原则**：**任何失败都要留下可诊断的信息**，而不是白屏。

---

## 6. 跨平台策略

### 6.1 技术选型：Electron（而非 Tauri）

| | Electron | Tauri |
|---|---|---|
| 与 `dsh-pet` 一致性 | ✅ **同栈**，它已用 Electron 自动探测/下载运行时 | ❌ 不同栈，需两套 |
| 运维 | ✅ 一次 Electron 版本，两处复用 | ❌ 需 Rust 工具链 |
| 体积 | ❌ 大得多 | ✅ 几 MB |

> **决策：用 Electron**，理由是**与 `dsh-pet` 同栈** —— 它的桌面模式已经在做"自动探测/下载 Electron 到 `~/.dsh/electron/`"，
> 启动器可以复用同一套运行时与经验，而不是引入第二套桌面技术栈。
> 代价是包体更大；若后续体积成为问题，再评估 Tauri（届时需重估与 `dsh-pet` 的协作方式）。

### 6.2 各平台要点

| 平台 | 要点 |
|---|---|
| **Windows** | 从 **npm 安装的 Node** 取 `node.exe`（实测路径 `C:\Program Files\nodejs\node.exe`）；注意 `%APPDATA%\npm` 与 npx 缓存两种 dsh 位置；`dsh` 是 `.ps1`/`.cmd` 包装，需要用 `shell: true` 或直接调 `node <bin.js>`；退出时用 `taskkill /T` 确保子进程树结束 |
| **Linux** | 注意 **无图形会话**时的降级（`dsh-pet` 已有先例：无 `DISPLAY`/`WAYLAND_DISPLAY` 时跳过桌面窗口）；AppImage 或 tar.gz；避免依赖系统 Electron |
| **macOS** | `.app` 包 + 公证问题（未签名会被 Gatekeeper 拦）；⚠️ **`dsh-pet` 的素材在 Safari/WKWebView 下 webm alpha 不兼容**（黑底）→ macOS 需 HEVC `.mov` 素材；首次运行需引导用户信任 |
| **通用** | `$DSH_HOME` 优先，缺失则回落 `~/.dsh`；**共享**用户现有配置与会话，不新建独立数据目录 |

### 6.3 发布形态

- **GitHub Release** 附带各平台压缩包（`win-x64.zip` / `linux-x64.tar.gz` / `macos-*.zip`）
- **解压即用**：不写注册表、不装服务（除可选的托盘自启）
- ⚠️ **未签名 exe 会被 SmartScreen 拦** → README 需说明如何"仍要运行"，或后续考虑签名
- 校验：Release 提供 `SHA256SUMS`

---

## 7. 与 `dsh-pet` 的关系（避免功能重叠）

两者都涉及桌面窗口，必须划清界限：

| | `dsh-pet`（第三方，依赖） | 启动器（本项目） |
|---|---|---|
| 职责 | **常驻的宠物窗口** + 状态动画 + 气泡 | **引导 + 拉起 DSH + 主窗口** |
| 谁拉起谁 | 它的桌面模式自己拉 Electron 小窗 | 启动器拉起 `dsh web` |
| 是否必需 | ❌ 可不要（核心功能不依赖它） | ❌ 可不要（用浏览器访问也一样） |
| 重叠点 | 都提供"不打开浏览器的常驻可见性" | 同上 |

**结论与取舍**：
- 启动器解决的是**"从零到能用"的摩擦**（环境 + 启动）
- `dsh-pet` 解决的是**"不开浏览器也能看见提问与进度"**
- **两者可以共存**，但要注意**不要各自拉一份 Electron**（若冲突，让启动器提供运行时，`dsh-pet` 复用）
- ⚠️ 待验证：`dsh-pet` 是否允许复用外部 Electron 运行时（已列入 todo）

---

## 8. 与 MVP 的关系

**启动器不是 MVP 的一部分。**

- **MVP** = R0（提问触达）+ R0b（进度），跑在**现有 web profile** 上
- **启动器** = 分发/引导层，让**别人**能零摩擦地用上 MVP

所以启动器的**优先级低于 R0/R0b**，但它有一个前置价值：
**它是你自己每天启动 DSH 的方式** —— 如果你自己天天用，它会更快暴露问题。

**建议**：R0 跑通后再做启动器；但**现在就把时序与陷阱记录下来**（本文），避免实现时重新踩坑。

---

## 9. 待验证清单（启动器专属）

| # | 问题 | 影响 |
|---|---|---|
| L1 | `npx --yes @deepseek-ai/dsh web` 的 stdout 格式是否稳定、token 抓取是否可靠 | 核心机制 |
| L2 | `npx` 的 `ECOMPROMISED` 锁冲突频率与重试策略 | 启动成功率 |
| L3 | Windows 上 `dsh` 是 `.ps1`/`.cmd` 包装，直接调 `node <bin.js>` 是否更稳 | 跨平台稳健性 |
| L4 | 端口被占用时换端口对 cookie 的影响（cookie 绑定 `host:port`） | 可用性 |
| L5 | `dsh-pet` 能否复用启动器自带的 Electron 运行时 | 避免双份 Electron |
| L6 | macOS 未签名 `.app` 的实际拦截行为 | macOS 发布 |
| L7 | Linux 无图形会话下的降级行为 | Linux 支持 |
| L8 | 退出时子进程树是否被可靠清理（Windows 尤其） | 不留孤儿进程 |
