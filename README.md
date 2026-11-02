# 三国闹西游 · 抖音云中间层

部署在抖音云托管服务 `threekingdom2`（应用 tt730e05b3ed7720d210，dev 环境 env-UGhsWODqIU）。Node 20，无运行时依赖，监听 8000 端口。

## 链路

1. 主播用直播伴侣启动玩法，客户端拿到 token，调用 `POST /start_game {token}`。
2. 中间层用 token 换取直播间信息，启动评论、礼物、点赞三类推送任务，再申请一次性 WebSocket 连接 ID，返回 `{roomId, anchorOpenId, nickName, connId, wsServicePath}`。
3. 客户端连接 `wss://<自定义域名>/__dycloud__/ws/connect/`，请求头带 `X-TT-WS-CONN-ID: connId` 和 `X-TT-SERVICE-PATH: /ws/on_connect`。如果网关的会话 ID 不等于 connId，客户端连上后先上行 `{"type":"hello","roomId","connId"}`。
4. 平台推送到 `POST /live_data_callback`。中间层依次：
   - 校验签名
   - 按 msg_id 去重
   - 把礼物 ID 映射成玩法礼物
   - 上报履约 ack_type 1
   - 推送 `{v:1, roomId, msgType, items:[LiveItem]}` 给客户端
   
   客户端断线时，消息暂存最近 500 包，重连后补推。
5. 客户端处理完一批消息后上行 `{"type":"ack","items":[{msgId,msgType}]}`，中间层据此上报履约 ack_type 2。
6. 结束时客户端调用 `POST /stop_game {roomId, connId}`，停止推送任务。

## 环境变量

| 变量 | 说明 |
|---|---|
| `APP_ID` | 小玩法 appid，填 tt730e05b3ed7720d210 |
| `PUSH_SECRET` | 在开发者后台“直播间数据推送配置”里填的签名密钥。**线上必须配置**，不配置时不校验签名 |
| `DY_ENV_ID` | 环境 ID，申请 WebSocket 连接 ID 时用。dev 填 env-UGhsWODqIU，prod 填 env-VQRQhfx9aR |
| `APP_SECRET` | 可选。配置后调用 OpenAPI 时会带上 access-token；内网专线调用本身不需要它 |
| `GIFT_MAP` | 可选，JSON 格式 `{"平台礼物ID":"RED_WAND",…}`，用来覆盖默认的礼物映射 |
| `SERVICE_ID` | 抖音云自动注入 |

## 本地开发

- 构建：`npm run build:server`，产物在 `server/dist/server.js`
- 测试：`npx vitest run tests/server.test.ts`
- 镜像：以 `server/` 为构建上下文，用 `server/Dockerfile` 构建

状态（房间、去重）保存在进程内存中，所以服务最小实例数和最大实例数都要设为 1。以后需要扩容时，要先把这些状态迁移到 Redis。
