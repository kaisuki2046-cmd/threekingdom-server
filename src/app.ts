// 中间层 HTTP 入口：开局换房间并启动推送任务、接收平台推送、把消息送到主播客户端。单实例内存状态（最小 / 最大实例数都设 1）。
// 客户端接收通道三选一，按优先级：直连 WebSocket（/ws_direct）> 抖音云网关 WebSocket（需自定义域名白名单）> HTTP 长轮询（/poll）。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GiftKind } from '../../src/shared/contracts';
import { verifyPush } from './sign';
import { MSG_TYPES, type MsgType, type OpenApi } from './openapi';
import { normalize, SeenIds, type LiveItem, type LivePacket } from './live';
import { acceptWebSocket, type WsConn } from './ws';

export const WS_SERVICE_PATH = '/ws/on_connect';
export const WS_DIRECT_PATH = '/ws_direct';
export const POLL_PATH = '/poll';
const QUEUE_CAP = 500;

interface Room {
  roomId: string;
  anchorOpenId: string;
  /** 开局时生成的随机凭证，客户端后续所有请求都要带上。 */
  clientKey: string;
  /** 抖音云网关的一次性连接 ID；未开通自定义域名 WebSocket 时为 null。 */
  connId: string | null;
  /** 网关回调里的 X-TT-SESSIONID；未连上前为 null。 */
  sessionId: string | null;
  gatewayConnected: boolean;
  ws: WsConn | null;
  /** 正在挂起的长轮询请求。 */
  waiter: ((packets: LivePacket[]) => void) | null;
  /** 客户端未连上时暂存，连上或下次轮询时补发。 */
  queue: LivePacket[];
  lastSeenAt: number;
  disconnectedAt: number | null;
}

export interface AppDeps {
  api: OpenApi;
  /** 直推开发者服务器时的签名密钥；走抖音云内网专线的推送不带签名。 */
  pushSecret?: string;
  giftMap: Record<string, GiftKind>;
  /** 长轮询最长挂起时间。 */
  pollWaitMs?: number;
  /** dev 探测开关（环境变量 POLL_PROBE=1）。 */
  pollProbe?: boolean;
  log?: (msg: string) => void;
  now?: () => number;
}

class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, '请求体过大');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): any {
  try { return JSON.parse(text || 'null'); } catch { throw new HttpError(400, '请求体不是合法 JSON'); }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function createApp(deps: AppDeps) {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? (() => Date.now());
  const pollWaitMs = deps.pollWaitMs ?? 20_000;
  const rooms = new Map<string, Room>();
  const bySession = new Map<string, Room>();
  const seen = new SeenIds();

  const roomByConn = (connId: string) => [...rooms.values()].find((r) => r.connId !== null && r.connId === connId);

  function auth(roomId: unknown, clientKey: unknown): Room {
    const room = rooms.get(String(roomId ?? ''));
    if (!room || room.clientKey !== clientKey) throw new HttpError(404, '房间不存在或凭证不匹配');
    return room;
  }

  function bindSession(room: Room, sessionId: string) {
    if (room.sessionId && room.sessionId !== sessionId) bySession.delete(room.sessionId);
    room.sessionId = sessionId;
    room.gatewayConnected = true;
    room.disconnectedAt = null;
    bySession.set(sessionId, room);
  }

  function enqueue(room: Room, packet: LivePacket) {
    room.queue.push(packet);
    if (room.queue.length > QUEUE_CAP) room.queue.shift();
    if (room.waiter) { const w = room.waiter; room.waiter = null; w(room.queue.splice(0)); }
  }

  async function deliver(room: Room, packet: LivePacket) {
    if (room.ws?.open) return room.ws.send(JSON.stringify(packet));
    if (room.gatewayConnected && room.sessionId) {
      const failed = await deps.api.pushToSessions([room.sessionId], packet);
      if (!failed.length) return;
      room.gatewayConnected = false;
      room.disconnectedAt ??= now();
    }
    enqueue(room, packet);
  }

  async function flush(room: Room) {
    const pending = room.queue.splice(0);
    for (const p of pending) await deliver(room, p);
  }

  /** 客户端处理完一批消息后回报，转成履约上报 ack_type 2。 */
  async function clientAck(room: Room, items: unknown) {
    if (!Array.isArray(items) || !items.length) return;
    const t = now();
    const byType = new Map<MsgType, { msg_id: string; msg_type: MsgType; client_time: number }[]>();
    for (const i of items as any[]) if (MSG_TYPES.includes(i?.msgType)) byType.set(i.msgType, [...(byType.get(i.msgType) ?? []), { msg_id: String(i.msgId), msg_type: i.msgType, client_time: t }]);
    for (const list of byType.values()) await deps.api.ack(room.roomId, 2, list).catch((e) => log(`ack2 失败：${e.message}`));
  }

  async function startGame(body: any) {
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) throw new HttpError(400, '缺少直播伴侣传入的 token');
    const info = await deps.api.liveInfo(token);
    for (const t of MSG_TYPES) await deps.api.startTask(info.roomId, t);
    // 网关连接 ID 需开通“自定义域名支持 websocket”；未开通时客户端改用直连或长轮询。
    const connId = await deps.api.connId(token).catch((e) => { log(`get_conn_id 不可用：${e.message}`); return null; });
    const old = rooms.get(info.roomId);
    if (old?.sessionId) bySession.delete(old.sessionId);
    old?.ws?.close();
    old?.waiter?.([]);
    const clientKey = randomBytes(16).toString('hex');
    rooms.set(info.roomId, {
      roomId: info.roomId, anchorOpenId: info.anchorOpenId, clientKey, connId, sessionId: null, gatewayConnected: false,
      ws: null, waiter: null, queue: old?.queue ?? [], lastSeenAt: now(), disconnectedAt: null
    });
    log(`start_game room=${info.roomId} anchor=${info.nickName}`);
    return { ...info, clientKey, connId, wsDirectPath: WS_DIRECT_PATH, pollPath: POLL_PATH, wsServicePath: WS_SERVICE_PATH };
  }

  async function stopGame(body: any) {
    const room = auth(body?.roomId, body?.clientKey);
    for (const t of MSG_TYPES) await deps.api.stopTask(room.roomId, t).catch((e) => log(`stop ${t} 失败：${e.message}`));
    rooms.delete(room.roomId);
    if (room.sessionId) bySession.delete(room.sessionId);
    room.ws?.close();
    room.waiter?.([]);
    log(`stop_game room=${room.roomId}`);
    return { stopped: true };
  }

  async function liveCallback(req: IncomingMessage, raw: string) {
    const h: Record<string, string | undefined> = {};
    for (const k of ['x-signature', 'x-nonce-str', 'x-timestamp', 'x-roomid', 'x-msg-type']) h[k] = header(req, k);
    // 走抖音云内网专线的推送不带签名（该路径只允许内网调用，切勿在访问控制里对外开放）；带签名的（直推开发者服务器）才校验。
    if (h['x-signature'] !== undefined && deps.pushSecret && !verifyPush(h, raw, deps.pushSecret)) throw new HttpError(401, '签名校验失败');
    const msgType = h['x-msg-type'] as MsgType;
    if (!MSG_TYPES.includes(msgType)) return { ignored: `msg_type ${msgType}` };
    const roomId = String(h['x-roomid'] ?? '');
    const list = parseJson(raw);
    if (!Array.isArray(list)) throw new HttpError(400, '推送体应为数组');
    const items: LiveItem[] = [];
    for (const r of list) {
      const it = normalize(msgType, r, deps.giftMap);
      if (it && seen.add(it.msgId)) items.push(it);
    }
    const room = rooms.get(roomId);
    // 未开局的房间也回 2xx：非 2xx 连续 10 次会触发平台熔断。
    if (!room || !items.length) return { accepted: items.length, room: !!room };
    const t = now();
    deps.api.ack(roomId, 1, items.map((i) => ({ msg_id: i.msgId, msg_type: msgType, client_time: t }))).catch((e) => log(`ack1 失败：${e.message}`));
    deliver(room, { v: 1, roomId, msgType, items }).catch((e) => log(`推送客户端失败 room=${roomId}：${e.message}`));
    return { accepted: items.length };
  }

  /** 长轮询：先处理回报，有暂存消息立即返回，否则挂起到有新消息或超时。 */
  async function poll(req: IncomingMessage, body: any): Promise<{ packets: LivePacket[] }> {
    // 仅 dev 探测网关能挂起多久：POLL_PROBE=1 时 roomId=__probe__ 只等待后返回空，不涉及任何房间数据。
    if (deps.pollProbe && body?.roomId === '__probe__') {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(0, Number(body.waitMs) || 0), 60_000)));
      return { packets: [] };
    }
    const room = auth(body?.roomId, body?.clientKey);
    room.lastSeenAt = now();
    room.disconnectedAt = null;
    await clientAck(room, body?.acks);
    if (room.queue.length) return { packets: room.queue.splice(0) };
    room.waiter?.([]); // 同一房间只保留最新一个挂起请求
    return new Promise((resolve) => {
      const done = (packets: LivePacket[]) => { clearTimeout(timer); if (room.waiter === done) room.waiter = null; resolve({ packets }); };
      const timer = setTimeout(() => done([]), pollWaitMs);
      room.waiter = done;
      req.on('close', () => { if (room.waiter === done) { room.waiter = null; clearTimeout(timer); } });
    });
  }

  async function wsEvent(req: IncomingMessage, raw: string) {
    const ev = String(header(req, 'x-tt-event-type') ?? '').toLowerCase();
    const sid = String(header(req, 'x-tt-sessionid') ?? '');
    if (ev === 'connect') {
      const room = roomByConn(sid);
      if (room) { bindSession(room, sid); await flush(room); }
      return { ok: true };
    }
    if (ev === 'disconnect') {
      const room = bySession.get(sid);
      if (room) { room.gatewayConnected = false; room.disconnectedAt = now(); log(`客户端断开 room=${room.roomId}`); }
      return { ok: true };
    }
    if (ev === 'uplink') {
      const msg = parseJson(raw);
      if (msg?.type === 'hello') {
        // 会话 ID 与连接 ID 不一致时，客户端连上后先报 roomId + clientKey 认领房间。
        const room = auth(msg.roomId, msg.clientKey);
        bindSession(room, sid);
        await flush(room);
        return { ok: true };
      }
      const room = bySession.get(sid);
      if (!room) throw new HttpError(404, '会话未绑定房间');
      if (msg?.type === 'ack') await clientAck(room, msg.items);
      return { ok: true };
    }
    throw new HttpError(400, `未知网关事件 ${ev}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && (path === '/' || path === '/health')) return send(res, 200, { ok: true, rooms: rooms.size });
      if (path === WS_SERVICE_PATH) return send(res, 200, await wsEvent(req, req.method === 'POST' ? await readBody(req) : ''));
      if (req.method !== 'POST') throw new HttpError(404, '未找到');
      const raw = await readBody(req);
      if (path === '/live_data_callback') return send(res, 200, await liveCallback(req, raw));
      if (path === '/start_game') return send(res, 200, await startGame(parseJson(raw)));
      if (path === '/stop_game') return send(res, 200, await stopGame(parseJson(raw)));
      if (path === POLL_PATH) { const r = await poll(req, parseJson(raw)); if (!res.destroyed) send(res, 200, r); return; }
      throw new HttpError(404, '未找到');
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`${path} 出错：${e?.stack ?? e}`);
      send(res, status, { error: e?.message ?? String(e) });
    }
  }

  /** 客户端直连：ws(s)://<域名>/ws_direct?roomId=…&clientKey=…；未带凭证或不匹配直接拒绝。 */
  function handleUpgrade(req: IncomingMessage, socket: Duplex) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== WS_DIRECT_PATH) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const room = rooms.get(url.searchParams.get('roomId') ?? '');
    if (!room || room.clientKey !== url.searchParams.get('clientKey')) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const conn = acceptWebSocket(req, socket, (text) => {
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      room.lastSeenAt = now();
      if (msg?.type === 'ack') clientAck(room, msg.items).catch(() => {});
      else if (msg?.type === 'ping') conn?.send(JSON.stringify({ type: 'pong', t: now() }));
    }, () => {
      if (room.ws === conn) { room.ws = null; room.disconnectedAt = now(); log(`直连断开 room=${room.roomId}`); }
    });
    if (!conn) return;
    room.ws?.close();
    room.ws = conn;
    room.lastSeenAt = now();
    room.disconnectedAt = null;
    conn.send(JSON.stringify({ type: 'hello', roomId: room.roomId }));
    flush(room).catch((e) => log(`补推失败 room=${room.roomId}：${e.message}`));
  }

  return { handle, handleUpgrade, rooms };
}
