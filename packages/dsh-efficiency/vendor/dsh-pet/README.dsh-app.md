# vendored: PC2005-cloud/dsh-pet

> **本目录是他人的代码，不是本项目的原创。**
> 我们只是把它复制进来以便改造，**版权归上游**。

---

## 1. 出处

| 项 | 值 |
|---|---|
| 上游仓库 | <https://github.com/PC2005-cloud/dsh-pet> |
| npm 包 | `dsh-pet` |
| **vendor 时的版本** | **`0.2.12`** |
| **上游 commit SHA** | **`6bb68c0f30abaf9e75330f55f639dff0817c9230`**（main 分支，2026-09-29 查得） |
| vendor 日期 | 2026-09-29 |
| 许可 | **MIT** · `Copyright (c) 2026 PC2005-cloud`（原文见本目录 `LICENSE`） |

> 记下 commit SHA 是为了日后精确对比上游改了什么：
> `git clone https://github.com/PC2005-cloud/dsh-pet && git diff 6bb68c0 -- src/`

## 2. vendor 了什么 / 没 vendor 什么

| 内容 | 是否 vendor | 说明 |
|---|---|---|
| `src/`（TypeScript 源码，50 文件） | ✅ | 主要改造对象 |
| `runtime/`（桌面 Electron helper，11 文件） | ✅ | 桌面端实际加载的就是这里 |
| `scripts/`（构建脚本） | ✅ | |
| `LICENSE` / `package.json` / `cordis.patch.yml` | ✅ | MIT 要求保留许可与版权声明 |
| **`assets/`（60.7 MB / 141 文件）** | ❌ **绝不** | **素材禁止商用**，运行时从已安装的 `dsh-pet` 包读取 |
| `lib/`（构建产物） | ❌ | 应自行重建，不 vendor 别人的产物 |

**为什么必须分开对待**：上游对**代码**用 MIT（允许复制修改），
对**素材**另有约定（**允许开源使用、禁止商用**，且二创必须署名）。
详见仓库根目录 [NOTICE.md](../../../../NOTICE.md) §0.1 与 [AGENTS.md](../../../../AGENTS.md) §4.1。

## 3. 署名义务（强制）

> 本项目是 `dsh-pet` 的衍生作品。
> **任何介绍、展示、分发本项目的地方，都必须附上：**
>
> ### <https://github.com/PC2005-cloud/dsh-pet>

## 4. 我们做的改动

改动由 **[`scripts/patch-vendor.mjs`](../../scripts/patch-vendor.mjs) 幂等施加**，
而不是手改 —— 这样升级上游时可以「覆盖 → 重跑补丁」，不必回忆改了哪些地方。

规则：
- 每处改动在代码里留 `[dsh-app]` 标记，与上游 diff 时一眼可辨
- 补丁脚本幂等：重复运行只会跳过，不会重复插入
- 补丁找不到锚点时会**报错退出**（而不是静默跳过）—— 上游改了那段代码时必须人工核对

**改动记录**：

| 日期 | 改动 | 文件 | 为什么 |
|---|---|---|---|
| 2026-09-29 | 同一工作状态档位内不打断正在播的动画 | `src/client/pet.ts`（浏览器端）<br>`runtime/electron-helper/events.js`（桌面端） | work-status 每次 tick（每个 `tool/result`）都重新抽动画并切过去，导致档位动画（如"搞定一步，继续看看"）**永远播不完**、一直被打断重开。改为档位未变且当前动画仍属本档位时直接返回。 |

### 升级流程（更新版）

```powershell
# 1) 取新版本源码
npm pack dsh-pet@<新版本>          # 或 git clone + checkout 目标 commit

# 2) 覆盖 vendor 目录（src/ runtime/ scripts/ LICENSE package.json cordis.patch.yml）
#    ⚠️ 不要带 assets/

# 3) 重新施加我们的改动 —— 若某处锚点已变，脚本会明确报出，人工核对后更新锚点
node scripts/patch-vendor.mjs

# 4) 重新构建
node scripts/build-vendor.mjs && node scripts/build-client-vendor.mjs && node scripts/build-host.mjs && node scripts/build.mjs

# 5) 更新本文件的版本号、commit SHA 与改动记录
```
