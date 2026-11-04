# Telegram 网关（dsh-tg）

> 状态：**v0.2 已部署在 ubuntu-gpu**（2026-11-03；v0.2 增加普通文本对话转发与 `/ready`）。
> 代码：[`packages/dsh-tg/`](../packages/dsh-tg/README.md) · 上游服务：[`packages/dsh-assistant/`](../packages/dsh-assistant/README.md)

## 1. 为什么单独拆一个服务

维护者要求：**Telegram 链路（入站 + 出站）由独立 agent 维护**，主代理不经办。

拆分前 `dsh-assistant` 既做"数据管线"（Canvas → Item → 提醒计划）又做"投递"（直接调 Bot API）。
拆开后职责单一，也让两边可以独立发布：

| 服务 | 职责 | 维护者 |
|---|---|---|
| `dsh-assistant`（8787） | 数据管线（抓取/去重/提醒，`/items`、`/health`）+ LLM 对话（`/chat`、`/session/check`） | Lead |
| `dsh-tg`（8788） | **唯一**与 Telegram 通信的组件：出站推送 + 入站命令 + 普通文本转发 | tg-agent |

`dsh-tg` **不 import** assistant 的源码（连 `src/notify/telegram.js` 也不 import）：
发送逻辑是复制 + 扩展的（多了 `getUpdates`、429 结构化错误），两个包刻意解耦。

## 2. 网络拓扑

两个容器在同一台机器（ubuntu-gpu），走 **external network `dsh-net`**，用**服务名**互访；
**不发布到 `0.0.0.0`**，所以同网段的其它机器看不到它们。

```
                     ┌─────────────────────────────┐
  Telegram Bot API ◀─┤ dsh-tg (container_name)     │
        ▲  │         │   dsh-net 内监听 :8788       │
        │  │         └──────────┬──────────────────┘
        │  │                    │ /items /chat /session/check
        │  └── 长轮询 getUpdates │  x-dsh-token
        │                       ▼
        │          ┌─────────────────────────────┐
        └──────────┤ dsh-assistant (:8787)       │
           sendMessage│ 数据管线 + LLM 对话（Lead） │
                     └─────────────────────────────┘
```

| 方向 | 调用 |
|---|---|
| tg → assistant | `http://dsh-assistant:8787`（env `ASSISTANT_BASE_URL`） |
| assistant → tg | `http://dsh-tg:8788/notify`（share 同一 token 文件） |
| 宿主手工调试 | `127.0.0.1:18788`（仅回环发布，容器间互访不依赖它） |
| assistant 手工调试 | `127.0.0.1:18787`（Lead 配置） |

`dsh-assistant` 的提醒推送不再直连 Bot API，改为 `POST http://dsh-tg:8788/notify`。

## 3. 凭据与鉴权

| 文件（容器内） | 来源（宿主） | 内容 |
|---|---|---|
| `/data/telegram.json` | `~/dsh-assistant/data/telegram.json`（**只读挂载**） | `{token, chatId, ...}`；本服务只读 `token`/`chatId` |
| `/data/api-token.txt` | `~/dsh-assistant/data/token.txt`（**只读挂载**） | assistant ↔ tg 共享密钥 |
| `/state/tg-state.json` | `~/dsh-tg/state/tg-state.json`（可写） | offset + 告警限频时间戳 |
| `/state/seq.json` | `~/dsh-tg/state/seq.json`（可写） | 「序号 → item.id」映射（`/done` 用） |

- 请求头 `x-dsh-token: <共享密钥>`；不匹配一律 **401**（常量时间比较）
- 凭据 **绝不**进仓库/镜像/日志：日志里 token 只出现 `907260…huVc` 这种掩码
- 轮换 bot token：改 `~/dsh-assistant/data/telegram.json` → 重启 `dsh-tg` 容器即可（两边共用同一文件，不会不一致）

## 4. HTTP 契约

### `GET /health`（免鉴权）

存活 + 轮询健康度，**不含任何凭据原文**：

```json
{
  "ok": true,
  "service": "dsh-tg",
  "version": "0.1.0",
  "pid": 1,
  "startedAt": "2026-11-03T19:29:39.545Z",
  "uptimeSec": 5,
  "offset": 170186104,
  "lastPollOkAt": "2026-11-03T19:29:39.898Z",
  "lastUpdateAt": "2026-11-03T19:29:40.369Z",
  "lastError": null,
  "poller": {
    "running": true,
    "consecutiveFailures": 0,
    "stale": false,
    "pollTimeoutSec": 30,
    "heartbeatStaleMs": 300000
  },
  "bot": { "tokenMasked": "907260…huVc", "chatId": "6413978793" },
  "assistant": { "baseUrl": "http://dsh-assistant:8787" }
}
```

`stale=true` 表示"距最近一次 `getUpdates` 成功已超过 `HEARTBEAT_STALE_MS`"，**与用户是否发消息无关**。

### `POST /notify`（需 `x-dsh-token`）

请求：

```json
{ "text": "提醒正文", "format": "plain", "meta": { "kind": "reminder" } }
```

- `text`：必填，≤ 4096 字符（Bot API 上限）
- `format`：`plain`（默认）| `markdown`（parse_mode=Markdown）| `markdownv2`
- `meta`：可选，只用于日志（不落盘）

成功：`200 {"ok":true,"messageId":19,"chatId":6413978793}`

失败（结构化，含 Telegram 的 `description` / `retry_after`）：

| HTTP | 场景 | 返回 `error` |
|---|---|---|
| 400 | 缺 text / text 过长 / format 非法 / body 非 JSON | `{code, message}` |
| 401 | token 错/缺 | `{code:"unauthorized"}` |
| 413 | body > 64 KB | `{code:"payload_too_large"}` |
| 429 | Telegram 限流 | `{kind:"rate_limited", retryAfter:5, telegramStatus:429, description}` |
| 502 | Telegram 其它错误（如 bot 被封 403） | `{kind:"api", telegramStatus:403, description}` |

## 5. 入站命令

| 命令 | 行为 |
|---|---|
| `/next` | 最近 **5** 个未完成截止（顺序由 assistant 给，**本服务不重排**） |
| `/list [n]` | 未完成清单，默认 10、最多 50；超时区/无截止/过期都有明确文案 |
| `/done <序号>` | 把**上一次 `/list`/`/next` 回复里**的第 N 项标记完成 |
| `/ready` | 登录 noVNC 后确认会话是否恢复（调 assistant `POST /session/check`） |
| `/status` | tg 运行时（运行时长/长轮询/offset/最近错误）+ assistant 可达性（`open`/`pending`/延迟） |
| `/help` | 帮助 |
| **普通文本** | **转发 assistant `POST /chat` 做对话**（LLM/上下文/历史都在 assistant 侧） |

### `/done` 的序号语义（重要）

序号是**展示序号**，只在最近一次 `/list` / `/next` 回复里有效。
每次回复时把「序号 → item.id」写入 `/state/seq.json`，重启后仍能解析：
`{ "version":1, "at":"...", "source":"list", "items": { "1": {"id":"canvas:assignment:123","title":"..."} } }`。

- 每次 `/list` / `/next` **整体覆盖**映射
- `/done N` 找不到映射时明确要求"先 /list"，**不猜**
- assistant 返回 404（事项已被删）时提示刷新，而不是静默成功

### assistant 接口（按 Lead 契约调用）

```http
GET  /items?status=open&limit=50      → {ok:true, count:N, items:[...]}
POST /items/{id}/status {"status":"done"} → {ok:true, id, status}
GET  /health                          → {ok:true, items, open, pending, lastTickAt, lastSyncAt}
POST /chat {"text":"..."}             → {ok:true, reply, usage}     （DeepSeek，P50 2-5s，长回复 20s+）
POST /session/check {}                → {ok:true, needsUser, reason, okSince}
```

⚠️ `count` 是**本次返回条数**（实测 limit=5 → count=5，而 `/health.open` 是 301），
所以回复里不写"共 N 条未完成"，只写"显示 N 条"。

`id` 形如 `canvas:assignment:123`，路径里的 `:` 保持字面量（只转义其它字符）。

### 对话：普通文本 → `POST /chat`

本服务对对话是**无状态转发**：不存聊天内容、不拼上下文、不接触模型 key
（DeepSeek 的 key 由 assistant 从 `/data/llm.json` 读，本服务既读不到也不记日志）。

| 情况 | 行为 |
|---|---|
| 成功 | 把 `reply` 发回用户；日志只记**输入/回复长度与耗时**，不记内容 |
| `reply` 为空 | 回「🤖 对话服务返回了空回复，请再试一次。」（不静默） |
| 长回复 | `reply` 超过 **4000** 字符时按**换行**切分，分多条发送（硬切时避开 emoji 代理对） |
| 超时 | `CHAT_TIMEOUT_MS`（默认 **60s**）超时 → 「对话服务暂时不可用（等待超时…）」 |
| assistant 502 | 「对话服务暂时不可用（原因…）」；原因取自返回体的 `error` |
| assistant 503 | 「对话服务暂时不可用（后台未启用：…）」 |
| assistant 不可达 | 「对话服务暂时不可用（assistant 不可达）」，引导看 `/status` |

对话请求用独立的超时（`CHAT_TIMEOUT_MS`），不影响 `/items`、`/status` 之类的短请求（`ASSISTANT_TIMEOUT_MS`）。

### `/ready`：登录后立即确认会话

维护者登录 noVNC 后发 `/ready`，本服务**立刻**调 assistant `POST /session/check`（不等 15 分钟巡检）：

- `needsUser:false` → 「✅ 已登录，会话正常」（有 `okSince` 时附带时间）
- `needsUser:true` → 「⚠️ 仍未登录（reason=xxx），请完成登录后再发 /ready。」
- 调用失败 → 「检查登录状态失败：…」，引导看 `/status`

## 6. 稳定性机制

| 机制 | 实现 | 为什么 |
|---|---|---|
| **offset 持久化** | 每处理完一条 update 就 `offset = update_id + 1` 落盘（原子 rename） | 重启不重复回复历史消息；最坏情况是重复一次而不是漏消息 |
| **指数退避** | 1s → 2s → 4s …（`BACKOFF_BASE_MS`/`BACKOFF_MAX_MS` 可配） | 网络抖动/服务端 5xx 时不要打满 Telegram |
| **429 遵从 retry_after** | 等 `retry_after*1000 + 250ms`，不走退避 | 违反只会被继续限流 |
| **心跳告警** | 只看"距最近一次 `getUpdates` 成功"是否超过 `HEARTBEAT_STALE_MS`（默认 5 分钟）；告警按 `ALERT_THROTTLE_MS`（默认 30 分钟）限频 | 用户不发消息是正常的，不能用"没消息"判断故障 |
| **鉴权/冲突告警** | 401/403、409（另一个实例在轮询）立即告警一次并限频 | 这两类不会自愈，需要人处理 |
| **单条失败不毒死循环** | 处理/回复异常只记日志，offset 仍前进 | 避免同一条消息无限重放 |
| **对话超时独立** | `/chat` 用 `CHAT_TIMEOUT_MS`（默认 60s），其余请求 10s | 模型长回复不该拖垮短查询，也不该被短超时误杀 |
| **可中断 sleep** | SIGTERM 时中断在途长轮询 + 退避等待（上限 15s 强制退出） | `docker restart` 不用等满一个退避窗口 |

## 7. 配置项

| env | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8788` / `0.0.0.0` | 容器内监听 |
| `TELEGRAM_CONFIG` | `/data/telegram.json` | bot 凭据文件 |
| `SHARED_TOKEN_FILE` / `SHARED_TOKEN` | `/data/api-token.txt` | 共享密钥（文件优先，env 覆盖） |
| `STATE_FILE` | `/data/tg-state.json` | offset + 告警时间戳（compose 里是 `/state/tg-state.json`） |
| `SEQ_FILE` | `/data/seq.json` | 序号映射（compose 里是 `/state/seq.json`） |
| `ASSISTANT_BASE_URL` | `http://127.0.0.1:8787` | 生产为 `http://dsh-assistant:8787` |
| `ASSISTANT_TOKEN` | 复用共享密钥 | 一般不用设 |
| `ASSISTANT_TIMEOUT_MS` | `10000` | items/health/session 等短请求超时 |
| `CHAT_TIMEOUT_MS` | `60000` | 对话请求超时（5s..180s；DeepSeek 长回复可能 20s+） |
| `POLL_TIMEOUT_SEC` | `30` | 长轮询秒数（1..60） |
| `HEARTBEAT_STALE_MS` | `300000` | 多久没成功轮询就告警 |
| `ALERT_THROTTLE_MS` | `1800000` | 同类告警最小间隔 |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | `1000` / `60000` | 指数退避 |
| `TG_TIMEZONE` | `America/New_York`（回退 `TZ`） | 回复里的时间显示 |
| `LOG_LEVEL` | `info` | `error|warn|info|debug` |

## 8. 部署（ubuntu-gpu）

```bash
# 1. 一次性：网络与状态目录
docker network create dsh-net      # 已由 Lead 创建；存在则跳过
mkdir -p ~/dsh-tg/state && chmod 700 ~/dsh-tg/state

# 2. 上传源码（从 Windows）
#    打包：tar -czf dsh-tg.tar.gz -C packages/dsh-tg package.json Dockerfile docker-compose.yml .dockerignore README.md src scripts
#    上传后：tar -xzf /tmp/dsh-tg.tar.gz -C ~/dsh-tg

# 3. 构建并启动
cd ~/dsh-tg
docker compose up -d --build
docker compose logs -f
```

compose 已经配好（见 [`docker-compose.yml`](../packages/dsh-tg/docker-compose.yml)）：

- `networks: [dsh-net]`（external）
- 只读挂载 assistant 的 `telegram.json` 与 `token.txt`
- `./state:/state` 可写
- `user: "1001:1001"` —— **ubuntu 上的 `taco` 是 uid/gid 1001**（不是 node 镜像默认的 1000），
  否则读不了 600 权限凭据、也写不了 `/state`
- `ports: 127.0.0.1:18788:8788` 仅本机回环调试用
- `restart: unless-stopped`

## 9. 验证（真实命令）

```bash
# 存活（宿主回环）
curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:18788/health

# 鉴权失败 → 401（用错 token）
curl -s -X POST http://127.0.0.1:18788/notify \
  -H 'content-type: application/json' -H 'x-dsh-token: wrong' \
  -d '{"text":"x"}'

# 真实出站推送（token 从文件读，绝不打印）
TOKEN=$(cat ~/dsh-assistant/data/token.txt)
curl -s -X POST http://127.0.0.1:18788/notify \
  -H 'content-type: application/json' -H "x-dsh-token: $TOKEN" \
  -d '{"text":"dsh-tg 验证消息"}'

# 入站命令 + 对话转发的冒烟（合成 update；最后一条普通文本会真实调 /chat 一次）
docker exec dsh-tg node scripts/smoke-commands.mjs

# 容器间连通性（可选，等价于 /status 做的事）
docker exec dsh-tg node --input-type=module -e "
const t = (await import('node:fs')).readFileSync('/data/api-token.txt','utf8').trim();
console.log(await (await fetch('http://dsh-assistant:8787/health')).json());"
```

真实验证记录（2026-11-03 v0.1、2026-11-04 v0.2，ubuntu-gpu）：

```
$ curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:18788/health
{"ok":true,"service":"dsh-tg","version":"0.2.0",...,"poller":{"running":true,"consecutiveFailures":0,"stale":false,...},"bot":{"tokenMasked":"907260…huVc",...}}
HTTP 200

$ curl ... -H 'x-dsh-token: definitely-wrong' ...
{"ok":false,"error":{"code":"unauthorized","message":"无效或缺失的 x-dsh-token"}}
HTTP 401

$ curl ... -H "x-dsh-token: $(cat .../token.txt)" -d '{"text":"✅ dsh-tg 部署验证..."}'
{"ok":true,"messageId":19,"chatId":6413978793}
HTTP 200
```

v0.2 对话转发 + `/ready` 的真实冒烟（`docker exec dsh-tg node scripts/smoke-commands.mjs`）：

```
===== /ready =====
⚠️ 仍未登录（reason=blocked），请完成登录后再发 /ready。

===== 用一句话说我现在最急的事是什么？ =====
最急的是明天23:59截止的 [OPCA] Potential Topic Considerations（TLIELP 5050）。

[smoke] OK：全部命令都产生了回复（/chat 之外均只读，未改动真实数据）
```

## 10. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `/health` 一直是 `stale:true`、日志有 `getUpdates 失败` | 查 `/data/telegram.json` 的 token 是否被 revoke；看日志里的 HTTP 状态 |
| `/health` 返回 401/403 告警 | token 无效 → 改 `telegram.json` 后 `docker compose restart` |
| 409 Conflict 告警 | 同一个 bot token 有第二个长轮询实例（例如旧的 `dsh-assistant` 直连投递进程还在跑）→ 只保留一个 |
| `/status` 里 assistant ❌ 不可达 | `docker network inspect dsh-net` 看两个容器是否都在；容器名必须是 `dsh-assistant` |
| `/notify` 返回 502 + `bot was blocked` | 维护者在 Telegram 里 block 了 bot，或 chatId 不对 |
| `/notify` 返回 429 | 等 `retryAfter` 秒；调用方（assistant）应尊重该字段 |
| `/done` 说"找不到第 N 项" | 序号只在最近一次 `/list`/`/next` 后有效；重启后 seq.json 仍在，但如果清单被重新分配过就按最近的来 |
| 对话回「暂时不可用（后台未启用…）」 | assistant 侧 `/chat` 返回 503：检查 assistant 的 `/data/llm.json`（key 由 Lead 维护，本服务不碰） |
| 对话很慢或超时 | 看 assistant 日志里的 DeepSeek 耗时；必要时调大 `CHAT_TIMEOUT_MS`（上限 180s） |
| `/ready` 一直回「仍未登录（reason=blocked）」 | noVNC 登录未完成/被拦；重新登录后再发 `/ready`，不要等巡检 |
| 长回复只收到一部分 | 本服务按 4000 字符切分；若第二条没到，查容器日志里是否有 Telegram 发送失败 |
| 容器起不来、日志 `共享密钥缺失` | `~/dsh-assistant/data/token.txt` 不存在或权限不对（容器以 uid 1001 运行） |
| 端口被占 | 8787/8788 在宿主上已被 `artex` 占用；本服务**不发布**这两个宿主端口，只用 18788 回环调试 |

## 11. 测试

```bash
cd packages/dsh-tg
node --test
```

- 零依赖、纯 ESM、`node:test`
- 覆盖：命令解析、offset 持久化、429/超时、鉴权失败、`/done` 调不通、心跳告警限频、HTTP 契约、
  对话转发（成功/空回复/502/超时/不可达）、长回复切分（换行优先、emoji 安全）、`/ready` 两态、`/session/check` 失败
- 全部用 fake `fetch` / fake updates，不访问真实 Telegram / DeepSeek

## 12. 已知限制（v0.2）

- **对话是无状态转发**：本服务不存聊天内容、不做上下文裁剪；历史与窗口都由 assistant 维护
- 长回复切分**不加「第 N 条」标记**（保持模型原本的 Markdown 结构）；如果分条顺序在客户端错乱，
  可改成带序号前缀，但会牺牲一点排版
- 展示层**不合并**同标题同截止的重复项：那是 classpipe 里两条不同 `canvas_id` 的记录，
  合并显示会让 `/done` 的序号指向变得含糊；回写也必须按 id 逐条
- `count` 语义以 assistant 实际返回为准（见 §5）
- 入站命令与对话的"真实用户消息"只能由维护者从 Telegram 发；自动化覆盖合成 update + 单测 + 真实 `/chat` 冒烟

## 13. 相关文档

- [部署与运维（ubuntu-gpu）](UBUNTU-DEPLOYMENT.md)
- [个人助理数据管线](ASSISTANT.md)
- 代码：[`README.md`](../packages/dsh-tg/README.md)
