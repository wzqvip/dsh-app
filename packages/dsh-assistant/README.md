# dsh-assistant（个人助理 · P0 数据层）

> 状态：**P0** —— 只有数据层（纯函数 + 单测），**还不是 DSH 插件**。
> 设计见 [docs/ASSISTANT.md](../../docs/ASSISTANT.md) · 分支 `feat/personal-assistant`

## 这个东西要解决什么

现在的 DSH 是**开发者工具**：你发起任务，它在会话里干完，结束。

个人助理要的是**常驻**：主动盯着课程/邮件/日程，该提醒时通过 IM 找到你。
差别不在"更聪明"，而在**触发方式（时间/事件发起）、记忆（跨会话）、输出（推到手机）**。

## 为什么先只做数据层

整个产品的正确性几乎全压在三件事上：

1. 同一份来源**重复摄取**不能重复插入
2. 用户标了 `done` 的事项**不能被下一次抓取复活**
3. 提醒**重启后不能重发**

这三件都能用纯函数表达、也都能脱离 DSH 单测。先把它们钉死，再接 ICS、再接插件外壳
—— 否则就会在宿主进程里调试业务逻辑，那是最慢的调试方式。

## 当前 API

```js
import { mergeItems, planReminders, setStatus, reminderText } from 'dsh-assistant';

// 1) 幂等合并：同一份数据重复喂进来，第二次是 unchanged
let { items, result } = mergeItems([], [
  {
    source: 'canvas', kind: 'assignment', sourceId: '12345',
    title: 'Essay #2', course: 'CSE 2231',
    dueAt: '2026-11-09T04:59:00Z',
    url: 'https://canvas.example/courses/1/assignments/12345',
  },
]);
// result => { inserted: ['canvas:assignment:12345'], updated: [], unchanged: [], rejected: [] }

// 2) 用户完成：唯一允许改 status 的入口
items = setStatus(items, 'canvas:assignment:12345', 'done');

// 3) 排提醒：T-3d / T-1d / T-4h，已过去的不补发
const plan = planReminders(items, { now: new Date() });
console.log(reminderText(plan[0]));
```

| 模块 | 内容 |
|---|---|
| `src/items.js` | `Item` 归一化、内容指纹、幂等合并、状态流转 |
| `src/reminders.js` | 递减提醒计划、去重键、到期筛选、文案 |
| `src/index.js` | 公开 API |

## 跑测试

```sh
cd packages/dsh-assistant
npm test          # 等价于 node --test
```

当前 **23 个用例全绿**，覆盖：幂等、DDL 变更、状态不被复活、坏时间降级、
提醒不补发/不重发、时区不确定告警。

## 下一步（见 docs §8）

- **P1** Canvas ICS 解析（含 Windows 时区名降级 → `tzUncertain`）
- **P2** DSH 插件外壳：`defineTool` 注册 `assistant.*` 工具 + 文件持久化 + 常驻调度
- **P3** 接 `dsh-im` 主动投递 → 手机真收到

## 明确不做

- 不做多用户 / 账号体系（单人、本机）
- 不存正文，只存结论与回源链接
- 不让 LLM 解析结构化数据（ICS/API）
- 不自动执行花钱或不可逆操作
