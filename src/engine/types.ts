/**
 * 端无关规则引擎的类型定义(ADR D-003)。
 *
 * 这里只有"纯逻辑"会用到的数据结构:状态、命令、事件。
 * 不 import 任何传输 / 渲染 / 系统时钟模块 —— 引擎是 (state, command) -> (state, events) 的纯函数。
 */

export type SeatId = string;

/** 棋盘格子类型(去 IP 化:不用 Monopoly 地名,用中性 group/编号)。 */
export type TileType =
  | "start"
  | "property"
  | "jail" // 监狱 / 探监(落在此处只是探监)
  | "gotojail"
  | "freeparking"
  | "chance"
  | "fate"
  | "tax";

/** 一块地产的静态定义(来自 GameConfig,运行时不可变)。 */
export interface PropertyDef {
  /** 彩色组 id,集齐整组才能盖房、空地租金翻倍。 */
  groupId: string;
  /** 购买价。 */
  price: number;
  /** 每栋房价。 */
  housePrice: number;
  /**
   * 租金表,下标 = 房屋等级:
   * 0=空地(无房)、1..4=1~4 栋房、5=旅馆。
   * 集齐整组且等级 0 时,引擎会再乘 GameConfig.fullGroupRentMultiplier。
   */
  rentTable: number[];
}

/** 棋盘格子静态定义。 */
export interface TileDef {
  index: number;
  type: TileType;
  /** type==="property" 时存在。 */
  property?: PropertyDef;
  /** type==="tax" 时的税额。 */
  taxAmount?: number;
  /** 展示名(去 IP 化的中性名称)。 */
  name: string;
}

/** 机会 / 命运卡的效果(简化版,首版够用)。 */
export type CardEffect =
  | { kind: "gain"; amount: number }
  | { kind: "pay"; amount: number }
  | { kind: "move"; toIndex: number }
  | { kind: "gotojail" }
  | { kind: "getout" }; // 获得一张出狱卡

export interface CardDef {
  id: string;
  text: string;
  effect: CardEffect;
}

/**
 * GameConfig —— §4A 数值基线全部参数化(硬约束:不写死)。
 * 建房时载入一份快照,可按房覆盖,便于试玩调参。
 */
export interface GameConfig {
  tiles: TileDef[];
  /** 起始资金。 */
  startingCash: number;
  /** 过起点奖励。 */
  passStartBonus: number;
  /** 集齐整组、空地时的租金倍数。 */
  fullGroupRentMultiplier: number;
  /** 抵押价 = 地产价 × 此比例。 */
  mortgageRatio: number;
  /** 赎回利息比例(赎回需付 抵押价 ×(1+此值))。 */
  redeemInterestRatio: number;
  /** 监狱最多停留回合数。 */
  maxJailTurns: number;
  /** 出狱罚金。 */
  jailFine: number;
  /** 每回合操作倒计时(秒)。 */
  turnTimerSec: number;
  /** 交易响应倒计时(秒)。 */
  tradeTimerSec: number;
  /** 拍卖每轮倒计时(秒)。 */
  auctionTimerSec: number;
  /** 单局时长硬上限(分钟),到点按净资产结算。 */
  hardTimeLimitMin: number;
  /** 每位玩家回合上限,先到者触发结算。 */
  maxTurnsPerPlayer: number;
  /** AI 托管买地保留的现金安全线(预留缓冲)。 */
  aiCashSafetyFloor: number;
  /** 机会卡堆。 */
  chanceDeck: CardDef[];
  /** 命运卡堆。 */
  fateDeck: CardDef[];
}

export type PlayerStatus = "active" | "bankrupt" | "spectating";
export type ConnectionStatus = "online" | "offline" | "ai";

export interface PropertyState {
  tileIndex: number;
  ownerSeatId: SeatId | null;
  /** 0=空地,1..4=房屋,5=旅馆。 */
  houseLevel: number;
  mortgaged: boolean;
}

export interface Player {
  seatId: SeatId;
  displayName: string;
  cash: number;
  position: number;
  inJail: boolean;
  jailTurns: number;
  getOutCards: number;
  status: PlayerStatus;
  connection: ConnectionStatus;
  /** 本玩家已完整结束的回合数(用于回合上限)。 */
  turnsTaken: number;
  /** 连续超时次数(达到阈值触发 AI 托管,见 PRD §4C)。 */
  consecutiveTimeouts: number;
}

/** 当前回合所处子状态。 */
export type TurnPhase = "normal" | "awaiting-buy" | "trade" | "auction";

/** 交易子状态机数据。 */
export interface TradeOffer {
  initiator: SeatId;
  counterparty: SeatId;
  /** 发起方给出的地产格子下标。 */
  giveProperties: number[];
  giveCash: number;
  /** 发起方索取对方的地产格子下标。 */
  getProperties: number[];
  getCash: number;
  /** 当前等待谁响应。 */
  awaiting: SeatId;
  /** 还价已用次数(全局上限 1)。 */
  counterUsed: boolean;
}

/** 拍卖子状态机数据。 */
export interface AuctionState {
  tileIndex: number;
  /** 仍在参与(未放弃)的座位轮转顺序。 */
  order: SeatId[];
  /** order 中当前轮到的下标。 */
  turnPtr: number;
  currentHigh: number;
  currentHighSeat: SeatId | null;
  /** 已放弃本场拍卖的座位。 */
  passed: SeatId[];
  /** 自上一次有效加价以来连续放弃的人数,用于"连续一轮无人加价成交"判定。 */
  passesSinceLastRaise: number;
}

/** 唯一权威计时器槽(D-004:任一时刻只有一个时钟在跑)。 */
export type TimerKind = "turn" | "trade" | "auction";
export interface TimerSlot {
  kind: TimerKind;
  /** 单调递增的 epoch,用于丢弃过期的 Timeout 命令。 */
  epoch: number;
  durationMs: number;
}

export type GamePhase = "lobby" | "playing" | "ended";

export interface GameState {
  roomId: string;
  config: GameConfig;
  phase: GamePhase;
  players: Player[];
  /** 座位轮转顺序。 */
  order: SeatId[];
  /** order 中当前行动玩家的下标。 */
  currentIndex: number;
  turnPhase: TurnPhase;
  properties: PropertyState[];
  trade: TradeOffer | null;
  auction: AuctionState | null;
  /** 当前等待购买决策的格子(turnPhase==="awaiting-buy")。 */
  pendingBuyTile: number | null;
  /** 本回合是否已掷骰(防止重复掷骰)。 */
  rolledThisTurn: boolean;
  /** 服务端权威 RNG 状态(掷骰只在引擎,绝不在客户端)。 */
  rngState: number;
  /** 计时器槽。 */
  timer: TimerSlot | null;
  /** 单调递增的计时器 epoch 计数器。 */
  timerSeq: number;
  /** 机会牌堆指针(已抽张数,循环)。 */
  chancePtr: number;
  fatePtr: number;
  /** 结算名次(phase==="ended" 时填充)。 */
  ranking: { seatId: SeatId; netWorth: number; rank: number }[];
}

// ---------------------------------------------------------------------------
// 命令(Intent 落到引擎的形态)。所有命令带 issuer;synthetic 表示由定时器/AI 合成。
// ---------------------------------------------------------------------------

export interface BaseCommand {
  issuer: SeatId;
  /** 由定时器超时或 AI 托管合成的命令。 */
  synthetic?: boolean;
}

export type Command =
  | (BaseCommand & { type: "StartGame" })
  | (BaseCommand & { type: "RollDice" })
  | (BaseCommand & { type: "BuyProperty" })
  | (BaseCommand & { type: "DeclineBuy" })
  | (BaseCommand & { type: "BuildHouse"; tileIndex: number })
  | (BaseCommand & { type: "Mortgage"; tileIndex: number })
  | (BaseCommand & { type: "Redeem"; tileIndex: number })
  | (BaseCommand & {
      type: "ProposeTrade";
      counterparty: SeatId;
      giveProperties: number[];
      giveCash: number;
      getProperties: number[];
      getCash: number;
    })
  | (BaseCommand & { type: "RespondTrade"; action: "accept" | "reject" | "counter"; counter?: TradeCounter })
  | (BaseCommand & { type: "PlaceBid"; amount: number })
  | (BaseCommand & { type: "PassBid" })
  | (BaseCommand & { type: "EndTurn" })
  | (BaseCommand & { type: "SetConnection"; target: SeatId; status: ConnectionStatus })
  | (BaseCommand & { type: "Timeout"; kind: TimerKind; epoch: number });

/** 还价内容(站在原发起方视角重新表述报价)。 */
export interface TradeCounter {
  giveProperties: number[];
  giveCash: number;
  getProperties: number[];
  getCash: number;
}

// ---------------------------------------------------------------------------
// 事件(服务端 -> 客户端广播)。客户端据此渲染,所有结果以事件为准。
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: "GameStarted"; order: SeatId[] }
  | { type: "TurnChanged"; seatId: SeatId }
  | { type: "DiceRolled"; seatId: SeatId; dice: [number, number]; doubles: boolean }
  | { type: "PlayerMoved"; seatId: SeatId; from: number; to: number; passedStart: boolean }
  | { type: "PropertyOffered"; seatId: SeatId; tileIndex: number; price: number }
  | { type: "PropertyBought"; seatId: SeatId; tileIndex: number; price: number }
  | { type: "RentPaid"; from: SeatId; to: SeatId; amount: number; tileIndex: number }
  | { type: "TaxPaid"; seatId: SeatId; amount: number }
  | { type: "CardDrawn"; seatId: SeatId; deck: "chance" | "fate"; text: string }
  | { type: "CashChanged"; seatId: SeatId; delta: number; cash: number }
  | { type: "SentToJail"; seatId: SeatId }
  | { type: "LeftJail"; seatId: SeatId; reason: "doubles" | "fine" | "card" }
  | { type: "HouseBuilt"; seatId: SeatId; tileIndex: number; level: number }
  | { type: "Mortgaged"; seatId: SeatId; tileIndex: number; amount: number }
  | { type: "Redeemed"; seatId: SeatId; tileIndex: number; amount: number }
  | { type: "TradeProposed"; offer: TradeOffer }
  | { type: "TradeCountered"; offer: TradeOffer }
  | { type: "TradeResolved"; result: "accepted" | "rejected"; reason?: "timeout" | "offline" | "declined" }
  | { type: "AuctionStarted"; tileIndex: number; order: SeatId[] }
  | { type: "BidPlaced"; seatId: SeatId; amount: number }
  | { type: "BidPassed"; seatId: SeatId; reason?: "timeout" | "offline" }
  | { type: "AuctionResolved"; result: "sold" | "passed-in"; winner?: SeatId; amount?: number; tileIndex: number }
  | { type: "PlayerBankrupt"; seatId: SeatId }
  | { type: "ConnectionChanged"; seatId: SeatId; status: ConnectionStatus }
  | { type: "TimerStarted"; kind: TimerKind; epoch: number; durationMs: number }
  | { type: "TimerCleared" }
  | { type: "GameEnded"; ranking: { seatId: SeatId; netWorth: number; rank: number }[] }
  | { type: "Rejected"; reason: string };

export interface ReduceResult {
  state: GameState;
  events: GameEvent[];
}
