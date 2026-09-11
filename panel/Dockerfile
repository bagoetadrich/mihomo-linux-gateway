# ============================================================
# panel 镜像 —— 管理面板
#
# 特点：
#   - 零依赖：不跑 npm install，只 COPY 源码
#   - 无构建步骤：前端是原生 HTML/CSS/JS，直接由后端托管
#   - 需要挂载 docker.sock（用于重启容器）和 ./config（用于读写节点源）
# ============================================================
FROM node:22-alpine

# curl 仅用于 Dockerfile 内自检；wget 用于容器 healthcheck
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY web ./web

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

EXPOSE 9091

# 用 node 自身做健康检查（避免依赖外部命令）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANEL_PORT||9091)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
