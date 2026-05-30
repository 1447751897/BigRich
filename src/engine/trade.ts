/**
 * 交易子状态机(PRD §4B ★)。
 *
 * 关键点:
 * - 仅自回合发起;进入交易时挂起主时钟、跑独立 20s 子时钟(D-004),退出再恢复主时钟。
 * - 还价全局仅 1 次,且"还价不可再被还价"。
 * - 任一方超时 = 自动拒绝;对方掉线 -> AI 托管被动一律拒绝。
 * - 接受时由单写者原子复核双方资产/现金,一次性过户(资金守恒)。
 */
import {
  changeCash,
  clearTimer,
  currentSeat,
  mustPlayer,
  propertyAt,
  startTimer,
  startTurnTimer,
} from "./helpers.js";
import type { Command, GameEvent, GameState, SeatId, TradeOffer } from "./types.js";

function reject(events: GameEvent[], reason: string): GameEvent[] {
  events.push({ type: "Rejected", reason });
  return events;
}

/** 校验一组地产确实由 seat 持有、且未抵押无房(开发中的地产不可交易)。 */
function ownsTradable(state: GameState, seat: SeatId, tiles: number[]): boolean {
  return tiles.every((idx) => {
    const ps = propertyAt(state, idx);
    return !!ps && ps.ownerSeatId === seat && !ps.mortgaged && ps.houseLevel === 0;
  });
}

export function proposeTrade(
  state: GameState,
  events: GameEvent[],
  cmd: Extract<Command, { type: "ProposeTrade" }>,
): void {
  if (state.phase !== "playing") return void reject(events, "game-not-playing");
  if (cmd.issuer !== currentSeat(state)) return void reject(events, "trade-only-on-own-turn");
  if (state.turnPhase !== "normal") return void reject(events, "must-resolve-current-action-first");
  if (cmd.counterparty === cmd.issuer) return void reject(events, "cannot-trade-self");

  const cp = mustPlayer(state, cmd.counterparty);
  if (cp.status !== "active") return void reject(events, "counterparty-not-active");

  if (!ownsTradable(state, cmd.issuer, cmd.giveProperties))
    return void reject(events, "give-properties-not-owned-or-developed");
  if (!ownsTradable(state, cmd.counterparty, cmd.getProperties))
    return void reject(events, "get-properties-not-owned-or-developed");
  if (cmd.giveCash < 0 || cmd.getCash < 0) return void reject(events, "negative-cash");
  if (cmd.giveCash > mustPlayer(state, cmd.issuer).cash) return void reject(events, "initiator-cash-insufficient");
  if (cmd.getCash > cp.cash) return void reject(events, "counterparty-cash-insufficient");

  const offer: TradeOffer = {
    initiator: cmd.issuer,
    counterparty: cmd.counterparty,
    giveProperties: [...cmd.giveProperties],
    giveCash: cmd.giveCash,
    getProperties: [...cmd.getProperties],
    getCash: cmd.getCash,
    awaiting: cmd.counterparty,
    counterUsed: false,
  };
  state.trade = offer;
  state.turnPhase = "trade";
  events.push({ type: "TradeProposed", offer: { ...offer } });

  // 对方掉线/托管:被动一律拒绝(PRD §4C),交易立即作废,不进入子流程等待。
  if (cp.connection !== "online") {
    resolveTrade(state, events, "rejected", "offline");
    return;
  }
  // 挂起主时钟,开 20s 交易子时钟。
  startTimer(state, events, "trade", state.config.tradeTimerSec);
}

export function respondTrade(
  state: GameState,
  events: GameEvent[],
  cmd: Extract<Command, { type: "RespondTrade" }>,
): void {
  const offer = state.trade;
  if (state.turnPhase !== "trade" || !offer) return void reject(events, "no-active-trade");
  if (cmd.issuer !== offer.awaiting) return void reject(events, "not-your-turn-to-respond");

  if (cmd.action === "reject") {
    resolveTrade(state, events, "rejected", "declined");
    return;
  }

  if (cmd.action === "counter") {
    // 只有对方(counterparty)能还价,且全局仅 1 次;还价不可再被还价。
    if (offer.counterUsed) return void reject(events, "counter-already-used");
    if (cmd.issuer !== offer.counterparty) return void reject(events, "only-counterparty-can-counter");
    if (!cmd.counter) return void reject(events, "counter-payload-required");

    // 还价以"原发起方视角"重述报价。复核归属/现金。
    if (!ownsTradable(state, offer.initiator, cmd.counter.giveProperties))
      return void reject(events, "counter-give-not-owned");
    if (!ownsTradable(state, offer.counterparty, cmd.counter.getProperties))
      return void reject(events, "counter-get-not-owned");

    offer.giveProperties = [...cmd.counter.giveProperties];
    offer.giveCash = cmd.counter.giveCash;
    offer.getProperties = [...cmd.counter.getProperties];
    offer.getCash = cmd.counter.getCash;
    offer.counterUsed = true;
    offer.awaiting = offer.initiator; // 计时切回发起方
    events.push({ type: "TradeCountered", offer: { ...offer } });
    // 重启 20s 交易子时钟给发起方决定。
    startTimer(state, events, "trade", state.config.tradeTimerSec);
    return;
  }

  // accept:由当前 awaiting 方接受当前报价。原子复核后一次性过户。
  if (cmd.action === "accept") {
    if (!atomicExecutable(state, offer)) {
      // 资产在等待期间发生变化导致不可执行 -> 作废。
      resolveTrade(state, events, "rejected", "declined");
      return;
    }
    executeTransfer(state, events, offer);
    resolveTrade(state, events, "accepted");
    return;
  }
}

/** 原子复核:双方仍持有各自要给出的地产,且现金充足。 */
function atomicExecutable(state: GameState, offer: TradeOffer): boolean {
  if (!ownsTradable(state, offer.initiator, offer.giveProperties)) return false;
  if (!ownsTradable(state, offer.counterparty, offer.getProperties)) return false;
  if (mustPlayer(state, offer.initiator).cash < offer.giveCash) return false;
  if (mustPlayer(state, offer.counterparty).cash < offer.getCash) return false;
  return true;
}

/** 一次性过户:地产 owner 互换 + 现金双向结算(资金守恒)。 */
function executeTransfer(state: GameState, events: GameEvent[], offer: TradeOffer): void {
  for (const idx of offer.giveProperties) propertyAt(state, idx)!.ownerSeatId = offer.counterparty;
  for (const idx of offer.getProperties) propertyAt(state, idx)!.ownerSeatId = offer.initiator;
  // 发起方:- giveCash + getCash;对方反向。净额一次性结算。
  const initiatorDelta = offer.getCash - offer.giveCash;
  if (initiatorDelta !== 0) changeCash(state, events, offer.initiator, initiatorDelta);
  if (-initiatorDelta !== 0) changeCash(state, events, offer.counterparty, -initiatorDelta);
}

/** 收尾:清交易状态,恢复主回合时钟,回到发起方回合。 */
function resolveTrade(
  state: GameState,
  events: GameEvent[],
  result: "accepted" | "rejected",
  reason?: "timeout" | "offline" | "declined",
): void {
  state.trade = null;
  state.turnPhase = "normal";
  events.push(reason ? { type: "TradeResolved", result, reason } : { type: "TradeResolved", result });
  clearTimer(state, events);
  // 恢复发起方主时钟(D-004:子流程结束才恢复)。
  startTurnTimer(state, events);
}

/** 交易子时钟超时 -> 自动拒绝。 */
export function resolveTradeTimeout(state: GameState, events: GameEvent[]): void {
  if (state.turnPhase !== "trade" || !state.trade) return;
  resolveTrade(state, events, "rejected", "timeout");
}
