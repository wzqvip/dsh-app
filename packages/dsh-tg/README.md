# dsh-tg（Telegram 网关）

> 状态：**v0.2.1 已部署 ubuntu-gpu**（入站命令 + 出站推送 + 普通文本对话转发，对话超时 10 分钟）。
> 契约 / 部署 / 排错见 [docs/TELEGRAM-GATEWAY.md](../../docs/TELEGRAM-GATEWAY.md)。

## 它是什么

DSH 里**唯一**与 Telegram 通信的组件：

```
                    ┌──────────────────────────────┐
  用户 ──消息───▶   │  dsh-tg (container, :8788)    │
   ▲                │  长轮询 getUpdates            │
   └──回复───────── │  命令解析 / 普通文本转发      │
                    └──────────┬───────────────────┘
                               │ GET /items, POST /items/{id}/status
                               │ POST /chat, POST /session/check
                               ▼  (x-dsh-token)
                    ┌──────────────────────────────┐
                    │  dsh-assistant (:8787)        │
                    │  数据管线 + LLM 对话（Lead）   │
                    └──────────────────────────────┘
```

- **出站**：`POST /notify {text, format?}` → Bot API `sendMessage`（assistant 的提醒改调这里）
- **入站**：`getUpdates` 长轮询 → `/next` `/list` `/done` `/ready` `/status` `/help`
- **对话**：普通文本**无状态转发**到 assistant 的 `POST /chat`；LLM/上下文/历史都在 assistant 侧，
  本服务不保存聊天内容。超时默认 **10 分钟**（工具轮次放开后可能跑几分钟），
  超过 3s 未返回会先发「正在处理」；超长回复按换行切成多条（Telegram 单条 4096 上限）
- 稳定性：offset 落盘、指数退避、遵从 429 `retry_after`、心跳异常限频告警

## 跑测试

```sh
cd packages/dsh-tg
node --test
```

零依赖、零 build；测试用 fake fetch，不碰真实 Telegram/assistant。

## 部署

```sh
# ubuntu-gpu
cd ~/dsh-tg
docker compose up -d --build
docker compose logs -f
```

详细步骤（网络、凭据挂载、验证命令、排错）见 [docs/TELEGRAM-GATEWAY.md](../../docs/TELEGRAM-GATEWAY.md)。
