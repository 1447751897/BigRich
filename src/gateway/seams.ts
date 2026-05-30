/**
 * 三个预留口子(PRD §7.3 / 02-design §5.2)—— 首版只留接口、默认实现为 no-op/匿名。
 * 转 A 面向公众、嵌入"轻社区"时替换实现即可,引擎与房间运行时无须改动。
 */
import type { SeatId } from "../engine/types.js";

/** ② 外部账号:首版=匿名昵称;将来=社区登录态。引擎只认 seatId。 */
export interface IdentityProvider {
  /** 校验并解析一次进房身份,返回稳定 seatId 与展示名。 */
  resolve(input: { token?: string; nickname?: string }): Promise<{ seatId: SeatId; displayName: string }>;
}

/** 首版匿名实现:昵称直接成名,seatId 由房间分配。 */
export class AnonymousIdentityProvider implements IdentityProvider {
  private counter = 0;
  async resolve(input: { token?: string; nickname?: string }): Promise<{ seatId: SeatId; displayName: string }> {
    const displayName = (input.nickname ?? "玩家").slice(0, 16);
    const seatId = `seat-${++this.counter}`;
    return { seatId, displayName };
  }
}

/** ③ 合规层:实名/防沉迷拦截 seam。首版 no-op 直通。 */
export interface ComplianceGate {
  /** 进房前检查;返回 false 表示拦截(首版恒 true)。 */
  allowJoin(seatId: SeatId): Promise<boolean>;
}

export class NoopComplianceGate implements ComplianceGate {
  async allowJoin(_seatId: SeatId): Promise<boolean> {
    return true;
  }
}

/** ① 可嵌入:host <-> game 的桥接 seam(postMessage/JS-SDK 桩)。首版仅定义契约。 */
export interface EmbedHost {
  /** 对局结束时回调宿主(将名次回传给"轻社区")。首版可空实现。 */
  onGameEnded(payload: { roomId: string; ranking: { seatId: SeatId; rank: number }[] }): void;
}

export class NoopEmbedHost implements EmbedHost {
  onGameEnded(): void {
    /* 首版不接真实宿主 */
  }
}
