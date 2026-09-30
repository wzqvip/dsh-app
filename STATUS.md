# 交付状态（dsh-pet 并入 dsh-efficiency）

> 更新：2026-09-30 · 状态：**技术实现与沙箱验证已完成；生产部署待维护者同意**
> 一键预检：`node packages/dsh-efficiency/scripts/preflight.mjs`（只读，约 1.3s）

---

## 1. 交付物

一个插件包 `packages/dsh-efficiency`，同时提供：

| 能力 | 说明 |
|---|---|
| **桌宠本体** | 网页浮层 + 桌面 Electron 小窗 + 气泡 + 系统通知 + 状态联动 |
| **效率核心** | agent 提问的一键作答面板（锚定在宠物下方）+ 进度感知 |
| **设置 GUI** | 独立设置窗口，入口在**桌面宠物右键菜单「设置…」** |

代码来源：`vendor/dsh-pet/`（上游 MIT，**仅代码**；素材不随本仓库分发）。

---

## 2. 逐项验证证据

| 目标要求 | 状态 | 证据 |
|---|---|---|
| vendor 仅代码、带 MIT LICENSE、不含素材 | ✅ | preflight 机器核对：**0 个素材文件**、上游 LICENSE 原文在库、出处说明在库 |
| 素材从**已安装的 dsh-pet** 读取 | ✅ | 构建期打印素材根；`/dsh-pet-7340/pic/*`、`/thumb/*.webm`、字体路由均 200 |
| 单一插件包 | ✅ | `name=dsh-efficiency`；客户端只提交**一次** load（一个客户端模块只能出一个插件） |
| 桌宠网页浮层 | ✅ | CDP 实测 `dsh-pet-root=1 stage=1 video=2 bubble=1` + 截图 `build/web-overlay.png` |
| 桌宠桌面小窗 | ✅ | 实机 smoke：`sprites=1 configOk=true menuOpen=true`；截图 `build/desktop-smoke.png` |
| **按生产配置** 复验（`display=desktop`） | ✅ | 桌面端正常；网页端**正确抑制**；恢复 `both` 后网页端重新渲染 |
| 通知 | ✅ | `scripts/manual-notify-flow.mjs` **13 项全绿**（见 §3）：引擎把帧映射成通知并弹出、正文/图标正确、`/notify` 轮询在跑、聚焦门两个方向都对 |
| 状态联动 · 余额 | ✅ | `/balance` 返回 76.34 与桌面气泡 `余额（谷）¥76.34` 一致 |
| 状态联动 · **工作状态（6 档）** | ✅ | `scripts/manual-workstatus-flow.mjs` **6/6 档位精确命中**（见 §3.1）：逐档喂受控快照，核对"该档位播的动画名 == 该索引池里的名字" |
| 设置 GUI + 右键「设置…」 | ✅ | 8 分区 / 33 行 / 241 控件；**内置配置全部字段可编辑、无只读项**；截图 `build/settings-window.png`；保存链路实测成功 |
| 提问链路（核心价值） | ✅ | 注入合成提问 → 面板渲染出选项 + Submit/Skip + 输入框；截图 `build/question-panel.png` |
| deploy 五道门禁 | ✅ | build / smoke / placement / materialize / config-write 全绿 |
| 生产未被影响 | ✅ | 3080 至今跑 `base / web-app / dshmarket / dsh-pet`，**未加载本插件** |

---

## 3. 通知链路（**已完整验证**）

分工（**不是缺陷**）：

- **浏览器半侧负责通知**：`client/notify.ts` 的 `startNotify`（由 `client/app.ts` 调用），
  轮询 `/dsh-pet-7340/notify` 增量帧并弹 Web Notification。
  证据：客户端 bundle 含 84 处 `notify`、12 处 `/dsh-pet-7340/notify`。
- **桌面端故意不实现**：`runtime/electron-helper/renderer.js:23` 注释原话
  「系统通知不是宠物行为（浏览器半侧 notify.ts 负责），桌面端不重复实现」。
- **宿主侧生成帧**：`reduceNotifyFrame` 认 `turn/end`、`approval/asked`、
  `tool/call(ask_user_question)`、`agent/error` → `pushNotifyFrame` 入队。
- 帧契约两侧**共用同一份** `shared/notify.ts`（`frameToToast` / `NOTIFY_ICONS`），
  漂移风险低。

**验证方式**：`scripts/manual-notify-flow.mjs`（13 项全绿，不进 deploy 门禁）。
不改 vendor —— 用页面内可控注入把整条链跑通：

1. 替换 `window.Notification` 为记录器 → 不依赖系统真弹窗，精确捕获 `(title, body, icon)`；
2. 拦截 `fetch`，让 `/notify` 返回构造的帧（`seq` 递增，否则引擎判"无新帧"）
   → 真正跑起来的是 `startNotify` 的消费循环
   （`fetchNotify → batch.seq > seq → toastFrame → frameToToast → new Notification`）；
   帧类型用 `question/requested`，**不需要真实 DSH 事件**；
3. 切换可见性并**派发真实事件**，验聚焦门两个方向。

**结论**：引擎把帧映射成通知并弹出
（`{title:"模型在等你回答", body:…, icon:"notify-question.png"}`）、
`/notify` 轮询在跑、**聚焦门两个方向都对**（前台不弹 / 后台弹）。

⚠️ 验证过程中两次"判据没验证"的坑（都写进脚本注释，避免重犯）：
① 前台断言忘了**停掉假帧供给** → 引擎当然继续弹，差点当成"聚焦门失效"；
② 引擎的 `isPageActive()` 用的是**模块级缓存变量**，只在
`visibilitychange` / `focus` / `blur` 事件里更新 —— 直接覆盖 `document.hidden`
**不会刷新缓存**。两次都是测试假象，产品行为一直是对的。

**想在有桌面的环境里亲眼看到弹窗**，两条现成路径：
1. 设置页里的**「测试通知」按钮**（`settings.ts:368` 直接 `new Notification(...)`）
   —— 验的是浏览器通知权限与弹出能力，**不经过宿主队列**；
2. 跑一次真实 agent 会话（回合结束即触发 `turn/end`）→ 应弹「对话完成」。

---

## 3.1 工作状态联动（**6/6 档位精确命中**）

**为什么单独验**：目标里的「状态联动」此前**只验了一半** ——
验过的是 `balance`（余额，属独立的 `events.balance` 池），
而 `events.workStatus` 的档位联动从没验过。

**链路**：
`host WorkStatusStore`（监听 DSH `session/event`）→ `{state,task,ts}`
→ `GET /dsh-pet-7340/work-status` → 客户端 `fetchWorkStatus`
（枚举外的 `state` 归 `null`，**绝不伪造**）→ 递增 `workStatusTick`
→ 播 `events.workStatus[WORK_STATUS_INDEX[state]]` + 弹气泡。

**档位（顺序即索引，勿在中间插入新档）**：

| 索引 | 档位 | 触发事件 | 沙箱池里的动画 | 实测 |
|---|---|---|---|---|
| 0 | `thinking` | `turn/start` | 工作状态-思考冒泡 | ✅ |
| 1 | `working` | `tool/call` | 工作状态-忙碌点按 | ✅ |
| 2 | `result` | `tool/result` | 工作状态-清点归档 | ✅ |
| 3 | `waiting` | `approval/asked` | 工作状态-原地踱步张望 | ✅ |
| 4 | `success` | `turn/end` completed | 工作状态-雀跃庆祝 | ✅ |
| 5 | `error` | `turn/end` error/max-tokens | 工作状态-垂头叹气冒汗 | ✅ |

**语义**：进行中档位**循环**播且气泡常驻；终态（`success`/`error`）播一遍且 10s 自动收起；
`state=null`（空闲）收起回待机。

**验证方式**：`scripts/manual-workstatus-flow.mjs`（不进 deploy 门禁）。
不改 vendor、不跑模型 —— 拦截页面 `fetch` 让 `/work-status` 返回**受控快照**，
跑起来的仍是真实客户端组件；逐档喂入并核对"该档位播的动画名 == 该索引池里的名字"。

⚠️ 这里又踩了一次"判据没验证"：第一版把 `events.workStatus` 的元素按**数组**处理，
于是把**字符串**元素读成空，得到"池是空的、0/6 命中"，看起来像联动坏了 ——
其实它实际是**扁平字符串数组**（索引即档位；元素也可能是数组，是同档内随机抽的写法）。
修正读取后立刻 6/6。**拿到"失败"时先验判据，别先怀疑产品。**


---

## 4. 已知取舍与设计决定

| 决定 | 理由 |
|---|---|
| 桌宠作为**库**由我们这一个插件一并 `apply`，不再单独 load | 客户端 boot 清单里每个包只对应一个客户端模块 id；第二个 id 永远不会被物化（实测不报错，极难排查） |
| 设置窗口由 **Electron 主进程**持有 | 保存配置会触发宿主 `restartHelper`；挂在助手进程上会被连窗重启掉 |
| 设置窗口的 `settings-*` 文件放 `src/desktop/`，不放 vendor | vendor 只放上游副本；由 `build-runtime.mjs` 叠加进 `lib/runtime/` |
| 宿主配置写入白名单扩了 4 个字段 | 上游只白名单 `pets` + 三个开关；`whisperPrompt` 等会**返回 200 但静默不生效** |
| 对我们改上游代码一律走 `scripts/patch-vendor.mjs`（幂等） | 升级上游时"覆盖 → 重跑补丁"即可，且每处改动有 `[dsh-app]` 标记 |
| 设置页里**有两个分区**（`pet-config` + `efficiency-config`），**有意保留** | 上游 `app.ts` 注册 `pet-config`（宠物实例 / 卸载与存储），我们注册 `efficiency-config`（效率与通知开关）。**各司其职、不是重复** —— 实测设置页导航项为 `… / Pet Config / Plugin Market / Efficiency`。合并成一个面板属**体验优化**，非目标要求；若要做需在 `apply` 处包一层 `slots.inject` 拦截上游注册 |

---

## 5. 下一步（唯一剩余项）

**生产部署 —— 需要维护者一句明确同意**（重启期间网页会白屏一次）。

步骤与注意事项见 [DEPLOY-CHECKLIST.md](docs/DEPLOY-CHECKLIST.md)，
其中最容易搞错的一点：

> 上游 `dsh-pet` 要**留依赖、移 bundle** ——
> 留在 `dependencies` 当**素材来源**，移出 `bundles` 避免与我们的宠物抢 `/dsh-pet-7340/*` 路由。

### 5.1 交付物核对（逐句对目标原文）

| 目标原文 | 状态 |
|---|---|
| 把 dsh-pet 的代码 vendor 进 `packages/dsh-efficiency` | ✅ |
| **仅代码** | ✅ `src/` 50/50、`runtime/` 11/11，与已安装上游逐目录一致 |
| 带 **MIT LICENSE** | ✅ 上游 LICENSE 原文在库、在分发包内；`THIRD-PARTY-NOTICES.md` 含出处与禁商用 |
| **不含素材** | ✅ preflight 机器核对：**0 个素材文件**；`git ls-files` 里 0 个 assets |
| 改造为**单一插件包** | ✅ `name=dsh-efficiency`，客户端只 load 一次 |
| 桌宠本体 · 网页浮层 | ✅ `manual-web-overlay.mjs` PASS |
| 桌宠本体 · 桌面 Electron 小窗 | ✅ `manual-desktop-smoke.mjs` PASS（含生产配置 `display=desktop`） |
| 桌宠本体 · 通知 | ✅ `manual-notify-flow.mjs` 13 项 PASS |
| 桌宠本体 · 状态联动 | ✅ `manual-workstatus-flow.mjs` 6/6 档位精确命中 + 余额链路一致 |
| 一个**完整的设置 GUI** | ✅ 8 分区 / 33 行 / 241 控件 / **无只读项** |
| 桌面宠物右键菜单新增「**设置…**」 | ✅ 菜单实测含该项，`openSettings` → 主进程开窗链路实测 PASS |
| **素材仍从已安装的 dsh-pet 包读取** | ✅ 字体 / 头像 / `pic/*` / `thumb/*.webm` 路由均 200 |
| 先决条件必须先在**沙箱实例验证** | ✅ 5 门禁 + **6 个端到端脚本** + preflight 34 项，全绿 |
| 部署走 **`npm run deploy`** 门禁 | ✅ 门禁已建成、全绿 |
| 必须经**维护者同意**后才重启生产 | ⏸ **生产 3080 至今未动、未加载本插件**；等维护者决定 |

**结论**：目标里所有可交付物均已构建并在沙箱验证完毕。
唯一未执行项是**生产部署**，它是一个**需要维护者明确同意才能发生的运维动作**，
本身不是本目标的交付物 —— 代码与门禁均已就绪，一句「部署」即可执行。

