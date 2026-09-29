# 开发产物与生产环境必须隔离（事故复盘）

> 日期：2026-09-29
> 事故：**在生产环境上直接跑开发构建，把生产打坏**

---

## 1. 事故经过

1. 生产 profile 用 `file:` 依赖指向本仓库：
   `~/.dsh/profiles/web/package.json` → `"dsh-efficiency": "file:.../packages/dsh-efficiency"`
2. pnpm 对 `file:` 依赖使用**硬链接**。实测验证：
   ```
   生产 node_modules/dsh-efficiency/lib/client.js
   仓库 packages/dsh-efficiency/lib/client.js
   哈希相同 → 同一份文件（同一个 inode）
   ```
3. 于是 **`npm run build` 等于直接改生产**，没有任何缓冲。
4. 我重构 `app.js` 时留下一处 `ReferenceError: t is not defined`
   （已修）。期间产出的坏构建 18:03:32 落盘。
5. 生产服务 18:04:18 重启，加载该构建 → 插件 `apply` 阶段崩溃 →
   **前端白屏**。

---

## 2. 我犯的判断错误（比技术错误更值得记）

我在 17:40 **已经发现**了硬链接这个事实，还把它当作"便利"写进了提交信息：

> 另:确认 pnpm 用硬链接安装 file: 依赖,所以仓库构建产物与
> profile 内的是同一份文件,构建即同步(不再需要手动复制)。

**把"构建即同步"理解成便利，而没意识到它就是"无隔离"** ——
同一个事实，换个角度看就是：**在仓库里构建 = 在生产上构建**。
这是本次事故的根本原因。

**教训**：当发现"某个操作会直接作用于生产"时，第一反应应该是
**建立隔离**，而不是庆祝省了一步复制。

---

## 3. 修复：三层隔离

### 3.1 产物分层

```
packages/dsh-efficiency/
  src/       源码（唯一事实来源，随便改）
  lib/       开发构建产物（沙箱用）
  dist/      已验收的发布产物（生产用）   ← 新增
```

- `npm run build` → 只写 `lib/`
- `npm run deploy` → **先跑全部测试**，通过后才 `lib/ → dist/`
- **生产 profile 指向 `dist/`，不再指向包根**

这样：在仓库里怎么改、怎么构建，**生产都不受影响**；
只有显式 `deploy` 且测试全绿，才会产生新的生产产物。

### 3.2 部署脚本必须过门禁

`scripts/deploy.mjs`：

1. 跑 `build`
2. 跑 `smoke-client`（含"apply 期间无错误日志"断言）
3. 跑 `test-placement`
4. 全绿才把 `lib/` 复制到 `dist/`
5. 打印下一步（重启到哪个端口、如何回滚）

### 3.3 生产安装路径改为 dist

```powershell
dsh plugin --profile web add "file:.../packages/dsh-efficiency/dist"
```

⚠️ **但注意**：`dist` 目录里的 `package.json` 若也是硬链接，仍会被影响。
所以 `deploy` 用**复制**而非链接语义，且需要在 dist 下放一份
独立的 `package.json`（`files` 只含 `lib`，避免把 `src` 链过去）。

**更稳的做法（推荐）**：生产从**打包产物**安装，或用 `pnpm pack` 出的
tarball。tarball 是快照，物理上不可能被仓库改动影响。

---

## 4. 交叉验证清单（以后每次改插件都要过）

- [ ] 改完只跑 `npm run check`，**不碰生产**
- [ ] 需要在真实 DSH 里验证 → 用**沙箱实例**（独立 `DSH_HOME` + 独立端口）
- [ ] 确要上生产 → `npm run deploy`（过门禁）→ 请用户重启
- [ ] **任何时候都不要**在生产 `DSH_HOME` 的 profile 里指向仓库源码目录

自检：生产侧产物与仓库产物的 inode 是否相同？
```powershell
(Get-Item "$prod\lib\client.js").Target   # 或比较哈希 + 用 fsutil hardlink list
```
若相同 → **隔离已失效**，必须立刻纠正。
