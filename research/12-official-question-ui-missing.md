# 官方问答 UI 未渲染答案卡 —— 待定位

> 日期：2026-09-29 · 环境：`dsh` 0.2.0-rc.2，生产实例 (3080)
> 状态：**现象已确证，根因待定位**

---

## 1. 现象（用户实测，两次确认）

`ask_user_question` 之后：

- ✅ 桌宠弹出气泡「需要你确认一下呢」
- ❌ **没有答案选项卡**（用户明确确认：输入框上方也没有）

用户原话：
> 官方的问答只有气泡"需要你确认一下呢"，但是没有没有答案选项卡

---

## 2. 已确证的部分（链路前半段是好的）

### 2.1 提问真的发生了

`scripts/session-probe.mjs` 统计会话日志：本会话 `ask_user_question` 被调用多次，
每次都有 `tool/call` 事件（seq 可查）。

### 2.2 宿主侧数据完整

生产实例 `GET /dsh-pet-7340/notify` 的队列里含 **5 条 `question/requested` 帧**，
每条都带**完整的 questions 数组** —— 含 `header` / `question` / `options` /
每个 option 的 `label` 与 `description` / `multiSelect`。

例：
```json
{"type":"question/requested","questions":[{
  "header":"官方卡片位置测试",
  "multiSelect":false,
  "options":[{"description":"…","label":"输入框上方出现了选项按钮"}, …],
  "question":"【关键测试】请只看【输入框正上方】：…"
}]}
```

→ **agent → 宿主 的提问链路、以及问题数据的完整性都没问题。**

### 2.3 官方 UI 插件确实加载了

`dsh-web-app` 的 `cordis.patch.yml` 里有：
```yaml
- id: ui-user-questions
  name: '@deepseek-ai/dsh-client-ui-user-questions'
```
且生产 `index.html` 的模块图里含 `client-ui-user-questions`。

---

## 3. 官方答案卡**应该**出现在哪（已查清）

`dsh-client-ui-user-questions/lib/client.js`：

```js
// L1910 —— 主答案卡：注册在【输入框上方】，不是弹窗
ctx.slots.inject("conversation.composer", () => ctx.slots.register({
  name: "conversation.composer",
  select: ({ pendingInteraction }) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
  locale: NS,
  store: questionDraftStore,
  inject: () => ({ keyedHooks: { questionCard: (key) => cards.source(key) } }),
  children: { "conversation.plan-review.actions": { kind: "list", scope: "session" } }
}, QuestionComposer));

// L1922 —— 已答复/历史回执：注册在对话流里
ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
  name: "conversation.chat.node", key: "question-reply", locale: NS
}, QuestionReplyView));
```

**关键：显示与否由 `select` 谓词决定** ——
`pendingInteraction instanceof PendingQuestion`。
`pendingInteraction` 为 null/undefined 或不是 `PendingQuestion` 实例 → 卡片不渲染。

---

## 4. `pendingInteraction` 的数据流（已追到一半）

```text
宿主侧 pending 投影
   ↓
dsh-client-ui-session/lib/client.js:310
   const projected = new Map([...next].map(([sessionId, value]) => [sessionId, value.interaction]));
   this.pendingSnapshot = projected;      // ← observePending(…)
   ↓
L352  pendingInteraction: this.pendingSnapshot.get(id)
```

`PendingQuestion` 类定义在 `dsh-client-ui-user-questions/lib/client.js:135`。

**未查完**：`observePending` 的上游 —— 宿主侧用哪个 Remote 投影推送
"该会话有一个待答问题"，以及它为何没有把 user-question 类型算进去。

---

## 5. 排除项

| 假设 | 结论 |
|---|---|
| 提问没发生 | ❌ 排除，会话日志有 `tool/call` |
| 宿主数据不全 | ❌ 排除，notify 帧里 questions 完整 |
| 官方 UI 没加载 | ❌ 排除，bundle 与模块图都在 |
| 卡片在别处（弹窗） | ❌ 排除，官方注册点是 `conversation.composer`（输入框上方），用户确认那里也没有 |
| 我的插件挡住了 | ❌ 排除，`seenRequests=0`，宿主侧 handler 从未被调用 |
| （对照）桌宠能看到 | ✅ 是的，`dsh-pet` 的 `tool/call` 监听正常，气泡与通知帧都产生了 |

---

## 6. 下一步

1. 读 `observePending` 上游，确认宿主侧 pending 交互投影对
   `user-questions` 类型的处理（`dsh-client-ui-session` 的 provider 注册处）
2. 对照 `dsh-client-ui-approval` —— 审批卡片能显示吗？
   若审批正常而提问不正常，则差异就在这两个类型之间，范围可大幅缩小
3. 若确认为 DSH 缺陷 → 整理最小复现，作为上游 issue 提交

---

## 7. 对项目的意义（重要）

若官方问答**确实无法作答**，则本项目的价值判断完全改变：

- 原判断：`dsh-pet` 已覆盖提问提醒 → 自研插件是**重叠**
- 新判断：提醒有了，但**能作答的那个 UI 不存在** →
  自研的"可作答面板"从**重叠**变成**唯一可用**的东西

因此 `packages/dsh-efficiency` 的
「客户端 answerer + 自带选项面板」路线**值得继续**，
且不再需要与官方 UI 争抢（官方那份本来就没渲染出来）。

⚠️ 但仍有前置验证：认领机制（`attachWait` / `delegate`）的行为
仍需在隔离环境确认，不能想当然。
