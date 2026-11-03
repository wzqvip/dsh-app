# dsh-tg（Telegram 网关）

> 状态：**v0.1 本地完成、已部署 ubuntu-gpu**（入站命令 + 出站推送；本轮不做 LLM 对话）。
> 契约 / 部署 / 排错见 [docs/TELEGRAM-GATEWAY.md](../../docs/TELEGRAM-GATEWAY.md)。

## 它是什么

DSH 里**唯一**与 Telegram 通信的组件：

```
                    ┌──────────────────────────────┐
  用户 ──消息───▶   │  dsh-tg (container, :8788)    │
   ▲                │  长轮询 getUpdates            │
   └──回复───────── │  解析 /next /list /done ...   │
                    └──────────┬───────────────────┘
                               │ GET /items, POST /items/{id}/status
                               ▼  (x-dsh-token)
                    ┌──────────────────────────────┐
                    │  dsh-assistant (:8787)        │
                    │  数据管线（Lead 维护）         │
                    └──────────────────────────────┘
```

- **出站**：`POST /notify {text, format?}` → Bot API `sendMessage`（assistant 的提醒改调这里）
- **入站**：`getUpdates` 长轮询 → 命令解析 → 回复
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
