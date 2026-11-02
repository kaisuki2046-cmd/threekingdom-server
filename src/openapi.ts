// 抖音开放平台 OpenAPI 与抖音云 WebSocket 推送网关。抖音云内网专线访问 OpenAPI 无需 access_token；
// 配了 APP_SECRET 时也会带上 access-token（公网调用或内网不认时兜底）。
export type MsgType = 'live_comment' | 'live_gift' | 'live_like';
export const MSG_TYPES: readonly MsgType[] = ['live_comment', 'live_gift', 'live_like'];

export interface OpenApiConfig {
  appId: string;
  appSecret?: string;
  /** 默认走抖音云内网专线：http://webcast-bytedance-com.openapi.dyc.ivolces.com */
  webcastBase: string;
  /** 抖音云 WebSocket 推送网关：http://ws-push.dyc.ivolces.com */
  wsPushBase: string;
  serviceId: string;
  envId: string;
}

type Fetch = typeof fetch;

export class OpenApi {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(readonly cfg: OpenApiConfig, private readonly http: Fetch = fetch, private readonly now = () => Date.now()) {}

  private async accessToken(): Promise<string | undefined> {
    if (!this.cfg.appSecret) return undefined;
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const r = await this.post('https://developer.toutiao.com/api/apps/v2/token', { appid: this.cfg.appId, secret: this.cfg.appSecret, grant_type: 'client_credential' }, {});
    const v = r?.data?.access_token as string | undefined;
    if (!v) throw new Error(`获取 access_token 失败：${JSON.stringify(r)}`);
    this.token = { value: v, expiresAt: this.now() + Number(r.data.expires_in ?? 7200) * 1000 };
    return v;
  }

  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
    const res = await this.http(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`${url} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  }

  private async webcast(path: string, body: unknown, tokenHeader = 'access-token') {
    const t = await this.accessToken();
    const r = await this.post(this.cfg.webcastBase + path, body, t ? { [tokenHeader]: t } : {});
    if (r?.err_no !== 0) throw new Error(`${path} 失败：${r?.err_no} ${r?.err_msg ?? ''} logid=${r?.logid ?? ''}`);
    return r.data;
  }

  /** 直播伴侣传给玩法的 token（30 分钟有效）换直播间信息。 */
  async liveInfo(token: string): Promise<{ roomId: string; anchorOpenId: string; nickName: string; avatarUrl: string }> {
    const d = await this.webcast('/api/webcastmate/info', { token }, 'x-token');
    const i = d?.info ?? {};
    return { roomId: String(i.room_id), anchorOpenId: String(i.anchor_open_id ?? ''), nickName: String(i.nick_name ?? ''), avatarUrl: String(i.avatar_url ?? '') };
  }

  startTask(roomId: string, msgType: MsgType) { return this.webcast('/api/live_data/task/start', { roomid: roomId, appid: this.cfg.appId, msg_type: msgType }); }
  stopTask(roomId: string, msgType: MsgType) { return this.webcast('/api/live_data/task/stop', { roomid: roomId, appid: this.cfg.appId, msg_type: msgType }); }

  /** 履约上报：ackType 1 = 收到推送，2 = 客户端处理完成。 */
  ack(roomId: string, ackType: 1 | 2, items: { msg_id: string; msg_type: MsgType; client_time: number }[]) {
    return this.webcast('/api/live_data/ack', { ack_type: ackType, app_id: this.cfg.appId, room_id: roomId, data: JSON.stringify(items) });
  }

  /** 为自定义域名 WebSocket 客户端申请一次性连接 ID。 */
  async connId(token?: string): Promise<string> {
    const r = await this.post(`${this.cfg.wsPushBase}/ws/get_conn_id`, { service_id: this.cfg.serviceId, env_id: this.cfg.envId, ...(token ? { token } : {}) }, {});
    if (r?.err_no !== 0) throw new Error(`get_conn_id 失败：${r?.err_no} ${r?.err_msg ?? ''}`);
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return String(d.conn_id);
  }

  /** 按连接（session）ID 推送给玩法客户端；返回推送失败的 session。 */
  async pushToSessions(sessionIds: string[], payload: unknown): Promise<string[]> {
    const r = await this.post(`${this.cfg.wsPushBase}/ws/push_data`, payload, { 'X-TT-WS-SESSIONIDS': JSON.stringify(sessionIds) });
    if (r?.err_no !== 0) throw new Error(`ws push 失败：${r?.err_no} ${r?.err_msg ?? ''}`);
    return r.data?.failed_session_id_list ?? [];
  }
}
