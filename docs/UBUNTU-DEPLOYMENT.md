# ubuntu-gpu 部署与运维

> 2026-11-03 起，个人助理与 classpipe 都跑在 `ubuntu-gpu`（Ubuntu 24.04 / Docker）。
> Windows 那份 classpipe **保留不动**，作为**开发环境**：功能在 Windows 改 → push →
> ubuntu `git pull` 并重建容器。数据库以 **ubuntu 为准**（之后都在 ubuntu 上改作业）。

## 拓扑

```
Windows（开发）                       ubuntu-gpu 192.168.3.30（运行）
├─ classpipe 源码（改功能）            ├─ ~/classpipe（git 仓库，拉代码）
├─ 推送到 GitHub                       │    └─ data/（DB + .app_secret，gitignored）
└─ 可选：本地跑一份验证                ├─ ~/classpipe-deploy（compose + 脚本，不在仓库里）
                                       │    ├─ docker-compose.yml（classpipe:8000）
                                       │    ├─ sync.sh（备份 → pull → 重建 → 体检）
                                       │    └─ backup.sh（每日备份）
                                       ├─ ~/dsh-assistant（compose，assistant 容器）
                                       │    └─ data/（telegram.json / token.txt / state.json / run.log）
                                       └─ ~/dsh-tg（compose，tg 容器，接 dsh-net）
                                            └─ state/（offset / 序号映射）
```

> Telegram 链路由独立的 `dsh-tg` 容器负责（入站命令 + 出站推送），
> 与 `dsh-assistant` 通过 external network `dsh-net` 用服务名互访，不发布到局域网。
> 契约、部署与排错见 [TELEGRAM-GATEWAY.md](TELEGRAM-GATEWAY.md)。

## 访问方式

| 场景 | 地址 |
|---|---|
| 局域网 | `http://192.168.3.30:8000` |
| Tailscale（登录后） | `http://100.121.250.110:8000` 或 `http://ubuntu-gpu:8000` |
| 仅本机 | `http://127.0.0.1:8000` |

> 主机防火墙 `ufw` 是 **inactive**，端口 8000 已监听 `0.0.0.0`。
> ⚠️ 这意味着**同一局域网内任何人都能访问 classpipe**（它没有登录，会直接暴露
> 你的课程数据、批改记录，以及能调 Canvas 的操作）。若房间/网络不可信，
> 建议：只绑 Tailscale（`ports: ["100.121.250.110:8000:8000"]`）或加 `ufw` 白名单。

## 日常操作（都在 ubuntu 上）

```bash
# 更新代码 + 重建（在 Windows push 之后）
~/classpipe-deploy/sync.sh

# 只备份数据库
~/classpipe-deploy/backup.sh

# 看状态 / 日志
cd ~/classpipe-deploy && docker compose ps
docker compose logs --tail 50

# 助理
cd ~/dsh-assistant && docker compose logs --tail 30

# Telegram 网关（入站命令 + 出站推送）
cd ~/dsh-tg && docker compose logs --tail 30
```

`sync.sh` 做的事情（按顺序）：备份 DB+密钥 → `git pull --ff-only` → `compose up -d --build`
→ `/health` 与 `/canvas/all_tasks` 体检。**数据不会丢**：`data/` 是 gitignored 且挂 volume。

## 备份

- `sync.sh` 每次更新前自动备份一份
- **systemd timer** 每日 04:10 备份（`classpipe-backup.timer`），保留最近 14 份
- 位置：`~/classpipe/data/backups/classpipe-<时间戳>.tgz`
- ⚠️ 备份里含 **`.app_secret`**（解密 Canvas token 的密钥）—— 不要提交、不要外传

## 一次性配置（若换机器/重装）

1. **部署密钥**：`~/.ssh/classpipe_deploy`，公钥需加到 GitHub 仓库 `Settings → Deploy keys`
   （只读即可）。`~/.ssh/config` 里 `Host github-classpipe` 指向这把 key。
2. **classpipe 数据**：把 Windows 的 `data/classpipe.db` **和** `data/.app_secret`
   **成对**拷贝过来 —— 少了密钥，DB 里的 Canvas token 解不开。
3. **助理凭据**：`~/dsh-assistant/data/telegram.json`（`chmod 600`）与
   `~/dsh-assistant/data/token.txt`（`chmod 600`，assistant ↔ tg 共享密钥）。
   `dsh-tg` 把这两个文件**只读挂载**进容器，不各自存一份。

## Node 版本

宿主 Node 已从 18.19.1（EOL）升到 **22.23.4**（NodeSource 22.x）。
但两个服务都在容器里跑，宿主 Node 版本不影响它们。

## 与 Windows 那份的关系

| | Windows | ubuntu |
|---|---|---|
| 角色 | **开发**（改功能、验证） | **运行 + 数据（权威）** |
| classpipe DB | 保留旧数据，**不再使用** | 之后所有批改都在这里 |
| 助理 | 计划任务已卸载 | 容器常驻 |

> 两份 DB 从今天起会**分叉**。要以某一台为准，另一台就不要再写数据。
