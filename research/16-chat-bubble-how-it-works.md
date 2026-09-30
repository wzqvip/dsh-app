# dsh-pet 的对话气泡是怎么做的

> 日期：2026-09-29 · 来源：读 `vendor/dsh-pet` 源码（上游 `0.2.12`）
> 目的：搞清"右键菜单 → 对话 → 宠物说话气泡"这条链路，为后续设置 GUI 与自有功能做参考。

---

## 1. 一句话总览

**对话 = 「极简输入弹窗」+「复用碎碎念的展示链路」+「宿主侧走 DSH 的 LLM 抽象层」+「单写者记忆文件」。**

它把"用户输入"这件事做得极薄（只有一个输入框），而**展示、动画、气泡全部复用已有的碎碎念链路** —— 这是整个设计里最省力也最值得学的一处。

```text
右键「对话」
  → mountChatDialog()          极简输入框（shared/chat.ts，两端共用）
  → POST /dsh-pet-7340/chat    宿主生成回复并写记忆
  → onReply(reply, image)
  → triggerWhisper(reply, image)   ← 关键：直接复用碎碎念
  → 说话动画 + 白色气泡 10s 后消失
```

---

## 2. 文件分工

| 文件 | 大小 | 职责 |
|---|---|---|
| `src/shared/chat.ts` | 10.1 KB / 222 行 | **弹窗组件**（`CHAT_CSS` + `mountChatDialog`）+ `sendChat()` 客户端 |
| `src/host/chat.ts` | 7 KB / 145 行 | **调 LLM 生成回复**（走 `ctx.llm`），含可选配图的指令与解析 |
| `src/host/index.ts`（片段） | — | `/chat` 路由 + **记忆单写者**（`memory.json` 读写 + 锁） |
| `src/client/bubble.ts` | 7.7 KB / 139 行 | **气泡渲染**（余额气泡 + 碎碎念气泡两个 React 组件） |
| `src/client/pet.ts`（片段） | — | 菜单处理（L1345）+ `triggerWhisper`（L647） |

---

## 3. 逐段拆解

### 3.1 输入弹窗（`shared/chat.ts`）

**形态极简**：没有标题、没有发送按钮 —— 只有一个 `<textarea>`，回车发送，Esc 或点外部关闭。

| 机制 | 做法 |
|---|---|
| **宽度自适应** | 用 `canvas.measureText()` 量文本宽度，在 `CHAT_MIN_W`(160) ~ `CHAT_MAX_W`(340) 之间取值 |
| **高度自适应** | 到宽度上限后 `input.style.height = max(scrollHeight, 22)` 随折行增高 |
| **定位** | 以宠物**身体命中区**（`.dsh-pet-hit`）右上角为基准，而不是视频框（桌宠在视频中间，两者不等价） |
| **夹回** | 超出 `clamp` 矩形（桌面端传「窗口 ∩ 工作区」）时夹回，**窗口/宠物零移动** |
| **错误** | 生成失败留在弹窗内显式显示，**绝不伪造回复** |
| **样式共用** | `CHAT_CSS` 与 `menu.ts` 的 `MENU_CSS` 一样，是**两端共用同一份 DOM 样式**的例外 |

```ts
// 宽度随文本增长
const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
root.style.width = w + 'px';
input.style.height = Math.max(input.scrollHeight, 22) + 'px';
```

### 3.2 宿主生成回复（`host/chat.ts`）

走 **DSH 的 LLM 统一抽象层** `ctx.llm`，与碎碎念 `generateWhisper` 同构：

| 项 | 取值 | 原因 |
|---|---|---|
| provider / model | `ctx.agentDefaultModel.currentSelection()` | 与余额/碎碎念同源，不另配 |
| `system` | 用户配置的 `whisperPrompt` | **碎碎念与对话共用同一人设** |
| messages | 历史（`memory.json` 截尾 N 轮）+ 本次 user 消息 | 历史 user 用 `createUserMessage({source:{kind:'plugin'}})`，assistant 用 `createAssistantMessage` |
| `reasoningEffort` | `'off'`，**且仅当模型声明支持时传** | 闲聊不需要推理；不支持却传 `off` 会被判 `UNSUPPORTED_REASONING_EFFORT` 并**折叠成空流**（表现为"模型没返回文本"） |
| `maxTokens` | **不显式传** | 推理模型把思考计入预算，显式小上限会截断正文；交给适配器默认值 |
| `temperature` | `1` | — |
| 超时 | 60s（碎碎念是 30s） | 对话要等生成 |
| 收集 | `BlockAssembler` 流式拼装，只取 `type==='text'` 的块 | — |

**可选配图（很巧的一处）**：与碎碎念"随机抽"不同，对话**有真实上下文**，所以把**整张表情包清单**交给模型让它**按语境选**：

```text
回复结尾可选附一张表情包…从下列清单里挑最贴合当前语境的：
<清单>
挑中就在回复最后另起一行写 [图:名称]
```

host 解析 `[图:名称]` 后**只在池内命中时采纳** —— 防模型幻觉出池外名称。未选/选错就不配图（配图是点缀，不强制）。

### 3.3 记忆（`host/index.ts`）

```jsonc
// memory.json —— 双层结构
{
  "<种类桶 assetRoot ?? petId>": {
    "<实例 id>": { "messages": [ { role, content, ts } ] }
  }
}
```

| 机制 | 做法 |
|---|---|
| **全存不删** | `memory.json` 只追加；**每次请求只截尾部 `chatMemoryRounds` 轮**（1 轮 = 1 问 1 答 → `slice(-rounds*2)`） |
| **单写者** | host 是唯一读写方；浏览器与桌面**天然共享同一份记忆**（它们只是不同的显示端） |
| **串行化** | `withMemoryLock(fn)` 包住写操作 |
| **损坏处理** | 解析失败 → 备份为 `memory.json.bak-<ts>` 并**从头开始**，不静默丢数据 |
| **轮数来源** | 条目级 / 主条目的 `chatMemoryRounds`（默认 5，非法即配置错误） |

### 3.4 回复 → 气泡（`client/bubble.ts` + `pet.ts`）

**关键设计：对话不自己造展示，直接复用碎碎念**（`pet.ts:1360`）：

```ts
onReply: (reply, image) => {
  triggerWhisper(reply, image);   // 复用碎碎念链路：随机说话动画 + 气泡 10s（含配图）
}
```

`triggerWhisper`（L647）做四件事：

1. 从 `animations.events.whisper` 池**随机抽一个"说话"动画**（避开当前正播的）
2. `setWhisperText(text)` / `setWhisperImage(image)`
3. `setWhisperBubbleOn(true)`，并用 `setTimeout` 在 **10s** 后关闭（与动画解耦）
4. `setOnce(true)` + `setAnim(name)` 播一遍

**气泡的三种形态**（都基于同一样式类 `dsh-pet-bubble`）：

| 气泡 | 组件 | 变体类 | 宽度行为 |
|---|---|---|---|
| 余额 | `makeBalanceBubble` | 失败时加 `dsh-pet-whisper` | 默认 `nowrap`（长文案会顶出宠物宽） |
| **碎碎念 / 对话** | `makeWhisperBubble` | `dsh-pet-whisper` | `white-space:normal`，短句窄框、长句封顶绕行；可带配图 |
| 工作状态 | （在 `pet.ts` 内） | 同一套 | — |

**CSS 要点**：

```css
.dsh-pet-bubble {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(100% - var(--dsh-pet-size) * 0.108);   /* 悬在宠物上方 */
  min-width: calc(var(--dsh-pet-size) * 0.26);
  max-width: calc(var(--dsh-pet-size) * 0.5);
  background: rgba(255,255,255,.92);
  opacity: 0; transition: opacity .25s ease;           /* is-on 时才显示 */
  pointer-events: none;                                 /* 不挡点击 */
  backdrop-filter: blur(6px);
}
.dsh-pet-bubble::after { /* 底部小三角，指向下方宠物 */ }
.dsh-pet-bubble.is-on { opacity: 1 }
```

> **所有尺寸都基于 `--dsh-pet-size`（宠物宽度 px）等比缩放** —— 宠物放大缩小，气泡、字号、内边距、尾巴、阴影全部跟随。系数按默认 462px 设计。
> 字体是随包提供的 `上首软糖体.ttf`，经 `/dsh-pet-7340/font/` 路由提供，`font-display:swap` 先回退后切换。

---

## 4. 值得学的设计

1. **复用现有链路到极致**：对话只新增"输入"这一步，展示/动画/气泡/配图**全部复用碎碎念**。代码量因此很小。
2. **单写者 + 单文件**：记忆只有 host 写，两端共享 —— 不需要任何同步机制。
3. **契约两端各自声明**：`shared/chat.ts` 与 `host/chat.ts` 各自声明同形状的类型，**不跨端 import**（这是 DSH 单文件加载约束的产物，见 [research/11](11-answerer-is-client-side.md)）。
4. **不伪造回复**：任何失败都显式返回结构化原因（`provider-missing` / `generate-error` / `bad-request`），UI 上明确提示。
5. **防幻觉的两个具体手法**：配图名称**只在池内命中才采纳**；模型不支持 reasoning 时**省略**该字段而不是硬传。
6. **两端共用一份 DOM 样式**（`MENU_CSS` / `CHAT_CSS` / `MEME_BUBBLE_CSS`）—— 浏览器浮层与桌面透明窗渲染完全一致。

---

## 5. 对本项目的可用之处

| 用途 | 怎么做 |
|---|---|
| **设置 GUI 复用气泡样式** | 直接复用 `bubbleCss`（`--dsh-pet-size` 等比缩放那套），保证视觉一致 |
| **消息提示** | 若将来要做"agent 提问"的气泡，可直接走 `triggerWhisper` 同款链路 |
| **LLM 调用范式** | `ctx.llm.stream()` + `BlockAssembler` + `supportsReasoningOff` 这套已经是本项目可复用的范式（与碎碎念、余额同源） |
| **记忆的位置** | 在 `~/.dsh/dsh-pet/memory.json`；设置 GUI 若要做"清空记忆"只需删这个文件 |

⚠️ 注意：这些代码都在 `vendor/dsh-pet/` 下（上游 MIT），我们改它要走
[`scripts/patch-vendor.mjs`](../packages/dsh-efficiency/scripts/patch-vendor.mjs) 的幂等补丁流程。
