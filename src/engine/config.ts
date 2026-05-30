/**
 * §4A 数值基线 -> 默认 GameConfig(全部参数化,不写死在逻辑里)。
 *
 * 这里生成一张 28 格棋盘(4 边 × 7 格),6 组彩色地产、4 个角、机会/命运/税收若干。
 * 数值是 PRD §4A 的"起步默认值",可在建房时整体覆盖以做试玩调参。
 */
import type { CardDef, GameConfig, PropertyDef, TileDef } from "./types.js";

/** 角的位置(28 格:0/7/14/21)。 */
const CORNERS = { start: 0, jail: 7, freeparking: 14, gotojail: 21 };

/** 6 组彩色地产,每组 3 块 = 18 块地产。去 IP 化:用中性色名。 */
const GROUPS: { id: string; name: string; price: number; baseRent: number }[] = [
  { id: "teal", name: "青", price: 100, baseRent: 6 },
  { id: "amber", name: "琥珀", price: 140, baseRent: 10 },
  { id: "coral", name: "珊瑚", price: 180, baseRent: 14 },
  { id: "violet", name: "紫罗兰", price: 220, baseRent: 18 },
  { id: "indigo", name: "靛蓝", price: 260, baseRent: 22 },
  { id: "crimson", name: "绯红", price: 320, baseRent: 28 },
];

/** 由基础租金推出整条租金曲线(§4A:×5/×15/×40/×60,旅馆再翻倍)。 */
function rentTable(base: number): number[] {
  return [base, base * 5, base * 15, base * 40, base * 60, base * 120];
}

function propertyDef(g: { price: number; baseRent: number; id: string }): PropertyDef {
  return {
    groupId: g.id,
    price: g.price,
    housePrice: Math.round(g.price * 0.6), // §4A:每栋房 ≈ 地产价 50–70%
    rentTable: rentTable(g.baseRent),
  };
}

/**
 * 生成 28 格棋盘。
 * 非角格共 24 个:18 块地产(6 组 ×3)+ 机会×2 + 命运×2 + 税收×2。
 * 地产按组穿插铺开,角位固定。
 */
function defaultBoard(): TileDef[] {
  const tiles: TileDef[] = new Array(28);
  // 角
  tiles[CORNERS.start] = { index: 0, type: "start", name: "起点" };
  tiles[CORNERS.jail] = { index: 7, type: "jail", name: "探监" };
  tiles[CORNERS.freeparking] = { index: 14, type: "freeparking", name: "免费停车" };
  tiles[CORNERS.gotojail] = { index: 21, type: "gotojail", name: "入狱" };

  // 18 块地产铺位(避开角)。
  const propertySlots = [1, 2, 4, 5, 8, 9, 11, 12, 13, 15, 16, 18, 19, 20, 22, 24, 25, 26];
  // 每组 3 块,顺序铺设。
  let slotIdx = 0;
  for (const g of GROUPS) {
    for (let k = 0; k < 3; k++) {
      const idx = propertySlots[slotIdx++]!;
      tiles[idx] = {
        index: idx,
        type: "property",
        name: `${g.name}${k + 1}`,
        property: propertyDef(g),
      };
    }
  }

  // 剩余非角、非地产格:机会×2、命运×2、税收×2。
  const specials: { idx: number; type: TileDef["type"]; name: string; taxAmount?: number }[] = [
    { idx: 3, type: "chance", name: "机会" },
    { idx: 6, type: "tax", name: "税收", taxAmount: 100 },
    { idx: 10, type: "fate", name: "命运" },
    { idx: 17, type: "chance", name: "机会" },
    { idx: 23, type: "fate", name: "命运" },
    { idx: 27, type: "tax", name: "税收", taxAmount: 75 },
  ];
  for (const s of specials) {
    tiles[s.idx] = { index: s.idx, type: s.type, name: s.name, taxAmount: s.taxAmount };
  }

  return tiles;
}

function defaultChanceDeck(): CardDef[] {
  return [
    { id: "c1", text: "银行分红,获得 100", effect: { kind: "gain", amount: 100 } },
    { id: "c2", text: "缴纳手续费 60", effect: { kind: "pay", amount: 60 } },
    { id: "c3", text: "前往起点", effect: { kind: "move", toIndex: 0 } },
    { id: "c4", text: "立即入狱", effect: { kind: "gotojail" } },
    { id: "c5", text: "获得一张出狱卡", effect: { kind: "getout" } },
    { id: "c6", text: "中奖,获得 50", effect: { kind: "gain", amount: 50 } },
  ];
}

function defaultFateDeck(): CardDef[] {
  return [
    { id: "f1", text: "缴税 80", effect: { kind: "pay", amount: 80 } },
    { id: "f2", text: "退税,获得 120", effect: { kind: "gain", amount: 120 } },
    { id: "f3", text: "前往免费停车", effect: { kind: "move", toIndex: 14 } },
    { id: "f4", text: "罚款 40", effect: { kind: "pay", amount: 40 } },
    { id: "f5", text: "获得一张出狱卡", effect: { kind: "getout" } },
    { id: "f6", text: "理财收益,获得 70", effect: { kind: "gain", amount: 70 } },
  ];
}

/** §4A 默认数值基线。深拷贝以免调用方误改共享引用。 */
export function defaultConfig(): GameConfig {
  return {
    tiles: defaultBoard(),
    startingCash: 1500,
    passStartBonus: 200,
    fullGroupRentMultiplier: 2,
    mortgageRatio: 0.5,
    redeemInterestRatio: 0.1,
    maxJailTurns: 3,
    jailFine: 50,
    turnTimerSec: 25,
    tradeTimerSec: 20,
    auctionTimerSec: 10,
    hardTimeLimitMin: 30,
    maxTurnsPerPlayer: 20,
    aiCashSafetyFloor: 200,
    chanceDeck: defaultChanceDeck(),
    fateDeck: defaultFateDeck(),
  };
}
