# 05 — 显示模式、输出风格与分步播放的可行性调查

调查对象：`dsh` (DeepSeek Harness) **0.1.7-rc.2**，npx 安装在
`C:\Users\WANGZ\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`。
下面所有路径均相对该目录。**本调查为只读**，未修改任何文件（除本报告）。

用户的原始诉求拆成 4 个子需求：① 完整过程 vs. 只显示"思考中"；② 把输出写到文件；
③ 输出长度/啰嗦度可配置；④ 交付风格可在"简短"与"galgame 风格"（点一下走一行、长按快进）之间切换。

---

## 0. 结论速览（TL;DR）

| 子需求 | 现状判定 | 关键既有扩展点 |
|---|---|---|
| ① 完整过程 / 只显示思考中 | **大部分已存在**（4 档 `transcriptView` + 可折叠的 `ReasoningRow`）；缺"只显示思考中、隐藏正文"这一档 | `ui-chat` 的 `TranscriptViewPolicy` / `ChatPresentationPolicy`；`dsh-client-ui-trajectory` 的折叠 props |
| ② 输出写到文件 | **已存在但形态不同**：有 `/export`（ZIP 下载）+ `serializeSessionLog()` + `writeFileAtomic()`；**缺**"写到宿主机任意路径"的端点 | `dsh-session-log-export`；`dsh-tool-fs` 的 `write` 工具；`dsh-atomic-write` |
| ③ 输出长度/啰嗦度 | **部分存在**：有 `maxTokens`、系统提示分段（persona/section）、agent preset；**没有**任何影响"助手散文长度"的旋钮 | `ctx.systemPrompt.section({...})`；`dsh-persona`；`dsh-agent-preset-registry` |
| ④ galgame 分步播放 | **不存在**：只有"按 turn 导航"和可展开折叠；**没有**暂停/单步/打字机/重放 | 客户端**确实**收到 token 级 delta（`AssistantLiveChunkEvent`）+ 会话日志里存有带时间戳的完整 chunk（`AssistantStreamRecord`） |

---

## 1. 事件流：客户端能观察到的全部类型（完整清单）

### 1.1 定义源头：`SessionEventMap`（持久化、append-only 真源）

定义文件：`dsh-session/lib/types/types.d.ts:255`（`export interface SessionEventMap`），
可合并扩展（merge-extensible）。**本仓库声明的全部成员清单**（生成物，权威）见
`dsh-session/lib/types/known-event-types.js:21` 的 `KNOWN_SESSION_EVENT_TYPES`。

```js
// dsh-session/lib/types/known-event-types.js:21
export const KNOWN_SESSION_EVENT_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
  'approval/policy', 'assistant/attempt', 'assistant/message', 'command/done', 'command/run',
  'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
  'deliverables/presented', 'developer/message', 'feedback/message-delete',
  'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
  'image/offload', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset',
  'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
  'session/title-llm-request', 'step/end', 'step/start', 'subagent/catalog',
  'subagent/descriptor', 'subagent/model-selection-policy', 'system/message', 'team/member',
  'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
  'tool-workflow/run-start', 'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  'tool/result', 'turn/end', 'turn/start', 'user/message', 'web/deepseek-search-llm-request',
  'workspace/changes',
])
```

**注意（实现约束）**：读路径会**拒绝**包含该集合之外事件类型的日志，除非该事件带 envelope 的
`ignorable` 标记——即"out-of-repo 插件自有事件"必须自行标记 `ignorable` 才可安全落盘。

### 1.2 表面事件（会产生 LLM message、进入有序 surface）

```ts
// dsh-session/lib/types/types.d.ts:442
export type SurfaceEventType =
  | 'system/message' | 'developer/message' | 'user/message'
  | 'assistant/message' | 'tool/result';
```

### 1.3 客户端真正收到的帧

浏览器通过 `SessionFollowFrame` 接收（`dsh-api-session-controller/lib/types/types.d.ts:516`）：

```ts
export type SessionFollowFrame =
  | { readonly type: 'snapshot'; header; cursor; records; hasMore; projections;
      assistantStream?: SessionAssistantStreamBaseline }
  | SessionEventEntry                    // { type:'event', event: SessionEvent }
  | { readonly type: 'assistant-stream'; frame: SessionAssistantStreamFrame };
```

**关键：`reasoning` / `thinking` 是独立的一等事件类型，有 `lib/types` 证据。**

1) 流式协议层 `StreamChunk`（`dsh-llm/lib/types/types.d.ts:417`）——token 级：

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }   // ← 推理/思考
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```

2) 客户端实时帧（`dsh-api-session-controller/lib/types/types.d.ts:482`）：

```ts
export type SessionAssistantStreamFrame =
  | { type:'start'; attemptId; revision; startedAfterSeq; turn; step }
  | { type:'chunk'; attemptId; revision; index; time; chunk: JsonValue }
  | { type:'end'; attemptId; revision; index;
      outcome: { kind:'committed'; eventType:'assistant/message'|'assistant/attempt'; seq }
             | { kind:'abandoned' } };
```

3) 客户端投影后的"类事件"（`dsh-api-session-controller/lib/types/client/contract/events.d.ts:6`）：

```ts
export interface AssistantLiveChunkEvent {
  readonly type: 'assistant/live-chunk';
  readonly seq: number; readonly time: number;
  readonly data: { attemptId; turn; step; chunk: StreamChunk };   // ← 原始 StreamChunk
}
export type SessionEventLike = SessionEvent | AssistantLiveChunkEvent;
```

4) 已定稿的助手内容块按 kind 区分（`dsh-client-ui-conversation/lib/types/client/contract/records.d.ts:26`）：

```ts
export type AssistantBlock =
  | { kind: 'text';       text: string }
  | { kind: 'reasoning';  text: string }      // ← 思考
  | { kind: 'image';      attachment: ImageAttachmentRef }
  | { kind: 'tool-call';  callId: string; name: string; argsRaw: string }
  | { kind: 'other';      block: unknown };
```

### 1.4 完整清单表

| 可观察类型 | 判别值 / 类型名 | 定义文件（相对 `@deepseek-ai/`） |
|---|---|---|
| 助手文本增量 | `StreamChunk.type === 'text-delta'` | `dsh-llm/lib/types/types.d.ts:422` |
| **推理/思考增量** | `StreamChunk.type === 'reasoning-delta'` | `dsh-llm/lib/types/types.d.ts:426` |
| 工具调用参数增量 | `StreamChunk.type === 'tool-call-delta'` | `dsh-llm/lib/types/types.d.ts:430` |
| 内容块起止 | `'block-start'` / `'block-end'` | `dsh-llm/lib/types/types.d.ts:418,436` |
| 用量 | `StreamChunk.type === 'usage'` (`TokenUsage`) | `dsh-llm/lib/types/types.d.ts:440` |
| 终止 | `StreamChunk.type === 'finish'` (`FinishReason`) | `dsh-llm/lib/types/types.d.ts:443` |
| 带时间戳的增量（持久化） | `AssistantStreamRecord` = `'text-chunks'\|'reasoning-chunks'\|'tool-call-chunks'\|'chunk'` | `dsh-llm/lib/types/assistant-stream.d.ts:16` |
| 客户端实时 chunk | `AssistantLiveChunkEvent` (`'assistant/live-chunk'`) | `dsh-api-session-controller/lib/types/client/contract/events.d.ts:6` |
| 助手定稿消息 | `'assistant/message'`（含 `stream: AssistantStreamRecord[]`, `usage`, `interrupted?`） | `dsh-session/lib/types/types.d.ts:330` |
| 未提交的模型尝试 | `'assistant/attempt'` | `dsh-session/lib/types/types.d.ts:344` |
| 工具调用 | `'tool/call'` (`callId, name, arguments`) | `dsh-session/lib/types/types.d.ts:354` |
| 工具结果 | `'tool/result'`（含 `meta?`、`error?`） | `dsh-session/lib/types/types.d.ts:374` |
| PTC 派发 | `'tool/ptc-dispatch'`, `'tool/ptc-dispatch-start'` | `dsh-session/lib/types/known-event-types.js:73` |
| 用户消息 | `'user/message'` | `dsh-session/lib/types/types.d.ts:294` |
| 系统提示 | `'system/message'` | `dsh-session/lib/types/types.d.ts:315` |
| 开发者消息 / 工具变更 | `'developer/message'` | `dsh-session/lib/types/types.d.ts:296` |
| 思考/步骤边界 | `'turn/start'`,`'turn/end'`,`'step/start'`,`'step/end'` | `dsh-session/lib/types/types.d.ts:262,273,278,283` |
| 压缩（上下文） | `'compaction/start'`,`/prune`,`/summary`,`/end` | `dsh-session/lib/types/known-event-types.js:31-34` |
| 图片卸载 | `'image/offload'` | `dsh-session/lib/types/known-event-types.js:43` |
| 重试 | `'llm/retry'`, `'llm/retry-started'` | `dsh-session/lib/types/known-event-types.js:44` |
| 斜杠命令 | `'command/run'` / `'command/done'` | `dsh-commands/lib/types/types.d.ts:101,113` |
| 待办 | `'todo/write'` | `dsh-tool-todo/lib/types/types.d.ts:29` |
| 目标 | `'goal/change'` | `dsh-session/lib/types/known-event-types.js:40` |
| 审批 | `'approval/asked'`,`'approval/decided'`,`'approval/policy'` | `dsh-session/lib/types/known-event-types.js:24-26` |
| 权限预设 | `'permission/preset'` | `dsh-permission-presets/lib/types/index.d.ts:29` |
| 沙箱模式 | `'sandbox/mode'` | `dsh-session/lib/types/known-event-types.js:51` |
| 计划模式 | `'plan/mode'` | `dsh-session/lib/types/known-event-types.js:48` |
| Agent preset 选择 | `'agent-preset/selected'` | `dsh-agent-preset-registry/lib/types/session.d.ts:25` |
| 子代理 | `'subagent/catalog'`,`/descriptor`,`/model-selection-policy` | `dsh-session/lib/types/known-event-types.js:59-61` |
| 工作流 | `'tool-workflow/run-start'`,`/run-end`,`/agent-start`,`/agent-end` | `dsh-session/lib/types/known-event-types.js:68-71` |
| 交付物 | `'deliverables/presented'` | `dsh-tool-present/lib/types/types.d.ts:13` |
| 模型/请求头 | `'model/selection'`,`'request/header'`,`'request/context'` | `dsh-session/lib/types/types.d.ts:393,405` |
| 会话标题/结束 | `'session/title'`,`'session/end-seed'` | `dsh-session/lib/types/types.d.ts:430` |
| 工作区变更 | `'workspace/changes'` | `dsh-session/lib/types/known-event-types.js:80` |
| 反馈 | `'feedback/message-put'`,`/message-delete`,`/record` | `dsh-session/lib/types/known-event-types.js:37-39` |
| 用户提问 / 钩子 / 团队 / 定时 | `ask-user` 相关、`'hook/invoked'`,`'hook/result'`,`'team/*'`,`'schedule/change'` | `dsh-session/lib/types/known-event-types.js:41-42,52,63-66` |
| 客户端投影节点（Chat） | `ConversationNode` 联合 | `dsh-client-ui-conversation/lib/types/client/contract/records.d.ts:246` |
| 客户端投影节点（Trajectory） | `TrajectoryCellKind = 'system'\|'user'\|'context'\|'compacted'\|'message'\|'tool'\|'subtool'` | `dsh-client-ui-trajectory/lib/types/client/trajectory-record.d.ts:7` |
| 过程活动分类（Chat 折叠标题） | `ProcessActivity = 'read'\|'readImage'\|'search'\|'write'\|'edit'\|'commands'\|'code'\|'webSearch'\|'webFetch'\|'subagents'\|'plan'\|'questions'\|'tools'` | `dsh-client-ui-chat/lib/types/client/contract/process-groups.d.ts:2` |

**客户端如何订阅**：客户端插件通过会话事件 Definition 注册表订阅，而不是直接读原始 socket：

```js
// dsh-client-ui-trajectory/lib/client.js:1024
ctx.uiConversation.events.register(trajectoryAssistantDefinition);
// 注册表 API:
// dsh-client-ui-conversation/lib/types/client/conversation/event-registry.d.ts:11
//   register(definition: ConversationNodeDefinition): () => void
//   registerFallback(definition: ConversationNodeDefinition): () => void
```

会话事件窗口本身是 `ObservableSnapshot<SessionEventWindow>`（`.../client/contract/events.d.ts:56`），
`MutableSessionEventSource` 提供 `replace/prepend/append/settleAssistant`（同文件 `:65`）。

---

## 2. 子需求①：完整过程 vs. 只显示"思考中"

### 2.1 现状判定：**大部分已存在**

`dsh-client-ui-chat` 已经带一个用户可见的"工作步骤展示"设置。真实配置 schema：

```ts
// dsh-client-ui-chat/lib/types/chat-settings.d.ts:4
export declare const CHAT_SETTINGS_NAMESPACE = "ui-chat";
export declare const TRANSCRIPT_VIEW_FIELD = "transcriptView";
export declare const TRANSCRIPT_VIEW_MODES: readonly ["compact", "standard", "detailed", "verbose"];
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number];
export declare const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode;   // = "detailed"（Web 非桌面）
```

中文界面文案（`dsh-client-ui-chat/lib/client.js:5461`）：

```
"settings.transcript.title": "工作步骤展示"
"settings.transcript.description": "选择希望看到多少工具调用细节"
"settings.transcript.compact": "简洁"
"settings.transcript.standard": "标准"
"settings.transcript.detailed": "详细"
"settings.transcript.verbose": "完全展开"
```

设置行的注册方式（可直接照抄的真实代码，`dsh-client-ui-chat/lib/client.js:12378`）：

```js
ctx.slots.inject("settings.general.item", () => ctx.slots.register({
  name: "settings.general.item",
  id: "transcript-view",
  order: 12,
  locale: NS,
  inject: () => ({
    hooks: { transcriptView: transcriptView.mode },
    setTranscriptView: (mode) => { transcriptView.setMode(mode); }
  })
}, TranscriptViewRow));
```

每个模式解析出的**运行期策略表**（这是真正的"扩展点"）：

```js
// dsh-client-ui-chat/lib/client.js:12013
const POLICIES = {
  compact:  { mode:"compact",  foldCompletedTurns:true,  stepGrouping:"collapsed", liveProcessDetail:false, settledReasoningPreview:false },
  standard: { mode:"standard", foldCompletedTurns:true,  stepGrouping:"collapsed", liveProcessDetail:true,  settledReasoningPreview:true  },
  detailed: { mode:"detailed", foldCompletedTurns:true,  stepGrouping:"history",   liveProcessDetail:true,  settledReasoningPreview:true  },
  verbose:  { mode:"verbose",  foldCompletedTurns:false, stepGrouping:"none",      liveProcessDetail:false, settledReasoningPreview:true  }
};
```

类型（`dsh-client-ui-chat/lib/types/client/presentation-policy.d.ts:9`）：

```ts
export interface ChatPresentationPolicy {
  readonly mode: TranscriptViewMode;
  readonly foldCompletedTurns: boolean;
  readonly stepGrouping: 'collapsed' | 'history' | 'none';
  readonly liveProcessDetail: boolean;
  readonly settledReasoningPreview: boolean;
}
export declare function presentationPolicyFor(mode: TranscriptViewMode): ChatPresentationPolicy;
export declare function derivePresentationPolicy(mode: ObservableSnapshot<TranscriptViewMode>): ObservableSnapshot<ChatPresentationPolicy>;
```

"思考行"已经是独立、可折叠的组件：

```ts
// dsh-client-ui-chat/lib/types/client/chat/ReasoningRow.d.ts:15
// 折叠摘要省略 ** 标记；展开渲染完整 Markdown；流式预览在段落首行完成时推进
export declare const ReasoningRow: MemoExoticComponent<({ text, running, usePresentation, useDisclosure, t }) => JSX.Element>;
```

### 2.2 缺什么

`dsh-client-ui-chat/README.md:83` 明确写了现有模式的能力边界：

> Work-details modes control process-group display and reasoning previews. Compact, Standard, and Detailed
> fold eligible completed Turns **without hiding the final answer**; Verbose retains the duration/status header
> without a collapse action and shows historical process rows directly.

即：**4 档模式改变的是"过程行"的可见性，从不隐藏最终答案。**
用户要的"只显示思考中"（把工具调用/文件编辑全部收起，只留一个"思考中/正在分析请求"指示）
**不存在为一个模式**，但距离很近：

- 最接近的是 `compact`（`foldCompletedTurns:true`, `stepGrouping:'collapsed'`, `liveProcessDetail:false`,
  `settledReasoningPreview:false`）——它把过程折叠成一行汇总标题，但没有隐藏正文。
- 运行中状态文案已存在：`message.stepProcess.thinking` = "正在分析请求"、
  `message.think` = "思考"、`message.stepProcess.done.thinking` = "已完成分析"
  （`dsh-client-ui-chat/lib/client.js:5366,5500,5393`）。

### 2.3 建议的挂钩点

1. **新增一个模式枚举值**（例如 `"thinking-only"`）：改 `TRANSCRIPT_VIEW_MODES` +
   `ChatSettingsFields.transcriptView` 的 `z.union([...])` + `POLICIES` 表，并加一条 locale。
   `ChatPresentationPolicy` 的注释明确说"renderer 只选单个字段，没有一个比较 mode 枚举，所以新增模式只改下面这张表"——
   但"隐藏正文"是**新语义**，需要新增一个策略字段（例如 `answersHidden` 或 `finalAnswerPresentation`），
   并让 `AssistantNodeView`/`conversation-nodes/assistant.ts` 消费它。**这部分必须新建。**
2. **Trajectory 已有折叠能力**（`TrajectoryTableProps`）：
   ```ts
   // dsh-client-ui-trajectory/lib/types/client/TrajectoryTable.d.ts:49
   collapsedTurns: ReadonlySet<number>;
   onToggleTurn: (turn: number) => void;
   collapsedAssistants: ReadonlySet<string>;
   onToggleAssistant: (id: string) => void;
   ```
   这是"逐 turn / 逐 assistant 折叠"的现成机制，可直接复用为"只显示思考"的折叠来源。
3. Trajectory 的记录数据模型（每个记录一行）：
   ```ts
   // dsh-client-ui-trajectory/lib/types/client/trajectory-record.d.ts:28
   export interface TrajectoryCellProps {
     index: number; recordId?: string; kind: TrajectoryCellKind;
     text: string; previewMarkdown?: string; opensTurn?: boolean; sourceSeq?: number;
     inputDetail?: string; outputDetail?: string;
     thinkingDetail?: string;              // ← 推理单独存放
     sourceBlocks?: readonly TrajectorySourceBlock[];
     outputBlocks?: readonly TrajectorySourceBlock[];
     schemaDetail?: string; assistantMetrics?: AssistantMetricDetail;
     result?: string; isError?: boolean; callId?: string; toolName?: string;
     timeSeconds: number | null; startedAt?: number | null;
     input?: number; cacheRead?: number; cacheWrite?: number; output?: number; think?: number;
     selected?: boolean;
   }
   ```
   注意 `thinkingDetail` 与 `outputDetail` **是两个独立字段**，所以"只显示思考"在数据层天然可分。
4. Trajectory 是**纯投影、只读**，不能改 Chat：
   `dsh-client-ui-trajectory/README.md:54` — "Trajectory neither reads nor changes the Chat conversation snapshot"。

---

## 3. 子需求②：把输出写到文件

### 3.1 现状判定：**已存在（ZIP 下载 + 序列化 API + 原子写工具），但缺"宿主机任意路径写入"**

#### (a) 已有 `/export` 斜杠命令（真实存在）

```yaml
# dsh-session-log-export/README.md:38
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

| 输入 | 结果 |
|---|---|
| `/export` | 记录 human-command 生命周期；浏览器下载 `api/session.export?sessionId=<id>&includeDescendants=true` |
| `/export <path>` | **报错**；浏览器下载由浏览器决定目标 |

配置只有一项：`compressionLevel`（默认 `6`，DEFLATE 0–9）。
ZIP 内结构：根会话 `session[.vN].jsonl`，子会话 `subagents/<id>/...`，
图片 `media/<attachmentId>.<ext>`，普通文件 `files/<prefix>/<digest>/<name>`。
**导出目录里没有 manifest。**

#### (b) 可直接复用的 API（不要重造）

```ts
// dsh-session-log-export/lib/types/archive.d.ts
export declare function sessionLogExportDeps(ctx: Context): SessionLogExportDeps;          // :51
export declare function flushLiveSessionLog(deps, id, signal?): Promise<void>;             // :60
export declare const SESSION_LOG_FILENAME: string;                                        // :73
export declare function serializeSessionLog(header: SessionHeader, events: readonly SessionEvent[]): string;  // :81
export declare function readSessionLogText(persistence: SessionPersistence, id: SessionId, signal?): Promise<string | undefined>;  // :92
export declare function sessionLogZipFilename(sessionId: string): string;                  // :98
export declare function sessionLogZipEntries(deps, rootContent, sessionId, includeDescendants, signal?): AsyncGenerator<SessionLogZipEntry>;  // :115
export declare function streamSessionLogZip(deps, rootContent, sessionId, includeDescendants, compressionLevel, signal): ReadableStream<Uint8Array>;  // :131

export type SessionLogZipEntry =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly data: Uint8Array }
  | { readonly path: string; readonly chunks: AsyncIterable<Uint8Array> };
```

`serializeSessionLog` 的契约：**首行 header，然后一行一个已校验事件，末尾换行**——
这正是"把对话写成 Markdown/JSONL"里 JSONL 那一半的现成实现。

`README.md:143` 的 Dev Note 明确说这是**有意的限制**，且指出了未来的扩展方向：

> **Future: export destinations beyond the browser** — The download is deliberately browser-scoped;
> a Host-path or native folder export would need a new endpoint contract and a decision on where the ZIP lands.

#### (c) 原子写文件

```ts
// dsh-atomic-write/lib/types/index.d.ts:46
export declare function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void>;
export declare function withFileLock<T>(filename: string, operation: () => Promise<T>, options?: FileLockOptions): Promise<T>;  // :83
export interface WriteFileAtomicOptions { mode: number; dirMode?: number }   // mode 必填，:17
```
`dsh-atomic-write` **不注册为 cordis 服务**（导出的是普通函数），宿主侧插件直接 import 即可。

#### (d) 模型侧写文件工具（真实参数 schema）

```js
// dsh-tool-fs/lib/index.js:527（applyWriteTool）
ctx.tools.register(defineTool({
  name: "write",
  description: "Create or fully replace a UTF-8 text file.",
  parameters: {
    file_path: { type:"string", required:true, description:"Path to write, resolved by the filesystem backend." },
    content:   { type:"string", required:true, description:"Full UTF-8 text content to write." },
    ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}
  }, ...
}));
```

```js
// dsh-tool-present/lib/index.js:24
name: "present",
description: "Declare existing files as final deliverables for the user. ...",
parameters: { files: { type:"array", required:true, description:"Usually the 1-2 most important deliverables; at most 4 per call.",
  items: { type:"object", additionalProperties:false, properties: {
    path: { type:"string", required:true, description:"Path of an existing regular file. Relative paths use the Session working directory." },
    description: { type:"string", description:"Brief description for the user." } } } } }
// 配置: Config = z.object({ maxFiles: z.number().default(8) })   // lib/index.js:8
```

`present` 成功后会落盘 `'deliverables/presented'` 事件（`dsh-tool-present/lib/types/types.d.ts:13`），
携带 `{ turn, callId, files: PresentedFile[] }`。

`str_replace_editor`（`dsh-tool-str-replace-editor`）支持 `view` / `create` / `str_replace` / `insert`；
`create` 在目标路径**已存在**时会失败（`lib/index.js:17`），即它是"创建新文件"语义。

**重要边界**：这些工具是 **model-facing**（由模型调用），**不能从客户端 UI 直接触发**。
"把输出写到文件"若要求"助手每次回答自动落盘"，需要在**宿主侧**新增一个插件：
订阅 `assistant/message` 事件 → `serializeSessionLog`/自建 Markdown 渲染 → `writeFileAtomic`。

#### (e) 会话文件格式与磁盘位置（已实测）

`dsh-session-persistence-jsonl/README.md:58` 的布局：

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # v0 压缩
      session.v1.jsonl.zstd
      session.v2.jsonl.zstd
      session.v3.jsonl.zstd
      session.jsonl / session.v1.jsonl / session.v2.jsonl / session.v3.jsonl   # compression: 'none' 时
```

配置（`root` **必填无默认**，`compression` 默认 `'zstd'`）：

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
```

**本机实测**（只读列目录）：根目录为 `C:\Users\WANGZ\.dsh\sessions`，真实路径形如

```
C:\Users\WANGZ\.dsh\sessions\--C-Users-WANGZ-Documents-GitHub-dsh-app--\session-68a2dc34-7012-4c61-b9d4-bf05c48af41d\session.v4.jsonl.zstd
```

**当前格式版本已被代码确证为 v4**（README 的布局表停在 v3，是文档滞后）：

```js
// dsh-session/lib/types/types.js:54
export const SESSION_FORMAT_VERSION = 4;
```

文件名由该常量派生，不是硬编码：

```js
// dsh-session-persistence-jsonl/lib/index.js:937
function logPath(root, cwd, id, compression) {
  return generationLogPath(root, cwd, id, SESSION_FORMAT_VERSION, compression);
}
// :761
function generationLogFilename(version, compression) {
  return `${sessionFormatLogFilename(version)}${compressionSuffix(compression)}`;
}
```

并且启动时会校验 catalog 与 Session 的版本一致：

```js
// dsh-session-persistence-jsonl/lib/index.js:2399
if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION)
  throw new Error(`session-persistence-jsonl: format catalog v${sessionFormatCatalog.currentVersion} does not match Session v${SESSION_FORMAT_VERSION}`);
```

`dsh-session-format-v3-to-v4/lib/types/codec.d.ts:7` 导出 `releasedV4SessionFormatCodec`。
**建议：任何需要"最新日志文件名"的代码都应调用 `logPath`/读 `SESSION_FORMAT_VERSION`，
绝不硬编码 `session.v4.jsonl`。** 版本升级（v4→v5）会改变路径。

物理编码：一连串独立的 Zstandard frame——一个只含 header 行的校验帧，
然后每批 durable append 一个校验帧。`compression:'none'` 时是纯 UTF-8 换行文本，
外部行读取器可直接消费；**默认压缩态必须通过 backend 读取**。
一 session 一写者：`flock(2)`（Windows 为基于路径的命名内核信号量）。

投影缓存（另一个目录，非日志本体）：
`C:\Users\WANGZ\.dsh\storages\session_projcache\sessions\<id>.json`；
工作区状态 `C:\Users\WANGZ\.dsh\storages\workspace.json`。

#### (f) 注册一个 `/export-md` 之类的命令

真实 API（`dsh-commands/README.md:35` 与其 `lib/types/types.d.ts`）：

```ts
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => {
    return { kind: 'success', text: 'plan mode selected' }
  },
})
```

```ts
// dsh-commands/lib/types/types.d.ts
export type CommandResult =
  | { kind:'success'; text?: string; sourceEventSeq?: SessionSeq }
  | { kind:'error'; text: string };
export interface CommandDescriptor { definitionId?; name: string; description: string; input?: CommandInputDescriptor }
export interface CommandInputDescriptor { hint: string; attachments?: boolean }
```
命令名规则：小写、字母数字 `_`/`-`，行首 `/`。命令**不进入模型历史**、不产生模型 token。
`/export` 就是这样注册的（`dsh-session-log-export/README.md:80`：宿主半边注册 `/export` 命令
并向 Connection 贡献 `GET`/`HEAD /api/session.export` 路由）。

---

## 4. 子需求③：输出长度 / 啰嗦度

### 4.1 现状判定：**部分存在（有提示注入机制，无输出长度旋钮）**

**没有任何既有机制影响"助手自己散文的长度"。** 逐一说明：

| 包 | 实际控制的东西 | 影响助手输出长度？ |
|---|---|---|
| `dsh-compaction-basic` | 上下文接近上限时把最老历史总结掉；`/compact` 手动触发；上下文溢出后重试 | **否**（降上下文，不降输出） |
| `dsh-compaction-tool-result-pruner` | 压力触发时把超预算的**工具结果**文本换成"头部 + 中部裁剪标记 + 尾部" | **否**（只裁工具结果） |
| `dsh-output-retention` | 库：`ItemRetainer` / `TextRetainer`，给工具自己用来限制返回给模型的条目/字节 | **否**（工具侧自用） |
| `dsh-spill-policy` | 超大文本/图片溢出到磁盘，模型只看到头尾 + 路径；`maxInlineTokens`（例如 12500），不设置则禁用 | **否** |
| `dsh-token-meter` | 测量/压力判定 | 否 |

`dsh-agent-loop` 的 `Config` **没有** `maxTokens` / `temperature` / `verbosity` 之类字段：

```ts
// dsh-agent-loop/lib/types/index.d.ts:80
export interface Config {
  maxParallelToolCalls: Volatile<number>;
  agents: (AgentOptions & { id: string; sessionId?: SessionId; cwd?: string; resumeSessionId?: SessionId })[];
}
```

`maxTokens` 只出现在**单次请求结构**里（`AssistantRequestConfig.maxTokens`，
`dsh-client-ui-conversation/lib/types/client/contract/records.d.ts:17`）和 `GenerateOptions` 采样里；
`dsh-llm/README.md:158` 明确说采样只有 `temperature`/`maxTokens`/`stop` 三个字段，
`maxTokens` 的本职是**上限截断**（`turn-max-tokens` 事件），不是"请说得简短"。

### 4.2 提示注入的三个真实扩展点

#### (a) 系统提示分段（最干净）

```ts
// dsh-system-prompt/lib/types/index.d.ts:47
export interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;
  readonly complete?: boolean;
}
// SystemPrompt 服务方法（:239, :258, :273, :282）
section(section: PromptSection): () => void
context(context: PromptContext): () => void
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void
suppressRuntimeContext(): () => void
```

中央分配的顺序常量里已有 persona 位置（`SECTION_ORDERS`，`:113`）：

```ts
HARNESS_IDENTITY: -1000,
DEPLOYMENT_PERSONA_PREFIX: 0,
...
DEPLOYMENT_PERSONA_SUFFIX: 10200,
```

所以一个插件可以这样做（**这是"先生成回答、再决定长度"的最可行路径**）：

```js
ctx.systemPrompt.section({
  name: 'style:verbosity',
  order: 10,                                   // 紧跟 deployment persona prefix
  text: ({ scope }) => currentStyle() === 'concise'
    ? '保持回答极简：默认 3 句以内，不解释显而易见的事。'
    : '充分展开：给出完整推理、示例与边界情况。',
});
```
`system-prompt/change` 事件（`:33`）会在 provider 变化时被发出，
`assemble()` 每次请求都重新求值 `text`，所以**运行时可切换**，无需重启。
但注意：改系统提示会**打断 provider KV cache**（前缀变化），这是真实代价。

#### (b) `dsh-persona`（面向"身份"，不是"长度"）

```ts
// dsh-persona/lib/types/index.d.ts:24
export interface Config {
  prefix: string;                  // 渲染为 deployment:persona-prefix 分段，支持 {{var}} 严格插值
  suffix?: string;                 // deployment:persona-suffix，缺省/空会遮蔽部署后缀
  complete?: boolean;              // 让 prefix 成为完整系统提示，压制所有其它分段
  includeRuntimeContext?: boolean; // 抑制动态运行时上下文快照
}
```
`dsh-persona` 是 **scope-only** 行（`:6`）：挂在 agent preset 里遮蔽该会话的部署 persona；
挂全局会与 prompt registry 自身注册冲突并**报错退出**。所以它天然是"每个 preset 一个角色"的机制。

#### (c) Agent preset + `agent-preset/selected`（可切换但**要新建会话才生效**）

```ts
// dsh-agent-preset-registry/lib/types/definition.d.ts:4
export interface PresetDefinition {
  readonly id: string; readonly name?: string; readonly description?: string; readonly order?: number;
  readonly plugins: readonly (Omit<EntryOptions,'id'|'disabled'> & { id?: string; disabled?: EntryOptions['disabled'] | JsExpr })[];
}
```

```ts
// dsh-agent-preset-registry/lib/types/types.d.ts:46 — 会话已开始则组合固定
'agent-preset/locked': { readonly sessionId: SessionId; readonly agentPreset: string; }
```

`dsh-client-ui-agent-preset/lib/types/client/AgentPresetSeat.d.ts:1-13` 的文档注释说得非常直白：

> It lives here rather than in the composer because the choice is **only available before a conversation starts**:
> once a turn has run, the session's history was produced under that preset's tools and the host refuses to swap them.

注册表选择策略（`preset.d.ts`）：
```ts
export interface Config {
  default: string;                              // 部署默认
  selectedDefault: Volatile<string | undefined>; // 用户通过 Settings 选出的默认
}
```
**结论：agent preset 是"按会话"的选择，首轮之后锁死；不能作为"回答中途切换长度"的手段。**
可切换的只有：新会话的默认 preset（Settings）、以及系统提示分段的实时求值。

#### (d) 现成的静态注入：`AGENTS.md`

```ts
// dsh-agent-instructions/lib/types/config.d.ts:8
export interface Config {
  dshHome?: string;                 // 含固定用户级全局 AGENTS.md；默认 $DSH_HOME 或 ~/.dsh
  projectRootMarkers?: string[];
  maxBytes: number;                 // 单个渲染基线的 UTF-8 字节上限
  maxSourceBytes?: number;
  instructionFileCandidates?: string[];
  localInstructionFileCandidates?: string[];
}
```
最省事的"让我简短一点"：写 `C:\Users\WANGZ\.dsh\AGENTS.md`。
但它是**全局、静态、需重启/重新装载**，且对所有项目生效——不适合做用户可切换的风格开关。

---

## 5. 子需求④：galgame 风格分步播放

### 5.1 现状判定：**不存在（必须新建）**

#### (a) 客户端确实收到 token 级 delta —— 所以客户端分步是**可行**的

见 §1.3：`SessionAssistantStreamFrame { type:'chunk', chunk: JsonValue }`
（`dsh-api-session-controller/lib/types/types.d.ts:490`）与
`AssistantLiveChunkEvent.data.chunk: StreamChunk`（`.../contract/events.d.ts:14`）。
浏览器拿到的是**原始 `StreamChunk`**（`text-delta` / `reasoning-delta` / `tool-call-delta`），
不是只拿到拼好的整条消息。这直接决定"点一下走一行"在客户端**技术可做**：

- 客户端可以自己缓冲 delta，按换行/句末标点切分，一次只"释放"一行；
- 但**流不能真的暂停**（没有 pause/resume 协议）——只能"前端延迟揭示"。
  真正的暂停需要新协议，**不在现有 API 内**。

#### (b) "重放"已经有素材：会话日志里存了带时间戳的完整 chunk 流

```ts
// dsh-llm/lib/types/assistant-stream.d.ts:16
export type AssistantStreamRecord =
  | { readonly type:'text-chunks';      readonly time0:number; readonly index:number; readonly dt:readonly number[]; readonly texts:readonly string[] }
  | { readonly type:'reasoning-chunks'; readonly time0:number; readonly index:number; readonly dt:readonly number[]; readonly texts:readonly string[] }
  | { readonly type:'tool-call-chunks'; readonly time0:number; readonly index:number; readonly dt:readonly number[]; readonly id:ToolCallId; readonly name?:string; readonly args:readonly string[] }
  | { readonly type:'chunk';            readonly time:number; readonly chunk:StreamChunk };

// 精确展开（含每个原始 delta 边界与时间戳）
export declare function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[];  // :71
export declare function joinAssistantStreamText(stream): string;   // :154  文本 delta 拼接
export declare function assistantStreamChunks<T>(stream, type: T): readonly Extract<StreamChunk,{type:T}>[];  // :146
export declare function assembleAssistantStream(stream, assembler?): BlockAssembler;  // :165
```
`assistant/message` 事件本身携带 `stream: AssistantStreamRecord[]`
（`dsh-session/lib/types/types.d.ts:335`）。**因此"逐字/逐行重放历史回答"有完整数据支撑，
包括真实打字节奏（`dt` 是相对时间增量）。** 这是 galgame 模式最有价值的既有资产。

#### (c) 已有的"分步/导航"能力（不是 galgame，但可复用）

| 能力 | 类型定义 | 粒度 |
|---|---|---|
| 按 turn 跳转 + 未加载 turn 分页 | `ChatNavigation.navigateToTurn(item: TurnRailItem)` — `dsh-client-ui-chat/lib/types/client/chat/use-chat-navigation.d.ts:37` | turn |
| Turn 导航轨（固定间距、悬停预览） | `TurnNavigator` + `TurnNavigatorHandle.activateTurn/scrollToTurn` — `.../chat/TurnNavigator.d.ts:12` | turn |
| 折叠/展开披露（每个 reasoning / tool 独立） | `UseDisclosure = () => { expanded; setExpanded; toggle }` — `.../contract/slots.d.ts:106`；`useDisclosure(version?)` — `.../chat/use-disclosure.d.ts:8` | 单个披露块 |
| 折叠状态表 | `TrajectoryTableProps.collapsedTurns / collapsedAssistants` | turn / assistant |
| 快捷键注册 | `ShortcutRegistry.register(command: ShortcutCommand): () => void` — `dsh-client-shortcuts/lib/types/client/registry.d.ts:58`；`registerFixed(command)` — `:46` | 全局按键 |

**明确不存在**（已 grep 客户端包）：`typewriter`（唯一命中是 PDF worker 的源码字符串）、
`stepwise`、`step-through`、`fast-forward`、`pauseStream`、`resumeStream` —— 全部 0 命中。
`replay` 的命中全部是 LLM 适配器层的 `ReplayEnvelope`（provider 响应重放），与 UI 播放无关。

#### (d) 要新建什么

1. **行切分器 + 揭示速率控制器**：消费 `AssistantLiveChunkEvent` 的 delta 缓冲，
   按 `\n`/句末标点切行；"点一下"释放一行；"长按"进入 `setInterval` 快速揭示（或直接渲染全部）。
2. **一个新的 `conversation.view` 标签页**（现有扩展点）：
   ```js
   // dsh-client-ui-trajectory/lib/client.js:8736 —— 真实范例
   ctx.slots.inject("conversation.view", () => ctx.slots.register({
     name: "conversation.view", id: "trajectory", order: 10, locale: NS,
     label: () => t("view.trajectory"),
     children: { "conversation.trajectory.images": { kind: "single", scope: "session" } },
     inject: (sessionId) => { /* ... */ }
   }, TrajectoryView));
   ```
   配套要注册一个 view builder（`ConversationViewRegistry.register(definition)`，
   `.../conversation/view-registry.d.ts:10`）与事件 Definition
   （`ctx.uiConversation.events.register(...)`）。
3. **历史重放**：用 `expandAssistantStream()` 从 `assistant/message` 的 `stream` 还原原始
   时间线，即可实现"重新播放这一段回答"。数据已在磁盘上，成本是要把
   `AssistantStreamRecord[]` 送到客户端（当前 `SessionFollowFrame` 只在 assistant-stream 实时帧里给 chunk；
   历史事件里的 `stream` 字段是否在 `SessionHistoryRecord` 中原样传输**未验证**，见 §7）。
4. **快捷键**：为"下一行"注册一个 shortcut command；长按用 pointerdown/pointerup 处理。
5. **注意与既有折叠的冲突**：`useDisclosure` 的 open state 在 display-mode 变化时**保留**
   （`README.md:106`：Display-mode changes preserve their open state），
   新模式的揭示进度需要自己的 state owner，不要塞进 disclosure。

---

## 6. 附加：对话写作 / 语音（galgame 是否该带语音）

`dsh-persona` 已在 §4.2(b) 说明——它是**系统提示层面的角色（persona）**，不是多轮剧本/角色扮演引擎：
没有角色卡、好感度、分支选项、立绘之类的结构。要做 galgame 叙事，**内容生成方式本身必须新建**
（最现实的做法：用 persona/section 注入 galgame 文风指令，靠模型产出一行一句的文本）。

语音支持现状（`dsh-experimental-client-ui-voice-input`）：

- 能力：**语音→文字**（STT）。麦克风按钮位于模型选择器与 Send 之间；
  录制 → 停止 → 转写 → **插入到输入草稿**（可审阅），不自动发送。
- 相关包：`dsh-experimental-speech-to-text`、`dsh-experimental-speech-to-text-sensevoice`、
  `dsh-experimental-api-speech-to-text`、`dsh-experimental-voice-input-bundle`。
- 明确限制（`README.md:66`）：
  > No automatic send, always-on microphone, wake word, streaming captions or **speech synthesis**.

**所以 galgame 若要有"角色配音"，语音合成（TTS）不存在，必须自建。**
STT 的现成能力对 galgame 的用处只有"用说话来推进对话"。

---

## 7. 未验证 / 风险

1. ~~**会话格式实际代次与 README 不一致**~~ → **已确证并解决**：`SESSION_FORMAT_VERSION = 4`
   （`dsh-session/lib/types/types.js:54`），当前日志确为 `session.v4.jsonl.zstd`，
   README 布局表停于 v3 属文档滞后。写文件名请用 `logPath()` / `SESSION_FORMAT_VERSION`，
   勿硬编码。
2. **`AssistantStreamRecord[]` 是否随历史事件原样传到浏览器，只确证到一半**。
   已确证：历史走线记录被 `historyEntries()` 收窄为 `SessionEventLikeEntry`
   （`dsh-api-session-controller/lib/types/client/sessions/history-records.d.ts:9`），
   即客户端拿到的是**完整 `SessionEvent` 对象**——而 `'assistant/message'` 事件的
   `stream: AssistantStreamRecord[]` 就在该对象内部（`dsh-session/lib/types/types.d.ts:335`），
   所以结构上应该随行传输。**未确证**的是 `dsh-typert-protocol` 的 wire schema 是否
   完整保留 `stream` 字段（我没有读协议的 `RemoteErrorDetailsMap` / schema 生成文件）。
   这一小步决定"重放历史回答"是零成本还是要新增 wire 字段，**动手前应先实测一次**：
   打开一个旧会话，在浏览器侧 dump 一条 `assistant/message` 事件的 `stream` 字段。
3. **`dsh-client-ui-renderer` 的节点渲染器注册表未细读**。
   `lib/types/client/registry.d.ts` 有 12KB，是"替换某个节点怎么渲染"的可能扩展点；
   `dsh-client-ui-chat` 的 `registerChatNodeRenderers` 是真实使用范例。
   如果"只显示思考中"要改渲染而非改投影，这里可能是另一个（更 invasive 的）挂钩点。
   我**没有**验证它是否允许第三方插件覆盖内置节点渲染。
4. **`transcriptView` 的 `standard` 值在某些客户端被作为默认**。
   `dsh-client-ui-chat/lib/client.js:12357`：
   `new TranscriptViewPolicy(chatSettings, "dshDesktop" in globalThis ? "standard" : DEFAULT_TRANSCRIPT_VIEW_MODE)`。
   桌面壳默认 `standard`，Web 用 schema 默认（`detailed`）。实际当前用户看到哪一档取决于运行载体。
5. **`ChatPresentationPolicy` 新增字段是破坏性改动面**。
   注释声称"renderer 只选单个字段、不比较 mode 枚举"，但要让"隐藏正文"生效，
   必然要改至少一个 renderer（`conversation-nodes/assistant.ts` 一侧）。
   升级 `dsh` 版本时这些内部 renderer 是最容易被上游重写的部分。
6. **`/export` 的 `/export <path>` 会报错**（`README.md:56`）。用户若期望"写到指定文件路径"，
   现有命令**明确不支持**，需要新的宿主路由 + 端点契约。
7. **`ui-chat` 的 `transcriptView` 只在 loopback/桌面持久化**。
   `dsh-client-ui-settings/README.md:106`：非 loopback 页面得到的是**无持久化**设置
   （form 一开始就是 `unavailable`，写入无效）。若通过远程 Web 访问，"风格设置"不会落盘。
8. **`settings.yaml` 已成为历史**。本机 `C:\Users\WANGZ\.dsh\settings.yaml.imported` 存在
   （内容只有 `ui-onboarding` 与 `web-search-deepseek` 两节），说明设置已迁移到 profile 的
   `cordis.patch.yml` + 用户设置文档；`dsh-settings/lib/types/index.d.ts:73` 有
   `importLegacyDocument` 专门处理这次迁移。**不要**再建议用户改 `settings.yaml`。
9. **权限预设不是"可注册"的扩展点**。`dsh-permission-presets` 的 preset 表来自
   **插件 Config**（`Config.presets: Record<string, PresetSpec>`，`lib/types/index.d.ts:82`），
   没有 `register()` 方法给第三方插件动态加入。若想照抄这个模式做"显示风格预设"，
   要么同样走 Config（需要改 profile 的 `cordis.patch.yml`），要么自建注册表。
   它值得借鉴的是**运行时可切换 + 落盘 `permission/preset` 事件**这套模式
   （`set(session, name)`，`:186`）。
10. **`present` 的 `maxFiles` 默认是 8**，但工具描述文本写"at most 4 per call"
    且 `present` 校验用 `config.maxFiles`（`lib/index.js:8,81`）——描述与实现不一致，
    这是上游文档瑕疵（不影响功能，但引用时不要写"最多 4 个"）。

---

## 8. 交付建议（最小可行路径）

| 目标 | 最小改动 |
|---|---|
| 只显示"思考中" | 在 `ui-chat` settings 的 `transcriptView` 联合里加一个模式；给 `ChatPresentationPolicy` 加一个 `answersHidden`/`processOnly` 字段；改 assistant 节点渲染消费它。**客户端插件改不了 `ui-chat` 内部**——需要 fork 或上游接受补丁，或新建一个自己的 `conversation.view` 只渲染 reasoning |
| 输出写文件 | 宿主插件：订阅 `assistant/message` → 自建 Markdown 渲染（或 `serializeSessionLog` 出 JSONL）→ `writeFileAtomic`。若需用户指定路径，再加一条宿主 Fetch 路由（照抄 `dsh-session-log-export` 的 `GET /api/session.export` 形态） |
| 简洁 / 详细切换 | 新插件注册两个 `ctx.systemPrompt.section`（同一 `name`，按当前设置返回不同 `text`），把设置存进自己的 Config namespace（`ctx.configForms.get("<entry-id>")`），并在 `settings.general.item` 注册一个行 |
| galgame 分步播放 | 新客户端插件：注册 `conversation.view` 标签页 + 自己的 `ConversationViewDefinition` + 自己的 `ConversationNodeDefinition`，内部消费 `AssistantLiveChunkEvent` 并按行揭示；历史重放用 `expandAssistantStream()`（前提见 §7.2） |
