# 环境基线

> 记录时间：2026-09-29 15:15
> 用途：S2 基线固化。任何改动前可对照本文件判断"什么变了"。

---

## 1. 运行时

| 项 | 值 |
|---|---|
| `dsh` 版本 | **0.2.0-rc.2** |
| 实际安装路径 | **`C:\Users\WANGZ\node_modules\@deepseek-ai\dsh`** |
| 包总数 | 288（其中 278 个 `@deepseek-ai/*` 为 `0.2.0-rc.2`） |
| Node | v24.13.0 |
| pnpm | 12.6.0 |
| 旧 npx 缓存 | ✅ **已清理**（`..._npx\1e7f6d9597241db0\` 不复存在），无路径歧义 |
| `dsh` 命令是否真全局安装 | ❌ **否**。`%APPDATA%\npm\dsh.cmd` 不存在，能否解析取决于 PATH |

## 2. 正在运行的实例

| 项 | 值 |
|---|---|
| 监听 | `127.0.0.1:3080`（**仅回环**） |
| 服务器 PID | **12088** |
| 监督进程 PID | 126644（`npx @deepseek-ai/dsh web`） |
| 启动时间 | 2026-09-29 14:44:17 |
| 健康检查 | `/` → **HTTP 401**（认证正常） |
| DSH_HOME | `C:\Users\WANGZ\.dsh` |

## 3. web profile

| 项 | 值 |
|---|---|
| 路径 | `C:\Users\WANGZ\.dsh\profiles\web` |
| bundles | `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` / **`dshmarket`** |
| `dshmarket` 版本 | 1.66.5（已装，可直接用来装插件） |
| `compatibility.json` | **不存在**（尚无版本豁免） |
| `patchReload` | `live`（改 patch 可能立即重载） |

## 4. profile 现有 patch 层

`cordis.patch.yml` 当前覆盖两项：

```yaml
- id: ui-settings-general
  config: { welcomeNoticeVersion: 2026-09-28.1 }
- id: web-search-deepseek
  config: { apiKeyEnv: DEEPSEEK_API_KEY, maxUses: 10 }
```

home 层 `~/.dsh/cordis.patch.yml`：**不存在**

## 5. 备份

- 位置：`backup/profile-web-20260929-151516/`
- 含：`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`
- ⚠️ `backup/` 已在 `.gitignore` 中，**不入库**（属本机产物）

### 回滚方法

```powershell
$b = 'C:\Users\WANGZ\Documents\GitHub\dsh-app\backup\profile-web-20260929-151516'
$t = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "$b\*" $t -Force
# 若装了插件导致启动失败，还需：
#   cd $t; pnpm install
# 然后重启 dsh web
```

## 6. 已明确的已知问题

| # | 问题 | 影响 |
|---|---|---|
| B1 | ⚠️ **`--dump-config` 与运行时不一致** —— dump 显示 `tool-ask-user` 无 config（应为 legacy），实际运行时是 timed | **不要用 `dump-config` 判断插件是否启用/如何配置** |
| B2 | `dsh` 命令未真正全局安装 | 全新终端可能找不到；启动器需覆盖此场景 |
| B3 | `shell.overlay` 等第三方依赖存在版本闸门风险 | 见 [compat-matrix.md](compat-matrix.md) |
| B4 | 进程无法重启自己的祖先树 | 见 [07-restart-findings.md](07-restart-findings.md) |

## 7. 待建立

- [ ] `research/compat-matrix.md` —— 第三方插件兼容性台账（下一步一起建）
