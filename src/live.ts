// 平台推送 → 发给玩法客户端的统一消息。中间层只做校验、去重、礼物 ID 映射，玩法规则仍由客户端权威模拟决定。
import type { GiftKind } from '../../src/shared/contracts';
import type { MsgType } from './openapi';

/** 平台礼物 ID（liwushuju 礼物素材表）→ 玩法内礼物。可用环境变量 GIFT_MAP（JSON）覆盖或补充。 */
export const DEFAULT_GIFT_MAP: Record<string, GiftKind> = {
  'n1/Dg1905sj1FyoBlQBvmbaDZFBNaKuKZH6zxHkv8Lg5x2cRfrKUTb8gzMs=': 'RED_WAND', // 仙女棒
  'eplFUy7i0B0fiv0Iym1MpOZa5XmUE8g/WUAyJ6Tc+UJJDpcs7pzclNOz/WM=': 'YELLOW_WAND', // 黄色仙女棒
  '4I66OIE1HKWfM7PNvAHtAgYUSNlggSEgcpo3ai8GYQXAWqjrDuH8NtjsWEQ=': 'BLUE_WAND', // 蓝色仙女棒
  'gs+95ujNzXXSCtLTv97fWgbApTQi0sqz1BULB+7w62g+v4sFxINvxOIrXCw=': 'PURPLE_WAND', // 紫色仙女棒
  '28rYzVFNyXEXFC8HI+f/WG+I7a6lfl3OyZZjUS+CVuwCgYZrPrUdytGHu0c=': 'MAGIC_MIRROR', // 能力药丸（内部 id 沿用魔镜）
  'PJ0FFeaDzXUreuUBZH6Hs+b56Jh0tQjrq0bIrrlZmv13GSAL9Q1hf59fjGk=': 'BATTERY', // 甜甜圈（内部 id 沿用 BATTERY）
  'IkkadLfz7O/a5UR45p/OOCCG6ewAWVbsuzR/Z+v1v76CBU+mTG/wPjqdpfg=': 'MICROPHONE' // 能量电池（内部 id 沿用 MICROPHONE）
};

export interface LiveItem {
  msgId: string;
  type: 'comment' | 'gift' | 'like';
  openId: string;
  nickname: string;
  avatarUrl: string;
  ts: number;
  text?: string;
  likeNum?: number;
  giftId?: string;
  /** 未接入的礼物（派对话筒、神秘空投等）为 null，客户端忽略。 */
  giftKind?: GiftKind | null;
  giftNum?: number;
  giftValueFen?: number;
  /** 平台测试数据：客户端可演示，但不得计入排行与成长。 */
  test?: boolean;
}

export interface LivePacket { v: 1; roomId: string; msgType: MsgType; items: LiveItem[] }

const TYPE_OF: Record<MsgType, LiveItem['type']> = { live_comment: 'comment', live_gift: 'gift', live_like: 'like' };

export function normalize(msgType: MsgType, raw: any, giftMap: Record<string, GiftKind>): LiveItem | null {
  if (!raw || typeof raw.msg_id !== 'string' || !raw.msg_id) return null;
  const base: LiveItem = {
    msgId: raw.msg_id, type: TYPE_OF[msgType], openId: String(raw.sec_openid ?? ''), nickname: String(raw.nickname ?? ''),
    avatarUrl: String(raw.avatar_url ?? ''), ts: Number(raw.timestamp) || 0
  };
  if (!base.openId) return null;
  if (msgType === 'live_comment') return { ...base, text: String(raw.content ?? '') };
  if (msgType === 'live_like') return { ...base, likeNum: Math.max(0, Math.floor(Number(raw.like_num) || 0)) };
  const giftId = String(raw.sec_gift_id ?? '');
  return {
    ...base, giftId, giftKind: giftMap[giftId] ?? null, giftNum: Math.max(0, Math.floor(Number(raw.gift_num) || 0)),
    giftValueFen: Math.max(0, Math.floor(Number(raw.gift_value) || 0)), ...(raw.test === true ? { test: true } : {})
  };
}

/** 按 msg_id 去重（平台可能重推），保留最近 capacity 条。 */
export class SeenIds {
  private readonly set = new Set<string>();
  constructor(private readonly capacity = 50_000) {}
  /** 首次出现返回 true。 */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.capacity) this.set.delete(this.set.values().next().value!);
    return true;
  }
}
