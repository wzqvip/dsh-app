# 部署步骤（待维护者同意后执行）

> 日期：2026-09-30 · 状态：**预检全绿，等维护者点头**
> 预检命令：`node packages/dsh-efficiency/scripts/preflight.mjs`（只读，1.3s）

## 前置

- `npm run deploy` 的五道门禁必须全绿（preflight 会跑）
- 生产 `3080` 现在跑的是 `base / web-app / dshmarket / dsh-pet`，
  **没有**我们的插件（已核对）

## 关键点：`dsh-pet` **必须移出 `bundles`**（但不再需要它当素材来源）

> **2026-09-30 起简化**：素材已**随本包分发**（`vendor/dsh-pet/assets/`，60.7 MB），
> 所以不再需要"保留 `dsh-pet` 当素材来源"那一步。
> 但**移出 `bundles` 这一步仍然必须做** —— 否则上游插件会与我们的宠物
> 抢同一批路由（`/dsh-pet-7340/*`）。

| 做什么 | 为什么 |
|---|---|
| **移出** `dsh-pet` 的 `dsh.profile.bundles` 条目 | 上游插件会注册**同一批**路由（`/dsh-pet-7340/*`）；我们的 bundle 里已含宠物代码与素材，两套一起跑会重复注册 |
| `dsh-pet` 留在/不留在 `dependencies` | **都可以** —— 素材不再依赖它。想留着也无害（只是多个包） |

> 历史说明：此前素材不随包分发，所以要求「**留依赖、移 bundle**」。
> 素材入库后只剩「移 bundle」一条。

## 步骤

> **实测补充**：装包 / 反复 `plugin add` 时，pnpm 收尾可能报
> `cannot access the file because it is being used by another process. (os error 32)`。
> 这通常是**文件被运行中的进程占用**（服务还没停干净）。
> 判断装没装成功**别看这条报错**，看结果：目标目录里有没有
> `package.json`、`lib/` 与 **`vendor/dsh-pet/assets/`（143 个文件）**。
> 若 `node_modules/dsh-efficiency` 只剩空壳 → 删掉重装。
>
> ⚠️ 装完**务必确认 `vendor/` 真的进去了** —— 实测踩过：`dsh plugin add` 会按
> 包内 `package.json` 的 `files` 白名单过滤，白名单过期时 `vendor/` 会被整个过滤掉，
> 而 release 目录里明明有素材。（已在 `deploy.mjs` 里改成每次重新生成该白名单。）

```powershell
# 0) 预检（只读，应 PASS）
node packages/dsh-efficiency/scripts/preflight.mjs

# 1) 装我们门禁把关后的成品 —— 指向 release/，不是包根
#    （release/ 是 deploy.mjs 的产物；包根是开发用）
dsh plugin --profile web add file:C:/Users/WANGZ/Documents/GitHub/dsh-app/packages/dsh-efficiency/release

# 1b) 核实素材真的装进去了（应为 143）
(Get-ChildItem "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-efficiency\vendor\dsh-pet\assets" -Recurse -File).Count

# 2) 把上游 dsh-pet 移出 bundles
#    编辑 %USERPROFILE%\.dsh\profiles\web\package.json 的 dsh.profile.bundles，去掉 "dsh-pet"
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
curl http://127.0.0.1:3080/dsh-efficiency/api/health
# 宠物配置 + 素材（素材应来自**本包自带**）
curl http://127.0.0.1:3080/dsh-pet-7340/config
curl http://127.0.0.1:3080/dsh-pet-7340/pic/cursor-grab.png
```

**看宿主日志里这一行**，它明确写出素材从哪来：

```
[dsh-app] 素材根: .../node_modules/dsh-efficiency/vendor/dsh-pet/assets （自带）
```

- 显示「**（自带）**」= 用的是包内素材，正常
- 显示「（回退到已安装的 dsh-pet）」= 包里没带素材，**发布包不完整**，回头查 `files` 白名单

网页里应能看到：桌宠浮层（`dsh-pet-root`/`dsh-pet-stage`/`dsh-pet-video`）、
余额气泡、以及有提问时锚定在宠物下方的提问面板。
桌面端右键宠物 → 菜单里有「设置…」。

## 回滚

```powershell
# 移出我们的插件即可回到现状（dsh-pet 原本就在 bundles 里，恢复它的条目）
dsh plugin --profile web remove dsh-efficiency
# 把 "dsh-pet" 加回 dsh.profile.bundles
# 重启
```

## 预期风险

- **白屏一次**：重启期间网页短暂不可用，属正常
- 首次启动会解析桌面 helper（`lib/runtime/`），若 Electron 未就绪会走下载/降级，
  宿主日志会明确写原因（`dsh-app` 前缀）
- 若素材路由 404：先看上面那行「素材根」日志 —— 它会直接告诉你素材从哪来、
  或为什么找不到
- 安装包体积较大（含 60.7 MB 素材），`plugin add` 会多花几秒；这是自带素材的代价
