# `npx ECOMPROMISED / Lock compromised` 根因与规避

> 日期：2026-09-29
> 现象：`npm error code ECOMPROMISED / npm error Lock compromised`
> 日志：`%LOCALAPPDATA%\npm-cache\_logs\2026-09-29T20_07_55_282Z-debug-0.log`

---

## 1. 结论速览

**这**不是**网络或权限问题，是 `npx` 的锁被"自己人"破坏：**

生产 DSH 服务**从 npx 缓存目录里运行**，而之后任何一次 `npx @deepseek-ai/dsh ...`
都会试图 **reify（重装）那个正在被运行的目录** → 锁被改动 → npx 主动放弃。

---

## 2. 证据链

### 2.1 报错栈（官方机制）

```
Error: Lock compromised
    at AbortSignal.<anonymous> (nodejs\node_modules\npm\node_modules\libnpmexec\lib\with-lock.js:52:30)
    at Timeout.touchLock   (nodejs\node_modules\npm\node_modules\libnpmexec\lib\with-lock.js:161:18)
error code ECOMPROMISED
```

- `touchLock`（:161）周期性"续租"锁；一旦发现**锁内容/存在性被改动**就 abort
- `with-lock.js:52` 把它翻译成 `ECOMPROMISED`
- **`libnpmexec` = `npx` 的实现包** → 这个错**只可能来自 npx**，普通 `npm install` 不会这样报

### 2.2 崩溃时 npx 正在做什么

日志显示它正在 reify：把

```
...\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-<name>
```

改名为

```
...\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\.dsh-<name>-<随机后缀>
```

即 **npx 想替换整份 `@deepseek-ai` 安装**。

### 2.3 谁在使用那个目录（关键）

```
PID 139884: "node" "...\_npx\1e7f6d9597241db0\node_modules\.bin\..\@deepseek-ai\dsh\lib\bin.js" web
```

**生产服务正从 npx 缓存里运行。** 于是：

1. `npx` 开始 reify（改名 + 重装）
2. 正在运行的服务器持有这些文件 → 改名失败或被打断
3. 锁文件随之变化 → `touchLock` 判定"锁被破坏"
4. `ECOMPROMISED`

### 2.4 现场痕迹：190+ 个残留临时目录

`@deepseek-ai\` 下遗留大量 `.dsh-<name>-<随机>` 目录（`.dsh-tool-ask-user-N5PFwlxE` 等），
**正是上一次 reify 被中断的残骸**。这就是"锁被破坏"的物理证据。

### 2.5 这不是偶发

本会话**最早期**就撞过一次同样的错：
`npx --yes @deepseek-ai/dsh web --help` → `ECOMPROMISED: Lock compromised`。
当时未深究，现在有了完整解释。

---

## 3. 规避方法（已验证）

### 3.1 核心原则：**长期运行的服务不要放在 npx 缓存里**

| 方式 | 是否会触发该问题 | 说明 |
|---|---|---|
| `npx @deepseek-ai/dsh web` | 🔴 **会** | 服务运行在 npx 缓存；后续任何 npx 调用都会 reify 它 |
| `node <稳定路径>/@deepseek-ai/dsh/lib/bin.js web` | ✅ **不会** | **全程不经过 npm**，无锁可破坏 |
| 全局安装 + `dsh web`（PATH 里有 shim） | ✅ 不会 | 需真正 `npm i -g`（本机当前**没有**） |

**本机可用的稳定路径（实测 0.2.0-rc.2）：**

```
C:\Users\WANGZ\node_modules\@deepseek-ai\dsh\lib\bin.js
```

### 3.2 推荐启动命令

```powershell
node "$env:USERPROFILE\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3080 --no-open
```

### 3.3 临时缓解（若已中招）

- 用**独立 `DSH_HOME` + 独立端口**跑开发实例，避开被占用的目录
- 残留的 `.dsh-*` 临时目录**不要删** —— 生产服务可能仍从其中某些路径加载

---

## 4. 已知残留与后续

| # | 项 | 状态 |
|---|---|---|
| N1 | `@deepseek-ai\` 下 190+ 个 `.dsh-*-<随机>` 残留目录 | ⬜ **未清理**（故意：可能有服务在用），可在停掉所有 dsh 后清理 |
| N2 | 生产服务仍从 npx 缓存运行（PID 139884） | ⬜ 建议改用稳定路径重启 |
| N3 | 本机**没有**真正的全局 dsh 安装（`%APPDATA%\npm` 下无 shim） | ⬜ 若想用 `dsh` 命令，需 `npm i -g @deepseek-ai/dsh` |
| N4 | npx 缓存的 `package.json` 与 `package-lock.json` 仍在（会被 reify 重写） | ⬜ 保持冻结即可 |

---

## 5. 对项目的启示

**启动器（Phase 5）绝不能依赖 `npx`。** 理由：

1. 它要把 `dsh web` 作为**长期子进程**拉起 → 正好踩这个坑
2. `npx` 会在启动时联网解析/重装 → 启动慢且可能失败
3. 正确做法：**定位一份稳定安装**（本地/全局/随包分发），用 `node <bin.js>` 直接启动

这已写入 [LAUNCHER.md](../docs/LAUNCHER.md) 的 L 系列待验证项。
