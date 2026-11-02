// 最小 WebSocket 服务端（RFC 6455，仅文本帧 + ping/close），用于客户端直连容器；无第三方依赖。
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsConn {
  send(text: string): void;
  close(): void;
  readonly open: boolean;
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex, onText: (t: string) => void, onClose: () => void): WsConn | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let open = true;
  let buf = Buffer.alloc(0);
  const frame = (op: number, payload: Buffer) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    socket.write(Buffer.concat([head, payload]));
  };
  const finish = () => { if (!open) return; open = false; socket.destroy(); onClose(); };
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(need);
      if (op === 0x1) onText(data.toString('utf8'));
      else if (op === 0x9) frame(0xa, data);
      else if (op === 0x8) { frame(0x8, Buffer.alloc(0)); finish(); return; }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return { send: (t) => { if (open) frame(0x1, Buffer.from(t, 'utf8')); }, close: () => { if (open) frame(0x8, Buffer.alloc(0)); finish(); }, get open() { return open; } };
}
