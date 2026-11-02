# 构建上下文为 server/ 目录。src/shared/contracts 只作类型引用，esbuild 打包时会擦除，不需要拷进镜像。
FROM node:20-alpine AS build
WORKDIR /b
RUN npm install --no-save esbuild@0.25.12
COPY build.mjs ./
COPY src ./src
RUN node build.mjs

# 运行层用 alpine + 系统 nodejs，比 node:20-alpine 小得多（大层推抖音云镜像仓库会超时）。
FROM alpine:3.22
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /b/dist/server.js /b/dist/server.js.map ./
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
CMD ["node", "--enable-source-maps", "server.js"]
