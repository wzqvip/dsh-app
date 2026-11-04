#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# dsh-browser 容器入口：Xvfb + x11vnc + noVNC + headed Chromium + Node 服务
#
# 为什么是 shell 脚本而不是 supervisord：
#   只需要"按顺序起来 + Chromium 崩了自动重启 + 收到信号时体面收尾"这三件事，
#   多装一个进程管理器等于多一份要维护的配置。
#
# 进程与端口（都在容器内，只有 6080 会被 compose publish 出去）：
#   Xvfb :99              虚拟屏（默认 1440x900x24）
#   x11vnc 127.0.0.1:5900 把虚拟屏变成 VNC，**只监听回环**，只有本机 websockify 能连
#   websockify 0.0.0.0:6080  noVNC 静态页 + WS 桥（对外唯一入口）
#   chromium :9222        headed 浏览器，CDP 只监听回环（Playwright 从本机连）
#   node   :8789          HTTP API（接 dsh-net，不发布）
#
# ⚠️ 三个实测踩过的坑（改这个文件前先读）：
#   1. HOME 必须是**容器内可写目录**。docker 用 `user: 1001:1001` 跑镜像里没有的
#      uid 时会把 HOME 设成 `/`，Chromium 写不了 crashpad 库就 SIGTRAP 崩溃，
#      日志里只有一句 `chrome_crashpad_handler: --database is required`。
#      所以这里强制 HOME=/tmp/...，绝不用 `${HOME:-…}`。
#   2. 容器**重启**会保留 /tmp，上次被 SIGKILL 的 Xvfb 会留下 `/tmp/.X99-lock`，
#      新 Xvfb 报 "Server is already active for display 99" 然后进重启死循环。
#      所以启动前先清锁，并在收到 SIGTERM 时把子进程收干净。
#   3. profile 里的 `SingletonLock` 记着 hostname；容器重建后 hostname 变化
#      会被判成"另一台电脑正在用这个 profile"而拒绝启动。每次启动前清掉。
# ─────────────────────────────────────────────────────────────────────────────
set -eu

export DISPLAY="${DISPLAY:-:99}"
DISPLAY_NUM="${DISPLAY#:}"
SCREEN="${SCREEN_GEOMETRY:-1440x900x24}"
PROFILE_DIR="${PROFILE_DIR:-/profile}"
CDP_PORT="${CDP_PORT:-9222}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
BROWSER_LANG="${BROWSER_LANG:-en-US}"
START_URL="${START_URL:-about:blank}"
STOP_FILE=/tmp/dsh-browser-stop

log() { printf '[entrypoint] %s\n' "$*" >&2; }

export HOME="${DSH_BROWSER_HOME:-/tmp/dsh-browser-home}"
mkdir -p "$HOME" "$PROFILE_DIR"

# X 客户端要往 /tmp/.X11-unix 里找 socket；非 root 的 Xvfb 不会自己建这个目录
mkdir -p /tmp/.X11-unix 2>/dev/null || true

rm -f "$STOP_FILE"

# ── 1. Xvfb ──────────────────────────────────────────────────────────────────
# 上次异常退出留下的锁（容器重启保留 /tmp）会让 Xvfb 直接拒绝启动
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
log "启动 Xvfb（${DISPLAY} ${SCREEN}）"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -nolisten tcp -ac &
XVFB_PID=$!

# 等 X 真的能接受连接（只看 socket 文件不够：Xvfb 先建 socket 再初始化）
waited=0
while :; do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    log "Xvfb 就绪（${DISPLAY}）"
    break
  fi
  waited=$((waited + 1))
  if [ "$waited" -gt 100 ]; then
    log "Xvfb 起不来（等了 20s，${DISPLAY} 连不上）"
    exit 1
  fi
  sleep 0.2
done

# ── 2. x11vnc（只监听回环）──────────────────────────────────────────────────
if [ -n "${VNC_PASSWORD:-}" ]; then
  # x11vnc 的 RFB 密码走 DES，**最多 8 字符**，超出部分会被静默忽略
  mkdir -p /tmp/x11vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/x11vnc/passwd >/dev/null 2>&1
  # shellcheck disable=SC2086  # 故意让 "-rfbauth <path>" 分词
  VNC_AUTH="-rfbauth /tmp/x11vnc/passwd"
  log "VNC 密码已启用（注意：RFB 密码最长 8 字符）"
else
  VNC_AUTH="-nopw"
  log "警告：未设置 VNC_PASSWORD —— noVNC 不需要密码，只适合临时调试"
fi
log "启动 x11vnc（127.0.0.1:${VNC_PORT}）"
# shellcheck disable=SC2086
x11vnc -display "${DISPLAY}" -localhost -forever -shared -noxdamage -quiet \
  -rfbport "${VNC_PORT}" ${VNC_AUTH} &
X11VNC_PID=$!

# ── 3. noVNC（websockify）────────────────────────────────────────────────────
WS_AUTH=""
if [ -n "${NOVNC_BASIC_AUTH:-}" ]; then
  # 形如 user:pass；websockify 的 BasicHTTPAuth 直接做字符串比较
  #
  # ⚠️ 实测（2026-11-03）：这个插件**只校验 WebSocket 握手**，静态文件照常 200。
  #   浏览器首次访问没有该站点的 Basic 凭据缓存，WS 握手不会带 Authorization
  #   → noVNC 报 "Failed to connect"。所以默认**不推荐**开，门槛靠 VNC 密码 + 绑定范围。
  WS_AUTH="--auth-plugin=BasicHTTPAuth --auth-source=${NOVNC_BASIC_AUTH}"
  log "警告：已启用 noVNC HTTP Basic —— 它只拦 WS 握手，可能让第一次访问的浏览器连不上"
fi
log "启动 websockify/noVNC（0.0.0.0:${NOVNC_PORT} → 127.0.0.1:${VNC_PORT}）"
# shellcheck disable=SC2086
websockify --web=/usr/share/novnc ${WS_AUTH} "0.0.0.0:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" &
WS_PID=$!

# ── 4. Chromium（崩了自动重启，但**带崩溃退避**；profile 在 /profile，登录一次长期有效）
chromium_loop() {
  crash_streak=0
  while [ ! -f "$STOP_FILE" ]; do
    # profile 里的 Singleton* 是"谁在占用这个 profile"的锁，内容是 hostname-pid。
    # 容器重建后 hostname 变了，旧锁会被判成"另一台电脑正在用" → Chromium 拒绝启动。
    # 我们保证同一时刻只有一个 Chromium，所以每次启动前直接清掉这些锁。
    rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie" 2>/dev/null || true
    log "启动 Chromium（profile=${PROFILE_DIR}，CDP=127.0.0.1:${CDP_PORT}）"
    chrome_started_at=$(date +%s)
    # --no-sandbox：容器内以非 root 跑，但内核不一定允许 user namespace
    # --password-store=basic：不然 Chromium 会找 gnome-keyring，弹出没人能填的对话框
    # --disable-breakpad：容器里不留崩溃转储，也少 spawn 一个 crashpad 进程（崩溃风暴时它也在堆积）
    chromium \
      --no-sandbox \
      --disable-dev-shm-usage \
      --disable-gpu \
      --password-store=basic \
      --no-first-run \
      --no-default-browser-check \
      --disable-session-crashed-bubble \
      --hide-crash-restore-bubble \
      --disable-breakpad \
      --disable-features=Translate,MediaRouter,OptimizationHints \
      --user-data-dir="${PROFILE_DIR}" \
      --remote-debugging-port="${CDP_PORT}" \
      --remote-debugging-address=127.0.0.1 \
      --window-position=0,0 \
      --window-size=1440,900 \
      --lang="${BROWSER_LANG}" \
      "${START_URL}" || true
    [ -f "$STOP_FILE" ] && break

    # ── 崩溃退避（2026-11-04 事故后的硬要求）──
    # 事故：Chromium 起不来 → 本循环每 2 秒重启一次 → 每次崩溃留下孤儿进程，
    # 在宿主上堆到 9.5 万个僵尸 → 进程表被占满 → 全系统 fork() 失败，
    # sshd 认证成功却起不了 shell，19 小时登不上。170,573 次崩溃。
    # 所以：**跑稳 60 秒才算"正常"**，否则连续崩溃要指数退避（2s→4s→…→60s 封顶），
    # 把"每秒造一次进程"压成"每分钟一次"，给看门狗（近 10 分钟 traps 计数）留出反应时间。
    ran=$(( $(date +%s) - chrome_started_at ))
    if [ "$ran" -ge 60 ]; then
      crash_streak=0
    fi
    crash_streak=$((crash_streak + 1))
    # 2s（前 3 次）→ 4s → 8s → 16s → 32s → 60s 封顶。
    # ⚠️ 不用 `**`：这个脚本跑在 dash 下，POSIX 算术里没有幂运算符（实测会报错）。
    delay=2
    if [ "$crash_streak" -ge 4 ]; then
      steps=$((crash_streak - 3))
      [ "$steps" -gt 6 ] && steps=6
      delay=2
      i=0
      while [ "$i" -lt "$steps" ]; do
        delay=$((delay * 2))
        i=$((i + 1))
      done
      [ "$delay" -gt 60 ] && delay=60
    fi
    log "Chromium 退出（连续第 ${crash_streak} 次，本次运行 ${ran}s），${delay} 秒后重启"
    sleep "$delay"
  done
}
chromium_loop &

# 等 CDP 起来（只是让日志好看：Node 服务自己会重试连接）
waited=0
while [ "$waited" -lt 50 ]; do
  if node -e "fetch('http://127.0.0.1:${CDP_PORT}/json/version').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    log "Chromium CDP 已就绪"
    break
  fi
  waited=$((waited + 1))
  sleep 0.4
done

# ── 5. Node 服务 + 优雅收尾 ─────────────────────────────────────────────────
# ⚠️ 这里**不能**用 `exec node`：那样信号只到 node，Xvfb/Chromium 会被 SIGKILL，
#    profile 里的 cookie/会话可能没落盘，而且 /tmp 会留 X 锁（下次重启直接起不来）。
log "启动 dsh-browser HTTP 服务"
node src/server.js &
NODE_PID=$!

shutdown() {
  log "收到退出信号：先让 Chromium 把 profile 写盘，再收子进程"
  touch "$STOP_FILE"
  kill -TERM "$NODE_PID" 2>/dev/null || true
  # 只给浏览器主进程发 TERM；它会把 cookie/Profile 状态 flush 到磁盘。
  # ⚠️ 实测：Chromium 的 cookie DB 是批量落盘的，刚写入就 SIGKILL 会丢 ——
  #    所以要等它真的退出（最多 6s），别只 sleep 1。
  pkill -TERM -f '/usr/lib/chromium/chromium' 2>/dev/null || true
  waited=0
  while pgrep -f '/usr/lib/chromium/chromium' >/dev/null 2>&1 && [ "$waited" -lt 30 ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
  if pgrep -f '/usr/lib/chromium/chromium' >/dev/null 2>&1; then
    log "Chromium 6s 内没退出，SIGKILL（可能丢最后一批 cookie）"
    pkill -KILL -f '/usr/lib/chromium/chromium' 2>/dev/null || true
  fi
  for pid in "${XVFB_PID:-}" "${X11VNC_PID:-}" "${WS_PID:-}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# node 自己退出（配置错误等）→ 跟着退，容器由 restart 策略接管
wait "$NODE_PID" || true
log "Node 服务已退出"
touch "$STOP_FILE"
pkill -TERM -f '/usr/lib/chromium/chromium' 2>/dev/null || true
sleep 1
exit 1
