// 直播间数据推送签名：除 x-signature / content-type 外的 x- 头按键名字典序拼 key=value&…，再接 body 与密钥，MD5 后 base64。
import { createHash, timingSafeEqual } from 'node:crypto';

export const SIGNED_HEADERS = ['x-msg-type', 'x-nonce-str', 'x-roomid', 'x-timestamp'] as const;

export function signPush(headers: Record<string, string>, body: string, secret: string): string {
  const qs = Object.keys(headers).sort().map((k) => `${k}=${headers[k]}`).join('&');
  return createHash('md5').update(qs + body + secret, 'utf8').digest('base64');
}

export function verifyPush(headers: Record<string, string | undefined>, body: string, secret: string): boolean {
  const got = headers['x-signature'];
  if (!got) return false;
  const picked: Record<string, string> = {};
  for (const k of SIGNED_HEADERS) if (headers[k] !== undefined) picked[k] = headers[k]!;
  const want = Buffer.from(signPush(picked, body, secret));
  const have = Buffer.from(got);
  return want.length === have.length && timingSafeEqual(want, have);
}
