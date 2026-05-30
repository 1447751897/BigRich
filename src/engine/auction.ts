/**
 * 拍卖子状态机(PRD §4B ★)。
 *
 * 触发:玩家落到无主地产但选择不买(或无力购买)-> 对全体在局玩家公开拍卖。
 * 关键点:
 * - 自 P 的下家起轮转,P 本人排最后;挂起主时钟、跑独立每轮 10s 子时钟(D-004)。
 * - 出价原子性(单写者串行):出价必须 > 当前最高价 且 ≤ 本人现金,否则拒绝(本轮内可重出)。
 *   因命令被串行化,两人同价/超额出价物理上不可能并存。
 * - "放弃"即退出本场竞价;当除最高出价者外全部放弃 -> 成交;无人出价且全员放弃 -> 流拍。
 * - 掉线/托管者直接放弃,不阻塞轮转。
 */
import {
  changeCash,
  clearTimer,
  mustPlayer,
  propertyAt,
  startTimer,
  startTurnTimer,
} from "./helpers.js";
import type { AuctionState, Command, GameEvent, GameState, SeatId } from "./types.js";

function reject(events: GameEvent[], reason: string): void {
  events.push({ type: "Rejected", reason });
}

function contenders(a: AuctionState): SeatId[] {
  return a.order.filter((s) => !a.passed.includes(s));
}

/** order 中 fromPtr 之后(循环)下一个仍在竞价的座位下标;无则 -1。 */
function nextContenderPtr(a: AuctionState, fromPtr: number): number {
  const n = a.order.length;
  for (let k = 1; k <= n; k++) {
    const p = (fromPtr + k) % n;
    if (!a.passed.includes(a.order[p]!)) return p;
  }
  return -1;
}

/** 开拍。order:自 P 下家起的全体在局玩家,P 本人最后。 */
export function startAuction(state: GameState, events: GameEvent[], tileIndex: number): void {
  const n = state.order.length;
  const order: SeatId[] = [];
  for (let k = 1; k <= n; k++) {
    const s = state.order[(state.currentIndex + k) % n]!;
    if (mustPlayer(state, s).status === "active") order.push(s);
  }
  const auction: AuctionState = {
    tileIndex,
    order,
    turnPtr: 0,
    currentHigh: 0,
    currentHighSeat: null,
    passed: [],
    passesSinceLastRaise: 0,
  };
  state.auction = auction;
  state.turnPhase = "auction";
  events.push({ type: "AuctionStarted", tileIndex, order: [...order] });
  settleCurrentBidder(state, events);
}

export function placeBid(state: GameState, events: GameEvent[], cmd: Extract<Command, { type: "PlaceBid" }>): void {
  const a = state.auction;
  if (state.turnPhase !== "auction" || !a) return reject(events, "no-active-auction");
  if (cmd.issuer !== a.order[a.turnPtr]) return reject(events, "not-your-turn-to-bid");

  const player = mustPlayer(state, cmd.issuer);
  // 出价原子性:必须高于当前最高价、且不超过本人现金。
  if (cmd.amount <= a.currentHigh) return reject(events, "bid-not-higher-than-current");
  if (cmd.amount > player.cash) return reject(events, "bid-exceeds-cash");

  a.currentHigh = cmd.amount;
  a.currentHighSeat = cmd.issuer;
  events.push({ type: "BidPlaced", seatId: cmd.issuer, amount: cmd.amount });

  a.turnPtr = nextContenderPtr(a, a.turnPtr);
  settleCurrentBidder(state, events);
}

export function passBid(
  state: GameState,
  events: GameEvent[],
  seat: SeatId,
  reason?: "timeout" | "offline",
): void {
  const a = state.auction;
  if (state.turnPhase !== "auction" || !a) return;
  if (seat !== a.order[a.turnPtr]) {
    reject(events, "not-your-turn-to-pass");
    return;
  }
  if (!a.passed.includes(seat)) {
    a.passed.push(seat);
    events.push(reason ? { type: "BidPassed", seatId: seat, reason } : { type: "BidPassed", seatId: seat });
  }
  a.turnPtr = nextContenderPtr(a, a.turnPtr);
  settleCurrentBidder(state, events);
}

/**
 * 让当前 turnPtr 指向的玩家就位:
 * - 先判定是否已可成交/流拍;
 * - 掉线/托管者自动放弃并继续轮转;
 * - 落到一个在线真人则重启 10s 子时钟,等待其出价/放弃。
 */
function settleCurrentBidder(state: GameState, events: GameEvent[]): void {
  const a = state.auction!;
  // 防御:无参与者直接流拍。
  for (let guard = 0; guard <= a.order.length + 1; guard++) {
    if (resolveIfDone(state, events)) return;
    if (a.turnPtr < 0 || a.passed.includes(a.order[a.turnPtr]!)) {
      a.turnPtr = nextContenderPtr(a, a.turnPtr < 0 ? 0 : a.turnPtr);
      if (a.turnPtr < 0) {
        resolveIfDone(state, events);
        return;
      }
    }
    const bidder = a.order[a.turnPtr]!;
    if (mustPlayer(state, bidder).connection !== "online") {
      // 托管/掉线:直接放弃,继续轮转。
      a.passed.push(bidder);
      events.push({ type: "BidPassed", seatId: bidder, reason: "offline" });
      a.turnPtr = nextContenderPtr(a, a.turnPtr);
      continue;
    }
    // 在线真人就位,开 10s 子时钟等待。
    startTimer(state, events, "auction", state.config.auctionTimerSec);
    return;
  }
}

/** 成交 / 流拍判定。返回是否已结束。 */
function resolveIfDone(state: GameState, events: GameEvent[]): boolean {
  const a = state.auction!;
  const c = contenders(a);
  if (a.currentHighSeat !== null && c.length <= 1) {
    // 除最高出价者外全部放弃 -> 成交。
    const winner = a.currentHighSeat;
    const amount = a.currentHigh;
    changeCash(state, events, winner, -amount);
    const ps = propertyAt(state, a.tileIndex)!;
    ps.ownerSeatId = winner;
    ps.houseLevel = 0;
    ps.mortgaged = false;
    events.push({ type: "AuctionResolved", result: "sold", winner, amount, tileIndex: a.tileIndex });
    exitAuction(state, events);
    return true;
  }
  if (a.currentHighSeat === null && c.length === 0) {
    // 无人出价且全员放弃 -> 流拍,地产维持无主。
    events.push({ type: "AuctionResolved", result: "passed-in", tileIndex: a.tileIndex });
    exitAuction(state, events);
    return true;
  }
  return false;
}

function exitAuction(state: GameState, events: GameEvent[]): void {
  state.auction = null;
  state.turnPhase = "normal";
  clearTimer(state, events);
  // 恢复 P 的主回合时钟(子流程结束才恢复)。
  startTurnTimer(state, events);
}

/** 拍卖每轮 10s 超时 -> 当前出价者放弃。 */
export function resolveAuctionTimeout(state: GameState, events: GameEvent[]): void {
  const a = state.auction;
  if (state.turnPhase !== "auction" || !a) return;
  const bidder = a.order[a.turnPtr];
  if (bidder) passBid(state, events, bidder, "timeout");
}
