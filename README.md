# 三国闹西游 · 抖音云中间层

部署在抖音云托管服务 `threekingdom2`（应用 tt730e05b3ed7720d210，dev 环境 env-UGhsWODqIU）。Node 20，无运行时依赖，监听 8000 端口，由 `/opt/application/run.sh` 启动。

外网地址（dev 默认公网域名）：`https://1mivco8u330h6-env-UGhsWODqIU.service.douyincloud.run`

## 链路

1. 主播用直播伴侣启动玩法，客户端拿到 token，调用 `POST /start_game {token}`。中间层用 token 换取直播间信息，启动评论、礼物、点赞三类推送任务，返回 `{roomId, anchorOpenId, nickName, avatarUrl, clientKey, pollPath}`。之后所有请求都要带上 `clientKey`。
2. 平台把直播间消息走内网专线推到 `POST /live_data_callback`。这种推送不带签名，只有带 `x-signature` 的推送才校验。中间层依次：
   - 按 msg_id 去重
   - 把礼物 ID 映射成玩法礼物
   - 上报履约 ack_type 1
   - 把 `{v:1, roomId, msgType, items:[LiveItem]}` 放进该房间的队列，队列最多保留 500 包
3. 客户端循环调用 `POST /poll {roomId, clientKey, acks?}` 取消息：
   - 队列里有消息就立即返回 `{packets:[…]}`
   - 没有消息就挂起，最长 20 秒（`POLL_WAIT_MS`），期间来了消息立刻返回，超时返回空数组
   
   `acks:[{msgId,msgType}]` 带上前一批已处理的消息，中间层据此上报履约 ack_type 2。实测默认公网域名的网关可以挂起至少 55 秒。
4. 结束时客户端调用 `POST /stop_game {roomId, clientKey}`，停止推送任务。

默认公网域名的网关不会把 WebSocket 升级请求转发给容器（实测返回空的 200），所以客户端只用长轮询。下面两条通道的代码保留着，但默认域名下都用不上：
- `/ws_direct`：客户端直连容器的 WebSocket
- `/ws/on_connect`：抖音云网关 WebSocket，需要申请“自定义域名支持 websocket”白名单

## 访问控制

- 对外开放：`/health`、`/start_game`、`/stop_game`、`/poll`
- **不要开放** `/live_data_callback`：它没有签名保护，只能走内网。

## 环境变量

| 变量 | 说明 |
|---|---|
| `APP_ID` | 小玩法 appid：tt730e05b3ed7720d210 |
| `DY_ENV_ID` | 环境 ID。dev 填 env-UGhsWODqIU，prod 填 env-VQRQhfx9aR |
| `PUSH_SECRET` | 直推开发者服务器时的 MD5 签名密钥。走抖音云内网时用不到 |
| `POLL_WAIT_MS` | 可选，长轮询最长挂起时间，默认 20000 |
| `POLL_PROBE` | 仅 dev 使用：设为 1 时，`/poll` 的 roomId 填 `__probe__` 就只等待 waitMs 后返回，用来测网关超时。**prod 不要设置** |
| `APP_SECRET` | 可选。配置后调用 OpenAPI 时会带上 access-token；内网专线调用不需要 |
| `GIFT_MAP` | 可选，JSON 格式 `{"平台礼物ID":"RED_WAND",…}`，用来覆盖默认的礼物映射 |
| `SERVICE_ID` | 抖音云自动注入 |

## 开发与发布

- 测试：`npx vitest run tests/server.test.ts`
- 构建镜像：`docker build --platform linux/amd64 -t sgxy-middle:vN server`
  - 要关闭 Docker Desktop 的 containerd 镜像存储，否则推送大层会超时
- 推送并发布：用 `node <npm 全局目录>/@open-dy/cloud-cli/bin/run`，依次执行 `container:push --image-id … --tag vN`，再执行 `container:deploy --tag vN --no-confirm`
  - 不要用 `dycloud.cmd` 传 `--env-params`，cmd 会把 `&` 截断
  - 传 `--env-params` 会整体替换已有的环境变量；不传则保留原有配置

状态（房间、队列、去重）保存在进程内存中，所以服务的最小实例数和最大实例数都要设为 1。以后需要扩容时，要先把这些状态迁移到 Redis。
