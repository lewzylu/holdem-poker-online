# 德州扑克联机服务端（只需要跑服务端的镜像，前端页面由它自己托管）
FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 复制服务端与前端静态资源（vendor/ 是 npm run vendor 生成的核心逻辑副本）
COPY server/ ./server/
COPY public/  ./public/
COPY tools/   ./tools/
COPY vendor/  ./vendor/

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# 账号与资产存在 /app/data，挂个卷就不会因为重启丢档
VOLUME ["/app/data"]

CMD ["node", "server/server.js"]
