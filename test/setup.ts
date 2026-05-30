/** 测试夹具:构造一局已开始的对局,并提供驱动命令的小工具。 */
import { createGame, reduce } from "../src/engine/engine.js";
import type { Command, GameEvent, GameState, SeatId } from "../src/engine/types.js";

export interface Harness {
  state: GameState;
  events: GameEvent[];
}

/** 创建并开始一局 n 人对局(座位 p0..p{n-1})。 */
export function startedGame(n = 4): GameState {
  const seats = Array.from({ length: n }, (_, i) => ({ seatId: `p${i}`, displayName: `玩家${i}` }));
  let s = createGame("room-test", seats, { seed: 12345 });
  s = reduce(s, { type: "StartGame", issuer: "p0" }).state;
  return s;
}

/** 顺序施加一条命令,返回 {state, events}。 */
export function step(state: GameState, cmd: Command): Harness {
  const r = reduce(state, cmd);
  return { state: r.state, events: r.events };
}

/** 找出第 k 块地产格子的下标(k 从 0 起)。 */
export function propertyTiles(state: GameState): number[] {
  return state.config.tiles.filter((t) => t.type === "property").map((t) => t.index);
}

/** 直接指派某地产归属(测试夹具用)。 */
export function setOwner(state: GameState, tileIndex: number, seatId: SeatId | null): void {
  const ps = state.properties.find((p) => p.tileIndex === tileIndex)!;
  ps.ownerSeatId = seatId;
}

export function setCash(state: GameState, seatId: SeatId, cash: number): void {
  state.players.find((p) => p.seatId === seatId)!.cash = cash;
}

export function cashOf(state: GameState, seatId: SeatId): number {
  return state.players.find((p) => p.seatId === seatId)!.cash;
}

export function ownerOf(state: GameState, tileIndex: number): SeatId | null {
  return state.properties.find((p) => p.tileIndex === tileIndex)!.ownerSeatId;
}

export function has(events: GameEvent[], type: GameEvent["type"]): boolean {
  return events.some((e) => e.type === type);
}

export function find<T extends GameEvent["type"]>(
  events: GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<GameEvent, { type: T }> | undefined;
}

/** 当前活跃计时器的 kind(无则 null)。 */
export function timerKind(state: GameState): string | null {
  return state.timer?.kind ?? null;
}

export function timerEpoch(state: GameState): number {
  return state.timer?.epoch ?? -1;
}
