# 主机健康看门狗（systemd timer）

2026-11-04 事故之后加的：机器积累了 **95,076 个僵尸进程**，耗尽 NPROC，
导致 `sshd` 认证成功却无法 `fork`（`Cannot execute /bin/bash: Resource temporarily unavailable`），
**19 小时无法登录/部署**，而所有业务服务"看起来正常"。

## 它做什么

每 5 分钟检查一次宿主指标，异常时推送 Telegram：

| 指标 | 阈值 |
|---|---|
| 僵尸进程数 | > 1000 |
| 近 10 分钟内核崩溃（traps） | > 100（**先行指标**：崩溃 5 分钟后僵尸才开始堆） |
| 进程总数 | > 20000 |
| 负载（1 分钟） | > 2 × 核数 |
| 可用内存 | < 1 GB |
| 根分区使用率 | > 90% |

- **正常时静默**（不产生任何消息噪音）
- 告警带 **1 小时冷却**，避免刷屏
- 告警里直接给出「僵尸最多的父进程 PPID」和排查命令

## 安装

```bash
# 1) 脚本放到位（仓库里是本文件的同级目录）
install -m 750 packages/dsh-assistant/scripts/host-watchdog.sh ~/dsh-assistant/host-watchdog.sh

# 2) systemd 单元
sudo tee /etc/systemd/system/dsh-host-watchdog.service >/dev/null <<'UNIT'
[Unit]
Description=DSH host health watchdog (zombies/load/mem/disk -> Telegram)
After=network-online.target

[Service]
Type=oneshot
User=taco
ExecStart=/home/taco/dsh-assistant/host-watchdog.sh
UNIT

sudo tee /etc/systemd/system/dsh-host-watchdog.timer >/dev/null <<'UNIT'
[Unit]
Description=Run DSH host health watchdog every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# 3) 启用
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-host-watchdog.timer
```

## 自测

```bash
~/dsh-assistant/host-watchdog.sh --force   # 强制推一条，确认能到 Telegram
systemctl list-timers dsh-host-watchdog.timer
```

## 依赖

- 网关 token：`~/dsh-assistant/data/token.txt`（与 dsh-tg 网关共享，600）
- 推送目标：`http://127.0.0.1:18788/notify`（dsh-tg 网关，本机回环）

## 可覆盖的环境变量

`WATCHDOG_STATE` / `WATCHDOG_TOKEN_FILE` / `WATCHDOG_TG_URL` / `WATCHDOG_COOLDOWN`

## 已知限制

- 阈值是按这台机器（16 核 / 15 GB）定的，换机器要改
- 它只能**发现**僵尸，不能**阻止**；真要根治得找到那个不 `wait()` 的父进程
  （这台机器上还跑着 immich / frigate / scopesentry 等 26 个容器，源头未必在本项目）
