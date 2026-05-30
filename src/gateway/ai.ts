/**
 * 简单规则 AI 托管(PRD §4C)。职责是"防卡场",不是当强敌。
 *
 * 给定当前权威状态,返回此刻"应由 AI 替非在线玩家发出的下一条命令";
 * 若当前该行动者是在线真人、或无需 AI 介入,返回 null。
 * 网关在每次广播后调用它,把返回的命令投回单写者队列,从而不依赖 25s 超时也能快速推进。
 */
import type { Command, GameState, SeatId } from "../engine/types.js";

function conn(state: GameState, seatId: SeatId): string {
  return state.players.find((p) => p.seatId === seatId)?.connection ?? "online";
}

function cashOf(state: GameState, seatId: SeatId): number {
  return state.players.find((p) => p.seatId === seatId)?.cash ?? 0;
}

export function aiDefaultCommand(state: GameState): Command | null {
  if (state.phase !== "playing") return null;

  if (state.turnPhase === "auction") {
    const a = state.auction;
    if (!a) return null;
    const bidder = a.order[a.turnPtr];
    if (!bidder || conn(state, bidder) === "online") return null;
    return { type: "PassBid", issuer: bidder }; // 托管不加价
  }

  if (state.turnPhase === "trade") {
    const awaiting = state.trade?.awaiting;
    if (!awaiting || conn(state, awaiting) === "online") return null;
    return { type: "RespondTrade", issuer: awaiting, action: "reject" }; // 被动一律拒绝
  }

  const cur = state.order[state.currentIndex];
  if (!cur || conn(state, cur) === "online") return null;

  if (state.turnPhase === "awaiting-buy") {
    const tileIndex = state.pendingBuyTile;
    if (tileIndex === null) return { type: "DeclineBuy", issuer: cur };
    const price = state.config.tiles[tileIndex]?.property?.price ?? Infinity;
    // 现金高于安全线才买,否则不买(交给拍卖)。
    if (cashOf(state, cur) - price >= state.config.aiCashSafetyFloor) {
      return { type: "BuyProperty", issuer: cur };
    }
    return { type: "DeclineBuy", issuer: cur };
  }

  if (state.turnPhase === "normal") {
    if (!state.rolledThisTurn) return { type: "RollDice", issuer: cur };
    return { type: "EndTurn", issuer: cur };
  }

  return null;
}
