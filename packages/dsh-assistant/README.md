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

## 部署（Docker，推荐 24/7 跑在 Linux 上）

在目标机器（例如 `ubuntu-gpu`）上：

```bash
mkdir -p ~/dsh-assistant/data && cd ~/dsh-assistant
# 1) 放源码（tar 或 git）与凭据
cp telegram.json data/ && chmod 600 data/telegram.json
# 2) 起容器（镜像自带 node:22，不依赖宿主 Node）
docker compose up -d --build
docker compose logs -f
```

前提：**classpipe 在同一台宿主机上**（容器用 `host.docker.internal:8000` 访问）。
classpipe 在别的机器上就改 compose 里 `--classpipe` 的地址。

| 文件 | 作用 |
|---|---|
| `Dockerfile` | `node:22-slim`，只拷 src/scripts/package.json，`/data` 为 volume |
| `docker-compose.yml` | `restart: unless-stopped`；`host.docker.internal` 指向宿主 classpipe；容器日志限 5m×2 |
| `.dockerignore` | 排除 `data/`（凭据）、`test/` |

> **为什么用容器**：目标机自带 Node 18（已 EOL），容器自带运行时，
> 部署不依赖宿主版本，也不和其它项目抢 node。

### 换宿主机 / 更新代码

```bash
cd ~/dsh-assistant
docker compose down
# 覆盖源码后
docker compose up -d --build
```

状态在 `data/state.json`，凭据在 `data/telegram.json` —— 重建容器不丢。

## 关于 classpipe 的同步（重要）

**classpipe 自己没有调度器**（`app/*.py` 里没有 APScheduler / 定时任务），
它只在被调用时同步。所以如果只读 `/canvas/all_tasks`，
读到的永远是"上次有人手动点同步时的快照"。

本守护进程因此**每轮先触发同步**：`GET /courses` → 对每个已有课程
`POST /canvas/courses/{id}/sync` → 再读 `/canvas/all_tasks`。

- 只同步**已导入**的课程，不调 `/import_all`（那个会新建课程）
- 串行执行（Canvas 有速率限制）
- 单课失败不阻断其余
- 默认最多每 **6 小时**同步一次（`--sync-max-age-hours`），可用 `--no-sync` 关掉

实测：13 门课同步 33–47s，事项数从 391 变成 400（真的抓到了新数据）。

## 真跑：单机（Windows / 临时调试）

```sh
# 0) 配凭据（只存在用户目录，不进仓库）
#    ~/.dsh-assistant/telegram.json → {"token":"<bot token>","chatId":"<chat id>"}
node scripts/send-test.mjs        # 连通性自检：能收到就说明链路通

# 1) 先看它会推什么（不需要凭据）
node scripts/run-assistant.mjs --dry --once

# 2) 真跑（自动读上面的凭据）
node scripts/run-assistant.mjs --once

# 3) 常驻，每 45 分钟看一次
node scripts/run-assistant.mjs --interval 45
```

也支持 dsh-im 通道：`--bot-id <botId> --target-id <targetId>`。
优先级：**Telegram 直连 > dsh-im**。

状态落在 `~/.dsh-assistant/state.json`（`--state` 可覆盖）。
日志：`~/.dsh-assistant/run.log`；单实例锁：`~/.dsh-assistant/run.lock`。

## 常驻：Windows 计划任务（推荐）

```powershell
# 安装（每 45 分钟轮询 + 每天 08:00 摘要）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-schedule.ps1

# 立即验证一次
Start-ScheduledTask -TaskName DshAssistant-Poll
Get-Content $env:USERPROFILE\.dsh-assistant\run.log -Tail 10

# 卸载
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Remove
```

| 任务 | 频率 | 命令 |
|---|---|---|
| `DshAssistant-Poll` | 每 45 分钟 | `run-assistant.mjs --once` |
| `DshAssistant-Digest` | 每天 08:00 | `run-assistant.mjs --digest-only` |

**为什么用计划任务而不是常驻进程**：常驻进程关机就没了，而"定时提醒"最怕**悄悄停了**。
计划任务由系统托管、重启后仍在，每轮是独立进程（状态落磁盘，天然可恢复）。

**为什么两个任务**：提醒要高频（45 分钟），摘要要固定时刻（早 8 点）。混在一起会让摘要时间漂移。

### 加固措施（都有实测）

| 机制 | 实测结果 |
|---|---|
| **单实例锁** | 新鲜锁 → `另一个助理进程正在运行，本轮跳过`；31 分钟前的僵死锁 → 自动接管 |
| **文件日志 + 轮转** | 每轮完整写入 `run.log`，超过 1 MiB 轮转到 `.1` |
| **失败告警限频** | classpipe 挂时告诉你，但 6 小时内只吼一次（可 `--alert-cooldown-hours` 调） |

实测计划任务：`LastTaskResult=0`，日志完整记录 `事项 391 → 391（新增 0）… --once 完成`。

### 三个防"劝退/丢消息"的设计

| 机制 | 解决的问题 |
|---|---|
| **首次静默播种** | 第一次启动不会把你这学期全部未到期作业一次性推给你（实测静默导入 391 条） |
| **持久发送队列** | 失败的通知留在队列里下轮重试；否则 Telegram 抖一次，「新截止」就永久丢了（下一轮它已是 unchanged） |
| **补发窗口 12h** | 停机几天后重启，只补最近 12 小时内到点的提醒，不刷屏 |

实测（真实数据）：

```
第 1 次：事项 0 → 391（新增 391）  【首次播种：静默导入，不推送】
第 2 次：事项 391 → 391（新增 0）  提醒计划 35（到期 0）  已发 0 / 待发 0
删掉一条后：新增 1 → [dry] 会推送：🆕 新截止：[OPCA] Potential Topic Considerations  截止 11/4 23:59
```

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
