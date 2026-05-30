/**
 * 规则引擎主入口(ADR D-003:纯逻辑、端无关)。
 *
 *   reduce(state, command) -> { state, events }
 *
 * - 纯函数:入口深拷贝 state,只改副本,不依赖传输/渲染/系统时钟。
 * - 服务端权威:掷骰用内置 RNG;客户端只发意图,所有结果以返回的事件为准。
 * - 单写者:房间运行时按序把命令喂进来即可,原子性由"串行处理"天然保证(D-001)。
 * - 计时:超时不旁路改状态,而是由定时器服务投递 Timeout 命令走这里(D-004)。
 */
import { startAuction } from "./auction.js";
import { placeBid, passBid, resolveAuctionTimeout } from "./auction.js";
import { defaultConfig } from "./config.js";
import {
  activePlayers,
  changeCash,
  clearTimer,
  currentSeat,
  isCurrentTimer,
  mustPlayer,
  payOrBankrupt,
  propertyAt,
  settle,
  startTurnTimer,
  tile,
} from "./helpers.js";
import { mortgage, redeem } from "./mortgage.js";
import { rollDice } from "./rng.js";
import { proposeTrade, resolveTradeTimeout, respondTrade } from "./trade.js";
import type {
  CardDef,
  Command,
  GameConfig,
  GameEvent,
  GameState,
  Player,
  ReduceResult,
  SeatId,
  TimerKind,
  TurnPhase,
} from "./types.js";

export interface SeatInit {
  seatId: SeatId;
  displayName: string;
}

/** 创建一局(lobby 态)。config 缺省用 §4A 默认基线;seed 决定服务端 RNG。 */
export function createGame(
  roomId: string,
  seats: SeatInit[],
  opts: { config?: GameConfig; seed?: number } = {},
): GameState {
  const config = opts.config ?? defaultConfig();
  const players: Player[] = seats.map((s) => ({
    seatId: s.seatId,
    displayName: s.displayName,
    cash: config.startingCash,
    position: 0,
    inJail: false,
    jailTurns: 0,
    getOutCards: 0,
    status: "active",
    connection: "online",
    turnsTaken: 0,
    consecutiveTimeouts: 0,
  }));
  return {
    roomId,
    config,
    phase: "lobby",
    players,
    order: seats.map((s) => s.seatId),
    currentIndex: 0,
    turnPhase: "normal",
    properties: config.tiles
      .filter((t) => t.type === "property")
      .map((t) => ({ tileIndex: t.index, ownerSeatId: null, houseLevel: 0, mortgaged: false })),
    trade: null,
    auction: null,
    pendingBuyTile: null,
    rolledThisTurn: false,
    rngState: opts.seed ?? 0x1a2b3c4d,
    timer: null,
    timerSeq: 0,
    chancePtr: 0,
    fatePtr: 0,
    ranking: [],
  };
}

function reject(events: GameEvent[], reason: string): ReduceResult["events"] {
  events.push({ type: "Rejected", reason });
  return events;
}

/** 读取当前子状态,返回宽化的 TurnPhase —— 用于跨函数调用后避免 TS 过度收窄。 */
function readPhase(state: GameState): TurnPhase {
  return state.turnPhase;
}

/** 纯函数 reduce:深拷贝后分发处理。 */
export function reduce(prev: GameState, cmd: Command): ReduceResult {
  const state: GameState = structuredClone(prev);
  const events: GameEvent[] = [];

  switch (cmd.type) {
    case "JoinSeat":
      joinSeat(state, events, cmd.seatId, cmd.displayName);
      break;
    case "SetConnection": {
      const p = mustPlayer(state, cmd.target);
      p.connection = cmd.status;
      events.push({ type: "ConnectionChanged", seatId: cmd.target, status: cmd.status });
      break;
    }
    case "StartGame":
      startGame(state, events);
      break;
    case "RestartGame":
      restartGame(state, events);
      break;
    case "RollDice":
      rollDiceCmd(state, events, cmd.issuer);
      break;
    case "BuyProperty":
      buyProperty(state, events, cmd.issuer);
      break;
    case "DeclineBuy":
      declineBuy(state, events, cmd.issuer);
      break;
    case "BuildHouse":
      buildHouse(state, events, cmd.issuer, cmd.tileIndex);
      break;
    case "Mortgage":
      mortgage(state, events, cmd);
      break;
    case "Redeem":
      redeem(state, events, cmd);
      break;
    case "ProposeTrade":
      proposeTrade(state, events, cmd);
      break;
    case "RespondTrade":
      respondTrade(state, events, cmd);
      break;
    case "PlaceBid":
      placeBid(state, events, cmd);
      break;
    case "PassBid":
      passBid(state, events, cmd.issuer);
      break;
    case "EndTurn":
      endTurn(state, events, cmd.issuer);
      break;
    case "Timeout":
      handleTimeout(state, events, cmd.kind, cmd.epoch);
      break;
    case "ForceSettle":
      // 30 分钟时长硬上限到点(由网关 wall-clock 触发):立即按净资产排名结算。
      if (state.phase === "playing") settle(state, events, "time-limit");
      break;
    default: {
      const _never: never = cmd;
      void _never;
    }
  }

  return { state, events };
}

// --- 对局生命周期 -----------------------------------------------------------

/** lobby 阶段动态加入座位(免注册:输昵称即占座)。保持服务端权威、可快照。 */
function joinSeat(state: GameState, events: GameEvent[], seatId: SeatId, displayName: string): void {
  if (state.phase !== "lobby") return void reject(events, "game-already-started");
  if (state.players.some((p) => p.seatId === seatId)) return void reject(events, "seat-taken");
  if (state.players.length >= 8) return void reject(events, "room-full");
  state.players.push({
    seatId,
    displayName: displayName.slice(0, 16) || `玩家${state.players.length + 1}`,
    cash: state.config.startingCash,
    position: 0,
    inJail: false,
    jailTurns: 0,
    getOutCards: 0,
    status: "active",
    connection: "online",
    turnsTaken: 0,
    consecutiveTimeouts: 0,
  });
  state.order.push(seatId);
  events.push({ type: "SeatJoined", seatId, displayName, order: [...state.order] });
}

function startGame(state: GameState, events: GameEvent[]): void {
  if (state.phase !== "lobby") return void reject(events, "already-started");
  if (state.players.length < 2) return void reject(events, "need-at-least-2-players");
  state.phase = "playing";
  state.currentIndex = 0;
  state.turnPhase = "normal";
  state.rolledThisTurn = false;
  events.push({ type: "GameStarted", order: [...state.order] });
  events.push({ type: "TurnChanged", seatId: currentSeat(state) });
  startTurnTimer(state, events);
}

/**
 * 「再来一局」:对局结束后把状态重置回 lobby,保留座位/座次/配置,等待房主重新开始。
 * 不重置 rngState —— 续用当前(已推进过的)RNG 流,保证下一局骰子序列与上一局不同,
 * 既避免在纯函数引擎里引入随机源,又不破坏可注入种子的回归可重放性。
 */
function restartGame(state: GameState, events: GameEvent[]): void {
  if (state.phase !== "ended") return void reject(events, "game-not-ended");
  state.phase = "lobby";
  state.currentIndex = 0;
  state.turnPhase = "normal";
  state.rolledThisTurn = false;
  state.trade = null;
  state.auction = null;
  state.pendingBuyTile = null;
  state.timer = null;
  state.ranking = [];
  state.chancePtr = 0;
  state.fatePtr = 0;
  // 地产全部回到无主、无房、未抵押。
  for (const ps of state.properties) {
    ps.ownerSeatId = null;
    ps.houseLevel = 0;
    ps.mortgaged = false;
  }
  // 玩家保留座位与昵称/连接,游戏内数值复位。
  for (const p of state.players) {
    p.cash = state.config.startingCash;
    p.position = 0;
    p.inJail = false;
    p.jailTurns = 0;
    p.getOutCards = 0;
    p.status = "active";
    p.turnsTaken = 0;
    p.consecutiveTimeouts = 0;
  }
  events.push({ type: "TimerCleared" });
  events.push({ type: "GameReset", order: [...state.order] });
}

// --- 普通回合流 -------------------------------------------------------------

function rollDiceCmd(state: GameState, events: GameEvent[], issuer: SeatId): void {
  if (state.phase !== "playing") return void reject(events, "game-not-playing");
  if (issuer !== currentSeat(state)) return void reject(events, "not-your-turn");
  if (state.turnPhase !== "normal") return void reject(events, "resolve-current-action-first");
  if (state.rolledThisTurn) return void reject(events, "already-rolled");

  const player = mustPlayer(state, issuer);
  const { dice, state: rng } = rollDice(state.rngState);
  state.rngState = rng;
  const doubles = dice[0] === dice[1];
  const sum = dice[0] + dice[1];
  events.push({ type: "DiceRolled", seatId: issuer, dice, doubles });
  state.rolledThisTurn = true;

  // 监狱:掷双数出狱并移动;否则停留计数,满 maxJailTurns 付罚金出狱。
  if (player.inJail) {
    if (doubles) {
      player.inJail = false;
      player.jailTurns = 0;
      events.push({ type: "LeftJail", seatId: issuer, reason: "doubles" });
    } else {
      player.jailTurns += 1;
      if (player.jailTurns >= state.config.maxJailTurns) {
        payOrBankrupt(state, events, issuer, null, state.config.jailFine);
        if (player.status === "active") {
          player.inJail = false;
          player.jailTurns = 0;
          events.push({ type: "LeftJail", seatId: issuer, reason: "fine" });
        }
      } else {
        // 仍在狱中,本回合不移动,等待 EndTurn。
        return;
      }
    }
    if (player.status !== "active") return;
  }

  movePlayer(state, events, issuer, sum);
  if (player.status === "active" && state.turnPhase === "normal") {
    // 落点结算后无待决买地/拍卖/破产 -> 玩家可继续操作(盖房/抵押/交易)或 EndTurn。
  }
  // 若当前玩家在结算中破产,自动结束其回合。
  if (mustPlayer(state, issuer).status !== "active" && state.phase === "playing") {
    advanceTurn(state, events);
  }
}

function movePlayer(state: GameState, events: GameEvent[], seat: SeatId, steps: number): void {
  const player = mustPlayer(state, seat);
  const n = state.config.tiles.length;
  const from = player.position;
  const to = (from + steps) % n;
  const passedStart = from + steps >= n;
  player.position = to;
  events.push({ type: "PlayerMoved", seatId: seat, from, to, passedStart });
  if (passedStart) changeCash(state, events, seat, state.config.passStartBonus);
  resolveLanding(state, events, seat);
}

/** 直接移动到目标格(机会/命运卡用);经过起点给奖励。 */
function moveTo(state: GameState, events: GameEvent[], seat: SeatId, toIndex: number): void {
  const player = mustPlayer(state, seat);
  const from = player.position;
  const passedStart = toIndex < from; // 向前绕回起点
  player.position = toIndex;
  events.push({ type: "PlayerMoved", seatId: seat, from, to: toIndex, passedStart });
  if (passedStart) changeCash(state, events, seat, state.config.passStartBonus);
  resolveLanding(state, events, seat);
}

function resolveLanding(state: GameState, events: GameEvent[], seat: SeatId): void {
  const player = mustPlayer(state, seat);
  const t = tile(state, player.position);
  switch (t.type) {
    case "property": {
      const ps = propertyAt(state, t.index)!;
      const price = t.property!.price;
      if (ps.ownerSeatId === null) {
        // 无主:进入待购买决策(买 or 不买->拍卖)。
        state.turnPhase = "awaiting-buy";
        state.pendingBuyTile = t.index;
        events.push({ type: "PropertyOffered", seatId: seat, tileIndex: t.index, price });
      } else if (ps.ownerSeatId !== seat && !ps.mortgaged) {
        const rent = rentForLanding(state, t.index);
        payOrBankrupt(state, events, seat, ps.ownerSeatId, rent);
        events.push({ type: "RentPaid", from: seat, to: ps.ownerSeatId, amount: rent, tileIndex: t.index });
      }
      break;
    }
    case "tax":
      payOrBankrupt(state, events, seat, null, t.taxAmount ?? 0);
      if (player.status === "active") events.push({ type: "TaxPaid", seatId: seat, amount: t.taxAmount ?? 0 });
      break;
    case "gotojail":
      sendToJail(state, events, seat);
      break;
    case "chance":
      drawCard(state, events, seat, "chance");
      break;
    case "fate":
      drawCard(state, events, seat, "fate");
      break;
    case "start":
    case "jail":
    case "freeparking":
      break;
  }
}

/** 用 helpers.rentFor 计算(已含抵押=0、集齐整组翻倍)。 */
function rentForLanding(state: GameState, tileIndex: number): number {
  // 复用 helpers 的 rentFor 逻辑(此处直接调用以避免重复)。
  const ps = propertyAt(state, tileIndex)!;
  const def = tile(state, tileIndex).property!;
  let rent = def.rentTable[ps.houseLevel] ?? def.rentTable[0]!;
  if (ps.houseLevel === 0 && ownsFullGroupInline(state, ps.ownerSeatId!, def.groupId)) {
    rent = Math.round(rent * state.config.fullGroupRentMultiplier);
  }
  return rent;
}

function ownsFullGroupInline(state: GameState, seatId: SeatId, groupId: string): boolean {
  const groupTiles = state.config.tiles.filter((t) => t.property?.groupId === groupId);
  return groupTiles.every((t) => propertyAt(state, t.index)?.ownerSeatId === seatId);
}

function sendToJail(state: GameState, events: GameEvent[], seat: SeatId): void {
  const player = mustPlayer(state, seat);
  const jailTile = state.config.tiles.find((t) => t.type === "jail");
  player.position = jailTile ? jailTile.index : player.position;
  player.inJail = true;
  player.jailTurns = 0;
  events.push({ type: "SentToJail", seatId: seat });
}

function drawCard(state: GameState, events: GameEvent[], seat: SeatId, deck: "chance" | "fate"): void {
  const cards: CardDef[] = deck === "chance" ? state.config.chanceDeck : state.config.fateDeck;
  if (cards.length === 0) return;
  const ptr = deck === "chance" ? state.chancePtr : state.fatePtr;
  const card = cards[ptr % cards.length]!;
  if (deck === "chance") state.chancePtr = ptr + 1;
  else state.fatePtr = ptr + 1;
  events.push({ type: "CardDrawn", seatId: seat, deck, text: card.text });

  const player = mustPlayer(state, seat);
  switch (card.effect.kind) {
    case "gain":
      changeCash(state, events, seat, card.effect.amount);
      break;
    case "pay":
      payOrBankrupt(state, events, seat, null, card.effect.amount);
      break;
    case "move":
      moveTo(state, events, seat, card.effect.toIndex);
      break;
    case "gotojail":
      sendToJail(state, events, seat);
      break;
    case "getout":
      player.getOutCards += 1;
      break;
  }
}

function buyProperty(state: GameState, events: GameEvent[], issuer: SeatId): void {
  if (state.turnPhase !== "awaiting-buy" || state.pendingBuyTile === null)
    return void reject(events, "no-property-to-buy");
  if (issuer !== currentSeat(state)) return void reject(events, "not-your-turn");
  const tileIndex = state.pendingBuyTile;
  const price = tile(state, tileIndex).property!.price;
  const player = mustPlayer(state, issuer);
  if (player.cash < price) return void reject(events, "cash-insufficient");
  changeCash(state, events, issuer, -price);
  propertyAt(state, tileIndex)!.ownerSeatId = issuer;
  events.push({ type: "PropertyBought", seatId: issuer, tileIndex, price });
  state.turnPhase = "normal";
  state.pendingBuyTile = null;
}

function declineBuy(state: GameState, events: GameEvent[], issuer: SeatId): void {
  if (state.turnPhase !== "awaiting-buy" || state.pendingBuyTile === null)
    return void reject(events, "no-property-to-decline");
  if (issuer !== currentSeat(state)) return void reject(events, "not-your-turn");
  const tileIndex = state.pendingBuyTile;
  state.pendingBuyTile = null;
  // 不买 -> 对全体在局玩家公开拍卖(PRD §4B)。
  startAuction(state, events, tileIndex);
}

function buildHouse(state: GameState, events: GameEvent[], issuer: SeatId, tileIndex: number): void {
  if (state.phase !== "playing") return void reject(events, "game-not-playing");
  if (issuer !== currentSeat(state)) return void reject(events, "build-only-on-own-turn");
  if (state.turnPhase !== "normal") return void reject(events, "resolve-current-action-first");
  const ps = propertyAt(state, tileIndex);
  if (!ps || ps.ownerSeatId !== issuer) return void reject(events, "not-owner");
  if (ps.mortgaged) return void reject(events, "mortgaged");
  const def = tile(state, tileIndex).property!;
  if (!ownsFullGroupInline(state, issuer, def.groupId)) return void reject(events, "need-full-group");
  if (ps.houseLevel >= 5) return void reject(events, "max-level");
  const player = mustPlayer(state, issuer);
  if (player.cash < def.housePrice) return void reject(events, "cash-insufficient");
  changeCash(state, events, issuer, -def.housePrice);
  ps.houseLevel += 1;
  events.push({ type: "HouseBuilt", seatId: issuer, tileIndex, level: ps.houseLevel });
}

function endTurn(state: GameState, events: GameEvent[], issuer: SeatId): void {
  if (state.phase !== "playing") return void reject(events, "game-not-playing");
  if (issuer !== currentSeat(state)) return void reject(events, "not-your-turn");
  if (state.turnPhase !== "normal") return void reject(events, "resolve-current-action-first");
  if (!state.rolledThisTurn) return void reject(events, "must-roll-first");
  advanceTurn(state, events);
}

/** 轮转到下一名 active 玩家;处理回合上限结算。 */
function advanceTurn(state: GameState, events: GameEvent[]): void {
  // 记当前玩家完成一个回合。
  const finishing = mustPlayer(state, currentSeat(state));
  finishing.turnsTaken += 1;
  finishing.consecutiveTimeouts = 0;

  // 回合上限:任一玩家完成 maxTurnsPerPlayer -> 结算(先到先结算)。
  if (finishing.turnsTaken >= state.config.maxTurnsPerPlayer) {
    settle(state, events, "turn-limit");
    return;
  }
  if (activePlayers(state).length <= 1) {
    settle(state, events, "last-standing");
    return;
  }

  // 找下一名 active 玩家。
  const n = state.order.length;
  for (let k = 1; k <= n; k++) {
    const idx = (state.currentIndex + k) % n;
    if (mustPlayer(state, state.order[idx]!).status === "active") {
      state.currentIndex = idx;
      break;
    }
  }
  state.turnPhase = "normal";
  state.rolledThisTurn = false;
  state.pendingBuyTile = null;
  events.push({ type: "TurnChanged", seatId: currentSeat(state) });
  startTurnTimer(state, events);
}

// --- 超时兜底(D-004:超时 -> 合成默认命令,与真人同路)----------------------

function handleTimeout(state: GameState, events: GameEvent[], kind: TimerKind, epoch: number): void {
  // 过期 Timeout(已被新的计时器取代)直接忽略。
  if (!isCurrentTimer(state, kind, epoch)) return;

  if (kind === "trade") {
    resolveTradeTimeout(state, events);
    return;
  }
  if (kind === "auction") {
    resolveAuctionTimeout(state, events);
    return;
  }
  // kind === "turn":回合主时钟超时,合成默认操作。
  const seat = currentSeat(state);
  const player = mustPlayer(state, seat);
  player.consecutiveTimeouts += 1;

  if (state.turnPhase === "awaiting-buy") {
    // 默认不买 -> 触发拍卖(PRD:落地不买即拍卖)。
    declineBuy(state, events, seat);
    return;
  }
  if (state.turnPhase === "normal") {
    if (!state.rolledThisTurn && !player.inJail) {
      // 还没掷骰 -> 自动掷骰(默认操作)。
      rollDiceCmd(state, events, seat);
      // 自动掷骰后若落到无主地产,默认不买 -> 拍卖(rollDiceCmd 可能已改 turnPhase)。
      if (readPhase(state) === "awaiting-buy") {
        declineBuy(state, events, seat);
        return;
      }
    }
    // 已掷骰或在狱中:结束回合(此处 turnPhase 经函数调用可能已变化)。
    if (state.phase === "playing" && readPhase(state) === "normal" && currentSeat(state) === seat) {
      advanceTurn(state, events);
    }
  }
}
