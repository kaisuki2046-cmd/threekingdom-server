// 中间层 HTTP 入口：开局换房间并启动推送任务、接收平台推送、WebSocket 网关回调。单实例内存状态（最小实例数设 1）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GiftKind } from '../../src/shared/contracts';
import { verifyPush } from './sign';
import { MSG_TYPES, type MsgType, type OpenApi } from './openapi';
import { normalize, SeenIds, type LiveItem, type LivePacket } from './live';

export const WS_SERVICE_PATH = '/ws/on_connect';
const QUEUE_CAP = 500;

interface Room {
  roomId: string;
  anchorOpenId: string;
  connId: string;
  /** 网关回调里的 X-TT-SESSIONID；未连上前为 null。 */
  sessionId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  /** 客户端未连上时暂存，连上后补推。 */
  queue: LivePacket[];
}

export interface AppDeps {
  api: OpenApi;
  /** 平台推送配置里填写的签名密钥；未配置时不校验（只用于本地调试）。 */
  pushSecret?: string;
  giftMap: Record<string, GiftKind>;
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
  const rooms = new Map<string, Room>();
  const bySession = new Map<string, Room>();
  const seen = new SeenIds();

  const roomByConn = (connId: string) => [...rooms.values()].find((r) => r.connId === connId);

  function bindSession(room: Room, sessionId: string) {
    if (room.sessionId && room.sessionId !== sessionId) bySession.delete(room.sessionId);
    room.sessionId = sessionId;
    room.connected = true;
    room.disconnectedAt = null;
    bySession.set(sessionId, room);
  }

  async function deliver(room: Room, packet: LivePacket) {
    if (!room.connected || !room.sessionId) {
      room.queue.push(packet);
      if (room.queue.length > QUEUE_CAP) room.queue.shift();
      return;
    }
    const failed = await deps.api.pushToSessions([room.sessionId], packet);
    if (failed.length) {
      room.connected = false;
      room.disconnectedAt ??= now();
      room.queue.push(packet);
    }
  }

  async function flush(room: Room) {
    const pending = room.queue.splice(0);
    for (const p of pending) await deliver(room, p);
  }

  async function startGame(body: any) {
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) throw new HttpError(400, '缺少直播伴侣传入的 token');
    const info = await deps.api.liveInfo(token);
    for (const t of MSG_TYPES) await deps.api.startTask(info.roomId, t);
    const connId = await deps.api.connId(token);
    const old = rooms.get(info.roomId);
    if (old?.sessionId) bySession.delete(old.sessionId);
    rooms.set(info.roomId, { roomId: info.roomId, anchorOpenId: info.anchorOpenId, connId, sessionId: null, connected: false, disconnectedAt: null, queue: old?.queue ?? [] });
    log(`start_game room=${info.roomId} anchor=${info.nickName}`);
    return { ...info, connId, wsServicePath: WS_SERVICE_PATH };
  }

  async function stopGame(body: any) {
    const room = rooms.get(String(body?.roomId ?? ''));
    if (!room || room.connId !== body?.connId) throw new HttpError(404, '房间不存在或连接 ID 不匹配');
    for (const t of MSG_TYPES) await deps.api.stopTask(room.roomId, t).catch((e) => log(`stop ${t} 失败：${e.message}`));
    rooms.delete(room.roomId);
    if (room.sessionId) bySession.delete(room.sessionId);
    log(`stop_game room=${room.roomId}`);
    return { stopped: true };
  }

  async function liveCallback(req: IncomingMessage, raw: string) {
    const h: Record<string, string | undefined> = {};
    for (const k of ['x-signature', 'x-nonce-str', 'x-timestamp', 'x-roomid', 'x-msg-type']) h[k] = header(req, k);
    if (deps.pushSecret && !verifyPush(h, raw, deps.pushSecret)) throw new HttpError(401, '签名校验失败');
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
      if (room) { room.connected = false; room.disconnectedAt = now(); log(`客户端断开 room=${room.roomId}`); }
      return { ok: true };
    }
    if (ev === 'uplink') {
      const msg = parseJson(raw);
      if (msg?.type === 'hello') {
        // 会话 ID 与连接 ID 不一致时，客户端连上后先报 roomId + connId 认领房间。
        const room = rooms.get(String(msg.roomId ?? ''));
        if (!room || room.connId !== msg.connId) throw new HttpError(404, '房间不存在或连接 ID 不匹配');
        bindSession(room, sid);
        await flush(room);
        return { ok: true };
      }
      const room = bySession.get(sid);
      if (!room) throw new HttpError(404, '会话未绑定房间');
      if (msg?.type === 'ack' && Array.isArray(msg.items)) {
        const t = now();
        const byType = new Map<MsgType, { msg_id: string; msg_type: MsgType; client_time: number }[]>();
        for (const i of msg.items) if (MSG_TYPES.includes(i?.msgType)) byType.set(i.msgType, [...(byType.get(i.msgType) ?? []), { msg_id: String(i.msgId), msg_type: i.msgType, client_time: t }]);
        for (const list of byType.values()) await deps.api.ack(room.roomId, 2, list).catch((e) => log(`ack2 失败：${e.message}`));
      }
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
      throw new HttpError(404, '未找到');
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`${path} 出错：${e?.stack ?? e}`);
      send(res, status, { error: e?.message ?? String(e) });
    }
  }

  return { handle, rooms };
}
