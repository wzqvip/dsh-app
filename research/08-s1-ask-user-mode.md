# S1 验证：`ask_user_question` 的模式（A1）

> 日期：2026-09-29 · 对应任务 [todo.md](../todo.md) 的 A1 / P2-5
> 结论：**实际生效的是 `timed` 模式**（非 schema 默认的 `legacy`）

---

## 1. 为什么这是第一步

`dsh-tool-ask-user` 的 Config 默认值是：

```js
mode: z.union(["legacy","timed"]).default("legacy")
```

- **`legacy`** = 阻塞式 `ask()`。**用户不在场时 agent 干等，提问也不进入可回答投影**
  → 本项目的核心价值（离开也能补答）**直接不成立**
- **`timed`** = `askTimed()`。超时返回 `{pending:true}`，**agent 继续独立工作，提问仍可回答**
  → 正是我们要的行为

所以这是唯一一个"不成立就要改方向"的验证点。

---

## 2. 验证结果

### 2.1 决定性证据：工具 schema 里有 `timeout` 参数

`timeout` 这个参数（代码里叫 `TIMED_WAIT_PARAMETER`）**只存在于 timed 分支**：

```js
// lib/index.js:118-121（在 registerTimedAskUser 内部）
[TIMED_WAIT_PARAMETER]: {
  type: "integer",
  description: `Wait seconds for the entire batch (default ${defaultTimeout}); omit unless the user specifies a duration. ...`
}
```

而 `registerTimedAskUser` 只在 `config.mode === "timed"` 时被调用：

```js
// lib/index.js:219-221
if (config.mode === "timed") {
  registerTimedAskUser(ctx, config.timeout);
  return;
}
```

**本会话的 `ask_user_question` 确实带 `timeout` 参数**（描述含
"Wait seconds for the entire batch (default 120)…"）
→ **只有 timed 分支才可能提供它**。

另一个标志：timed 分支会返回 `{ pending, callId, message }`，legacy 分支不会。

### 2.2 行为观察

用带短超时的问题实测，提问在几秒内就被正常回答，**未观察到 `pending` 路径**
（因为作答早于超时）。这**不构成反证** —— 它只说明前台等待期正常。

### 2.3 ⚠️ 一处未能解释的矛盾

`dsh --profile web --dump-config` 里 `tool-ask-user` 条目**只有 `id` 和 `name`，没有 `config` 块**：

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
```

按此应回落到 schema 默认 `legacy`，**与实际生效的 timed 矛盾**。

已排除的可能：
- profile 层 `cordis.patch.yml` —— 未提及 `tool-ask-user`
- home 层 `~/.dsh/cordis.patch.yml` —— **不存在**
- 第二个注册方 —— 仅 `dsh-tool-ask-user` 一个包注册该工具

**结论**：`dump-config` 的组装结果与运行时实际组装**不一致**。
这本身是一个值得记录的上游现象，但对本项目**无阻塞** ——
行为证据（`timeout` 参数存在）已足够支撑实现。

> ⚠️ 留给启动器/文档的注意：**不要用 `dump-config` 判断某个插件是否启用或如何配置**，
> 它可能与运行时不一致。以运行时行为为准。

---

## 3. 结论与后续

| 项 | 结论 |
|---|---|
| **A1** | ✅ **`timed` 模式生效**，核心功能前提成立 |
| 方向 | ✅ 按现方向推进，**不需要**改 `mode` |
| 待补 | 等 R0 实现后，用真实场景验证 **`pending` → 稍后补答** 这条路径（A2） |

**A2 仍未验证**：超时后的 `continued` 提问，`answer()` 是否真能 steer 回 agent。
这需要 R0 实现到一半才能测（要能提交回答）。计划在 [EXECUTION.md](../docs/EXECUTION.md) 的 S4 一并验证。

---

## 4. 根据维护者选择调整的顺序

维护者选择：**优先装 `dsh-pet`（S3），先把承载层跑通**。

调整后的顺序：**S2 备份 → S3 装 `dsh-pet` → S4 R0 → S5 R0b → S6 设置页**。
（原计划 S3 在 S2 之后，与选择一致，无需改计划，只是确认优先级。）
