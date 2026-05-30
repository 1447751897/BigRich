/**
 * 引擎内部共享的纯辅助函数。
 * 全部以 (state, events) 形式工作:直接修改传入的 state(调用方已在 reduce 入口深拷贝),
 * 把产生的事件 push 进 events 数组。不依赖任何传输/系统时钟。
 */
import type { GameEvent, GameState, Player, PropertyState, SeatId, TileDef, TimerKind } from "./types.js";

export function getPlayer(state: GameState, seatId: SeatId): Player | undefined {
  return state.players.find((p) => p.seatId === seatId);
}

export function mustPlayer(state: GameState, seatId: SeatId): Player {
  const p = getPlayer(state, seatId);
  if (!p) throw new Error(`unknown seat ${seatId}`);
  return p;
}

export function currentSeat(state: GameState): SeatId {
  return state.order[state.currentIndex]!;
}

export function tile(state: GameState, index: number): TileDef {
  return state.config.tiles[index]!;
}

export function propertyAt(state: GameState, tileIndex: number): PropertyState | undefined {
  return state.properties.find((p) => p.tileIndex === tileIndex);
}

export function activePlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.status === "active");
}

/** 净资产 = 现金 + 地产估值(被抵押折半)+ 房屋投入。用于结算排名。 */
export function netWorth(state: GameState, seatId: SeatId): number {
  const p = mustPlayer(state, seatId);
  let worth = p.cash;
  for (const ps of state.properties) {
    if (ps.ownerSeatId !== seatId) continue;
    const def = tile(state, ps.tileIndex).property!;
    worth += ps.mortgaged ? Math.floor(def.price * state.config.mortgageRatio) : def.price;
    worth += ps.houseLevel * def.housePrice;
  }
  return worth;
}

/** 某座位是否拥有 group 的全部地产(用于空地租金翻倍 / 盖房资格)。 */
export function ownsFullGroup(state: GameState, seatId: SeatId, groupId: string): boolean {
  const groupTiles = state.config.tiles.filter((t) => t.property?.groupId === groupId);
  return groupTiles.every((t) => propertyAt(state, t.index)?.ownerSeatId === seatId);
}

/** 计算落在某地产应付的租金(被抵押=0;空地集齐整组翻倍)。 */
export function rentFor(state: GameState, tileIndex: number): number {
  const ps = propertyAt(state, tileIndex);
  if (!ps || ps.ownerSeatId === null || ps.mortgaged) return 0;
  const def = tile(state, tileIndex).property!;
  let rent = def.rentTable[ps.houseLevel] ?? def.rentTable[0]!;
  if (ps.houseLevel === 0 && ownsFullGroup(state, ps.ownerSeatId, def.groupId)) {
    rent = Math.round(rent * state.config.fullGroupRentMultiplier);
  }
  return rent;
}

export function changeCash(state: GameState, events: GameEvent[], seatId: SeatId, delta: number): void {
  const p = mustPlayer(state, seatId);
  p.cash += delta;
  events.push({ type: "CashChanged", seatId, delta, cash: p.cash });
}

/**
 * 让 from 向 to(null=银行)支付 amount。
 * 若 from 现金不足 -> 付清全部余额后破产,余额归 to(若有),返回 true 表示破产。
 */
export function payOrBankrupt(
  state: GameState,
  events: GameEvent[],
  from: SeatId,
  to: SeatId | null,
  amount: number,
): boolean {
  const debtor = mustPlayer(state, from);
  if (debtor.cash >= amount) {
    changeCash(state, events, from, -amount);
    if (to) changeCash(state, events, to, amount);
    return false;
  }
  // 资不抵债:付清剩余现金后破产。
  const remaining = debtor.cash;
  if (remaining > 0) {
    changeCash(state, events, from, -remaining);
    if (to) changeCash(state, events, to, remaining);
  }
  bankrupt(state, events, from);
  return true;
}

/** 破产:转观战,名下地产收归银行(重置房屋/抵押)。随后检查是否仅剩一人 -> 结算。 */
export function bankrupt(state: GameState, events: GameEvent[], seatId: SeatId): void {
  const p = mustPlayer(state, seatId);
  if (p.status === "bankrupt" || p.status === "spectating") return;
  p.status = "bankrupt";
  for (const ps of state.properties) {
    if (ps.ownerSeatId === seatId) {
      ps.ownerSeatId = null;
      ps.houseLevel = 0;
      ps.mortgaged = false;
    }
  }
  events.push({ type: "PlayerBankrupt", seatId });
  // 破产后转观战(不退场,可继续看)。
  p.status = "spectating";
  maybeEndGame(state, events);
}

/** 仅剩 ≤1 名 active 玩家时结算。 */
export function maybeEndGame(state: GameState, events: GameEvent[]): boolean {
  if (state.phase !== "playing") return false;
  if (activePlayers(state).length <= 1) {
    settle(state, events);
    return true;
  }
  return false;
}

/** 按净资产降序结算排名,结束对局。 */
export function settle(state: GameState, events: GameEvent[]): void {
  if (state.phase === "ended") return;
  clearTimer(state, events);
  const ranked = state.players
    .map((p) => ({ seatId: p.seatId, netWorth: netWorth(state, p.seatId) }))
    .sort((a, b) => b.netWorth - a.netWorth)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  state.phase = "ended";
  state.ranking = ranked;
  state.turnPhase = "normal";
  events.push({ type: "GameEnded", ranking: ranked });
}

// --- 计时器(D-004:唯一权威时钟槽,任一时刻只有一个在跑)---------------------

export function startTimer(state: GameState, events: GameEvent[], kind: TimerKind, sec: number): void {
  const epoch = ++state.timerSeq;
  const durationMs = sec * 1000;
  state.timer = { kind, epoch, durationMs };
  events.push({ type: "TimerStarted", kind, epoch, durationMs });
}

export function startTurnTimer(state: GameState, events: GameEvent[]): void {
  startTimer(state, events, "turn", state.config.turnTimerSec);
}

export function clearTimer(state: GameState, events: GameEvent[]): void {
  if (state.timer) {
    state.timer = null;
    events.push({ type: "TimerCleared" });
  }
}

/** Timeout 命令是否对应当前活跃计时器(否则视为过期,忽略)。 */
export function isCurrentTimer(state: GameState, kind: TimerKind, epoch: number): boolean {
  return !!state.timer && state.timer.kind === kind && state.timer.epoch === epoch;
}
