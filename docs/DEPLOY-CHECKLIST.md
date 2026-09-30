# 部署步骤（待维护者同意后执行）

> 日期：2026-09-30 · 状态：**预检全绿，等维护者点头**
> 预检命令：`node packages/dsh-efficiency/scripts/preflight.mjs`（只读，1.3s）

## 前置

- `npm run deploy` 的五道门禁必须全绿（preflight 会跑）
- 生产 `3080` 现在跑的是 `base / web-app / dshmarket / dsh-pet`，
  **没有**我们的插件（已核对）

## 关键点：上游 `dsh-pet` 要「留依赖、移 bundle」

这两件事必须**分开**做，否则会坏：

| 做什么 | 为什么 |
|---|---|
| **保留** `dsh-pet` 在 profile 的 `dependencies`（`node_modules` 里有它） | 我们的宠物**素材**是从已安装的 `dsh-pet` 读的（素材禁商用，不随本仓库分发）。删掉它 → 宠物无立绘/表情包/字体 |
| **移出** profile 的 `dsh.profile.bundles` | 上游插件会注册**同一批**路由（`/dsh-pet-7340/*`）与我们冲突；且我们的 bundle 里已含宠物代码，两套一起跑会重复注册 |

结论：`dsh-pet` 只当**素材来源**，不再作为插件激活。

## 步骤

> **实测补充**：装 `dsh-pet` / 反复 `plugin add` 时，pnpm 收尾可能报
> `cannot access the file because it is being used by another process. (os error 32)`。
> 这通常是**文件被运行中的进程占用**（服务还没停干净）。
> 判断装没装成功**别看这条报错**，看结果：目标目录里有没有
> `package.json` 与 `lib/`。若 `node_modules/dsh-efficiency` 只剩空壳 → 删掉重装。

```powershell
# 0) 预检（只读，应 PASS）
node packages/dsh-efficiency/scripts/preflight.mjs

# 1) 装我们门禁把关后的成品 —— 指向 release/，不是包根
#    （release/ 是 deploy.mjs 的产物，与生产隔离；包根是开发用）
dsh plugin --profile web add file:C:/Users/WANGZ/Documents/GitHub/dsh-app/packages/dsh-efficiency/release

# 2) 把上游 dsh-pet 移出 bundles，但**保留在 dependencies**（素材来源）
#    编辑 %USERPROFILE%\.dsh\profiles\web\package.json 的 dsh.profile.bundles，
#    去掉 "dsh-pet"，保留 dependencies 里的 "dsh-pet": "^0.2.12"
#    ⚠️ 实测：`dsh plugin add dsh-pet` 会**自动把它加进 bundles**，必须手工移出。

# 3) 关掉旧的桌面宠物进程（否则会有两只宠物同时挂在屏幕上！
#    实测踩过：沙箱与生产各开一只，维护者右键到了没有设置菜单的那只）
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force

# 4) 重启生产（**会白屏一次**）—— 必须维护者明确同意后才做
.\scripts\restart-dsh.ps1     # 需在独立终端跑（它拒绝从监听进程的后代调用）
```

> ⚠️ **装完务必核对文件是最新的**（`plugin add` 是硬拷贝不是软链）：
> 比对 `packages/dsh-efficiency/release/lib/` 与
> `~/.dsh/profiles/web/node_modules/dsh-efficiency/lib/` 的哈希。
> 详见 [TESTING.md](TESTING.md) §4.1。

## 部署后要立刻验的

```powershell
# 宿主健康
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3080/dsh-efficiency/api/health
# 宠物配置 + 素材（确认素材仍来自 dsh-pet）
curl ... http://127.0.0.1:3080/dsh-pet-7340/config
curl ... http://127.0.0.1:3080/dsh-pet-7340/pic/cursor-grab.png
```

网页里应能看到：桌宠浮层（`dsh-pet-root`/`dsh-pet-stage`/`dsh-pet-video`）、
余额气泡、以及有提问时锚定在宠物下方的提问面板。
桌面端右键宠物 → 菜单里有「设置…」。

## 回滚

```powershell
# 移出我们的插件即可回到现状（dsh-pet 本来就在 bundles 里，恢复它的条目）
dsh plugin --profile web remove dsh-efficiency
# 把 "dsh-pet" 加回 dsh.profile.bundles
# 重启
```

## 预期风险

- **白屏一次**：重启期间网页短暂不可用，属正常
- 首次启动会解析桌面 helper（`lib/runtime/`），若 Electron 未就绪会走下载/降级，
  宿主日志会明确写原因（`dsh-app` 前缀）
- 若素材路由 404：检查 `dsh-pet` 是否仍安装在 profile 的 `node_modules` 里
