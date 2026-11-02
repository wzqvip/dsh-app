# dsh-assistant（个人助理 · P0+P1）

> 状态：**P0/P1 完成** —— 数据层 + classpipe 适配器 + 轮询循环。
> **还不是 DSH 插件**（插件外壳在 P2）。
> 设计见 [docs/ASSISTANT.md](../../docs/ASSISTANT.md) · 分支 `feat/personal-assistant`

## 这个东西要解决什么

现在的 DSH 是**开发者工具**：你发起任务，它在会话里干完，结束。

个人助理要的是**常驻 + 主动**：

> 定时（或事件触发）去查看课程/邮件/日程，
> 发现**新增或改期的截止**，通过 IM 找到你。

差别不在"更聪明"，而在**触发方式（时间/事件发起）、记忆（跨会话）、输出（推到手机）**。

## 已经能跑的部分

```
classpipe（Canvas）─┐
                    ├─→ 归一成 Item ─→ 幂等去重 ─→ 提醒计划 ─→ 通知
（未来）gmail/outlook┘
```

```
$ node scripts/probe-classpipe.mjs
[probe] 上游：作业 235 / 测验 81 / 公告 75
[probe] 映射出 391 条原始项
[probe] 入库 391 条（inserted 391 / rejected 0）
[probe] 幂等复跑：unchanged 391 / inserted 0 ✅
[probe] 有截止 159 条，其中未来 12 条
[probe] 未来 7 天内将触发的提醒 14 条
[probe] OK
```

## API

| 模块 | 内容 |
|---|---|
| `src/items.js` | `Item` 归一化、内容指纹、幂等合并、状态流转 |
| `src/reminders.js` | 递减提醒（T-3d / T-1d / T-4h）、去重键、不补发过期 |
| `src/sources/classpipe.js` | 读 classpipe `/canvas/all_tasks` → `Item` 原始项 |
| `src/poll.js` | 一轮「拉取 → 合并 → 生成通知 → 投递」+ 定时器（单飞保护） |

```js
import { fetchClasspipeTasks, pollOnce, createPoller } from 'dsh-assistant';

// 跑一轮：只有"变化"才会产生通知
let store = [];
const result = await pollOnce({
  fetchItems: async () => (await fetchClasspipeTasks()).items,
  items: store,
  notify: (text) => console.log('[推给用户]', text), // P3 换成 dsh-im 主动投递
  timeZone: 'America/New_York',
});
store = result.items;

// 定时：每小时查看一次（上一轮没跑完会跳过，不叠加）
const poller = createPoller({
  intervalMs: 60 * 60 * 1000,
  run: async () => { /* 同上的 pollOnce */ },
});
poller.start();
```

## 关键设计（都有单测锁住）

| 规则 | 为什么 |
|---|---|
| **先入库再通知** | 通知失败最多丢一条消息；反过来会丢数据 |
| **只有变化才通知** | 同一份数据第二次拉取是 `unchanged`，否则每小时都收到"还有 2 天截止" |
| **摄取永不复活 done/dropped** | 用户标了完成，再抓一次不能变回未完成 |
| **过期截止不当"新截止"推** | 补发一堆过期 DDL 是噪音 |
| **内容指纹排除 status/revision/时间戳** | 否则用户一改状态就被判成"内容变了" |
| **轮询单飞** | 拉取可能比间隔慢，不保护就会叠加请求把自己打挂 |
| **时区不确定就明说** | 宁可标注"请核对"，也不静默给错时间 |

## 跑测试

```sh
cd packages/dsh-assistant
npm test          # node --test
```

**45 个用例**：幂等、DDL 改期、done 不复活、坏时间降级、提醒不补发/不重发、
classpipe 字段映射与异常（非 200 / success=false / 超时）、轮询单飞。

## 下一步

| 阶段 | 内容 |
|---|---|
| **P2** | DSH 插件外壳：`defineTool` 注册 `assistant.*` 工具 + 文件持久化 + 常驻调度 |
| **P3** | 接 `dsh-im` **主动投递**（`botId + targetId`）→ 手机真收到 |
| P4 | gmail（IMAP 只读）/ outlook（Graph）/ mika（手机执行） |

## 明确不做

- 不做多用户 / 账号体系（单人、本机）
- 不存正文，只存结论与回源链接
- 不让 LLM 解析结构化数据（ICS/API）
- 不自动执行花钱或不可逆操作
