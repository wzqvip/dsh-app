# dsh-tg 运行镜像
#
# 为什么用 node:22-slim：
#   ubuntu-gpu 宿主是 Node 22（但服务全在容器里跑），固定大版本可以避免宿主升级影响；
#   slim 足够 —— 本服务零依赖，不需要构建工具链。
#
# 为什么 USER node：
#   容器内 uid=1000，和宿主 taco 一致：能只读宿主 600 权限的凭据文件，
#   也能写挂进来的 /state 目录，不需要 root。
FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

# 只有运行必需的东西：源码 + 冒烟脚本。测试/文档不进镜像。
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

USER node

# /data：只读挂凭据（telegram.json / api-token.txt）
# /state：可写挂状态（offset / 序号映射）
VOLUME ["/data", "/state"]

EXPOSE 8788

CMD ["node", "src/index.js"]
