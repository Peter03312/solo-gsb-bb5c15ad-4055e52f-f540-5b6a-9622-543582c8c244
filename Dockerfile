# 一键运行镜像：安装依赖 -> 初始化数据 -> 启动服务
FROM node:20-bookworm-slim

# better-sqlite3 在 Node 20 / bookworm 上可直接使用预编译二进制；
# 保留构建工具链以备无预编译包时源码编译。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先复制依赖清单以利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 复制应用代码
COPY src ./src
COPY public ./public

# 数据文件目录（Compose 中以命名卷持久化）
RUN mkdir -p /data
ENV DB_PATH=/data/callboard.db \
    PORT=3000 \
    TZ=Asia/Shanghai \
    NODE_ENV=production

EXPOSE 3000

# 启动过程：先幂等建表与数据初始化，再启动 Web 服务。
CMD ["sh", "-c", "node src/initdb.js && node src/server.js"]
