#!/usr/bin/env bash
# 主机健康看门狗：僵尸进程 / 进程数 / 负载 / 内存 / 磁盘异常时推送 Telegram。
#
# 为什么需要（2026-11-04 真实事故）：
#   这台机器累积了 **95,076 个僵尸进程**，耗尽 NPROC 配额，导致
#   sshd **认证成功却无法 fork**：
#       Cannot execute /bin/bash: Resource temporarily unavailable
#   后果：整整 19 小时无法登录、无法部署，而 classpipe / noVNC / Telegram bot
#   全都"看起来正常" —— 因为它们是早已在跑的进程，不需要新建进程。
#   监控必须看**进程表健康**，而不只是"服务还活着没"。
#
# 用法：
#   ./host-watchdog.sh            # 正常巡检（异常才推送，1 小时冷却）
#   ./host-watchdog.sh --force    # 强制推送一条（部署后自测用）
#
# 阈值（按 16 核 / 15GB 机器定，换机器记得改）：
#   僵尸 > 1000     进程数 > 20000     负载 > 2×核数
#   可用内存 < 1GB  根分区 > 90%
set -uo pipefail

STATE_FILE="${WATCHDOG_STATE:-$HOME/.dsh-host-watchdog.last}"
TOKEN_FILE="${WATCHDOG_TOKEN_FILE:-$HOME/dsh-assistant/data/token.txt}"
TG_URL="${WATCHDOG_TG_URL:-http://127.0.0.1:18788/notify}"
COOLDOWN="${WATCHDOG_COOLDOWN:-3600}"
FORCE="${1:-}"

zombies=$(ps -eo stat --no-headers 2>/dev/null | grep -c '^Z' || true)
procs=$(ps -e --no-headers 2>/dev/null | wc -l)
load1=$(cut -d' ' -f1 /proc/loadavg)
memavail=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
disk=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
cores=$(nproc)

problems=()
[ "${zombies:-0}" -gt 1000 ] && problems+=("僵尸进程 ${zombies}（阈值 1000）")
[ "${procs:-0}" -gt 20000 ] && problems+=("进程总数 ${procs}（阈值 20000）")
[ "$(awk -v l="$load1" -v c="$cores" 'BEGIN{print (l>c*2)?1:0}')" = "1" ] && problems+=("负载 ${load1}（${cores} 核）")
[ "${memavail:-9999}" -lt 1024 ] && problems+=("可用内存仅 ${memavail}MB")
[ "${disk:-0}" -gt 90 ] && problems+=("根分区 ${disk}%")

# 一切正常且不是强制模式 → 静默退出（不产生噪音）
if [ ${#problems[@]} -eq 0 ] && [ "$FORCE" != "--force" ]; then exit 0; fi

now=$(date +%s)
last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
if [ "$FORCE" != "--force" ] && [ $((now-last)) -lt "$COOLDOWN" ]; then exit 0; fi
echo "$now" > "$STATE_FILE"

# 顺手把"谁在制造僵尸"找出来，省掉人工再查一遍
zparent=$(ps -eo ppid,stat --no-headers 2>/dev/null | awk '$2 ~ /Z/ {print $1}' | sort | uniq -c | sort -rn | head -1)

text="⚠️ $(hostname) 主机健康告警"
for p in "${problems[@]}"; do text+=$'\n'"· $p"; done
if [ ${#problems[@]} -eq 0 ] && [ "$FORCE" = "--force" ]; then
  text+=$'\n'"· （强制测试推送，指标正常）"
fi
if [ -n "${zparent:-}" ]; then text+=$'\n'"· 僵尸最多的父进程：$zparent"; fi
text+=$'\n\n'"排查僵尸：ps -eo ppid,stat,comm | awk '\$2 ~ /Z/ {print \$1}' | sort | uniq -c | sort -rn | head"

token=$(cat "$TOKEN_FILE")
body=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "format": "plain"}, ensure_ascii=False))' "$text")
curl -sS -m 10 -X POST "$TG_URL" -H "content-type: application/json" -H "x-dsh-token: $token" -d "$body" >/dev/null
