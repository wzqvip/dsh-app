# DSH 桌宠 + 自适应 Web —— 可执行任务清单

配套文档：[plan.md](plan.md)（规划与调研依据）
基线：`dsh` **0.2.0-rc.2** / Node v24.13.0 / pnpm 12.6.0 / profile `web` / `http://127.0.0.1:3080`（仅回环）
⚠️ **版本双镜像**：磁盘包已全部是 `0.2.0-rc.2`（mtime 09-29 11:31），但**正在运行的 GUI 是 09-28 启动的旧版内存镜像** → 先做 P0-0。

**执行优先级（已确认）**
1. 🔴 **R0 提问触达** —— 先做，这是项目存在的理由
2. **R0b 进度感知** —— 顺带做，且**只用零成本档位 A/B**
3. 其余（galgame / 显示模式 / 输出长度 / 进度气泡）→ **Phase 2b，可延后可砍**
4. 分发：**只发 GitHub**，用户 `clone → build → add file:`
5. 插件市场上架：**等 MVP 跑通**

**使用约定**
- 🔒 = 动环境前必须已备份
- ⏱️ = 预估工时
- 🚦 = 阻塞后续任务的门禁
- `[插件]` = 需要 `dsh plugin --profile web add`；`[自研]` = 需要写代码；`[验证]` = 只观察记录

---

## Phase 0 — 基线固化 🚦（不做完不许装任何插件）

- [ ] **P0-0** ⚠️ **重启 `dsh web`（关键前置）** ⏱️5min
  - 已实测：磁盘 278 个 `@deepseek-ai/dsh-*` 包 = `0.2.0-rc.2`（mtime **09-29 11:31:59**），而running GUI（PID 127888）**启动于 09-28 13:45** → **进程是旧版内存镜像，磁盘是新版**
  - 风险：进程在 11:31 之后若惰性加载被替换的旧文件可能 ENOENT
  - 重启后"看到的行为"才与"磁盘代码"对齐 → **后续所有验证都基于重启后的实例**
  - 注意：重启会**换新 launch token**；但 cookie 仍有效 30 天（签名密钥持久化在 `.credentials.yaml`）
  - 重启后确认 GUI 健康：`/` 应返回 **401**（= 认证正常）
- [ ] **P0-1** 🔒 备份 profile 配置目录 ⏱️5min
  - 备份 `C:\Users\WANGZ\.dsh\profiles\web` 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`
  - 目标路径：`backup\profile-web-<timestamp>\`
- [ ] **P0-2** 记录运行时基线到 `research/baseline.md` ⏱️10min
  - `dsh --version`（实测 **0.2.0-rc.2**）
  - 278 个 `@deepseek-ai/dsh-*` 包版本分布（**全部 0.2.0-rc.2**；非 `@deepseek-ai` 包另有版本，正常）
  - `Get-NetTCPConnection -LocalPort 3080`（实测仅 `127.0.0.1`）
  - 当前 `dsh.profile.bundles`（`dsh-base` / `dsh-web-app` / `dshmarket`）
  - `dshmarket` 当前版本 **1.66.5**
- [ ] **P0-3** 建立 `research/compat-matrix.md` ⏱️15min
  - 表头：`包名 | 版本 | 声明的 dsh peer | 安装结果 | 启动后 skippedBundles | 结论`
  - 预填已知候选（见 plan.md §11）
- [ ] **P0-4** 确认回滚演练 ⏱️15min
  - 验证：还原 `package.json` + `pnpm-lock.yaml` → `pnpm install` → 重启 `dsh web` 能恢复
  - 记录 `compatibility.json` 的位置与手工修复方式（官方明确：**豁免不随插件/DSH 升级继承**）
  - 记录豁免命令：`dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk`
- [ ] **P0-5** 🚦 门禁：已重启 + 备份可还原 + 基线已记录 → 才进入 Phase 1

---

## Phase 1 — 能力打通（零自研，一次只装一个）🚦

> **铁律**：每装一个插件 → 重启 `dsh web` → 观察启动日志有无 `skippedBundles` 或"策略拒绝" → 记录进 compat-matrix → 才装下一个。
> 一次装多个会导致无法定位失败源。

### 1.1 显示模式（R2a）
- [ ] **P1-1** [插件][验证] 安装 `dsh-auto-collapse` ⏱️20min
  - `dsh plugin --profile web add dsh-auto-collapse`（npm 版本 0.2.1，仅 peer `schemastery`，依赖最干净）
  - 验证点：回合结束是否收成一行「已处理 X秒」；思考/工具是否折叠为 chip；**能否逐级展开**
  - 记录：这是否满足"完整过程 / 只显示思考中"的**最低档**？差在哪？
- [ ] **P1-2** [验证] 备选方案调研（仅在 P1-1 不满足时）⏱️30min
  - 候选：`@winteries/dsh-turn-fold`、`dsh-turn-fold`、`dsh-annotation`（可隐藏指定思考/工具）、`dsh-focus-overlay`
  - 目标：找到"能切换两种模式"而非"只能折叠"的方案
- [ ] **P1-3** 🚦 输出 R2a 结论：可直接用 / 需自研补哪一块

### 1.2 输出到文件（R2b）
- [ ] **P1-4** [验证] 内置导出能力 ⏱️20min
  - 读 `@deepseek-ai/dsh-session-log-export` 的 README，确认命令/入口与输出格式（Markdown / HTML）
  - 实测导出一份当前会话
- [ ] **P1-5** [验证] 找"每轮自动落盘"能力 ⏱️20min
  - 候选：`dsh-suite#plugin-session-export`(57★)、`dsh-timeline`(39★)、`dsh-bookmarks`(11★)
  - 判断：内置导出 + 手动触发是否够用？不够则记入 Phase 2 自研项

### 1.3 移动端自适应（R5 前半）
- [ ] **P1-6** [插件][验证] 安装 `dsh-web-mobile` ⏱️30min
  - 版本 3.0.3，注入了 layout/sidebar/conversation/settings/slots/primitives + `dsh-session-log-export`
  - **手机浏览器实测**：窄屏布局、侧栏、输入框、滚动
- [ ] **P1-7** [验证] 备选对比（若 P1-6 不满意）⏱️30min
  - `dsh-mobile-hanui`（**1024px 断点**、覆盖式抽屉、上滑加载历史、含 PWA）
  - `dsh-webui-mobile`（抽屉侧栏 + 悬浮按钮 + 相册/拍照上传）
  - `dsh-zen-remote`（手机优先 + PWA）
  - 注意：**多个移动端插件会改同一批槽位，只能留一个**
- [ ] **P1-8** 🚦 输出 R5-移动端结论 + 选定唯一方案

### 1.4 局域网访问（R4）—— 最高风险，放最后

> **已结案（见 plan.md §5）**：`dsh web --host 0.0.0.0` 被 CLI **硬拒绝**，且 `--trusted-host` 不改 socket 绑定。
> **正解不是"改 bind flag"，而是"保持 loopback + 加密入口"**。因此下面 P1-9 已由"试探"改为"选型"。
> 好消息：**DSH 本身有认证**（每进程 launch token → HMAC 签名 HttpOnly cookie），不是裸奔。

- [ ] **P1-9** [验证] 确认当前 token 兑换链路可用 ⏱️15min
  - 从 `dsh web` 启动日志取 `http://127.0.0.1:3080/?token=...`，验证兑换后 cookie 生效、刷新不再要 token
  - 记录 cookie 有效期（默认 30 天）与"清 cookie 即失效 / 全局吊销需删 `.credentials.yaml` 的 `client-connection/browser-session` 记录并重启"
- [ ] **P1-10** [验证] **选型：SSH/Tailscale（方案1）还是 Caddy 反代（方案2）** ⏱️30min
  - 方案 1 ★★★★★：零改动、加密、风险低；代价是手机需装 VPN 客户端
  - 方案 2 ★★★★☆：本机 Caddy 单 exe + `--trusted-host <外部authority>`；**必须保留 Host 头**、**必须挂根路径**（token 兑换硬要求 `pathname === "/"`，子路径必失败）、**必须放行 WS 且无 >2s 停顿**（每 2s Ping，未回 Pong 即断）
  - ⚠️ 全仓库**没有 TLS 服务端**（`createSecureServer|https.createServer|tls.createServer` 零命中）→ TLS 只能靠外部反代
- [ ] **P1-11** [插件][验证] 仅当上述都不通时：装局域网插件 ⏱️40min
  - 首选 `@wingsky-1/dsh-lan-proxy`（0.2.7）：`0.0.0.0` 监听 + WS 转发 + 自签 TLS + Host/Origin 重写 + 仅 IP 字面量 Host + 回环白名单
  - 备选 `dsh-web-lan-access`（1.3.2）、`dsh-mobile`（0.5.2）
  - ⚠️ **注意**：这类插件"重写 Host/Origin 以通过 /api 信任围栏"= **主动放宽官方安全围栏**，必须确认它同时提供了自己的门禁
  - ⚠️ 注意 peer 范围与 0.2.0-rc.2 的匹配（plan.md §3）
- [ ] **P1-12** 🔒 安全红线自查（**必须逐条打勾才能长期保留**）⏱️30min
  - [ ] **优先保持 `host=127.0.0.1`**（能不上 `0.0.0.0` 就不上）
  - [ ] 已理解：拿到 cookie = **完整 RCE**（`terminal.create` 以系统用户权限开 shell，**绕开 Agent 沙箱与审批**）
  - [ ] 已理解：`/api/file?path=<绝对路径>` **可读任意可读文件**（无工作区约束）
  - [ ] 已理解：`settings`/`credentials` **有写权限**（可把 LLM key 改指到攻击者端点）
  - [ ] 传输已加密（SSH/WireGuard/反向代理 TLS）——**明文 HTTP 下 cookie 无 `Secure`，嗅探即失守**
  - [ ] Windows 防火墙**只放行私有网络配置文件**
  - [ ] 已确认 `--trusted-host` 的 authority 写法通过严格校验（裸 authority、WHATWG 规范化后不变、无端口零填充/百分号编码/无括号 IPv6）
  - [ ] 知道未认证暴露面：`/assets/*`、`/plugins/<id>/client.js`、**`/plugins/events`（HMR SSE，无围栏）**
  - [ ] 有"一键关闭局域网"的手段
- [ ] **P1-13** 🚦 输出 R4 结论 + 安全评估签字

### 1.5 桌宠（R1 视觉）—— ⭐ 模板已定：`PC2005-cloud/dsh-pet`

> **已选定模板**（见 plan.md §4.2）：[`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)，npm `dsh-pet@0.2.12`，832★。
> **它自带 Electron 透明置顶窗桌面模式 + `shell.overlay` 网页浮层 + 六档工作状态联动 + pet pack 扩展机制** → **本项目不再需要自研 Tauri/Electron 薄壳**。

- [ ] **P1-14** 🔴 [插件][验证] **装 `dsh-pet` 并处理版本闸门（最高优先级硬风险）** ⏱️50min
  - **本项目只发 GitHub 不发布 npm**，且 `dsh-pet` 也建议**从源码构建**（`lib/` 不入库）：
    ```sh
    git clone https://github.com/PC2005-cloud/dsh-pet.git
    cd dsh-pet/dsh-pet
    npm install
    npm run prepare      # ⚠️ 必须用 prepare，裸 tsdown 会缺桌面运行时与类型声明
    dsh plugin --profile web add file:<上一步的绝对路径>
    ```
  - 若要走 npm 路线（可选）：`dsh plugin --profile web add dsh-pet`
  - 🔴 **预期会被拒**：它声明了 11 个 `@deepseek-ai/dsh-*` peer，范围**全为 `^0.1.1-rc.2`**（`dsh-host-webserver`/`dsh-client-ui-slots`/`dsh-client-connection`/`dsh-client-runtime`/`dsh-llm`/`dsh-commands`/`dsh-home-paths`/`dsh-credentials`/`dsh-agent-default-model` …）
  - semver 判定：`^0.1.1-rc.2` = `>=0.1.1-rc.2 <0.2.0`，**不含 `0.2.0-rc.2`**（预发布只匹配同 `[major,minor,patch]` 元组）
  - 它的 README 也写"当前在 **0.1.5-rc.1** 下开发并测试"
  - 被拒时：
    ```sh
    dsh plugin --profile web version-exemptions          # 先看运行时版本与已有豁免
    dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk
    ```
  - ⚠️ 豁免**不随插件/DSH 升级继承**，升级后需重新授予
- [ ] **P1-15** [验证] 验证**桌面模式**（关键能力）⏱️30min
  - 每只宠物设 `display: desktop` 或 `both` → 应出现**独立透明置顶小窗**（跟随宠物移动，不铺满屏幕）
  - 首次自动下载 Electron 到 `~/.dsh/electron/`；缺失时仅日志告警，不影响网页形态
  - 验证它**走独立进程管道、不受 web 访问闸门影响**（这是它的核心优势）
- [ ] **P1-16** [验证] 验证网页浮层与状态联动 ⏱️30min
  - 网页端走 `shell.overlay`（我们确认的官方席位）
  - 开 `workStatusEnabled` → 六档「思考/工作/整理/等待/成功/出错」动画 + 气泡是否跟随本会话
- [ ] **P1-17** [验证] 配置到满意（大小/位置/多开/边距）⏱️30min
  - 设置页「桌宠配置」**或** `$DSH_HOME/dsh-pet/main-config.json`（同构，**整字段替换**语义）
  - 试试动画池/播放权重/事件周期这些**设置页给不了的自由配置**
- [ ] **P1-18** [验证] 对照其它桌宠，确认选型正确 ⏱️20min
  - `dsh-live2d-pets`(27★，状态镜像但**无桌面独立窗**)、`dsh-whale-widget`(3369★，偏余额挂件)、`whale-girl`(338★，偏养成)
  - dsh-pet 是唯一同时具备"网页浮层 + 桌面窗 + 状态联动 + 多开 + 素材链 + pet pack"的
- [ ] **P1-19** ⚠️ [验证] **确认许可证与署名义务** ⏱️10min
  - 代码 MIT；**素材（动画/提示词/源视频）允许开源使用、禁止商用**
  - **二创强制署名**：任何介绍/展示/分发处须附 `https://github.com/PC2005-cloud/dsh-pet`
  - Safari 不兼容 webm alpha（黑底）→ macOS 需 Release `assets-mov` 的 HEVC `.mov` + 改 `ANIMATION_EXT`；**Windows 不受影响**
- [ ] **P1-20** 🚦 输出 R1 结论：dsh-pet 装通 + 桌面模式可用 + 许可证已知悉

### 1.6 CLI 形态（R5 后半）
- [ ] **P1-21** [插件][验证] 安装 `@tomowang/dsh-tui`（0.9.0）⏱️40min
  - peer `^0.1.7-rc.2`；自带 standard/ptc/minimal/cordis 四份预设 patch
  - 注意：它是**独立 profile 级 TUI 前端**，可能不适合直接塞进 `web` profile → 需要单独 profile
  - 验证：可折叠工具卡片、终端内审批与提问、会话续接
- [ ] **P1-22** [验证] 备选 `@deepseek-harness-tui/dsh-tui`（0.11.2，3734★，React-reconciler）⏱️30min
- [ ] **P1-23** 🚦 输出 R5-CLI 结论

### 1.7 Phase 1 收口
- [ ] **P1-24** 🚦 汇总 `research/compat-matrix.md`：哪些能直接用、哪些要豁免、哪些必须自研 ⏱️30min

---

## Phase 2 — ★ 核心效率层（自研主体，**本项目存在的主要理由**）🚦

> 前置：Phase 1 收口完成，已明确"哪些不自己写"。
> 🎯 **本阶段只做 R0（问题提醒+一键回答）与 R0b（进度采集）** —— 这两个是项目的全部价值来源。
> 其余（显示模式、galgame、进度气泡）全部挪到 **Phase 2b**，**可延后也可砍**。
> 技术细节见 [ARCHITECTURE.md](ARCHITECTURE.md) §3–§4。

### 2.0 工程骨架（**契约已确认，可直接开工**）

- [ ] **P2-1** 研究 `dshmarket` 作为工程模板 ⏱️1h
  - 本机路径：`C:\Users\WANGZ\.dsh\profiles\web\node_modules\dshmarket`（v1.66.5, MIT）
  - **`src/` 源码随包发布** —— 当前机器上唯一的完整可读范例
  - `src/client/index.ts`（289 行）一次演示完：设置页 / Tab / 配置卡 / `shell.overlay` / `ctx.provide` / slot 探测
  - `src/routes.ts` 有 **40+ 个 `webServer.register` 实例** → 新路由照这个写
  - 抄 `package.json` 的 `dsh.bundle.patch` / `dsh.client` / `exports["./client"]` + `cordis.patch.yml` 的 `insert`
- [ ] **P2-2** [自研] 搭建插件包骨架 `dsh-efficiency` ⏱️3h
  - Host 半：具名导出 `apply(ctx, config)` + `inject`（**服务名，不是包名**）+ 可选 `name`/`Config`；**无 default export**
  - Client 半：必须产出 `window.__ModuleLoader__.load({ id: "<包名>", factory })`；factory 内导出同样的 `apply`/`inject`/`name`；**惰性 CJS**
  - 基座静态模块表已含 react / react-dom / jsx-runtime / cordis / ui-primitives / client-store → **直接 require，`external` 留空**
  - ⚠️ **不声明 `@deepseek-ai/dsh*` peer** → 完全绕开版本闸门
  - ⚠️ tsdown 共享预设**未随 npm 发布**，需自配；CSS 打成字符串自注入 `<style data-plugin-css>`
- [ ] **P2-3** [自研] 安装与校验回路 ⏱️1h
  - `dsh plugin --profile web add link:<本地目录>` → pnpm 成功后**自动追加进 `dsh.profile.bundles`**
  - 校验：`dsh --profile web --dump-config`（**不启动服务器**）
  - 临时覆盖：`dsh web --patch .\dev.patch.yml`
  - 记录：patch 层序 = bundles → profile patch → **$DSH_HOME patch（更高）** → `--patch`；`id` 定向是**整键替换不深合并**
- [ ] **P2-4** 🚦 骨架冒烟：能在 GUI 里看到一个空白设置分节
  - ⚠️ **版本自适应必须用 `ctx.slots.inject(slot, cb)` 探测槽位存在性，不要比版本号**
  - ⚠️ **绝不要注册 `root` 槽位**（会 shadow 整个 AppFrame）

### 2.1 ★【R0】问题提醒与一键回答 —— 最高价值

- [ ] **P2-5** 🔴 [验证] **前置确认 A1：`tool-ask-user.mode` 是 `timed` 还是 `legacy`** ⏱️20min
  - `dsh-tool-ask-user/lib/index.js:212` → `mode: z.union(["legacy","timed"]).default("legacy")`
  - **`legacy`（默认）= 阻塞式 `ask()`**：你不在场 agent 就**干等**，且问题**不进可回答投影** → 整个核心功能失效
  - **`timed` = `askTimed()`**：超时返回 `{pending:true}`，agent 继续干活，问题仍可回答 ✅
  - 检查方式：`dsh --profile web --dump-config`，找 `tool-ask-user` 行的 config
  - 若不是 `timed`：需在 profile patch 里改（并评估对现有工作流的影响）
  - **这 20 分钟决定整个 Phase 2.1 是否成立，必须最先做**
- [ ] **P2-6** [自研] Host 侧：订阅提问事件 ⏱️4h
  - 订阅 `user-questions/request`（**waterfall**）与 `approval/request`（**waterfall**）
  - 这是 25 条转发事件白名单里**仅有**的两条 waterfall，且**重连后会重放**（其余 23 条 emit 类不会）
  - 读 `userQuestions` 投影拿待答清单：`{ active: PendingUserQuestion[], settled: SettledUserQuestion[] }`
  - 限时问题用 `ctx.userQuestions.attachWait(agent, callId, signal)` 拿 `AsyncIterable<{remainingMs}>` 做倒计时
  - ⚠️ 有人接手后**倒计时归客户端所有**，Host 不再计时
- [ ] **P2-7** [自研] Host 侧：提交回答 ⏱️3h
  - `ctx.userQuestions.answer(agent, callId, answer)`，`answer` = `{ answers: [{ id, selected: string[], custom? }] }`
  - 支持多选（`multiSelect`）与自由文本（`custom`）
  - ⚠️ 已 `continued` 的问题，回复作为 `user-question-reply` **steer 回 agent**（**不伪造**工具结果）
  - ⚠️ 官方明确：**没有任何 Remote 方法能"放弃"问题** —— 面板收起不发送内容。这正合我们需求
- [ ] **P2-8** [自研] 承载：推送到 `dsh-pet` + 降级路径 ⏱️4h
  - 主路径：桌面小窗显示**角标 + 题干 + 选项按钮**，点选即答
  - 降级 1：`dsh-pet` 未就绪/未装 → **系统通知**
  - 降级 2：都不行 → 网页浮层
  - ⚠️ 需先验证 A6：`dsh-pet` 能否被**喂入自定义状态**，还是只能用它的内置探测
- [ ] **P2-9** [验证] **验收 R0（关键）** ⏱️30min
  - [ ] agent 提问后，**不切到浏览器**就能看到问题
  - [ ] **点一下选项就能回答**，且 agent 收到答案继续
  - [ ] **超时后离开一会儿再回来，问题仍在，仍能补答** ← 核心场景
  - [ ] 等待期间**不产生额外 token**（官方明确"等待人类回答不会增加 token"）

### 2.2 ★【R0b】进度采集（档位 A/B，零额外 token）

- [ ] **P2-10** [自研] 信号采集 ⏱️4h
  - `api-session/status`、`api-session/activity`（会话状态）
  - tool-call 生命周期（在跑什么、调用计数）
  - `reasoning-delta` 与 `text-delta` —— **已确证分离** → 能精确区分"在思考"与"在写"
  - 待办投影（`dsh-tool-todo`）→ "第 N/M 项"
  - goal / plan / workflow 投影
  - `userQuestions` 投影 → **待答问题角标**（与 2.1 共用）
  - token meter（可选展示）
- [ ] **P2-11** [自研] 信号 → 六档状态映射 ⏱️2h
  - 映射到 `dsh-pet` 的六档：思考 / 工作 / 整理 / 等待 / 成功 / 出错
  - **复用它的状态机与动画，不写新渲染**
  - 🔑 关键档位：**有待答问题/待审批 → 「等待」**
- [ ] **P2-12** [自研] 档位 A（原始信号直出）⏱️2h
  - 状态字 + 待办 N/M + 当前工具 + 运行时长
- [ ] **P2-13** [自研][可选] 档位 B（本地聚合"人话"）⏱️3h
  - **规则模板拼句，不过模型** → 额外 token 仍为 **0**
- [ ] **P2-14** 🚦 验收 R0b：不打开网页就能知道"它在干什么、跑到哪、卡在哪"

### 2.3 统一设置页 + 两个低成本项

- [ ] **P2-15** [自研] 设置页 ⏱️4h
  - 挂 `settings.section`（整页）或 `settings.general.item`（单行）
  - 按"**主线默认开 / 可选默认关**"分组（见 [ARCHITECTURE.md](ARCHITECTURE.md) §7）
  - **中文必须走 `ctx.locale`**（否则 i18n 校验会拒绝新增文案）；zh 已内置
  - ⚠️ **非 loopback 页面设置不持久化**（`dsh-client-ui-settings/README.md:106`）→ 远程场景需自建存储
- [ ] **P2-16** [自研] R5 第一步：注入 `viewport-fit=cover` ⏱️1h
  - 用 `webserver/index-inject` 推 `IndexInjection` 行 `{kind:'style'|'html'}`
  - 现状 index.html 只有 `width=device-width, initial-scale=1` → 缺此属性则 `env(safe-area-inset-*)` 在 iPhone 上**恒为 0**
- [ ] **P2-17** [自研][可选] R2b 升级：写会话到指定路径 ⏱️4h
  - Host：`ctx.inject(['webServer'], c => c.effect(() => c.webServer.register({ kind:'exact', path, handler })))`
  - Client：同源 `fetch(new URL(path, document.baseURI).pathname)`（cookie 自动带）
  - ❌ **Typert Remote 走不通**（需 monorepo 内部 codegen）
  - ⚠️ Host 侧**不要用 `ctx.provide`**（未实证），改用 `Service` 子类
  - **复用** `serializeSessionLog()` / `readSessionLogText()` / `sessionLogZipEntries()` + `writeFileAtomic()`
  - ⚠️ 文件名必须走 `logPath()`，**不要硬编码**（格式已确证 **v4**）
  - 失败要静默降级，不能因写文件失败中断对话
- [ ] **P2-18** 🚦 **Phase 2 验收 = MVP 达成**：R0 + R0b 在**不打开浏览器**的前提下完整可用

---

## Phase 2b — 可选表达层（**可延后、可砍**）

> 架构上已保证（[ARCHITECTURE.md](ARCHITECTURE.md) §2）：**不做这些，Phase 2 的核心价值依然成立。**
> 按价值排序：R2a > R2d ≈ R2c > 档位 C。

### 2b.1 显示模式（R2a）
- [ ] **P2-19** [自研] 「完整过程 / 只显示思考中」二态切换 ⏱️6h
  - **基础设施已够**：推理是独立一等类型（`'reasoning-delta'`；`thinkingDetail` 与 `outputDetail` 是**两个独立字段**）
  - 优先**包装**内置 `ui-chat.transcriptView`（4 档已存在），**不要重造折叠逻辑**
  - 缺的是"藏正文"语义 → 新增 policy 字段（如 `answersHidden`）并改 assistant 节点渲染
  - 挂钩：`ChatPresentationPolicy`（`chat/lib/types/client/presentation-policy.d.ts:9`）+ `POLICIES`（`chat/lib/client.js:12013`）
  - ⚠️ 官方明确这些模式折叠过程行时 **"without hiding the final answer"** → 这一步是真正的增量
- [ ] **P2-20** 🚦 两种模式可独立切换且互不干扰

### 2b.2 galgame 逐句播放器（R2d）
- [ ] **P2-21** [验证] **V12：先测历史重放成本** ⏱️20min
  - 打开一个**旧会话**，浏览器侧 dump 一条 `assistant/message` 的 `stream` 字段是否完整
  - 完整 → 历史重放零成本（用 `expandAssistantStream()`）；缺失 → 需新增 wire 字段
- [ ] **P2-22** [自研] 文本切句器 ⏱️4h
  - 中英混排：中文按 `。！？…；`，英文按 `.!?` 且**避开小数/缩写**
- [ ] **P2-23** [自研] 叙事播放器组件 ⏱️8h
  - 落点：注册 `conversation.view`（照抄 Trajectory 实现），或 `conversation.chat.node` 接管 `assistant-step`
  - 数据：`useTrajectory().partial` + `AssistantLiveChunkEvent.data.chunk`（**已确证 token 级**）
  - 交互：**点击 → 下一句**；**按住 → 快进**；键盘（空格/回车）+ 触屏 tap/hold
  - ⚠️ 流**无法真正暂停**（无 pause/resume 协议）→ 只能"前端延迟揭示"
- [ ] **P2-24** [自研] 与 `dsh-whale-galgame` 的关系厘清 ⏱️3h
  - 它是**角色扮演游戏壳**（好感度/记忆/CG 图鉴）；我们要的是**把正常 agent 输出逐句播放的阅读器**
- [ ] **P2-25** 🚦 点按 / 长按快进 / 触屏 三种交互均可用

### 2b.3 输出长度档位（R2c）
- [ ] **P2-26** [自研] 三档：简短 / 标准 / 详尽 ⏱️4h
  - 用 `ctx.systemPrompt.section({name, order, text: ({scope}) => …})` —— `text` **每次 assembly 求值 → 运行时可切换**
  - ❌ **不要用 agent preset**：官方原文 "the host refuses to swap them"，错误码 `agent-preset/locked`
  - ❌ 不要指望 compaction / tool-result-pruner / output-retention / spill-policy（只管上下文与**工具结果**）
  - 文案必须给**明确句数/字数上限**，否则只会变成"语气不同"
- [ ] **P2-27** 🚦 三档可切换且输出长度有**可观测差异**

### 2b.4 档位 C：进度气泡（⚠️ 消耗额外 token）
- [ ] **P2-28** 🔴 [验证] **A4：观察者会话如何与主会话隔离** ⏱️1h
  - 候选：子代理 / 独立会话 + 只读会话日志 / 其他
  - 必须保证：**不污染主会话上下文与 token 计量**
  - 决定档位 C 是否可行
- [ ] **P2-29** [自研] 看门狗会话 + 气泡 ⏱️6h
  - ⚠️ **默认关闭，必须显式开启**
  - 可配周期 + **可配预算上限**
  - 只读（无副作用工具权限）
  - **失败静默降级到档位 A/B**（观察者出错不能影响主线）
- [ ] **P2-30** 🚦 开/关档位 C 时，档位 A/B 均不受影响

---

## Phase 3 — 桌宠打磨与扩展（1–2 天）⭐ 已大幅简化

> ⭐ **模板已定：`dsh-pet`（见 plan.md §4.2）。不再自研薄壳** —— 它的桌面模式已覆盖原计划约 1.5 天的工作量。
> 本阶段从"造桌宠"变成"**调好 + 扩展它**"。装机与版本闸门在 **P1-14**（Phase 1）完成。

- [ ] **P3-1** [验证] 桌面模式深度验证 ⏱️1h
  - 多屏 / 异构 DPI / 任务栏条带 / 屏幕空洞下的漫游与甩抛边界（它声称都已处理，需实测）
  - 点击穿透、不抢焦点、高 DPI 下的清晰度
  - 与网页形态**行为一致性**对比
- [ ] **P3-2** [验证] 关闭/降级路径 ⏱️30min
  - 确认 `display: none` 能彻底关闭；确认删掉 Electron 运行时后网页形态仍正常
  - 确认宠物不干扰正常使用（不挡输入框、不抢焦点、可拖动避开）
- [ ] **P3-3** [自研][可选] pet pack：自定义宠物种类 ⏱️4h
  - `$DSH_HOME/dsh-pet/pet/<种类>-config.json` + `<种类>-animation/`（与主宠物**严格隔离**，动画池不回落全局）
  - 素材来源：dsh-pet 自带素材链（`scripts/`：Python + ffmpeg，`watermark → chroma → normalize → encode`）
  - 或 [aigengtu.com](https://aigengtu.com/) 梗图（⚠️ **静态图不能直接当动画**，需转 webm 或仅作气泡贴图；⚠️ 版权归原作者）
  - ⚠️ 也可以用"往 `main-animation/webm/` 放 `.webm`"的最快路径做单动作替换
- [ ] **P3-4** [验证] 功能开关组合调优 ⏱️1h
  - 工作状态联动（六档）/ 碎碎念 / 对话 / 余额 —— 逐项开，观察是否噪音过大
  - ⚠️ 余额功能需要对应 provider 的 API key（`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY`），未登记的服务商只会弹文字说明
- [ ] **P3-5** [验证] 系统通知（窗口失焦时 toast）⏱️20min
  - 对话完成 / 生成失败 / 输出截断 / 权限申请 / 用户选择
- [ ] **P3-6** ⚠️ [验证] 若将来要自研桌面端：三个坑必须避开 ⏱️仅备查
  - **绝不能用 `file://`**（`Origin: null` → `new URL("null")` 抛错 → 403）
  - **端口必须钉死 3080**（cookie 绑定 `host:port`，换端口即失效）
  - 原生 WS 客户端须**自己答 Ping**（2s 间隔）
  - ❌ 不要走 SDK / ACP（拿不到实时 reasoning）；✅ 走 web/API `session/follow {assistantStream:true}`
- [ ] **P3-7** 🚦 桌宠常驻、可关、不影响正常使用，且分工清晰（不与 galgame 播放器重叠）

## Phase 4 — 局域网与多端（**纯 Web 能力，与桌宠无关**）

> 🔑 **定位（v0.3.1 澄清）**：手机/平板用**浏览器访问响应式网页**，**不做成桌宠**。
> 桌宠设置面板只是**放开关的地方** → 本阶段实现**不调用 `dsh-pet` 任何东西**，桌宠没装也必须可用。

### 4.1 局域网开关（⚠️ 不是即时生效）

- [ ] **P4-1** [自研] 局域网开关（写 patch + 提示重启）⏱️4h
  - ⚠️ **无法即时生效**：运行中的 `dsh web` 不能改绑定地址（socket 已绑定）
  - ⚠️ **CLI 硬拒绝 `0.0.0.0`**（`dsh-web-app/lib/startup.js:40`）→ 只能走 **patch 层**
  - 覆盖 `webserver` 行的 `config.host = '0.0.0.0'`
    ⚠️ **id 定向 patch 不做深合并 → 必须重述整个 config**
  - 流程：写 patch → **明确提示"需重启生效"** → 提供「一键重启」
  - ⚠️ web profile `patchReload: live`，改 patch 可能立即触发重载（待实测 V16）
- [ ] **P4-2** 🔒 [自研] **安全门槛（不可省）** ⏱️3h
  - [ ] 明确展示风险文案：**同网段可执行任意命令**（不是隐蔽小字）
  - [ ] 显示将要暴露的地址
  - [ ] **首次开启需显式确认**（不是默认勾选）
  - [ ] 提供**一键关闭**
  - [ ] **优先引导走反代 + TLS**，而非裸 `0.0.0.0`（见 plan.md §5 的方案 1/2）
  - [ ] 建议同时提示 Windows 防火墙仅放行私有网络
- [ ] **P4-3** [验证] 手机实测局域网访问 ⏱️30min
  - 注意：**非 HTTPS 下 `crypto.randomUUID` 有 fallback**，但**语音输入不可用**、**PWA 装不上**
- [ ] **P4-4** 🚦 局域网开关可用 + 安全门槛齐备 + 可一键关闭

### 4.2 响应式与多端

- [ ] **P4-5** [自研] `viewport-fit=cover` 已在 P2-16 完成 → 验证 safe-area 生效 ⏱️15min
- [ ] **P4-6** [插件][验证] 先复用现成移动端插件 ⏱️1h
  - `dsh-web-mobile`(3.0.3,105★) / `dsh-mobile-hanui`(1024px 断点+PWA) / `dsh-webui-mobile`
  - ⚠️ 多个移动端插件会改同一批槽位 → **只能留一个**
- [ ] **P4-7** [自研] 平板中间断点（768–1024）⏱️4h
  - 现状：1024 阈值会把竖屏平板当窄屏，但中栏其实有 ~768px
  - **公认空白 → 有价值的自研点**；目标：横屏双栏、竖屏单栏
- [ ] **P4-8** [自研] 折叠屏适配 ⏱️1d
  - `env(viewport-segment-*)` / `screen-spanning` 双屏布局 + 铰链 gap
  - **先验证 V8 实际支持度**（已确认代码库 0 处使用）
- [ ] **P4-9** [自研][可选] PWA（manifest 已有，**缺 Service Worker**）⏱️4h
  - ⚠️ **PWA 必须 HTTPS**（与 4.1 的安全要求一致）
  - 可复用 `dsh-mobile-hanui` 的实现思路
- [ ] **P4-10** [验证] 触屏修复 ⏱️2h
  - `DragHandle` **无 `touch-action`** → 触屏拖把手会同时滚页面
  - composer 缺 `enterkeyhint`；软键盘不驱动视口高度；无 ≥44px 触控目标规范
- [ ] **P4-11** [自研][可选] CLI/TUI 接入 ⏱️1d
  - 先试 `@tomowang/dsh-tui`（peer `^0.1.7-rc.2`）或 `@deepseek-harness-tui/dsh-tui`(3734★)
  - 自建需新前端 + 新 profile bundle，复用 `ctx.remote` / `ctx.cmdlineArgs` / `ctx.locale`
- [ ] **P4-12** 🚦 手机 / 平板 / 折叠屏 / 桌面 四种形态实测通过

---

## Phase 5 — 启动器（解压即用 exe）

> 完整设计见 **[LAUNCHER.md](LAUNCHER.md)**。**不是 MVP 的一部分**，排在 R0/R0b 之后。
> 选型 **Electron**（与 `dsh-pet` 同栈）。⚠️ **不要做成"另一个 DSH 客户端"** —— 只做引导 + 承载。

### 6.1 环境检测与引导
- [ ] **P5-1** [自研] 环境探测 ⏱️4h
  - Node ≥20 / npm / **dsh** / 端口占用 / 网络可达
  - 🔴 **实测事实**：本机 `dsh` **只在 npx 缓存**（`..._npx\<hash>\node_modules\.bin\dsh.ps1`），
    `%APPDATA%\npm` 下**无全局安装** → **不能假设 `dsh` 命令存在**（L3）
  - ⚠️ **版本不匹配只提示，不阻断**（实测"版本双镜像"：磁盘 `0.2.0-rc.2` + 运行中旧版进程）
- [ ] **P5-2** [自研] 环境引导 UI ⏱️4h
  - 用人话说明**缺什么**（不是抛 stack trace）
  - 给**可点击的官方下载链接**
  - **"我已装好，重新检测"** 按钮
  - 可折叠的**原始命令与原始输出**（便于求助时贴出）
  - 允许**跳过检测**直接尝试启动（高级用户）
- [ ] **P5-3** [自研] dsh 缺失时的两条路（**让用户选，不替他决定**）⏱️3h
  - **A（默认）** `npx --yes @deepseek-ai/dsh` —— 零安装、不污染全局；⚠️ 首次慢、依赖网络
  - **B（显式选项）** `npm install -g @deepseek-ai/dsh` —— 后续快，但改全局环境
- [ ] **P5-4** 🚦 在一台**干净环境**上验证引导流程（或手动清空 PATH 模拟）

### 6.2 启动与承载
- [ ] **P5-5** [自研] 拉起 DSH —— **按级联回退**（⚠️ 按维护者实际用法设计）⏱️6h
  - 🔑 **维护者实际用 `npm run deepseek`，不是全局 `dsh` 命令** —— 启动器不能只认一种方式
  - 级联顺序：
    ```
    ① npm run deepseek                             ← 首选
    ② 读 package.json，有 start 则 npm run start     ← 回退
    ③ npm 不存在 → 引导安装（浏览器打开 nodejs.org）→ 一键重试
    ④ dsh 不存在 → npx --yes @deepseek-ai/dsh web
    ```
  - ⚠️ **`npm run`（不带脚本名）会打印脚本列表并以 0 退出，不报错** → 第②档必须
    **读 `package.json` 判断 `start` 是否存在**，而不是裸跑 `npm run`（L12）
  - ⚠️ **忠实转发参数，不硬编码**：若用户的 `deepseek` 脚本自带端口/profile/workspace，
    启动器应尊重它（L10）
  - ⚠️ **带超时**（如 90s）等 stdout 出现 `dsh web: http://127.0.0.1:<port>/?token=<t>`
  - 🔴 `npx` 有 `ECOMPROMISED: Lock compromised` 的**实战记录** → 必须重试（退避）+ 清晰报错（L2）
- [ ] **P5-5b** [自研] 确定**工作目录**（级联的前提）⏱️3h
  - `npm run <script>` **必须在含该 script 的 `package.json` 所在目录执行**
  - 实测：`Documents`/`Desktop`/`Downloads`/用户根目录下**都没有**定义 `deepseek` 的 `package.json`
    → 它在用户自己的项目目录里，**启动器无从猜测**（L11）
  - 方案 A（推荐）：首次启动让用户**选择项目目录**并记住，支持多目录
  - 兜底：若该目录没有 `deepseek`/`start` 脚本 → 用内置脚本直接起 `dsh web`
- [ ] **P5-6** [自研] 同源载入界面 ⏱️3h
  - **持久 partition** 先 `loadURL(tokenizedUrl)` → 服务端 `303` + `Set-Cookie`
  - 再载入 `http://127.0.0.1:<port>/`
  - ⚠️ **禁止 `file://`**（`Origin: null` → 403）
  - ⚠️ **cookie 绑定 `host:port`** → 换端口 cookie 全废（L4）
  - ⚠️ token 兑换硬要求 `pathname === "/"` → 不支持子路径挂载
- [ ] **P5-7** [自研] 托盘 + 生命周期 ⏱️4h
  - 托盘图标、最小化到托盘、子进程监控
  - 🔴 **退出时必须优雅关闭 dsh 子进程树**（Windows 用 `taskkill /T`）→ 不留孤儿占用 3080（L8）
  - 崩溃时提示 + 一键重启，保留日志
- [ ] **P5-8** [自研] 失败处理（**任何失败都要可诊断，不能白屏**）⏱️3h
  - 环境缺失 → 引导页
  - token 超时 → 展示已捕获 stdout + "打开浏览器手动查看"
  - 端口占用 → 提示 + 换端口选项（注意 L4）
  - 界面 401/403 → 说明 token 兑换失败

### 6.3 跨平台与发布
- [ ] **P5-9** [验证] Windows 适配 ⏱️4h
  - `dsh` 是 `.ps1`/`.cmd` 包装 → 试**直接调 `node <bin.js>`** 是否更稳（L3）
  - Node 路径取 `C:\Program Files\nodejs\node.exe`（实测）
  - `%APPDATA%\npm` 与 npx 缓存两种位置都要找
- [ ] **P5-10** [验证] Linux 适配 ⏱️4h
  - ⚠️ **无图形会话**时降级（`dsh-pet` 已有先例：无 `DISPLAY`/`WAYLAND_DISPLAY` 时跳过窗口）
  - AppImage 或 tar.gz；**不要依赖系统 Electron**（L7）
- [ ] **P5-11** [验证] macOS 适配 ⏱️4h
  - `.app` 打包 + **未签名会被 Gatekeeper 拦** → 引导用户信任（L6）
  - ⚠️ **webm alpha 在 WKWebView 不兼容**（黑底）→ 需 HEVC `.mov` 素材
- [ ] **P5-12** [自研] Release 打包与校验 ⏱️4h
  - `win-x64.zip` / `linux-x64.tar.gz` / `macos-*.zip`
  - `SHA256SUMS`
  - ⚠️ 未签名 exe 会被 SmartScreen 拦 → README 需说明"仍要运行"
- [ ] **P5-13** [验证] **避免与 `dsh-pet` 各自拉一份 Electron**（L5）⏱️2h
  - 验证它能否复用启动器自带的运行时；不能则记录冲突与取舍
- [ ] **P5-14** 🚦 三平台至少**一个**能"解压 → 双击 → 可用"

---

## Phase 6 — 可维护性

- [ ] **P6-1** 钉死插件版本与 peer 范围，写清豁免记录 ⏱️1h
- [ ] **P6-2** 编写 DSH 升级演练脚本 ⏱️4h
  - 升级前：备份 → 兼容预检 → 启动验证
  - 出问题：一键回滚（`package.json` + `pnpm-lock.yaml` + `compatibility.json`）
- [ ] **P6-3** 建立 `skippedBundles` 监控 ⏱️2h
  - 每次启动自动检查并提示，避免"插件静默失效"
- [ ] **P6-4** 上游跟进机制 ⏱️持续
  - 若 R2a（折叠）或 R2d（galgame）被官方收纳 → 删掉自研部分
- [ ] **P6-5** 整理 `research/` 为可分享的调研结论 ⏱️2h
  - 目前 `registry-snapshot.json` 5.1MB，考虑只留筛选后的子集
- [ ] **P6-6** 发布流程 ⏱️2h
  - 首个 `v0.1.0` tag + Release 说明（模板见 [`.github/REPO-METADATA.md`](.github/REPO-METADATA.md)）
  - 按该文件的检查清单填好 GitHub 的 Description / Topics / Social preview

---

## 关键路径（最短可用闭环）

```
P0-0 重启 ──► P0-1 备份 ──► P1-14 装 dsh-pet（含版本豁免）
   │
   └──► ★ P2-5 确认 mode=timed ──► P2-6/7 问题收发 ──► P2-8 推送+降级 ──► P2-9 验收 R0
                                        │
                                        └──► P2-10/11/12 进度采集+映射 ──► P2-14 验收 R0b
                                                    │
                                                    └──► P2-15 设置页 ──► P2-18 ★ MVP 达成
```

**最小可用版本（MVP）= P0-0 → P0-1 → P1-14 → P2-5 → P2-6/P2-7 → P2-8 → P2-9 → P2-10~P2-12 → P2-15 → P2-18**

> **MVP 的定义**：**不打开浏览器**就能收到 agent 的提问、点一下回答、并随时看到进度。
> Phase 2b（显示模式 / galgame / 输出长度 / 进度气泡）、Phase 3 剩余项、Phase 4 **全部可延后或砍掉**，不影响 MVP 成立。

---

## 立即可做的五件事

1. **P0-0 重启 `dsh web`** —— 磁盘已是 0.2.0-rc.2，进程还是 09-28 的旧版内存镜像（5 分钟）
2. **P0-1 备份 profile** —— 成本最低、收益最高（5 分钟）
3. 🔴 **P2-5 确认 `tool-ask-user.mode` 是不是 `timed`** —— **这是整个核心功能的前提**，20 分钟：
   ```sh
   dsh --profile web --dump-config | Select-String -Context 0,6 'tool-ask-user'
   ```
   默认是 `legacy`（阻塞式）→ 若是，你不在场时 agent 会**干等**，且问题不进可回答投影。
4. 🔴 **P1-14 装 `dsh-pet` 并处理版本闸门** —— 唯一的高危未知项：
   ```sh
   dsh plugin --profile web add dsh-pet
   # 若被拒：
   dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk
   ```
5. **测 V12**（仅当要做 galgame 时）：dump 一条旧消息的 `assistant/message.stream` 字段 → 20 分钟

---

## 待验证清单（A = 核心效率 / L = 启动器 / V = 通用）

### A 系列（阻塞核心功能，优先验证）

| ID | 问题 | 阻塞什么 | 状态 |
|---|---|---|---|
| **A1** | **`tool-ask-user.mode` 是 `timed` 还是 `legacy`？** 默认是 `legacy`（阻塞） | 🔴 **整个 R0 的前提** | ⬜ **P2-5 最先做** |
| **A2** | 超时后的 `continued` 问题，`answer()` 在本部署下真能 steer 回 agent？ | R0 核心场景（离开后补答） | ⬜ |
| **A3** | `user-questions/request` 在客户端插件里的**具体挂钩点**（槽位/服务名） | P2-6 实现 | ⬜ |
| **A4** | 档位 C 的观察者会话如何隔离（子代理 / 独立会话 / 只读日志） | 档位 C 可行性 | ⬜ |
| **A5** | 非 loopback 下设置存储方案 | 远程体验 | ⬜ |
| **A6** | `dsh-pet` 能否被**喂入自定义状态**，还是只能用它的内置探测 | P2-8 信号映射方式 | ⬜ |

### L 系列（启动器专属）

| ID | 问题 | 阻塞什么 | 状态 |
|---|---|---|---|
| **L1** | `npx --yes @deepseek-ai/dsh web` 的 stdout 格式是否稳定、token 抓取是否可靠 | 启动器核心机制 | ⬜ |
| **L2** | `npx` 的 `ECOMPROMISED: Lock compromised` 频率与重试策略 | 启动成功率（**已在本机实际遇到**） | 🟡 已观察到，策略待定 |
| **L3** | Windows 上 `dsh` 是 `.ps1`/`.cmd` 包装，直接调 `node <bin.js>` 是否更稳 | 跨平台稳健性 | ⬜ **实测：本机 dsh 只在 npx 缓存，无全局安装** |
| **L4** | 端口被占用时换端口对 cookie 的影响（cookie 绑定 `host:port`） | 可用性 | ⬜ |
| **L5** | `dsh-pet` 能否复用启动器自带的 Electron 运行时 | 避免双份 Electron | ⬜ |
| **L6** | macOS 未签名 `.app` 的实际拦截行为 | macOS 发布 | ⬜ |
| **L7** | Linux 无图形会话下的降级行为 | Linux 支持 | ⬜ |
| **L8** | 退出时子进程树是否被可靠清理（Windows 尤其） | 不留孤儿进程占用 3080 | ⬜ |
| **L9** | 干净环境（无 Node / 无 dsh）下的引导流程是否真的可走通 | 非开发者能否自助 | ⬜ |
| **L10** | **`npm run deepseek` 脚本的实际内容** —— 是否等价于 `dsh web`？是否自带端口/profile/workspace 参数？ | 决定启动器**忠实转发**还是自己拼参数 | ⬜ **需维护者确认** |
| **L11** | 用户项目目录的**选定与记忆**方案 | 首次启动体验 | ⬜ |
| **L12** | `npm run` 无参数会打印脚本列表并以 0 退出（**不报错**） | 级联第②档的正确判定方式 | ✅ 已确认行为，实现需读 `package.json` |

### V 系列（通用）

| ID | 问题 | 阻塞什么 | 状态 |
|---|---|---|---|
| V1 | 候选**第三方**插件在 0.2.0-rc.2 上是否被 peer 检查拒绝 | Phase 1 全部 | 🔴 **`dsh-pet` 高危已确认**（peer 全为 `^0.1.1-rc.2`）→ **第一优先级实测**。自研插件不声明 peer 可完全绕过 |
| V2 | `transcriptView` 4 档行为边界；新增"藏正文"字段能否只改一个 policy 对象 | P2-19 工作量 | 🟡 已定位 `POLICIES`(`chat/lib/client.js:12013`) + `ChatPresentationPolicy`，**未实测渲染改动** |
| V3 | 能否拿到 reasoning 增量事件 | P2-19 精度 | ✅ **已确证分离**：`'reasoning-delta'`、`kind:'reasoning'`、`thinkingDetail`/`outputDetail` 是两个独立字段 |
| V4 | 前端拿到 token 增量还是整段消息 | P2-23 播放器形态 | ✅ **已确证 token 级**：`AssistantLiveChunkEvent.data.chunk: StreamChunk` |
| V5 | bind flag 能否解决 R4 | — | ✅ **已结案：不能，改为 loopback + SSH/VPN/反代**。且 **R0 成立后 R4 降级为加分项** |
| V6 | 非安全上下文缺哪些 Web API | 是否必须 HTTPS | 🟡 **部分结案**：`randomUUID` 有 fallback；裸调用仅 1 处；**语音输入需 HTTPS**；**无 SW → 不能装 PWA** |
| V7 | `@linxin666/dsh-web-all` 全家桶是否值得采用 | 可能一次性解决多项 | ⬜ |
| V8 | 折叠屏支持度 | P4-1 | ✅ **已结案：完全空白**（只有 1024/768 断点，无 `viewport-segments`/Device Posture） |
| V9 | Tauri 透明置顶窗在 Windows 的行为 | — | ✅ **已不再需要**（dsh-pet 的桌面模式已覆盖） |
| V10 | patch 覆盖 `webserver.config.host` 是否生效 | 方案 3 前提 | ⬜ **用 `--dump-config` 验证，不要直接启动** |
| V11 | web profile 默认 fs/sandbox 配置 | 安全评估精度 | ⬜ |
| **V12** | **wire schema 是否完整保留 `assistant/message.stream`** | **决定 galgame 历史重放成本** | ⬜ **P2-21 动手前必须测** |
| **V13** | 现成移动端插件如何绕过"JS 内联列宽 + root 槽独占" | 决定 Phase 4 是抄还是自己动 `AppFrame` | ⬜ |
| **V14** | `ui-layout` 的 class 名在 DSH 升级后是否变化 | 决定 `!important` 覆盖方案的寿命 | ⬜ |
| **V15** | `shell.overlay` 的 z-index / containing block | — | ✅ **已降级**：dsh-pet 已实测可用，是现成范例 |
| **V16** | `dsh.profile.patchReload` 是否为死字段 | 影响"改 patch 是否实时生效"的预期 | ⬜ 改 patch 观察是否热重载 |
| **V17** | 官方 Electron Desktop 的实际 preload/IPC 协议 | — | ⬜ 低优先级（**不需要**） |
