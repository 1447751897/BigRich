/**
 * 抵押 / 赎回(PRD §4B)。仅自回合操作,无跨玩家冲突,不需要子状态机。
 * - 抵押价 = 地产价 × mortgageRatio(默认 50%);被抵押地产不可收租。
 * - 赎回需付 抵押价 ×(1 + redeemInterestRatio)(默认 +10% 利息)。
 */
import { changeCash, currentSeat, mustPlayer, propertyAt, tile } from "./helpers.js";
import type { Command, GameEvent, GameState } from "./types.js";

function reject(events: GameEvent[], reason: string): void {
  events.push({ type: "Rejected", reason });
}

function mortgageValue(state: GameState, tileIndex: number): number {
  return Math.floor(tile(state, tileIndex).property!.price * state.config.mortgageRatio);
}

export function mortgage(state: GameState, events: GameEvent[], cmd: Extract<Command, { type: "Mortgage" }>): void {
  if (state.phase !== "playing") return reject(events, "game-not-playing");
  if (cmd.issuer !== currentSeat(state)) return reject(events, "mortgage-only-on-own-turn");
  if (state.turnPhase !== "normal") return reject(events, "must-resolve-current-action-first");

  const ps = propertyAt(state, cmd.tileIndex);
  if (!ps || ps.ownerSeatId !== cmd.issuer) return reject(events, "not-owner");
  if (ps.mortgaged) return reject(events, "already-mortgaged");
  if (ps.houseLevel > 0) return reject(events, "must-sell-houses-first");

  const amount = mortgageValue(state, cmd.tileIndex);
  ps.mortgaged = true;
  changeCash(state, events, cmd.issuer, amount);
  events.push({ type: "Mortgaged", seatId: cmd.issuer, tileIndex: cmd.tileIndex, amount });
}

export function redeem(state: GameState, events: GameEvent[], cmd: Extract<Command, { type: "Redeem" }>): void {
  if (state.phase !== "playing") return reject(events, "game-not-playing");
  if (cmd.issuer !== currentSeat(state)) return reject(events, "redeem-only-on-own-turn");
  if (state.turnPhase !== "normal") return reject(events, "must-resolve-current-action-first");

  const ps = propertyAt(state, cmd.tileIndex);
  if (!ps || ps.ownerSeatId !== cmd.issuer) return reject(events, "not-owner");
  if (!ps.mortgaged) return reject(events, "not-mortgaged");

  const cost = Math.ceil(mortgageValue(state, cmd.tileIndex) * (1 + state.config.redeemInterestRatio));
  const player = mustPlayer(state, cmd.issuer);
  if (player.cash < cost) return reject(events, "cash-insufficient");

  ps.mortgaged = false;
  changeCash(state, events, cmd.issuer, -cost);
  events.push({ type: "Redeemed", seatId: cmd.issuer, tileIndex: cmd.tileIndex, amount: cost });
}
