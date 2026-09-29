# 第三方插件兼容性台账

> 目的：每个第三方插件采用前，先跑「安装 → 启动 → 检查跳过/拒绝」并记录在此。
> **一次只装一个**，否则无法定位失败源。
>
> 基线：`dsh` **0.2.0-rc.2**（288 包，278 个 `@deepseek-ai/*` 一致）
> 判定口径：安装是否被 peer 闸门拒绝 / 启动后是否出现在 `skippedBundles` / 运行是否正常

---

## 台账

| 插件 | 版本 | 声明的 dsh peer | 安装 | 启动 | 结论 |
|---|---|---|---|---|---|
| `dshmarket` | 1.66.5 | 见下 | ✅ 已装（预先存在） | ✅ 正常 | 可用 |
| **`dsh-pet`** | **0.2.12** | **`^0.1.1-rc.2`**（11 项） | ✅ **豁免后成功** | ✅ **完全正常** | ✅ **可用**（闸门警告过于保守） |
| `dsh-auto-collapse` | 0.2.1 | 仅 `schemastery` | ⬜ 待测 | ⬜ | 🟢 依赖最干净 |

---

## ⭐ 关键结论：版本闸门会**误判**

**`dsh-pet@0.2.12` 在 `dsh 0.2.0-rc.2` 上实际完全可用**，尽管闸门判定它"不兼容"并警告"可能崩溃或数据丢失"。

这意味着：**闸门拒绝 ≠ 真的不能用**。它与 `dshmarket` 的表现一致（后者 peer 上限写 `0.2.0-rc.1` 也能正常跑）。

→ **实践建议**：遇到闸门拒绝时，**先在隔离实例里实测**，再决定是否给主环境豁免。本次正是这么做的。

---

## `dsh-pet` 0.2.12 —— 隔离实例实测记录

**环境**：隔离 `DSH_HOME` = `C:\Users\WANGZ\dsh-test-home`，端口 3097。主环境未触碰。

| 步骤 | 结果 |
|---|---|
| 1. 装到主 profile（未豁免） | ❌ **被拒**，profile 保持原状（bundles 不变、无 `node_modules/dsh-pet`） |
| 2. 在**隔离 HOME** 授予豁免 | ✅ `dsh: allowed dsh-pet@0.2.12 for DSH 0.2.0-rc.2` |
| 3. 隔离 HOME 安装 | ✅ 62.22 MB，`+11` 包，2 秒完成（有 peer 警告，非致命） |
| 4. 启动 | ✅ 监听 3097，**输出 token 正常** |
| 5. **有无策略拒绝 / skippedBundles** | ✅ **完全没有**（stderr 仅一条无害信息：`main-config.json` 的 pets 未设 → 取默认列表） |
| 6. 宿主路由 | ✅ `/dsh-pet-7340/config` → **HTTP 200** |
| 7. 客户端插件 | ✅ **`index.html` 的前端模块图里含 `dsh-pet/client.js`** |
| 8. Electron 桌面模式 | ✅ **自动下载并启动**（v43.3.0，137.7MB，16.2s → `ready`） |
| 9. 健康检查 | ✅ `/` → HTTP 401 |

### 副作用（需纳入考虑）

| 项 | 说明 |
|---|---|
| **Electron 体积** | 下载 137.7MB，解压后**目录 347.3 MB** |
| 下载位置 | `$DSH_HOME/electron`（主环境将是 `C:\Users\WANGZ\.dsh\electron`） |
| 首次启动耗时 | +16.2 秒（下载），之后复用 |
| ⚠️ 装到主环境需**再下一次** | 隔离环境的 Electron 不会被主环境复用 |

### 复现命令

```powershell
# 隔离环境验证（不碰主环境）
$env:DSH_HOME = "$env:USERPROFILE\dsh-test-home"
dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk
dsh plugin --profile web add dsh-pet
dsh web --port 3097 --no-open
```

---

## 逐个记录

### `dshmarket` 1.66.5（已装）

- peer 范围上限写 `0.2.0-rc.1`，运行时是 `0.2.0-rc.2`
- **实际正常运行** → 说明**这类不匹配在真实环境中可能已被容忍**，或存在豁免
- ⚠️ 因此**不能只凭 peer 范围预判**，必须实测
- `compatibility.json` 当前**不存在** → 说明它不是通过豁免放行的

### `dsh-pet` 0.2.12（待测，S3）

**声明的 peer（11 项，全部 `^0.1.1-rc.2`）**

```
@deepseek-ai/dsh-llm
@deepseek-ai/dsh-commands
@deepseek-ai/dsh-home-paths
@deepseek-ai/dsh-credentials
@deepseek-ai/dsh-client-runtime
@deepseek-ai/dsh-host-webserver
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-connection
@deepseek-ai/dsh-agent-default-model
（+ react、@deepseek-ai/cordis 等非 dsh 前缀项）
```

**semver 判定**：`^0.1.1-rc.2` = `>=0.1.1-rc.2 <0.2.0`，**不含 `0.2.0-rc.2`**
（预发布版本只匹配同 `[major,minor,patch]` 元组的范围）
→ **预期被版本闸门拒绝**

**处理顺序**

```powershell
# ① 先正常装，观察真实结果（不要凭预判跳过这步）
dsh plugin --profile web add dsh-pet

# ② 被拒则查看运行时版本与已有豁免
dsh plugin --profile web version-exemptions

# ③ 授予精确版本豁免（需明确接受风险）
dsh plugin --profile web allow-version dsh-pet@0.2.12 --dsh-version 0.2.0-rc.2 --accept-risk

# ④ 仍不行则从源码构建（lib/ 不入库，必须 prepare）
git clone https://github.com/PC2005-cloud/dsh-pet.git
cd dsh-pet\dsh-pet; npm install; npm run prepare
dsh plugin --profile web add file:<绝对路径>
```

⚠️ 豁免**不随插件/DSH 升级继承**，升级后需重新授予。

**失败也不要紧**：架构上 L1 不依赖 L2 ——
核心功能必须能在**没有 `dsh-pet`** 的情况下工作（S4 有强制的降级检验）。

---

## 记录模板

```
### `<包名>` <版本>

- peer：
- 安装：✅/❌ + 原始输出摘要
- 启动：是否出现在 skippedBundles / 是否有策略拒绝告警
- 运行：功能是否可用
- 是否用了豁免：
- 结论：
```
