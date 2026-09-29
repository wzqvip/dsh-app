# answerer 在客户端，不在宿主侧 —— R0 的架构性发现

> 日期：2026-09-29 · 环境：`dsh` 0.2.0-rc.2
> 触发：`dsh-efficiency` 在宿主侧 `ctx.on('user-questions/request')` 注册监听，
> 但两次真实提问后 `seenRequests` 仍为 0。

---

## 1. 现象（实测）

生产实例（PID 39424）加载 `dsh-efficiency` 后：

```
[dsh-efficiency] apply() 开始
[dsh-efficiency] host half ready
```

但随后我调用 `ask_user_question` 两次（会话日志 `tool/call` 事件
seq=4434、seq=4482，本地时间 17:15、17:17），health 端点仍是：

```json
{"seenRequests":0,"pending":0,"answered":0}
```

→ **宿主侧监听器从未被触发**。

---

## 2. 根因：事件是**作用域化**的，且 answerer 在**客户端**

### 2.1 派发点用了 scopeTarget

`dsh-user-questions/lib/index.js:681`：

```js
return await (agent === void 0
  ? this.ctx.waterfall("user-questions/request", request, noAnswerer)
  : this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request",
      { ...request, agent }, noAnswerer));
```

只要调用方带了 agent（正常路径都会带），就是**带作用域的 waterfall**。

### 2.2 全部注册方都是客户端

在 `@deepseek-ai/*` 里搜 `user-questions/request`，**host 侧没有任何注册**，
唯一实现方在浏览器端：

```js
// dsh-client-ui-user-questions/lib/client.js:1927
ctx.remote.$on("user-questions/request", function (request, next) {
  return answerQuestion(ctx, this, request, next, cards);
});
```

类型定义也印证：

> `UserQuestionService` —— "validation plus the **scoped answerer waterfall**"，
> 且 "**UI packages compose answerers on the Agent-scoped Cordis waterfall**"。

而 `dsh-api-remotes` 把这条事件登记为 `{ event: "user-questions/request", mode: "waterfall" }`，
**通过 Remote 层转发到浏览器**，由客户端 answerer 作答。

### 2.3 结论

```text
❌ 错误假设：宿主插件可以用 ctx.on() 旁听提问
✅ 实际情况：answerer 在客户端；官方 UI 用 ctx.remote.$on(...) 注册，
             并且它的 handler 【返回答案】—— 它就是 answerer
```

---

## 3. 官方 answerer 的完整模式（供正确实现参考）

`answerQuestion`（client.js:1757）展示了分阶段作答的完整机制：

| 步骤 | 做法 |
|---|---|
| 取 session | `ctx.sessions.scopeOf(owner)` —— `owner` 是 handler 里的 `this` |
| 建卡片 | `cards.ensure(sessionId, request.questions, callId)` |
| **前台认领** | `ctx.remote.userQuestions.attachWait(sessionId, callId, signal)` → **异步迭代器** |
| 超时判定 | `await iterator.next()`；`opening.done === true` → **说明已被别人认领** → `return await next()` |
| 剩余时间 | `Date.now() + opening.value.remainingMs` |
| 挂载 | `card.pending.attachWaterfall(waterfall.channel)` |
| 让位 | `waterfall.channel.delegate()` → 抛 `isDelegation` → `return await next()` |
| 结束 | 迭代器第二次 `next()` 会抛 "the foreground question wait ended" |

**关键设计**：多个 answerer 可以**共存**，靠 `attachWait` 的"前台认领" + `delegate` 协作，
不是简单抢占。这为第三方扩展留了口子。

---

## 4. 对 `dsh-efficiency` 的影响

### 4.1 现状盘点

| 部分 | 状态 | 依赖宿主捕获？ |
|---|---|---|
| 宠物感知定位（`placement.js`） | ✅ 已测试通过（7 组断言） | 否 |
| 面板 UI（多问题/多选/自由文本） | ✅ 已构建、槽位注册验证通过 | 否 |
| 宿主 `/api/answer` | ✅ 端点分支全对 | 是 |
| **宿主捕获提问** | ❌ **架构上不成立** | — |

所以：**面板能画出来，但拿不到数据；`/api/answer` 没有 callId 可用。**

### 4.2 两条可行路线

**路线 A —— 客户端 answerer（与官方共存）**

把注册从宿主侧 `ctx.on` 换成客户端 `ctx.remote.$on('user-questions/request', ...)`，
照抄 `answerQuestion` 的结构：

- 用 `attachWait` 尝试认领前台
- 若 `done === true`（官方已认领）→ `return next()` **让位**
- 若认领成功 → 展示在宠物旁的面板里，等用户作答 → 返回答案

⚠️ **风险**：若我的认领先于官方，**官方对话卡片可能不再出现**（`attachWait` 是单认领）。
必须先做**降级验证**：确认让位路径能恢复官方行为，否则会破坏现有可用功能。

**路线 B —— 面板降级为"镜像 + 引导"**

不抢答，只把"有人问你"这件事做得更醒目（点击 → 滚到官方提问处）。
价值有限，但**零风险**。

---

## 5. 遗留问题（本轮未解决）

| # | 问题 | 状态 |
|---|---|---|
| Q1 | 宿主侧 `ctx.on` 到底为何完全不触发 —— 是 scope 过滤，还是 Remote 层根本不经过 host waterfall？ | ⬜ 未定论。两种解释都与现象一致，需读 `dsh-api-remotes` 的转发表实现 |
| Q2 | 桌面宠物小窗**比网页版小**（用户实测）。窗口实测 924×744 物理像素，正好等于 `petWindowSize(462)`（**未乘 scale**），但内容被 `setZoomFactor(petScale()=2.25)` 放大 → 内容大于窗口 | ⬜ 疑似 dsh-pet 缺陷，待进一步确认 |
| Q3 | 系统通知未弹出（用户实测"没反应"）。`notify.ts` 有 `pageVisible && pageFocused` 门控，逻辑上失焦才弹 | ⬜ 待查通知权限/门控实际行为 |
| Q4 | `primary-scale.json` 在 Electron 启动**之后**（17:16:25 vs 17:09:51）被改写，写入方不明 | ⬜ 未查 |

---

## 6. 环境事实（本轮实测，备查）

```text
系统真实缩放 = 2.25 (225%)
  探针不 force : scaleFactor 2.25, 逻辑尺寸 996x898
  探针 force=1 : scaleFactor 1,    物理尺寸 2240x2020
  → 2240 / 2.25 ≈ 996  ✅ 自洽，缓存里的 2.25 是【正确】的

Electron 宠物窗口实测: 924 x 744 物理像素, 窗口 DPI 216 (2.25x), 位置 L=354 T=-3
petWindowSize(462)      = 924 x 744   ← 与实测吻合
petWindowSize(462*2.25) = 2080 x 1674 ← 公式本应给出的值
```
