# dsh-browser 运行镜像
#
# 为什么用 **Debian**（node:22-bookworm-slim）而不是 Ubuntu：
#   Ubuntu 24.04 的 `chromium` 是个 snap 包装 deb —— 实测 apt 里 Candidate 是 (none)，
#   容器里没有 snapd 根本装不上。Debian bookworm 有**真正的** chromium deb
#   （实测候选 156.0.8078.79），这是容器里跑 headed Chromium 最省事的底座。
#
# 为什么要装 fonts-noto-cjk：
#   学校邮箱 / 2FA 页面有中文。没有 CJK 字体时 noVNC 里看到的是"豆腐块"，
#   维护者没法确认自己点的是哪个按钮 —— 这个服务的前提是"人能看懂屏幕"。
#
# 为什么不要在镜像里下 Playwright 的浏览器：
#   人和 agent 必须看**同一个**浏览器（登录态、cookie、窗口）。node_modules 里
#   只有 playwright-core，它只当 CDP 客户端用，连的是本机这个 chromium。
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      x11-utils \
      novnc \
      websockify \
      fonts-noto-cjk \
      fonts-liberation \
      ca-certificates \
      procps \
 && rm -rf /var/lib/apt/lists/*

# 非 root 的 Xvfb 不会自己建 /tmp/.X11-unix，预建好并给粘滞位
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Debian 的 novnc 只带 vnc.html，没有 index.html → 访问根路径会 404。
# 建个软链，让维护者少记一段 URL（http://host:16080/ 直接用）。
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

WORKDIR /app

# 先只拷 manifest 再装依赖：改源码不必重装 node_modules
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY docker ./docker

# 防御 Windows 检出带来的 CRLF（否则 sh 报 "$'\r': not found"）
RUN sed -i 's/\r$//' docker/entrypoint.sh && chmod +x docker/entrypoint.sh

# Chromium 的持久 profile（登录态）——compose 里挂 ./profile，绝不进镜像
VOLUME ["/profile"]

ENV NODE_ENV=production

# 8789 = HTTP API（走 dsh-net，不发布）；6080 = noVNC（宿主机发布 16080）
EXPOSE 8789 6080

ENTRYPOINT ["/app/docker/entrypoint.sh"]
