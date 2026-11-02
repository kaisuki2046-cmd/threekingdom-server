// 启动：读环境变量并监听端口（抖音云容器默认 8000）。
import { createServer } from 'node:http';
import { createApp } from './app';
import { DEFAULT_GIFT_MAP } from './live';
import { OpenApi } from './openapi';

const env = process.env;
const appId = env.APP_ID ?? '';
if (!appId) console.warn('未设置 APP_ID，OpenAPI 调用会失败');

const api = new OpenApi({
  appId,
  appSecret: env.APP_SECRET || undefined,
  webcastBase: env.WEBCAST_BASE ?? 'http://webcast-bytedance-com.openapi.dyc.ivolces.com',
  wsPushBase: env.WS_PUSH_BASE ?? 'http://ws-push.dyc.ivolces.com',
  serviceId: env.SERVICE_ID ?? '',
  envId: env.DY_ENV_ID ?? ''
});

const app = createApp({ api, pushSecret: env.PUSH_SECRET || undefined, pollProbe: env.POLL_PROBE === '1', pollWaitMs: env.POLL_WAIT_MS ? Number(env.POLL_WAIT_MS) : undefined,giftMap: { ...DEFAULT_GIFT_MAP, ...(env.GIFT_MAP ? JSON.parse(env.GIFT_MAP) : {}) } });
if (!env.PUSH_SECRET) console.warn('未设置 PUSH_SECRET，推送签名不校验（仅限本地调试）');

const port = Number(env.PORT ?? 8000);
const server = createServer((req, res) => void app.handle(req, res));
server.on('upgrade', (req, socket) => app.handleUpgrade(req, socket));
server.listen(port, () => console.log(`三国闹西游中间层已启动 :${port}`));
