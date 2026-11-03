# dsh-assistant 运行镜像
#
# 为什么用 Node 22 而不是宿主的 Node：
#   ubuntu-gpu 自带的是 Node 18（已 EOL）。容器自带运行时，部署不再依赖宿主版本，
#   也不会和宿主机上其它项目抢 node。
#
# 为什么默认跑 --interval 常驻而不是配 cron：
#   容器本身由 Docker 的 restart policy 托管；进程内定时器比"容器里装 cron"简单，
#   且状态落 volume，重启后能接着跑。
FROM node:22-slim

WORKDIR /app

# 只有运行必需的东西：源码 + 脚本。测试/文档不进镜像。
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production

# 凭据、状态、日志都放 /data（compose 里挂 volume，绝不进镜像）
VOLUME ["/data"]

# 默认：每 45 分钟查看一次；classpipe 走 compose 里的 host.docker.internal
CMD ["node", "scripts/run-assistant.mjs", \
     "--interval", "45", \
     "--classpipe", "http://host.docker.internal:8000", \
     "--tg-config", "/data/telegram.json", \
     "--state", "/data/state.json", \
     "--log-file", "/data/run.log"]
