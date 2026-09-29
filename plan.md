# DSH 效率助手 —— 项目规划

> 版本：**v0.3（效率定位修订稿）**
> 日期：2026-09-29
> 状态：**仅规划，未开工**。所有结论均来自对运行环境的实测与官方/社区包的源码级实读，未验证项集中在 §8。
> 环境基线：`dsh` **0.2.0-rc.2**（npx 安装）、Node v24.13.0、pnpm 12.6.0、cargo 1.80.0 + WebView2 153.x、profile `web`、Web GUI `http://127.0.0.1:3080`（**仅监听回环**）。
>
> 🎯 **项目定位（v0.3 修订）**：**效率导向**。核心痛点是"agent 提问时你不在网页前，任务干等"。
> 桌宠只是**不打开网页就能看到提问与进度**的载体；**桌宠属性与 galgame 都是可选交互模块，不是主要内容**。
> 详见 [README.md](README.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md)。
>
> ⭐ **桌宠已选定模板：[`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)**（npm `dsh-pet@0.2.12`，832★）。它**自带 Electron 透明置顶窗桌面模式** + `shell.overlay` 网页浮层 + 六档工作状态联动 + 完整素材链 → **本项目不再需要自研 Tauri/Electron 薄壳**（详见 §4.2）。
>
> ⚠️ **版本双镜像（已实测确认，务必知悉）**
> - **磁盘上全部 278 个 `@deepseek-ai/dsh-*` 包 = `0.2.0-rc.2`**（mtime 均为 2026-09-29 11:31:59）。非 `@deepseek-ai` 的包（cordis 4.0.4、schemastery 3.18.4 等）另有版本，正常。
> - **正在运行的 GUI（PID 127888）启动于 2026-09-28 13:45**，而包在 **09-29 11:31** 被整体替换 → **当前进程是旧版内存镜像，磁盘是新版**。
> - 本调研的所有源码引用均取自**磁盘（0.2.0-rc.2）**；所有引用的包在报告写就时已是新版（早期简报里的 `0.1.7-rc.2` 是我的笔误，已更正）。
> - ⚠️ **实际影响**：进程在 11:31 之后若惰性加载被替换掉的旧文件，可能 ENOENT。**重启 `dsh web` 是任何 Phase 1 改动前的必要步骤**（也让"当前看到的行为"与"磁盘代码"对齐）。已实测当前 GUI 仍健康（`/` 返回 401 = 认证正常）。

**配套文档**
- [README.md](README.md) —— 项目介绍（效率定位、核心能力、进度档位）
- [ARCHITECTURE.md](ARCHITECTURE.md) —— 技术设计（提问-回答管线、进度来源、token 成本）
- [LAUNCHER.md](LAUNCHER.md) —— 启动器设计（解压即用、环境检测、跨平台）
- [todo.md](todo.md) —— 可执行任务清单
- [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) / [NOTICE.md](NOTICE.md) —— 贡献、安全、许可
- 调研原始报告（源码级，含行号）：`research/01-plugin-architecture.md`、`02-embedding-and-sdk.md`、`03-web-lan-access.md`、`04-responsive-ui.md`、`05-display-modes.md`

### 已确认的方向性决策（v0.3）

| 决策 | 结论 | 理由 |
|---|---|---|
| 定位 | **效率工具**；桌宠与 galgame 是可选载体 | 真正痛点是提问触达，不是桌宠 |
| **局域网 / 手机适配** | **纯 Web 能力，与桌宠无关**；桌宠设置面板只是放开关的地方 | 手机/平板用浏览器访问响应式网页，不做成桌宠 |
| 仓库 / 包名 | 仓库 `wzqvip/dsh-app`；插件包 **`dsh-efficiency`** | 直白表达效率定位 |
| 与 `dsh-pet` 的关系 | **依赖，不 fork**（先依赖，以后再评估是否自建） | 它升级我们跟着受益；代价是需处理它装不上时的降级 → 故架构分层 |
| 优先级 | **先做 R0（提问触达）**；进度先用零成本方式 | 痛点是"任务干等"，不是"看不懂状态" |
| 分发 | **只发 GitHub，不发布 npm**；用户 `clone → build → add file:` | 避免过早处理 npm 发布细节 |
| **启动器** | **做成 exe，GitHub Release 发布，解压即用**；自动检测环境、缺失则引导配置 | 消除"装 Node + 装 dsh + 敲命令 + 终端不能关"的摩擦 |
| **启动器技术栈** | **Electron**（与 `dsh-pet` 同栈） | 复用同一运行时与经验，避免引入第二套桌面技术栈；代价是包体较大 |
| **启动器优先级** | **低于 R0/R0b** —— 它是分发/引导层，不是核心效率层 | MVP 不包含启动器；详见 [LAUNCHER.md](LAUNCHER.md) |
| 插件市场上架 | **等 MVP 跑通再上架** | 避免为未验证的功能写英文 README 与元信息 |
| 素材 | **先用 `dsh-pet` 自带素材**，只做署名 | 零素材工作量，最快验证核心功能 |
| 许可 | 本项目代码 **MIT** | 与依赖生态一致 |


---

## 0. 一句话结论

**这是一个效率工具，不是桌宠项目。**
它要解决的是：**agent 问你问题时你不在网页前，整个任务干等。**

关键发现：**官方 `ctx.userQuestions` 已经为这个场景准备好了全部机制** ——
`askTimed()` 超时后 agent 继续干活、问题仍留在会话里可答、你几小时后点一下答案照样 steer 回 agent，而且**官方明确"等待人类回答不会增加 token"**。
所以 R0（不打开网页收发提问）**不是要发明机制，而是要把已有机制接到桌面常驻层上**。

同时本项目**不要从零写桌宠 App、不要 fork DSH**：
DSH 是 cordis 插件宿主，社区已有 **4382 个**插件，桌宠载体直接用 `dsh-pet`（自带 Electron 透明置顶窗）。

**桌宠形象、galgame 逐句阅读、进度气泡都是可选模块** —— 架构上保证去掉它们，核心效率功能依然成立。

调研顺带确认的三个"被误解的事实"：
1. **现在的 Web GUI 根本没有响应式** —— 全仓只有**一个**框架级断点，且三列宽度是 **JS 内联样式**，媒体查询改不动。
2. **agent preset 不能中途切换风格** —— 官方原文 "the host refuses to swap them"，有 `agent-preset/locked`。
3. **没有任何旋钮能控制助手输出长度** —— compaction / pruner / spill 只管上下文与**工具结果**。


因此本项目定位为：**一套"展现层插件"（补上这两个空白）+ 一份可复现的安装编排 + 可选的桌宠薄壳**。

---

## 1. 需求拆解（把模糊需求变成可验收条目）

### 1.1 项目定位（v0.3 修订）

> **本项目是效率导向的。** 核心痛点是：**agent 提问时你不在网页前，于是任务干等。**
> 桌宠只是**不需要打开网页就能看到提问与进度**的载体；桌宠属性与 galgame **都是可选交互模块，不是主要内容**。

### 1.2 需求清单（★ = 优先级）

| # | 需求 | 性质 | 归属层 | 优先级 | 调研判定 |
|---|---|---|---|---|---|
| **R0** | **不打开网页即可收到 agent 提问并一键回答** | **事件+交互** | 官方 `userQuestions` + 承载层 | **★★★ 主线** | ✅ **官方机制齐备**（`askTimed`/`answer`/投影），见 [ARCHITECTURE.md](ARCHITECTURE.md) §3 |
| **R0b** | **随时看到进度**（状态/待办/工具/时长/待答角标） | 事件+UI | 客户端插件 | **★★★ 主线** | ✅ 零额外 token，信号齐备 |
| R2a | 可选「完整过程」/「只显示思考中」 | UI 状态 | 客户端插件 | ★★ | 🟡 **一半已存在**（内置 4 档），缺"藏正文"档 |
| R2b | 输出写入文件 | 宿主能力 | 宿主 | ★★ | 🟡 已有 `/export`（ZIP），**缺"写宿主机任意路径"** |
| R2c | 输出长度可设置（简短/长） | 模型行为 | system prompt 分段 | ★ | 🟡 无输出长度旋钮，只能提示词注入 |
| R5 | 自适应手机/电脑/平板/折叠屏/CLI | 响应式+多前端 | 客户端插件/新前端 | ★★ | ❌ 框架级响应式不存在；CLI 需新建前端。**纯 Web 能力，与桌宠无关** |
| R4 | 局域网开放给其他机器 | 网络+安全 | 反向代理/隧道 | ★ | 🟡 **不能靠 bind flag**，见 §5。**纯 Web 能力**；设置面板只是放开关的地方 |
| — | 桌宠形象（载体） | UI | `dsh-pet` | ★ 可选 | ✅ **已选定模板，零自研** |
| R2d | galgame（点一下下一句，按住快进） | UI 播放器 | 客户端插件 | ★ 可选 | ❌ 完全不存在，必须新建 |
| R3 | 保留网页，点一下打开网页 | — | — | ★ 可选 | ✅ 零开发 |
| — | **进度气泡（独立观察会话）** | **模型行为** | 独立会话 | ★ 可选 | ❌ 需新建；⚠️ **消耗额外 token，默认关闭** |

### 1.3 四个必须分层的事实

1. **R0/R0b 是主线，且彼此独立于全部可选模块**。
   架构上必须保证：**关掉桌宠、关掉 galgame、关掉进度气泡，R0/R0b 依然完整可用**（见 [ARCHITECTURE.md](ARCHITECTURE.md) §2）。
2. **R4/R5（局域网与多端）是纯 Web 能力，与桌宠无关**（v0.3.1 澄清）。
   手机/平板走**浏览器访问响应式网页**，不做成桌宠；桌宠设置面板只是**放开关的地方**。
   → **桌宠没装/装不上时，R4/R5 也必须可用**（它属于 L0 宿主能力的开关）。
   ⚠️ 但"一键开局域网"**不是即时生效的开关** —— 需改 patch + 重启，且必须带安全门槛（见 §3 的 R4/R5）。
3. **R2c 与"进度气泡"同属模型行为层**（要花钱），而 R2a/R2d 是纯前端渲染层（不花钱）。
   混在一个设置项里会导致"改显示风格却烧了 token"。
4. **R0 可以显著降低 R4 的紧迫性**。
   你原本需要局域网访问，很大程度是因为"必须在网页上回答问题"。
   一旦 R0 成立（桌面常驻层直接收发），**远程访问从"刚需"降级为"加分项"**，而 R4 是本项目**风险最高**的部分（§5）。

> **落地顺序（已确认）**：先做 R0（价值最高、成本最低、风险最小），R0b 顺带用零成本方式做，其余再谈。


---

## 2. DSH 真实架构（实测）

- `dsh` 是**唯一受支持的启动器**；SDK 与 ACP 都只是 profile，不是独立可执行命令。
- 配置树叠加顺序：`bundle 的 patch` → `profile/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`。
- 一个 npm 包**同时**承载宿主插件与客户端插件：主入口 = Node 侧，`./client` 导出 + `dsh.client` = 浏览器侧。
- profile 目录：`C:\Users\WANGZ\.dsh\profiles\web`；当前 bundles = `dsh-base` / `dsh-web-app` / `dshmarket`；`patchReload: live`（**改 patch 会实时重载**）。
- `desktop` 名字**被保留给 Electron 持有的 profile**，CLI 拒绝管理它 → 官方预留了桌面形态，且已有多个社区 Tauri/Electron 客户端在消费。

### 2.1 插件契约（**已完全摸清**，可直接开工）

**Host 插件** = 标准 Cordis 插件：
- 具名导出 `apply(ctx, config)` + `inject: string[]`（**服务名，不是包名**）+ 可选 `name`、schemastery `Config`
- **没有 default export**

**Client 插件** = `lib/client.js` 必须是这个形状：
```js
window.__ModuleLoader__.load({
  id: "<npm 包名>",
  factory: (require) => { /* … */ return module.exports }
})
```
- factory 内同样导出 `apply(ctx)` / `inject` / `name`
- **惰性 CJS**：执行只注册 factory，副作用（含 CSS 注入）在**物化时**才跑
- 基座静态模块表已含 `react` / `react-dom` / `jsx-runtime` / `cordis` / `ui-primitives` / `client-store` → **直接 `require`，`external` 留空即可**（theme 与 dshmarket 都这么做）

**`dsh` 字段全集**（权威：`dsh-package-manifest/lib/types/types.d.ts`）：
`manifestVersion` / `bundle.patch` / `profile.bundles` / `client.{platform,inject,immediately,external}`
→ **没有 host 侧专用字段**。
⚠️ `dsh.client.inject` 是**信息性包名依赖**（用于拓扑排序），与模块导出的**服务** `inject` **是两回事**，极易混淆。
Client 入口靠 `exports["./client"]` + `dsh.client.platform === 'web'` 发现；Host 经 `/plugins/<pkg>/client.js?rev=<mtime,ctime,size 派生>` 提供。

### 2.2 客户端 UI 扩展点（已确认）

| 扩展点 | 用途 | 证据 |
|---|---|---|
| **`shell.overlay`** | **全应用浮层**（桌宠的正确席位）。官方原文："frame-wide floating layer, above every column… **click-through until your entry opts into pointer events**" | `dsh-client-ui-layout/lib/types/client/index.d.ts:75-88` |
| `conversation.view` | 新增与 Chat 并列的会话页签（**galgame 播放器推荐落点**） | Trajectory 即此实现 |
| `conversation.chat.node`（keyed） | **接管某类消息节点渲染**；key = `ChatNodeKind` | `chat/lib/types/client/contract/slots.d.ts:163` |
| `settings.section` | 加**整页**设置 |
| `settings.general.item` | 加设置**单行**（chat 的 `transcriptView` 即此） |
| `plugins.bundle.config` | 插件配置卡 |
| `webserver/index-inject` | 注入 `<style>` / `<meta>` 到 index.html | `dsh-host-webserver/lib/types/injections.d.ts:13-51` |
| `ctx.theme.overrideTokens()` / `register()` | 改/加 `--dsw-*` token | `theme/lib/types/client/index.d.ts:161-178` |
| `ctx.locale.addLanguage()` / `register()` | 加语言（**zh 已内置**） | `dsh-client-locale/README.zh.md:48-64` |

**关键 `ChatNodeKind`**：`assistant-step`（**流式增量就在这里**）、`tool-call`、`turn-process`、`user`、`context`、`system-prompt`、`turn-tail`、`turn-error` 等 15 个 key。

**两条硬约束**：
- ⚠️ **`root` 槽位被 ui-layout 独占，且类型注释明确禁止注册**（会 shadow 掉整个 AppFrame）→ 插件**无法从外部替换布局**。
- ⚠️ **版本自适应必须靠 `ctx.slots.inject(slot, cb)` 探测槽位是否存在，不要比版本号**（dshmarket 的 `settingsScope`→`settings` 改名事故即教训）。

### 2.3 观察 trajectory 的正确方式

session scope 的标准 props **直接给**：
- `useTrajectory()` → 内含 `partial`（**流式助手增量**）、`runningCalls`、`eventNodes`、`requests`
- `useSession()`、`useProjection(key)`、`useSessionStatus()`

### 2.4 Host↔Client RPC（**重要结论**）

- ❌ **Typert Remote（`ctx.typertGateway`/`ctx.remote`）第三方插件走不通** —— 需要 monorepo 内部 codegen 与 `dsh-api-remotes` 构建期装配。
- ✅ **唯一被真实第三方验证的路径**：
  - Host：`ctx.inject(['webServer'], c => c.effect(() => c.webServer.register({ kind:'exact', path:'/my/api/x', handler })))`
  - Client：同源 `fetch(new URL('my/api/x', document.baseURI).pathname)`（cookie 自动带，Host/Origin 围栏已处理）
  - 该模式由 **dshmarket 的 40+ 个路由实例**验证
  - ⚠️ Host 侧**不要用 `ctx.provide`**（未读到直接调用点），改用 `Service` 子类；客户端侧 `ctx.provide(name, value)` 已实证。

> 这对 R2b（写文件到指定路径）很关键：`/export <path>` 目前**明确报错**（官方 README 承认需要"新端点契约"）→ 要支持写宿主机任意路径，**必须新建宿主路由**。

---

## 3. 生态现状：你要的每件事都有人做过（4382 插件）

> 完整清单与筛选依据见 §12 附录；registry 快照存于 `research/registry-snapshot.json`。

### R2a 完整过程 / 只显示思考中
| 插件 | 版本 | 星 | 说明 |
|---|---|---|---|
| **内置** `ui-chat.transcriptView` | — | — | 设置 → 通用 → **"工作步骤展示"**，4 档 `compact/standard/detailed/verbose` |
| `dsh-auto-collapse` | 0.2.1 | 64 | Codex 风格：回合收一行「已处理 X秒」，思考/工具折叠为 chip，**卸载完整还原**，依赖极干净 |
| `@winteries/dsh-turn-fold` / `dsh-turn-fold` | — | 12/13 | 折叠栏 + 耗时/首字/token 指标 |
| `dsh-annotation` | — | 4 | 设置里**隐藏指定思考或工具详情** |

### R2b 写入文件
| 能力 | 说明 |
|---|---|
| **内置 `/export`** | 下载 `dsh-session-<id>.zip`（宿主路由 `GET /api/session.export`） |
| **可复用 API** | `serializeSessionLog()`、`readSessionLogText()`、`sessionLogZipEntries()`、`streamSessionLogZip()`（`dsh-session-log-export/lib/types/archive.d.ts`） |
| **原子写** | `writeFileAtomic(filename, content, {mode})`（`dsh-atomic-write`，**直接 import，不是 cordis 服务**） |
| `notes` / `dsh-timeline` / `dsh-bookmarks` | 便签 PNG / 导出对话 / 一键导出 Markdown |

### R2c 输出长度
- **没有任何旋钮影响助手散文长度**（已逐一排除 `compaction-basic`、`tool-result-pruner`、`output-retention`、`spill-policy` —— 它们只管上下文与**工具结果**）。
- `dsh-agent-loop` Config 只有 `maxParallelToolCalls` + `agents`，**没有 maxTokens/temperature/verbosity**。
- **可行路径**：`ctx.systemPrompt.section({name, order, text: ({scope}) => …})` —— `text` 每次 assembly 求值，**运行时可切换**（代价：打断 provider KV cache）。
- ⚠️ **`dsh-persona` 字段过于简单**（`prefix/suffix/complete`），且是 scope-only，只在 preset 内生效。
- ⚠️ **agent preset 不能用于中途切换风格**：官方原文 "only available before a conversation starts... the host refuses to swap them"，有 `agent-preset/locked` 错误码。

### R2d galgame 逐句播放
- **不存在**。全库 `typewriter`（唯一命中是 PDF worker 源码字符串）、`stepwise`、`step-through`、`fast-forward`、`pauseStream`、`resumeStream` **全 0 命中**。
- ⭐ **但 dsh-pet 提供了可直接复用的"逐字播放"先例**：它的碎碎念/对话回复就是**说话动画 + 气泡**的呈现，且**工作状态气泡会随状态打字机式变化**。虽然它不是"正文逐句播放器"，但**气泡组件 + 动画联动**这部分可以直接借用/参照。
- **基础设施完备**：客户端**确实收到 token 级 delta**（`AssistantLiveChunkEvent.data.chunk: StreamChunk`；wire 帧 `SessionAssistantStreamFrame{type:'chunk'}`）；且会话日志里存了**带真实时间戳的完整 chunk 流**（`AssistantStreamRecord` 含 `dt` 相对时间增量数组），`expandAssistantStream()` 可精确还原每个 delta 边界 → **"逐字重放历史回答"有完整数据支撑**。
- 参照物：`dsh-whale-galgame`（0.4.1，31★，多角色 + 好感度 + CG 图鉴）、`dsh-nexttavern`（119★，独立酒馆阅读 TAB）、`dsh-status-rotator`（92★，打字机实现）。
- ⚠️ **注意区分**：那些是"角色扮演游戏壳"，你要的是"**把正常 agent 输出逐句播放的阅读器**"。
- ⚠️ **流本身无法真正暂停**（无 pause/resume 协议），只能是"前端延迟揭示"。
- 💡 **定位澄清**：`dsh-pet` 的气泡是"**宠物说的话**"（碎碎念/对话，记忆独立于会话）；R2d 的播放器是"**agent 正文的呈现**"。**两者定位不同，应并存而非合并。**

### R4 局域网
见 §5（这是最需要谨慎的部分）。候选：`@wingsky-1/dsh-lan-proxy`、`@linxin666/dsh-remote-web-ui`、`dsh-mobile`、`dsh-web-lan-access`、`ds-harness-remote`（**只读 ApiProxy，最保守**）、`dsh-tether`、`dsh-bridge`。

### R4/R5 局域网与多端（**已澄清：纯 Web 能力，与桌宠无关**）

> 🔑 **定位澄清（v0.3.1）**：局域网/手机访问是**网页端**的能力 —— 手机/平板用浏览器访问**响应式网页**，**不做成桌宠**。
> 桌宠设置面板只是**放这个开关的地方**，不是一个"桌宠功能"。
> 因此它与桌宠**彻底解耦**：**桌宠没装/装不上时，这个能力也必须可用**（它属于 L0 宿主能力的开关）。

#### 响应式现状（源码级复核）

| 目标 | 现状 | 缺失 |
|---|---|---|
| 手机 | 3 处 `@media (width<=400/480)` 微调；7 处 `pointer:coarse` | **无 `viewport-fit=cover`** → safe-area 全废；三列仍在；无抽屉/汉堡/底部栏；composer 无 `enterkeyhint`；软键盘不驱动高度 |
| 平板 | 1024 阈值会收起左栏 | **无"中等"档**（768–1024），竖屏平板被当窄屏 |
| 折叠屏 | `@container` 会随中栏变宽自动生效 | **0 处** `viewport-segment-*` / `screen-spanning`；无铰链 gap/padding 概念 |
| CLI | `ctx.remote`（React-free RPC）、`dsh-cmdline`、`dsh-client-locale` 可复用 | **无 TUI 前端**；无 ink/blessed；无 `tui` profile；`dsh --profile tui` **只是 README 举例** |
| 触屏 | 7 处 `pointer:coarse` | **`DragHandle` 无 `touch-action`** → 触屏拖把手会同时滚页面；无 ≥44px 触控目标规范 |

**现成移动端插件**：`dsh-web-mobile`(3.0.3,105★)、`dsh-mobile-hanui`(1024px 断点 + PWA)、`dsh-webui-mobile`、`dsh-mobile`(333★)、`dsh-zen-remote`。
**现成 TUI**：`@tomowang/dsh-tui`(0.9.0，peer `^0.1.7-rc.2`)、`@deepseek-harness-tui/dsh-tui`(0.11.2,3734★)。

#### ⚠️ "设置面板一键开局域网"的真实形态

这个开关**不是"点了立刻生效"**，因为：

1. **运行中的 `dsh web` 无法在运行时改绑定地址** —— socket 已绑定
2. **CLI 硬拒绝 `0.0.0.0`**（`dsh-web-app/lib/startup.js:40`，理由原文："it would expose remote code execution to the network"）
3. 可行路径是**改 patch 层**：id 定向覆盖 `webserver` 行的 config 为 `host: '0.0.0.0'`
   ⚠️ **必须重述整个 config**（id 定向 patch **不做深合并**）
4. **改完需要重启** `dsh web`

→ **正确形态**：改 patch → 明确提示"需重启生效" → 提供一键重启。
→ **安全门槛（必须有）**：开关不能是个无知觉的复选框。必须：
   - 明确展示风险（**同网段可执行任意命令**）
   - 显示将要暴露的地址
   - 提供一键关闭
   - 推荐/引导走**反代 + TLS**而非裸 `0.0.0.0`（详见 §5）

**现成桌宠 —— ⭐ 已选定 `PC2005-cloud/dsh-pet`(832★)**，其余为对照：

| 插件 | 星 | 相对 dsh-pet 的差异 |
|---|---|---|
| **`dsh-pet`（选中）** | 832 | **唯一同时具备：网页浮层 + 桌面透明置顶小窗 + 六档工作状态联动 + 多开 + 完整素材链 + pet pack 扩展机制** |
| `dsh-whale-widget` | 3369 | 余额/用量挂件为主，动画与状态联动不如 dsh-pet |
| `dsh-live2d-pets` | 27 | Live2D 模型 + 状态镜像；**无桌面独立窗**，且 Live2D 模型素材授权更复杂 |
| `whale-girl` | 338 | QQ 宠物形态（投喂/玩耍），偏养成、无桌面窗 |
| `dsh-whale-musume` | 89 | 摸头养成、494 条台词、30 项成就；偏养成 |
| `deepseek-desk-pet` | 5 | macOS 真置顶窗、系统 Python + ctypes 零依赖；**仅 macOS** |
| `dsh-pet-bridge` | 9 | 只做状态桥（把会话状态推给 cc-pet），本身不是桌宠 |

**已存在的完整桌面客户端**（**本项目不再需要**，仅作参考）：`MochiNek0/dsh-desktop`（Tauri，自动拉起 `dsh web` 并嵌窗，2.3MB）、`anywhere-labs`(Electron)、`RyensX/dsh-app`(Tauri 2)、`dataelement/dsh-desktop`、`local-dsh`(内置 llama.cpp)。

---

## 4. 推荐架构

> 完整技术设计见 **[ARCHITECTURE.md](ARCHITECTURE.md)**。此处只给分层与归属。

```
┌────────────────────────────────────────────────────────────────┐
│ L3 可选表达层（默认可关，去掉不影响主线）                        │
│   · 进度气泡（独立观察会话，⚠️ 消耗额外 token，档位 C）           │
│   · galgame 逐句阅读（R2d）                                      │
│   · 「只显示思考中」藏正文档（R2a）                              │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│ L2 承载层（可替换 —— 用 dsh-pet，零自研）                        │
│   · 桌面透明置顶小窗（Electron 自持，走独立进程管道）             │
│   · 网页浮层 shell.overlay                                       │
│   · 六档状态动画（思考/工作/整理/等待/成功/出错）· 气泡 · 通知    │
└────────────────────────────────────────────────────────────────┘
                              │ 事件
┌────────────────────────────────────────────────────────────────┐
│ L1 核心层 ★ 本项目自研，且不依赖 L2/L3                           │
│   dsh-efficiency                                                │
│     · 【R0】问题采集 → 提醒 → 一键回答   ← 项目存在的主要理由    │
│     · 【R0b】进度采集（档位 A/B，零额外 token）                  │
│     · 信号 → 六档状态的映射                                      │
│     · 统一设置页                                                │
│     [Host] webserver/index-inject 注入响应式 CSS（R5 第一步）    │
│            新 HTTP 路由：写会话到指定路径（R2b）                  │
│            systemPrompt.section：简短/标准/详尽（R2c）            │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│ L0 DSH 宿主 0.2.0-rc.2 —— 绝不 fork，只用插件                    │
│   · userQuestions（askTimed / answer / 投影）← R0 的全部基础     │
│   · session 投影 · tool-call · 待办 · 审批 · 响应式槽位          │
└────────────────────────────────────────────────────────────────┘
```

### 4.0 两个关键架构决策

1. **`dsh-pet` 让薄壳工作归零**：原计划的"Tauri/Electron 薄壳"（约 1.5 天）**已被 `dsh-pet` 的桌面模式完全覆盖**，且它做得更完整（多屏边界、异构 DPI、甩抛物理、多开）。
   → 自研范围收缩为**单一的 `dsh-efficiency` 插件**。
2. **L1 刻意不依赖 L2/L3**：因为 `dsh-pet` 存在**已确认的版本闸门风险**（peer 全为 `^0.1.1-rc.2`，不含 `0.2.0-rc.2`，见 §6）。
   分层保证：**承载层装不上时，核心提醒仍能通过系统通知/网页浮层工作**。

### 4.1 三条硬约束（决定 R5 怎么做，来自源码复核）

1. **列宽是 JS 内联样式**：`AppFrame` 直接写
   `` gridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)` ``
   → **媒体查询改不了三列结构**，只能用 `!important` 覆盖内联样式，或改 `AppFrame`。
2. **`root` 槽位被 ui-layout 独占** → 插件**无法从外部替换布局**；真做手机版布局必须改包或在 profile 里替换 `ui-layout`。
3. **`viewport-fit=cover` 缺失**（实测 index.html 只有 `width=device-width, initial-scale=1`）→ `env(safe-area-inset-*)` 在 iPhone 上恒为 0。**任何移动端方案的第一步都必须是注入这个 meta。**

> **对本项目的启示**：现成的移动端插件必然是在绕这三条约束。**采用前必须实际看它怎么做**，并评估"DSH 升级后 class 名变化即失效"的风险。

### 4.2 ⭐ 桌宠已选定模板：`PC2005-cloud/dsh-pet`

> [github.com/PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · npm `dsh-pet@0.2.12` · MIT（代码）
> 这是一个**完整三件套项目**：`① 提示词配方 → ② 素材生成链 → ③ 插件成品`，任何人可 clone 后**从零生成自己的宠物**。

**它已经做到的事（直接省掉我们大量工作）**

| 能力 | 说明 |
|---|---|
| **桌面模式（关键）** | **每只宠物一个独立透明置顶局部小窗**（跟随宠物移动，不铺满屏幕），浏览器 overlay 与桌面模式**行为完全对齐**；Electron 按平台**自动探测/下载**到 `~/.dsh/electron/`，无需手动安装 |
| 开关粒度 | 每只宠物**必填字段 `display`**：`web` / `desktop` / `both` / `none`，设置页改动**即时生效** |
| **桌面端数据通道** | **走独立进程管道，不依赖 DSH 的 HTTP 路由，不受 web 访问闸门影响** —— 绕开了 §5 的全部安全约束 |
| 网页浮层 | 走 `shell.overlay`（正是我们确认的官方席位） |
| **工作状态联动** | 监听 DSH 会话事件 → **六档**「思考/工作/整理/等待/成功/出错」动画 + 常驻气泡；目标多轮任务只在真正收尾轮庆祝 |
| 交互物理 | 点击 Q 弹、拖拽阻尼弹簧、**甩抛抛物线 + 屏幕边缘反弹 + 落地摩擦**；两端共用同一份纯函数物理（`src/shared/physics.ts`） |
| 多开 / 漫游 | 多只同屏、各自独立大小与位置；朝朝向行走、先探测空间不走出屏幕，**多屏按各屏边界判定**（异构 DPI、任务栏、屏幕空洞均正确） |
| 对话与记忆 | 右键「对话」/`/chat` 与宠物聊天，**记忆持久化在 `$DSH_HOME/dsh-pet/memory.json`**，浏览器与桌面共享同一份 |
| 素材规模 | **一百余个**手绘风透明动画（VP9-Alpha webm，640×360），含待机/转向/移动/小动作/玩耍/吃东西/时节/文字/点击回应/拖拽/余额/碎碎念/工作状态；**动画链每段播完按权重接下一段**，双缓冲交叉淡入无空白帧 |
| 配置体系 | 设置页「桌宠配置」**或**直接编辑 `$DSH_HOME/dsh-pet/main-config.json`（同构格式，覆盖语义为**整字段替换**，非法配置**显式报错不静默**） |
| **pet pack** | 在 `$DSH_HOME/dsh-pet/pet/` 建 `<种类>-config.json` + `<种类>-animation/` 即可**新增全新宠物种类**（独立动画池与素材），与主宠物**严格隔离** |
| 自定义动画 | 往 `main-animation/webm/` 放 `.webm` 即为新动画，**优先于包内素材** |
| 无障碍 | 支持 `prefers-reduced-motion`（跳过 Q 弹挤压与淡入切换） |

**⚠️ 三个必须处理的问题**

1. **版本兼容冲突（已确认，高优先级）**
   `dsh-pet@0.2.12`（2026-09-24 发布）声明了 11 个 `@deepseek-ai/dsh-*` peer，范围全为 **`^0.1.1-rc.2`**（`dsh-host-webserver` / `dsh-client-ui-slots` / `dsh-client-connection` / `dsh-client-runtime` / `dsh-llm` / `dsh-commands` / `dsh-home-paths` / `dsh-credentials` / `dsh-agent-default-model` …）。
   **`^0.1.1-rc.2` 不含 `0.2.0-rc.2`**（semver：预发布版本只匹配同 `[major,minor,patch]` 元组的范围，且 `^0.1.x` 上界为 `<0.2.0`）
   → **极可能命中版本闸门**，需要：
   ```sh
   dsh plugin --profile web add dsh-pet          # 先正常装，观察是否被拒
   # 若被拒：
   dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk
   ```
   它自己的 README 也写明"当前在 **0.1.5-rc.1** 下开发并测试，建议使用相同版本" → **必须实测**，这是 Phase 1 的第一优先级项。
2. **许可证（重要，不能忽略）**
   - **代码 MIT**
   - **素材（动画/提示词/源视频）：允许开源使用，禁止商用**
   - **二创约定（强制）**：基于本项目的衍生/改版/换皮作品，**在任何介绍、展示、分发该作品的地方**，须附上原作者地址 `https://github.com/PC2005-cloud/dsh-pet`
   → 结论：**自用完全没问题**；若要发布自己的版本，必须保留署名。
3. **Safari/HEVC 不兼容**：Safari/WKWebView 不认 webm alpha（渲染为黑底）。macOS 需从 Release `assets-mov` 下载 HEVC-alpha `.mov`，放入 `main-animation/mov/`，并把 `ANIMATION_EXT` 改为 `.mov`。**Windows 场景不受影响。**

**素材补充来源**：[aigengtu.com](https://aigengtu.com/)（梗鲸 · DeepSeek 鲸鱼娘表情包库，含"蓝色大肥鱼""DeepSeek 酱语录"等）
→ 用途：作为 **pet pack 的素材来源**（`$DSH_HOME/dsh-pet/pet/<种类>-animation/`），或做碎碎念/对话的气泡配图。
⚠️ **注意授权**：该站是社区梗图收集站（投稿走 GitHub issue，含 takedown 模板），**图片版权归属各原作者**，自用可以，**商用或公开发布前需自行确认授权**。
⚠️ **格式限制**：dsh-pet 播放的是**透明动画 webm**，静态表情图**不能直接**作为动画使用 —— 要么只当气泡/贴图，要么用它的素材链（`scripts/`，Python + ffmpeg）自己生成动画。

**结论：桌宠不再需要自研薄壳。** 因为：
- 我们要的"桌面常驻透明小窗"，dsh-pet 的 `display: desktop` **已经实现**；
- 我们要的"点击打开完整网页"，它的桌面端右键菜单**已有「打开网站」**；
- 我们要的不是"另一个 DSH 桌面客户端"，而是"宠物 + 对话呈现" → 薄壳部分**直接用它的**，我们只做**它没有的**（galgame 播放器、统一设置页）。

### 4.3 四条集成通道的**决定性对比**（若将来要脱离 dsh-pet 自研桌面端再看）

> 完整证据见 [research/02-embedding-and-sdk.md](research/02-embedding-and-sdk.md)。
> ⚠️ **注：选定 dsh-pet 后，本节结论仅作"自研备选"参考——dsh-pet 已用独立进程管道绕开了这些约束。**

| 通道 | **实时 reasoning-delta** | 取消 turn | 审批应答 | 用户提问 |
|---|---|---|---|---|
| 进程内 `ctx.on('agent/assistant-stream')` | ✅ | ✅ | ✅ | ✅ |
| **web/API（`session/follow {assistantStream:true}`）** | ✅ | ✅ | ✅ | ✅ |
| SDK stdio | ❌ 仅 settle 后整块 | ❌ | ❌ | ❌ |
| ACP stdio | ❌ 仅 settle 后整块 | ✅ | ✅ 仅一次 | ❌ |

**若要自研桌面端**，只有 web/API 或进程内两条路能拿到实时 thinking：
- SDK 只有 3 个 request（`initialize`/`session/prompt`/`shutdown`）+ 4 个 notification，**纯 stdio、无网络选项**，官方明确 "No cancel or session-close methods"。
- ACP 的 `agent_thought_chunk` 由**已提交**消息**派生** → **整块到达**，官方原文 "raw provider deltas … stay off the wire"。

**自研时的三个坑**
1. **`file://` 或自定义 scheme 不能直连 `/api`** —— `isTrustedApiRequest` 对 `Origin: null` 会 `new URL("null")` **抛错 → 403**。→ 必须同源提供。
2. **没有 Bearer token**；cookie 名与载荷**绑定 `host:port`** → **端口一变 cookie 全废，必须钉死 3080**。
3. 好消息：**无 CSP / 无 X-Frame-Options / 无 CORS 头** → 注入自定义 UI 不会被拦。

**`desktop` 保留 profile**：官方集成契约**存在但未发布**（`rejectElectronProfile` 拒绝逻辑；`desktop` **不在 `PROFILE_TEMPLATES`** → 其 profile 目录由 Electron 自持）。官方桌面应用**不在 npm**。
> 💡 **这说明 dsh-pet 的桌面模式是"第三方自建"路线**（自持 Electron 运行时），而非走官方保留 profile —— 符合我们的需求，也解释了它为何"不受 web 访问闸门影响"。

### 4.4 为什么不全自研 / 不全装现成

| 路线 | 评价 |
|---|---|
| 从零写桌宠 App + 自己接 SDK | ❌ 重做会话/审批/工具卡片/轨迹/文件预览，数月且永远追不上上游 |
| Fork DSH 改前端 | ❌ 上游快速发版（0.1.7→0.2.0 已跨 rc），fork 即负债 |
| 纯装社区插件 | ⚠️ 覆盖 R1/R2b/R3/R4 大部分，但 **R2a 缺档、R2c 无旋钮、R2d 不存在** → 这就是差异点 |
| **插件 + 薄壳（推荐）** | ✅ 复用 ~90%，自研 ~10% 且集中在前端，升级风险最小 |

### 4.5 三条落地路线（递进）

**路线 ① 纯插件栈（0 代码，先跑起来）** —— 立刻验证"这些插件在 0.2.0-rc.2 上到底能不能用"。
**路线 ② 自研展现层插件（本项目主体）** —— 补 R2a/R2c/R2d，统一设置页。
**路线 ③ 桌宠薄壳（可选）** —— 先体验 `MochiNek0/dsh-desktop` 再决定。

---

## 5. 安全模型与局域网方案（**已源码级复核**）

> 完整证据（含行号与逐字代码）见 [research/03-web-lan-access.md](research/03-web-lan-access.md)。

### 5.1 DSH 其实有三层防线（比预想的好）

| 层 | 位置 | 作用 | 是否真边界 |
|---|---|---|---|
| ① 绑定 | `dsh-host-webserver` config `host` | socket 是否可达 | **是**（唯一真边界） |
| ② Host/Origin 围栏 | `dsh-client-connection/lib/index.js:205-219` | 防 DNS rebinding / CSRF | 否（官方自述 "not an auth layer"） |
| ③ 浏览器会话认证 | 同上 `:221-460` (`BrowserAuth`) | launch token → 签名 cookie | **是** |

**关键事实**：
- **不是裸奔**。每进程 256-bit launch token → `GET /?token=...` 兑换为 **HMAC-SHA256 签名的 HttpOnly cookie**（`SameSite=Strict`、`Path=/`、默认 30 天，密钥持久化在 `$DSH_HOME/.credentials.yaml` → 重启不失效，但**每进程 launch token 会变**）。
- **CLI 硬拒绝 `0.0.0.0`**（`dsh-web-app/lib/startup.js:40`，原文理由："it would expose remote code execution to the network"）。
- **但能力不缺**：webserver schema **原生接受 `0.0.0.0`**，`dsh-web-app` 也已有完整 LAN 分支（自动采样 LAN IPv4 → 自动进 trustedHosts → 打印带 token 的 LAN URL）。**被挡住的只有 CLI 一行字符串检查** → **策略闸门，非能力缺口**。
- `--host <具体 LAN IP>` 过得了 CLI，但撞 schema `z.union([const("127.0.0.1"), const("0.0.0.0")])` → **启动失败**。
- `--trusted-host` **只放宽围栏②，不改 socket 绑定**。
- **全仓库没有 TLS 服务端**（`createSecureServer|https.createServer|tls.createServer` 零命中）。

### 5.2 威胁等级：拿到 cookie = 完整 RCE

| 严重度 | 能力 | 证据 |
|---|---|---|
| **致命** | `terminal.create/write` 开交互式 shell，**以系统用户权限、绕开 Agent 沙箱与审批策略** | `dsh-api-terminal-controller/README.md:30` |
| **致命** | `session.prompt` 驱动 Agent 跑 shell | 这正是 CLI 拒绝 `0.0.0.0` 的理由 |
| **严重** | `GET /api/file?path=<绝对路径>` **读任意可读文件**（无工作区约束） | `dsh-api-session-controller/lib/index.js:2334-2401` |
| **严重** | `workspaceFiles.read/readBytes` 同样支持工作区外绝对路径 | `README.md:12,40` |
| **严重** | `settings`/`credentials` **写权限**（可把 LLM key 改指到攻击者端点） | `dsh-api-settings-controller` |
| **高** | 明文 HTTP 上嗅探 cookie（**刻意无 `Secure`**）→ 直接升级为上面全部 | `lib/index.js:296-298` |

**未认证即可访问**：`/assets/*`、`/plugins/<id>/client.js`、**`/plugins/events`（HMR SSE，无 admit、无围栏，泄露模块图）**。
**已防住**：DNS rebinding、CSRF（SameSite=Strict + sec-fetch-site + Origin + 无 CORS 头）。
**完全没有**：CSP、HSTS、TLS、限流。

### 5.3 四套方案（按推荐度）

| # | 方案 | 工作量 | 风险 | 改配置/代码 | 加密 | 手机 |
|---|---|---|---|---|---|---|
| **1** ★★★★★ | **SSH 隧道 / Tailscale + 保持 loopback** | 低 | **低** | 否 | ✅ | 需装 VPN 客户端 |
| **2** ★★★★☆ | **本机 Caddy/nginx + TLS + 保持 loopback** | 中 | 中 | 否（只加 `--trusted-host`） | ✅ | ✅（需信任内网 CA） |
| **3** ★★★☆☆ | `--patch` 覆盖 `webserver.config.host='0.0.0.0'` | 低 | **高** | 是（仅 YAML） | ❌ | ✅ |
| **4** ★★☆☆☆ | 自写 Cordis 插件加认证层 | 高 | 中 | 是（新包） | 需自实现 | ✅ |

**推荐：方案 1 或 2，永远保持 `host=127.0.0.1`。**

方案 2 的四个硬约束：
- **必须保留 Host 头**（否则 `Origin != Host` → 403）：Caddy 里 `header_up Host {host}`。
- **必须只挂根路径**：token 兑换硬要求 `url.pathname === "/"` → **子路径挂载肯定不可用**。
- **必须放行 WS 且不能有 >2s 停顿**：服务端每 2s Ping，未及时回 Pong 即断。
- 全仓无 TLS 服务端 → **TLS 只能靠外部反代**。

方案 3 注意：id 定向 patch **不做深合并**，必须**重述整个 config**；且 web profile `patchReload: live`，改 patch **可能立即触发重载**。

### 5.4 移动端安全上下文（决定"是否必须 HTTPS"）

- `crypto.randomUUID` **有 `getRandomValues` fallback**（注释明确点名 "plain HTTP on a LAN address" 场景）。
- 剪贴板多数有 `execCommand` fallback，但 **`dsh-client-ui-settings-account/lib/client.js:1041` 是裸调用**。
- **实验性语音输入在明文 HTTP 下完全不可用**（`getUserMedia` 需安全上下文）。
- **有 manifest 但无 Service Worker** → **当前无法安装 PWA**；`theme-color` 是运行时创建的。
- ⚠️ **非 loopback 页面设置不持久化**（`dsh-client-ui-settings/README.md:106`）→ **远程访问下"风格设置"不落盘**！这对 R2 的远程体验是硬伤。

### 5.5 红线

1. **优先保持 `host=127.0.0.1`**。
2. 若必须直连 LAN：**仅限完全可信的隔离网络** + HTTPS。
3. Windows 防火墙**只放行私有网络配置文件**。
4. 首次访问需人工传递启动日志里的 `?token=...`（30 天内不必重复）。
5. 保留**一键关闭局域网**的手段。

---

## 6. 版本兼容性（工程风险）

- 实测 `dsh --version` = **0.2.0-rc.2**，278 个 `@deepseek-ai/dsh-*` 包全部 **0.2.0-rc.2**。
  （npx 同目录 `package-lock.json` 记的是 0.1.7-rc.2，属缓存元数据，**不是**运行版本。）
- 官方机制（实读 `dsh-app-boot` / `dsh-plugin-manager` README）：
  - 导入插件前逐条校验 `peerDependencies` 里的 `@deepseek-ai/dsh*` 范围；**预发布版本参与范围匹配**。
  - 不匹配的**组合包被跳过**（列入 `skippedBundles`）；**行级插件被策略拒绝**（报告包名/版本/风险），**被拒模块永不 import**。
  - **未声明 DSH peer = 不施加约束**；**范围无效 = 视为不兼容**。
  - 安装时即检查（本地路径直接读 `package.json`；registry spec 经 `pnpm view`）→ **不兼容则在 pnpm 运行前失败**，不下载、不跑构建脚本。
  - 豁免存于 profile 的 `compatibility.json`（精确 `package@version` → 精确运行时版本列表），**插件升级与 DSH 升级都不继承**。
- **落到选型**：
  - 🔴 **`dsh-pet@0.2.12`（已选定模板）→ 版本闸门高危**：它声明了 11 个 `@deepseek-ai/dsh-*` peer，范围**全为 `^0.1.1-rc.2`**，而运行时是 `0.2.0-rc.2`。
    semver 判定：`^0.1.1-rc.2` = `>=0.1.1-rc.2 <0.2.0`，**不含 `0.2.0-rc.2`**（预发布只匹配同 `[major,minor,patch]` 元组）→ **极可能被拒**。
    它自己的 README 也写"当前在 **0.1.5-rc.1** 下开发并测试，建议使用相同版本"。
    **处理**：先正常 `add` 观察，被拒则用 `allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk` 豁免。**这是 Phase 1 的第一优先级项。**
  - ⚠️ `@wingsky-1/dsh-lan-proxy@0.2.7` peer **精确等于 `0.1.7-rc.2`**；`@tomowang/dsh-tui@0.9.0` peer `^0.1.7-rc.2` → 同样需实测或豁免。
  - ✅ `@linxin666/dsh-web-all@0.4.4` peer `>=0.2.0-rc.1` → **兼容 0.2.0-rc.2**（全家桶反而是版本上最安全的选择）。
  - ⚠️ 已装的 `dshmarket@1.66.5` peer 上限写 `0.2.0-rc.1` 却运行在 0.2.0-rc.2 → 说明**实际环境中这类不匹配可能已被容忍**，需实测确认。

### 6.1 ⭐ 关键发现：版本闸门可以被完全绕过

**闸门只检查 `peerDependencies` 中名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的项。**
（注意：`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-client-ui-slots` 等**都会命中**这个前缀。）

→ **我们自己写的本地插件只要不声明这类 peer，就完全不受版本闸门约束。**
这意味着 **§9 里的"版本不匹配"风险只适用于"我们要采用的第三方插件"，不适用于自研插件。**
（同时这也是把双刃剑：我们因此也拿不到"不兼容"的早期警告，需自行把关。）

启用豁免的正确命令：
```sh
dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <当前运行时版本> --accept-risk
```
豁免存于 `profile/compatibility.json`，用 `dsh plugin --profile web version-exemptions` 查看，`revoke-version` 撤销。

### 6.2 本地开发插件的安装（已确认的确切行为）

```sh
# 插件必须先构建好 lib/client.js —— Host 不编译客户端
dsh plugin --profile web add link:<本地目录>
```
- pnpm 成功后，`reconcile()` 会**自动把声明了 `dsh.bundle.patch` 的包追加进**
  `C:\Users\WANGZ\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` → **无需手改 YAML**
- `link:` 协议是纯符号链接，**改完重建即生效**，适合反复迭代
- 校验（**不启动服务器**）：`dsh --profile web --dump-config`
- 临时叠加一层覆盖而不改 profile：`dsh web --patch .\dev.patch.yml`

### 6.3 patch 语义（已确认）

- 层序：`bundles` → profile `cordis.patch.yml` → **`$DSH_HOME/cordis.patch.yml`（优先级更高）** → `--patch`
- `id` 定向 = **整键替换（不做深合并）**；`insert` = 追加；**命中不到只 warn 不报错**
- 支持 `!!js` 标量（Loader 在 entry 激活时求值）
- ⚠️ `dsh.profile.patchReload` 在任何已安装 JS 中 **grep 不到** → 可能是**死字段**（web profile 写的是 `live`，实际是否实时重载待实测）

### 6.4 构建约定（已确认）

- `"bundle": "tsdown"` → 产出**单个 `__ModuleLoader__` 包裹**的产物；`.d.ts` 由 tsc 单独出
- ⚠️ **共享 tsdown 预设未随 npm 发布** → 需自配，以 dshmarket 产物为模板（它用 `scripts/normalize-client-banner.mjs` 后处理 banner）
- CSS 惯例：打包成字符串后自注入 `<style data-plugin-css>`

### 6.5 许可证

所有 `@deepseek-ai/*` 与 `dshmarket` 均为 **MIT**。逐字抄较大片段需在自己的 LICENSE/NOTICE 中保留其版权与 MIT 声明。

> **纪律（贯穿整个 Phase 1）**：每个**第三方**候选插件采用前必须跑「安装 → 启动 → 检查 `skippedBundles` / 策略拒绝」冒烟测试，结果记入 `research/compat-matrix.md`。**一次只装一个**，否则无法定位失败源。
> 自研插件因不声明 `@deepseek-ai/dsh*` peer 而不受闸门约束，但需自行把关兼容性（见 §6.1）。

---

## 7. 分阶段路线图

### Phase 0 — 基线固化（0.5 天）
- 备份 `~/.dsh/profiles/web`（`package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`）
- 记录基线：`dsh --version`、包版本分布、监听地址、bundles
- 建立 `research/compat-matrix.md`
- 验证回滚手段（含 `compatibility.json` 的手工修复方式）

### Phase 1 — 能力打通（1–2 天，零自研）
按**一次只装一个**逐个验证：R2a `dsh-auto-collapse` → R2b 内置 `/export` → R5 `dsh-web-mobile` → R4 反代/隧道 → R5-CLI `@tomowang/dsh-tui` → R1 `dsh-live2d-pets`。
**验收**：每项给出"通过/跳过 + 原因"，形成兼容矩阵。

### Phase 2 — ★ 核心效率层（3–4 天，**本项目存在的主要理由**）

> 契约已完全摸清（§2.1–2.4），**可直接开工**。技术细节见 [ARCHITECTURE.md](ARCHITECTURE.md) §3–§4。
> 最佳模板 = 本机 `dshmarket`（**`src/` 源码随包发布**）：`src/client/index.ts`（289 行）一次演示完设置页 / Tab / 配置卡 / `shell.overlay` / `ctx.provide` / slot 探测；`src/routes.ts` 有 **40+ 个 `webServer.register` 实例**。

**2.0 骨架（所有后续工作的前提）**
- 搭建插件工程骨架 `dsh-efficiency`：pnpm + tsdown（自配，共享预设未发布）+ `dsh.bundle.patch` + `dsh.client`
  - Client 半必须产出 `window.__ModuleLoader__.load({id, factory})` 形状；CSS 打成字符串自注入 `<style data-plugin-css>`
  - **不声明 `@deepseek-ai/dsh*` peer** → 绕开版本闸门（§6.1）
  - 用 `dsh plugin --profile web add link:<dir>` 安装（会自动进 `dsh.profile.bundles`）
  - 用 `dsh --profile web --dump-config` 校验，**不要靠启动来试错**

**2.1 【R0】问题提醒与一键回答 —— 最高价值**
- **前置确认 A1**：`tool-ask-user` 的 `mode` 是否为 `"timed"`（默认是 `legacy`）
  ⚠️ **这是整个核心功能的前提**：legacy 模式下提问是阻塞的，你不在场 agent 就干等，且问题不进可回答投影
- **Host 侧**：订阅 `user-questions/request`（waterfall）与 `approval/request`（waterfall）
  - 这是 25 条转发事件白名单里**仅有**的两条 waterfall，且**重连后会重放**
  - 读 `userQuestions` 投影拿待答清单：`{ active: PendingUserQuestion[], settled: SettledUserQuestion[] }`
  - 限时问题用 `attachWait(agent, callId, signal)` 拿 `{ remainingMs }` 做倒计时
- **提交回答**：`ctx.userQuestions.answer(agent, callId, answer)`
  - `answer` 形如 `{ answers: [{ id, selected: string[], custom? }] }`
  - ⚠️ 已 `continued` 的问题，回复会作为 `user-question-reply` **steer 回 agent**（不伪造工具结果）
- **承载**：推送到 `dsh-pet` 桌面小窗（角标 + 选项按钮）；`dsh-pet` 未就绪时降级到**系统通知**
- **验收**：agent 提问后，**不切到浏览器**就能看到问题并点选回答；且**超时后回来仍能补答**

**2.2 【R0b】进度采集（档位 A/B，零额外 token）**
- 信号来源（全部已有，不调用模型）：`api-session/status`、`api-session/activity`、tool-call 生命周期、`reasoning-delta` 与 `text-delta`（**已确证分离**）、待办投影、goal/plan/workflow 投影、待答问题角标、token meter
- **映射到 `dsh-pet` 的六档**（思考/工作/整理/等待/成功/出错）→ **复用它的状态机与动画，不写新渲染**
  - 关键档位：**有待答问题/待审批 → 「等待」**
- 档位 A = 原始信号直出；档位 B = 本地规则模板拼成人话（**仍不过模型**）

**2.3 统一设置页**
- 挂 `settings.section`（整页）或 `settings.general.item`（单行）
- 按"主线默认开 / 可选默认关"分组（见 [ARCHITECTURE.md](ARCHITECTURE.md) §7）
- 中文必须走 `ctx.locale`（**新增文案不走会被 i18n 校验拒绝**）
- ⚠️ **非 loopback 页面设置不持久化**（`dsh-client-ui-settings/README.md:106`）→ 远程场景需自建存储

**2.4 顺手补两个低成本项**
- **R5 第一步**：`webserver/index-inject` 注入 `viewport-fit=cover`（原子级改动，收益极大）
- **R2b 升级**：宿主精确路由 + **复用** `serializeSessionLog()` / `writeFileAtomic()` 支持写指定路径（⚠️ 文件名走 `logPath()`，格式已确证 v4）

- **验收**：R0 + R0b 在**不打开浏览器**的前提下完整可用；设置页可独立开关各模块

### Phase 2b — 可选表达层（4–6 天，**可延后/可砍**）

> 这些是"锦上添花"。架构上已保证：**不做这些，Phase 2 的核心价值依然成立**。

- **R2a 补齐**：「完整过程 / 只显示思考中」
  - 推理已是**独立一等类型**（`'reasoning-delta'`；`thinkingDetail`/`outputDetail` 是两个独立字段）→ 基础设施够
  - 缺的是"藏正文"语义：新增 policy 字段（如 `answersHidden`）并改 assistant 节点渲染
  - 优先**包装**内置 `ui-chat.transcriptView`（4 档已存在）而非重造折叠逻辑
- **R2d 新建**：galgame 播放器
  - 落点：`conversation.view`（照抄 Trajectory 实现），或 `conversation.chat.node` 接管 `assistant-step`
  - 数据：`useTrajectory().partial` / `AssistantLiveChunkEvent.data.chunk`（**已确证 token 级**）
  - 历史重放：`expandAssistantStream()` 精确还原 delta 边界与 `dt` 时间戳（⚠️ 先测 V12）
  - 交互：点击 → 下一句；按住 → 快进；键盘 + 触屏
  - ⚠️ 流**无法真正暂停**（无 pause/resume 协议）→ 只能"前端延迟揭示"
- **R2c 新建**：简短 / 标准 / 详尽
  - 用 `ctx.systemPrompt.section({name, order, text: ({scope}) => …})` —— `text` **每次 assembly 求值，运行时可切换**
  - ❌ **不要用 agent preset**：官方原文 "only available before a conversation starts… the host refuses to swap them"
- **档位 C**：进度气泡（独立观察会话）
  - ⚠️ **消耗额外 token → 默认关闭 + 可配周期 + 可配预算上限 + 失败静默降级到 A/B**
  - 需先验证 A4：观察者会话如何与主会话隔离（子代理 / 独立会话 / 只读日志）


### Phase 3 — 桌宠（1–2 天）⭐ 已大幅简化

> **模板已定：`dsh-pet`。不再自研薄壳**（它的桌面模式已覆盖原计划 1.5 天的工作量）。
> 本阶段从"造桌宠"变成"**装好 + 调好 + 扩展它**"。

- **3.1 装通（最高优先级，含唯一硬风险）**
  - `dsh plugin --profile web add dsh-pet` → **观察是否被版本闸门拒绝**（peer 全为 `^0.1.1-rc.2`，不含 `0.2.0-rc.2`）
  - 若被拒：`dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk`
  - 若装通但运行异常：从源码构建（`git clone` → `cd dsh-pet/dsh-pet` → `npm install` → `npm run prepare` → `add file:<dir>`）
  - ⚠️ **注意 `npm run prepare` 才是完整构建**（裸 `tsdown` 会缺桌面运行时与类型声明）
- **3.2 桌面模式**
  - 每只宠物设 `display: desktop` 或 `both`，验证**独立透明置顶小窗**
  - 首次会自动下载 Electron 到 `~/.dsh/electron/`；缺失时仅日志告警，不影响网页形态
  - 验证它**不受 web 访问闸门影响**（这是它的关键优势）
- **3.3 配置到满意**
  - 大小/位置/多开/边距；`$DSH_HOME/dsh-pet/main-config.json` 可做**设置页给不了的自由配置**（动画池、权重、事件周期）
  - 开工作状态联动（六档）+ 碎碎念 + 对话 + 余额（可选）
- **3.4 pet pack 扩展（可选）**
  - 用 `$DSH_HOME/dsh-pet/pet/<种类>-config.json` + `<种类>-animation/` 挂自定义种类
  - 素材来源：dsh-pet 自带素材链（`scripts/`：Python + ffmpeg），或 [aigengtu.com](https://aigengtu.com/) 的梗图（⚠️ **静态图不能直接当动画**，需转 webm 或仅作气泡贴图；⚠️ 版权归原作者）
  - ⚠️ **遵守二创约定**：任何展示/分发处附 `https://github.com/PC2005-cloud/dsh-pet`
- **3.5 与桌面宠物的分工（避免功能重叠）**
  - 对话入口：用 dsh-pet 右键「对话」（记忆独立）**还是**走主界面会话？需明确，否则用户困惑
  - 桌宠的气泡是"宠物说的话"，`dsh-presentation` 的 galgame 播放器是"agent 正文的呈现" —— **两者定位不同，可并存**
- ⚠️ **不要做的事**：不要注册 `root` 槽位；不要自己写 Electron 壳（dsh-pet 已有）；不要试图改 `dsh-pet` 包内文件（用 pet pack 或用户层配置覆盖）

### Phase 4 — 响应式与多端（3–5 天）
- ⚠️ **纯 Web 能力，与桌宠无关**（桌宠没装也必须可用）
- **局域网开关**：写 patch + 提示重启 + **安全门槛**（⚠️ 非即时生效，CLI 硬拒绝 `0.0.0.0`）
- **手机**：抽屉/汉堡/底部栏 + composer `enterkeyhint` + 软键盘 `visualViewport` + `touch-action` 修复 + ≥44px 触控目标
- **平板**：补 768–1024 中等档（`computeColumns()` 加档位参数）
- **折叠屏**：`@media (horizontal-viewport-segments:2)` + 铰链 gap
- **PWA**：补 Service Worker + apple-touch-icon + maskable 图标（**必须 HTTPS**）
- **CLI**：接入 `@tomowang/dsh-tui`，或自建 TUI 前端（复用 `ctx.remote` + `ctx.cmdlineArgs` + `ctx.locale`）
- 设置共享（Web 与 CLI 同一份配置）

### Phase 5 — 启动器（解压即用 exe，3–5 天）

> 完整设计见 **[LAUNCHER.md](LAUNCHER.md)**。**它不是 MVP 的一部分**，排在 R0/R0b 之后。
> 选型 **Electron**（与 `dsh-pet` 同栈，复用其运行时探测经验）。

- **环境检测**：Node ≥20 / npm / dsh / 端口占用 / 网络可达
  - ⚠️ **实测事实**：本机 `dsh` **只存在于 npx 缓存**（`..._npx\<hash>\node_modules\.bin\dsh.ps1`），
    而 `%APPDATA%\npm` 下**没有全局安装** → **不能假设 `dsh` 命令存在**
  - 缺失时二选一：`npx --yes @deepseek-ai/dsh`（无侵入，默认）或 `npm install -g`（显式选项）
  - ⚠️ **版本不匹配只提示，不阻断**（实测存在"版本双镜像"：磁盘新版 + 运行中旧版进程）
- **启动时序**：拉起 `dsh web --no-open` → 从 stdout 抓 `?token=` → 持久 partition **同源**载入
  - ⚠️ **禁止 `file://`**（`Origin: null` → 403）
  - ⚠️ **端口与 cookie 绑定**：cookie 名与载荷都绑定 `host:port`，换端口即失效
  - ⚠️ token 兑换硬要求 `pathname === "/"` → **不支持子路径挂载**
- **失败处理**：任何失败都要留下可诊断信息，不能白屏
  - `npx` 有 `ECOMPROMISED: Lock compromised` 的实战记录 → 必须重试 + 清晰报错
- **跨平台**：Windows（`.ps1`/`.cmd` 包装，需直接调 `node bin.js`；退出用 `taskkill /T`）/
  Linux（无图形会话降级）/ macOS（未签名 Gatekeeper；⚠️ **webm alpha 在 WKWebView 不兼容**，需 HEVC `.mov`）
- **与 `dsh-pet` 划清界限**：启动器负责"从零到能用"，`dsh-pet` 负责"不开浏览器也能看见"
  - ⚠️ 避免**各自拉一份 Electron**（待验证 `dsh-pet` 能否复用外部运行时）
- **发布**：GitHub Release 各平台包 + `SHA256SUMS`，解压即用

### Phase 6 — 可维护性（持续）
- 钉死版本与 peer 范围，写清豁免记录
- DSH 升级演练 + 一键回滚
- `skippedBundles` 监控（避免插件静默失效）
- 上游跟进：若 R2a/R2d 被官方收纳则删掉自研部分

---

## 8. 待验证清单

> **A 系列 = 效率功能专属（阻塞核心）**，**V 系列 = 通用**。
> 完整的 A/V 双表（含按任务号的对齐）见 [todo.md](todo.md#待验证清单a-系列--效率功能专属v-系列--通用)。

### 8.1 A 系列 —— 阻塞 R0（核心功能）的前提

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| **A1** | **`tool-ask-user.mode` 是 `timed` 还是 `legacy`？**（默认 `legacy` = 阻塞） | 🔴 **整个 R0 的前提**：legacy 下你不在场 agent 就干等，问题也不进可回答投影 | ⬜ **最先验证** |
| **A2** | 超时后 `continued` 的问题，`answer()` 在本部署下真能 steer 回 agent？ | R0 的核心场景（离开后补答） | ⬜ |
| **A3** | `user-questions/request` 在客户端插件里的具体挂钩点（槽位/服务名） | R0 实现方式 | ⬜ |
| **A4** | 档位 C 的观察者会话如何隔离（子代理 / 独立会话 / 只读日志） | 档位 C 是否可行 | ⬜ |
| **A5** | 非 loopback 下设置存储方案 | 远程体验 | ⬜ |
| **A6** | `dsh-pet` 能否被**喂入自定义状态**，还是只能用它的内置探测 | 进度信号映射方式 | ⬜ |

### 8.2 V 系列 —— 通用

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| V1 | 候选**第三方**插件在 0.2.0-rc.2 上是否被 peer 检查拒绝 | Phase 1 全部 | 🔴 **`dsh-pet` 高危已确认**（peer 全为 `^0.1.1-rc.2`）→ **第一优先级实测**。自研插件不声明 peer 可完全绕过 |
| V2 | `transcriptView` 的 4 档行为边界；新增"藏正文"字段能否只改一个 policy 对象 | R2a 工作量 | 🟡 已定位 `POLICIES`(`chat/lib/client.js:12013`) + `ChatPresentationPolicy`，**未实测渲染改动** |
| V3 | 客户端 reasoning 增量是否与正文分离 | "只显示思考中"精度 | ✅ **已确证分离**：`'reasoning-delta'`、`kind:'reasoning'`、`trajectory` 的 `thinkingDetail`/`outputDetail` 是**两个独立字段** |
| V4 | 前端拿到 token 增量还是整段消息 | 播放器形态 | ✅ **已确证 token 级**：`AssistantLiveChunkEvent.data.chunk: StreamChunk` |
| V5 | bind flag 能否解决 R4 | — | ✅ **已结案：不能，改为 loopback + SSH/VPN/反代** |
| V6 | 非安全上下文缺哪些 Web API | 是否必须 HTTPS | 🟡 **部分结案**：`randomUUID` 有 fallback；裸调用 1 处；**语音需 HTTPS**；**无 SW → 不能装 PWA** |
| V7 | `@linxin666/dsh-web-all` 全家桶是否值得采用 | 可能一次性解决多项 | ⬜ |
| V8 | 折叠屏支持度 | Phase 4 | ✅ **已结案：完全空白** |
| V9 | Tauri 透明置顶窗在 Windows 的行为 | Phase 3 | ⬜ |
| V10 | patch 覆盖 `webserver.config.host` 是否生效 | 方案 3 前提 | ⬜ **用 `--dump-config` 验证，不要直接启动** |
| V11 | web profile 默认 fs/sandbox 配置 | 安全评估精度 | ⬜ |
| **V12** | **wire schema 是否完整保留 `assistant/message.stream` 字段** | **决定 galgame 历史重放是零成本还是要新增 wire 字段** | ⬜ **动手前必须先测**：打开旧会话，浏览器侧 dump 一条 `assistant/message` 的 `stream` |
| **V13** | **现成移动端插件如何绕过"JS 内联列宽 + root 槽独占"** | 决定 Phase 4 是抄还是自己动 `AppFrame` | ⬜ |
| **V14** | **`ui-layout` 的 class 名在 DSH 升级后是否变化** | 决定 `!important` 覆盖方案的寿命 | ⬜ |
| **V15** | **`shell.overlay` 的 z-index / containing block 无契约** —— 桌宠是否会被裁剪或遮挡？ | 决定桌宠用 overlay 还是独立窗口 | ⬜ **注册一个空浮层实测** |
| **V16** | **`dsh.profile.patchReload` 是否为死字段**（已安装 JS 中 grep 不到） | 影响"改 patch 是否实时生效"的预期 | ⬜ 实测：改 patch 观察是否热重载 |

---

## 9. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 局域网暴露导致**远程代码执行** | **高** | 保持 loopback + SSH/VPN/反代 + HTTPS + 防火墙仅私有网络。⭐ **dsh-pet 桌面模式走独立进程管道，不受此约束** |
| **`dsh-pet` 被版本闸门拒绝**（peer `^0.1.1-rc.2` vs 运行时 `0.2.0-rc.2`） | **高** | 先正常装；被拒则 `allow-version ... --accept-risk` 豁免；再不行则 clone 源码 `npm run prepare` 后 `file:` 安装 |
| 上游快速迭代导致插件失效 | **高** | 插件化而非 fork；升级前预检；保留豁免与回滚 |
| **靠 `!important` 覆盖内联列宽**，class 名一变就失效 | **高** | 优先用 `shell.overlay` / `conversation.view` 等**官方槽位**；把改 `AppFrame` 作为备选并评估替换 `ui-layout` 包 |
| **素材授权**：dsh-pet 素材**禁止商用**，二创**必须署名** | 中 | 自用可行；发布前附 `https://github.com/PC2005-cloud/dsh-pet`；aigengtu 图片版权归原作者，商用需另行确认 |
| 第三方插件版本不匹配导致启动失败 | 中 | 一次只装一个 + `skippedBundles` 检查 + compat-matrix。**自研插件因不声明 peer 可完全绕过（§6.1）** |
| 多个社区插件争抢同一槽位 | 中 | 先跑路线①穷举；同槽位只留一个 |
| **非 loopback 下设置不落盘** | 中 | 自研设置用自己的存储，而非依赖 `dsh-settings` |
| **`shell.overlay` 无 z-index/裁剪契约** | 中 | dsh-pet 已实测可用（它是现成范例）→ 风险实际已降级 |
| galgame 播放器与流式渲染打架 | 中 | 先测 V12；必要时退化为"整段切句" |
| 折叠屏/平板是空白，需从零补 | 中 | 排在 Phase 4，不影响 MVP |
| 桌宠对话与主会话对话定位重叠，用户困惑 | 中 | 明确分工（§Phase 3.5）；两者定位不同，可并存 |
| 生态太丰富导致范围失控 | 中 | 严格按 Phase 验收，不通过不进入下一阶段 |

---

## 10. 立即可做的下一步

1. **重启 `dsh web`（P0-0，最优先）** —— 磁盘已是 `0.2.0-rc.2`，但运行中的进程（PID 127888）是 09-28 启动的旧版内存镜像。**否则后面所有验证都建立在错误基线上。**
2. **跑 Phase 0 备份**（5 分钟，成本极低，收益极高）。
3. 🔴 **装 `dsh-pet` 并处理版本闸门**（V1，最高优先级实测）：
   ```sh
   dsh plugin --profile web add dsh-pet
   # 若被拒：
   dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk
   ```
   装通后立即验证桌面模式（`display: desktop`）与网页浮层。
4. **只装 `dsh-auto-collapse`**，刷新页面看效果并观察启动是否有 `skippedBundles`。
5. **打开旧会话，在浏览器侧 dump 一条 `assistant/message` 的 `stream` 字段**（V12）→ 20 分钟，决定 galgame 历史重放的实现成本。
6. **决定 R4 安全底线**：接受"同网段可执行任意命令"吗？不接受则走 SSH/Tailscale 或 Caddy 反代。

---

## 11. 附录：调研产出索引

| 文件 | 内容 | 规模 |
|---|---|---|
| `research/01-plugin-architecture.md` | 插件契约、`dsh.*` 字段全集、slot 总表、RPC 路径、安装与 patch 语义、hello-world 骨架 | 86 KB |
| `research/02-embedding-and-sdk.md` | 四条集成通道对比、SDK/ACP 协议面、`desktop` 保留 profile、Electron 集成细节 | 69 KB |
| `research/03-web-lan-access.md` | `dsh web` 全部标志、三层安全模型、威胁模型、四套 LAN 方案 | 47 KB |
| `research/04-responsive-ui.md` | 布局架构、`@media`/`@container` 普查、403 个 token、适配目标对照表 | 53 KB |
| `research/05-display-modes.md` | 全部流事件类型、四个子需求判定、galgame 挂钩点、语音/导出 | 45 KB |
| `research/registry-snapshot.json` | 社区插件目录快照（4382 个，2026-09-28） | 5.1 MB |

---

## 12. 附录：候选插件速查（本机 0.2.0-rc.2 适用性）

| 需求 | 首选 | 版本 | 备注 |
|---|---|---|---|
| **桌宠（选定）** | **`dsh-pet`** | **0.2.12** | ⭐ **自带桌面透明窗 + 六档状态联动 + pet pack**；🔴 peer `^0.1.1-rc.2`，**需豁免** |
| 过程折叠 | `dsh-auto-collapse` | 0.2.1 | 依赖极干净，先试这个 |
| 移动端 | `dsh-web-mobile` | 3.0.3 | 窄屏好用宽屏适用 |
| 移动端备选 | `dsh-mobile-hanui` | — | 1024px 断点 + PWA 思路 |
| 局域网 | **SSH/Tailscale 或 Caddy** | — | **优先零插件方案** |
| 局域网插件 | `@wingsky-1/dsh-lan-proxy` | 0.2.7 | peer 精确 `0.1.7-rc.2`，需实测 |
| 全家桶 | `@linxin666/dsh-web-all` | 0.4.4 | peer 兼容 0.2.0-rc.2 ⭐ |
| 桌宠备选 | `dsh-live2d-pets` | 0.3.0 | 状态镜像，无桌面窗 |
| galgame 参照 | `dsh-whale-galgame` | 0.4.1 | 角色扮演壳，非"播放器" |
| TUI | `@tomowang/dsh-tui` | 0.9.0 | peer `^0.1.7-rc.2` |
| 导出 | 内置 `/export` | — | 复用，勿重造 |
| 插件市场 | `dshmarket`（已装） | 1.66.5 | 可用来发现并一键安装 |
| **宠物素材** | [aigengtu.com](https://aigengtu.com/) | — | 梗图库；⚠️ 静态图需转 webm，版权归原作者 |

> registry 快照：`research/registry-snapshot.json`（4382 插件，2026-09-28）。分类计数：`ui` 755、`tools` 576、`dev` 314、`session` 285、`remote` 134、`theme` 153、`fun` 134。
