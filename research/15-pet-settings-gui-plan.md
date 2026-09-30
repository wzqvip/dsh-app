# 桌面宠物设置 GUI —— 实施方案

> 目标：在**桌面宠物的右键菜单**里新增「设置…」，点开一个**我们自己的 GUI 设置窗**，
> 把目前只能手改 JSON 的字段都变成可视化开关。
>
> 决定：对 `dsh-pet` 走**轻量补丁**（A 案），形态定稿后再考虑正式 fork（B 案）。

---

## 1. 许可前提（已核实）

`dsh-pet` 是 **MIT**：`Copyright (c) 2026 PC2005-cloud`，
允许 use / copy / **modify** / merge / publish / distribute，**只需保留版权与许可声明**。

⚠️ 但**素材（立绘 / 动画 webm / memes）不是 MIT 覆盖的范围**，
上游明确**禁止商用**且二创须署名。所以：
- 改**代码** ✅ 允许
- **复制素材**进本仓库 ❌ 仍禁止（[AGENTS.md](../AGENTS.md) §4）

---

## 2. 精确接入点（已核实，非推测）

桌面端右键菜单在 **`runtime/electron-helper/sprite.js`**：

### 2.1 菜单根项组装（L1027）

```js
// 桌面专属工具根项（打开网站 / 查看余额 / 碎碎念 / 对话 / 回到初始位置）
const tools = [{ label: '打开网站', action: 'open-site' }];
if (this.pet.balanceEnabled) tools.push({ label: '查看余额', action: 'show-balance' });
tools.push(
  { label: '碎碎念', action: 'whisper' },
  { label: '对话', action: 'chat' },
  { label: '回到初始位置', action: 'home' },
);
const tree = tools.concat(S.buildMenuTree(this.animations));
```

→ **加一项**：`tools.push({ label: '设置…', action: 'settings' })`

### 2.2 action 处理（L1060，if 链）

```js
onMenuAction(leaf) {
  this.closeMenu();
  if (leaf.action === 'open-site') {
    if (window.petBridge) window.petBridge.openDshSite(ORIGIN);  // ← 先例：走 preload 桥
    return;
  }
  ...
}
```

→ **加一支**：`if (leaf.action === 'settings') { window.petBridge?.openSettings?.(); return; }`

### 2.3 桥（preload.js）

已有先例 `openDshSite`（`preload.js:33` 注释说"主进程用系统默认浏览器打开"）。
→ 照抄一份 `openSettings`，由 `main.js` 建一个设置窗。

### 2.4 主进程（main.js）

需要一个新 `BrowserWindow` 加载我们的设置页；已有 `main.js:735` 处理 `open-site` 的先例。

> ⚠️ 注意：`main.js` 里的 desktop helper 是**宠物窗自己的进程**，
> 而 `PUT /config` 会触发宿主 `syncDesktop()` → **重启 helper** →
> 设置窗如果建在 helper 里，保存后会被一起重启掉。
> **所以设置窗必须建在别处**（见 §3.2）。

---

## 3. 设置窗放哪（关键设计取舍）

### 3.1 问题

| 方案 | 后果 |
|---|---|
| 建在 desktop helper 里 | **保存配置 → 宿主重启 helper → 设置窗被关掉**。体验很差。 |
| 用系统浏览器打开网页 | 那不是"GUI 设置窗"，而且要开浏览器（与项目初衷相悖） |

### 3.2 结论：**由 DSH 宿主进程建设置窗**

新增一个小的宿主侧能力（**独立 Electron 进程**，不是 helper 的）：

```
DSH 宿主 (node)
  ├── dsh-pet helper (宠物窗)      ← PUT /config 会让它重启
  └── efficiency 设置窗 (Electron) ← 不受影响，可长期开着
```

「设置…」的路径：
```
桌面宠物右键 → sprite.js action:'settings'
  → preload 桥 → helper main.js
  → 经宿主 HTTP 通知宿主「请打开设置窗」
  → 宿主 spawn 独立的 Electron 设置窗
```

**为什么不直接在 helper 里 spawn**：helper 会被 `syncDesktop()` 重启，
它 spawn 的子进程会跟着死。由宿主 spawn 才稳定。

---

## 4. GUI 内容（参考我们讨论过的全部字段）

分四组，全部走 `GET/PUT /dsh-pet-7340/config`（见 [research/13](13-dsh-pet-settings-api.md)）：

### 组 1 · 显示（白名单内，保存即时生效 + 自动重启桌面窗）

| 项 | 字段 | 控件 |
|---|---|---|
| 显示位置 | `pets[].display` | 下拉：web / desktop / both / none |
| 尺寸 | `pets[].size` | 数字 + 滑杆 |
| 角落 | `pets[].position.corner` | 四向选择 |
| 边距 | `pets[].position.marginX / marginY` | 两个数字 |
| 名字 | `pets[].name` | 文本 |

### 组 2 · 开关（白名单内）

| 项 | 字段 | 说明 |
|---|---|---|
| 余额显示 | `pets[].balanceEnabled` | 默认开 |
| 碎碎念 | `pets[].whisperEnabled` | 默认关 |
| **工作状态联动** | `pets[].workStatusEnabled` | 默认关，**零 token** |
| **系统通知** | `notificationsEnabled` | 全局 |
| 碎碎念配图 | `whisperImageEnabled` | 全局 |
| 对话配图 | `chatImageEnabled` | 全局 |

### 组 3 · 频率（**不在白名单** → 需要独立读写通道）

| 项 | 字段 | 现状 |
|---|---|---|
| 余额刷新周期 | `eventsRefreshSec.balance` | 只能手改 JSON |
| 碎碎念周期 | `eventsRefreshSec.whisper` | 同上 |
| 动画权重 idle/turn/move | `animationWeights.*` | 同上 |
| 各类动作权重 | `animations.categories[].weight` | 同上 |

⚠️ 这一组**不在 PUT 白名单**里。宿主 `saveUserConfig` 只重建白名单字段，
其余靠"读磁盘原对象透传保留"。
→ **要么**扩 dsh-pet 的白名单（改代码），**要么**我们直接写 `main-config.json`
并触发一次 `syncDesktop()`（无官方接口，得自己来）。
**待定，见 §6。**

### 组 4 · 文案（**不在白名单**）

| 项 | 字段 |
|---|---|
| 工作状态 6 档气泡文案 | `workStatusTexts[0..5]` |
| 碎碎念人设提示词 | `whisperPrompt` |
| 对话记忆轮数 | `chatMemoryRounds` |
| 表情包描述 | `memes.*` |

同 §3 组的限制。

---

## 5. 实施顺序（先小后大）

1. **菜单项 + 空窗**：右键多出「设置…」，点开一个能开能关的独立设置窗（哪怕内容还很少）
   → 先验证**整条链路**通不通（这是最容易卡住的地方）
2. **组 1 + 组 2**：白名单内的字段，走官方 PUT，立即能用
3. **组 3 + 组 4**：需要另开写入通道，单独设计
4. **形态定稿后**再决定是否转正式 fork

---

## 6. 待定 / 风险

| # | 事项 | 状态 |
|---|---|---|
| Q1 | 组 3/4 字段不在 PUT 白名单 → 需要独立写盘通道 | ⬜ 待设计 |
| Q2 | 设置窗由宿主 spawn，宿主侧需要一个"打开设置窗"的入口 | ⬜ 待实现 |
| Q3 | 补丁会被 `dsh-pet` 升级覆盖 → 需要一个可重复应用的补丁脚本 + 版本校验 | ⬜ 待实现 |
| Q4 | 桌面窗尺寸 bug（内容被 zoom 放大但窗口没跟着）尚未解决，放大尺寸的观感会受影响 | ⬜ 已知 |
| Q5 | ⚠️ **生产 3080 需重启**：当前进程内存里还挂着已删除的 `dsh-efficiency`，刷新会 404 | 🔴 **待用户执行** |
