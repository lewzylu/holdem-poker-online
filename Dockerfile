# 德州扑克联机服务端（只需要跑服务端的镜像，前端页面由它自己托管）
FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 只复制运行必需的部分：server / 前端静态资源 / 核心逻辑副本
# （tools/ 是开发与自测脚本，不该进镜像）
COPY server/ ./server/
COPY public/  ./public/
COPY vendor/  ./vendor/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# 账号与资产存在 /app/data，挂个卷就不会因为重启丢档。
# 以非 root 运行，先把数据目录的所有权交给 node 用户。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]

CMD ["node", "server/server.js"]
