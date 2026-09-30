# LLM 提示缓存：量化方法与实测

> 工具：[`scripts/cache-stats.mjs`](../scripts/cache-stats.mjs)
> 日期：2026-09-29 · 环境：`dsh` 0.2.0-rc.2

---

## 1. 为什么关心这个

长对话的提示规模会涨到**几十万 token**，其中绝大部分是**缓存命中**。
一旦某个改动破坏了"提示前缀稳定性"，命中率会掉下来、费用随之上升 ——
但**这个变化在界面上几乎看不出来**。

可以做量化之后，"某个改动是否伤了缓存"从猜测变成测量。

---

## 2. 数据来源

会话日志里每条 `assistant/message` 都带 provider 上报的 usage：

```json
{
  "inputTokens": 6054,
  "outputTokens": 258,
  "cacheReadTokens": 1024,
  "cacheWriteTokens": 0,
  "totalTokens": 7336
}
```

⚠️ **关键理解**：`inputTokens` 是**未缓存**的输入，**不含**缓存读取部分。因此：

```
提示总量 = inputTokens + cacheReadTokens
命中率   = cacheReadTokens / (inputTokens + cacheReadTokens)
```

> 这个坑我踩过一次：最初把 `totalTokens` 或投影里的累计值当成原始上报，
> 算出了"100%、4.37 亿 cacheRead"的荒谬结果。
> 必须取 `assistant/message.data.usage` 这一处。

---

## 3. 会话日志的格式（读它需要注意）

DSH 的会话日志是 **`session.v4.jsonl.zstd`** —— 一个**拼接多帧 zstd 容器**，
**不是**单个 zstd 流。证据：`dsh-session-persistence-jsonl/lib/index.js` 里的
`scanZstdFrames` / `tornStart` / `zstdDecompressSync(subarray(start,end))`。

因此：

| 做法 | 结果 |
|---|---|
| `zstdDecompressSync(整个文件)` | ❌ `Unknown frame descriptor` |
| 按帧魔数 `0xFD2FB528` 切分后逐帧解压 | ✅ 正确 |

**最后一个不完整的帧要跳过** —— 与 DSH 读取器行为一致（长会话在持续写入，
文件尾部常常是半个帧）。

---

## 4. 实测结果（本项目所在会话）

```
=== 596 次 LLM 调用 ===
  未缓存输入 inputTokens : 805,110
  缓存读取  cacheRead    : 228,349,184
  输出      outputTokens : 391,683

  提示总量               : 229,154,294
  ★ 缓存命中率           : 99.6%

  前 298 次 : 99.7%
  后 298 次 : 99.6%
```

最近几次请求的提示已达 **65 万 token**，其中 99.9% 命中缓存：

```
seq=3744  prompt=655053  read=654720  命中=100%
```

**这是长对话的正常形态**：整段历史被缓存，每轮只新增很小的后缀。

---

## 5. 实测：切换 DSH_HOME 的代价

把同一段对话搬到另一个 `DSH_HOME`（另一个实例）会引起**缓存失效**，原因是多重的：

| 因素 | 影响 |
|---|---|
| **API key 不同** | 实测生产与另一个实例用的是**不同 key**（`...3302f6` vs `...571c3c`）→ 很可能不在同一缓存域 |
| **新进程首次请求** | 前缀未命中 → 全量重算 |
| **系统提示可能不同** | 工作目录、环境事实等进入系统提示 → 前缀逐字节不同 |
| **时间上下文** | ⚠️ 实测是**用户消息**而非系统提示（`dsh-time-context` 用 `createUserMessage`）→ 对缓存**友好** |

**代价量级**：以 65 万 token 的提示为例，命中率归零意味着这次请求的输入
几乎全部按"未缓存价"计费（DeepSeek 缓存价约为全价的 1/10 量级）。

**关键结论**：这是**一次性损失**，不是持续损失 —— 预热完成后后续轮次会重新回到接近 100%。

> 因此建议：**不要为了"换个界面看看"而迁移长会话**。
> 需要隔离测试时，用**新的空环境**，不要搬长对话。

---

## 6. 用法

```powershell
# 直接读会话日志（自动识别拼接多帧 zstd）
node scripts/cache-stats.mjs "$env:USERPROFILE\.dsh\sessions\<workspace>\<sessionId>\session.v4.jsonl.zstd"

# 也接受已解压的 .jsonl
node scripts/cache-stats.mjs .\session.jsonl
```

输出：总命中率、前后半段对比、最近 10 次明细。

---

## 7. 对项目的启示

1. **凡是会改变提示前缀的改动都要量化**：换模型、改系统提示、
   切换 reasoning 档位、加/减上下文注入。
2. **`systemPrompt.section` 的代价不只是 KV cache 重建** ——
   它是**每一轮**都在改变前缀的一部分，会持续压低命中率。
   （这也是为什么 [ARCHITECTURE.md](../docs/ARCHITECTURE.md) 里的输出长度档位
   要标注"运行时可切换，代价是打断 provider KV cache"。）
3. **桌面宠物这类"只监听、不调模型"的功能，对缓存零影响**
   （`workStatusEnabled` 官方注释明确"仅监听，不调用模型"）。
   这与项目"零成本默认"的设计原则一致。
