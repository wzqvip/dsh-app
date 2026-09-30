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
| 通知 | ⚠️ 部分 | 接线已核对完整（见 §3）；**帧→toast 的展示段未验** |
| 状态联动 | ✅ | `/balance` 返回 79.16 与桌面气泡 `余额（谷）¥79.16` 一致；`/work-status` 门控正确 |
| 设置 GUI + 右键「设置…」 | ✅ | 截图 `build/settings-window.png`；DOM：4 分区 / 24 行 / 21 控件；保存链路实测成功 |
| 提问链路（核心价值） | ✅ | 注入合成提问 → 面板渲染出选项 + Submit/Skip + 输入框；截图 `build/question-panel.png` |
| deploy 五道门禁 | ✅ | build / smoke / placement / materialize / config-write 全绿 |
| 生产未被影响 | ✅ | 3080 至今跑 `base / web-app / dshmarket / dsh-pet`，**未加载本插件** |

---

## 3. 通知的接线现状（唯一部分验证项）

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

**未验的只是最后一段**：帧到达后 toast 是否真的弹出。
原因：帧只能由**真实 DSH 事件**触发；而注入需要给宿主加 dev 钩子，
但 `pushNotifyFrame` **没有对外导出**（只有 pet 宿主模块内部可见），
不值得为验证去改 vendor。

**若要补验**，两条现成路径：
1. 设置页里的**「测试通知」按钮**（`settings.ts:368` 直接 `new Notification(...)`）
   —— 验的是浏览器通知权限与弹出能力，**不经过宿主队列**。
   注意 headless 浏览器通常不展示系统通知，需在有桌面的浏览器里点。
2. 跑一次真实 agent 会话（回合结束即触发 `turn/end`）→ 看是否弹「对话完成」。

---

## 4. 已知取舍与设计决定

| 决定 | 理由 |
|---|---|
| 桌宠作为**库**由我们这一个插件一并 `apply`，不再单独 load | 客户端 boot 清单里每个包只对应一个客户端模块 id；第二个 id 永远不会被物化（实测不报错，极难排查） |
| 设置窗口由 **Electron 主进程**持有 | 保存配置会触发宿主 `restartHelper`；挂在助手进程上会被连窗重启掉 |
| 设置窗口的 `settings-*` 文件放 `src/desktop/`，不放 vendor | vendor 只放上游副本；由 `build-runtime.mjs` 叠加进 `lib/runtime/` |
| 宿主配置写入白名单扩了 4 个字段 | 上游只白名单 `pets` + 三个开关；`whisperPrompt` 等会**返回 200 但静默不生效** |
| 对我们改上游代码一律走 `scripts/patch-vendor.mjs`（幂等） | 升级上游时"覆盖 → 重跑补丁"即可，且每处改动有 `[dsh-app]` 标记 |

---

## 5. 下一步（唯一剩余项）

**生产部署 —— 需要维护者一句明确同意**（重启期间网页会白屏一次）。

步骤与注意事项见 [DEPLOY-CHECKLIST.md](../DEPLOY-CHECKLIST.md)，
其中最容易搞错的一点：

> 上游 `dsh-pet` 要**留依赖、移 bundle** ——
> 留在 `dependencies` 当**素材来源**，移出 `bundles` 避免与我们的宠物抢 `/dsh-pet-7340/*` 路由。
