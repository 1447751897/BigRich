/** §4B 交易子状态机回归(对照 05-acceptance TC-TRADE-01..09)。 */
import { describe, expect, it } from "vitest";
import { reduce } from "../src/engine/engine.js";
import {
  cashOf,
  find,
  ownerOf,
  propertyTiles,
  setCash,
  setOwner,
  startedGame,
  step,
  timerEpoch,
  timerKind,
} from "./setup.js";

/** 构造:p0(当前回合)持地产 A,p1 持地产 B,现金可控。 */
function tradeScenario(p0Cash = 1000, p1Cash = 1000) {
  const s = startedGame(4);
  const [a, b] = propertyTiles(s);
  setOwner(s, a!, "p0");
  setOwner(s, b!, "p1");
  setCash(s, "p0", p0Cash);
  setCash(s, "p1", p1Cash);
  return { s, a: a!, b: b! };
}

describe("TC-TRADE", () => {
  it("TC-TRADE-01 正常接受:原子过户 + 现金双向结算,资金守恒,回到 P 回合并恢复主时钟", () => {
    const { s, a, b } = tradeScenario();
    const totalBefore = cashOf(s, "p0") + cashOf(s, "p1");
    // p0 用 地产A + 100 现金 换 p1 的 地产B。
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 100,
      getProperties: [b],
      getCash: 0,
    });
    expect(timerKind(h.state)).toBe("trade"); // 主时钟挂起,跑交易子时钟
    h = step(h.state, { type: "RespondTrade", issuer: "p1", action: "accept" });

    expect(find(h.events, "TradeResolved")?.result).toBe("accepted");
    expect(ownerOf(h.state, a)).toBe("p1");
    expect(ownerOf(h.state, b)).toBe("p0");
    expect(cashOf(h.state, "p0")).toBe(1000 - 100);
    expect(cashOf(h.state, "p1")).toBe(1000 + 100);
    expect(cashOf(h.state, "p0") + cashOf(h.state, "p1")).toBe(totalBefore); // 资金守恒
    expect(h.state.turnPhase).toBe("normal");
    expect(timerKind(h.state)).toBe("turn"); // 主时钟恢复
  });

  it("TC-TRADE-02 拒绝:交易作废、无任何资产变动、恢复主时钟", () => {
    const { s, a, b } = tradeScenario();
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    h = step(h.state, { type: "RespondTrade", issuer: "p1", action: "reject" });
    expect(find(h.events, "TradeResolved")?.result).toBe("rejected");
    expect(ownerOf(h.state, a)).toBe("p0");
    expect(ownerOf(h.state, b)).toBe("p1");
    expect(h.state.turnPhase).toBe("normal");
    expect(timerKind(h.state)).toBe("turn");
  });

  it("TC-TRADE-03 还价仅 1 次:Q 还价 -> P 接受过户;Q 不能二次还价", () => {
    const { s, a, b } = tradeScenario();
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    // Q(p1)还价:要求 p0 再补 50 现金。
    h = step(h.state, {
      type: "RespondTrade",
      issuer: "p1",
      action: "counter",
      counter: { giveProperties: [a], giveCash: 50, getProperties: [b], getCash: 0 },
    });
    expect(find(h.events, "TradeCountered")).toBeTruthy();
    expect(h.state.trade?.awaiting).toBe("p0"); // 计时切回发起方
    expect(timerKind(h.state)).toBe("trade");

    // 发起方 p0 接受还价。
    h = step(h.state, { type: "RespondTrade", issuer: "p0", action: "accept" });
    expect(find(h.events, "TradeResolved")?.result).toBe("accepted");
    expect(ownerOf(h.state, a)).toBe("p1");
    expect(ownerOf(h.state, b)).toBe("p0");
    expect(cashOf(h.state, "p0")).toBe(1000 - 50);
  });

  it("TC-TRADE-03b 还价不可再被还价:对方第二次 counter 被拒", () => {
    const { s, a, b } = tradeScenario();
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    h = step(h.state, {
      type: "RespondTrade",
      issuer: "p1",
      action: "counter",
      counter: { giveProperties: [a], giveCash: 50, getProperties: [b], getCash: 0 },
    });
    // 现在 awaiting=p0。p1 不能再操作;且 counter 已用尽。让 p0 尝试 counter -> 应被拒。
    h = step(h.state, {
      type: "RespondTrade",
      issuer: "p0",
      action: "counter",
      counter: { giveProperties: [a], giveCash: 0, getProperties: [b], getCash: 0 },
    });
    expect(find(h.events, "Rejected")).toBeTruthy();
    expect(h.state.trade).not.toBeNull(); // 交易仍在等待 p0 的 接受/拒绝
  });

  it("TC-TRADE-04 对方响应超时:自动拒绝", () => {
    const { s, a, b } = tradeScenario();
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    const ep = timerEpoch(h.state);
    h = step(h.state, { type: "Timeout", issuer: "system", kind: "trade", epoch: ep });
    expect(find(h.events, "TradeResolved")?.reason).toBe("timeout");
    expect(ownerOf(h.state, a)).toBe("p0");
    expect(timerKind(h.state)).toBe("turn");
  });

  it("TC-TRADE-05 还价后发起方超时:自动拒绝", () => {
    const { s, a, b } = tradeScenario();
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    h = step(h.state, {
      type: "RespondTrade",
      issuer: "p1",
      action: "counter",
      counter: { giveProperties: [a], giveCash: 50, getProperties: [b], getCash: 0 },
    });
    const ep = timerEpoch(h.state);
    h = step(h.state, { type: "Timeout", issuer: "system", kind: "trade", epoch: ep });
    expect(find(h.events, "TradeResolved")?.reason).toBe("timeout");
    expect(ownerOf(h.state, a)).toBe("p0");
  });

  it("TC-TRADE-06 计时隔离:交易期间主回合时钟暂停,只有一个时钟在跑", () => {
    const { s, a, b } = tradeScenario();
    const turnEpochBefore = timerEpoch(s);
    expect(timerKind(s)).toBe("turn");
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    // 进入交易:活跃时钟变为 trade,turn 时钟的旧 epoch 已被取代。
    expect(timerKind(h.state)).toBe("trade");
    // 旧的 turn Timeout 现在是过期命令,应被忽略(不影响交易)。
    const stale = step(h.state, { type: "Timeout", issuer: "system", kind: "turn", epoch: turnEpochBefore });
    expect(stale.events.length).toBe(0); // 过期计时器被静默忽略
    expect(stale.state.turnPhase).toBe("trade"); // 交易未受影响
  });

  it("TC-TRADE-07 非法报价:现金不足 / 归属不符 -> 服务端拒绝,报价不成立", () => {
    const { s, a, b } = tradeScenario(1000, 1000);
    // 报价含 p0 现金 2000 > 余额 1000。
    let h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 2000,
      getProperties: [b],
      getCash: 0,
    });
    expect(find(h.events, "Rejected")).toBeTruthy();
    expect(h.state.turnPhase).toBe("normal");
    expect(h.state.trade).toBeNull();

    // 报价含归属不符:p0 索取一块不属于 p1 的地产。
    const other = propertyTiles(s)[5]!; // 无主
    h = step(s, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [other],
      getCash: 0,
    });
    expect(find(h.events, "Rejected")).toBeTruthy();
    expect(h.state.trade).toBeNull();
  });

  it("TC-TRADE-08 对方掉线:AI 托管被动一律拒绝,交易作废不卡场", () => {
    const { s, a, b } = tradeScenario();
    // 标记 p1 掉线/托管。
    let h = step(s, { type: "SetConnection", issuer: "system", target: "p1", status: "offline" });
    h = step(h.state, {
      type: "ProposeTrade",
      issuer: "p0",
      counterparty: "p1",
      giveProperties: [a],
      giveCash: 0,
      getProperties: [b],
      getCash: 0,
    });
    expect(find(h.events, "TradeResolved")?.reason).toBe("offline");
    expect(ownerOf(h.state, a)).toBe("p0");
    expect(h.state.turnPhase).toBe("normal");
    expect(timerKind(h.state)).toBe("turn"); // 主时钟恢复,不卡场
  });

  it("TC-TRADE-09 仅自回合可发起:非当前回合玩家发起被拒", () => {
    const { s, a, b } = tradeScenario();
    // 当前是 p0 回合;p1 尝试发起。
    const h = step(s, {
      type: "ProposeTrade",
      issuer: "p1",
      counterparty: "p2",
      giveProperties: [b],
      giveCash: 0,
      getProperties: [],
      getCash: 0,
    });
    expect(find(h.events, "Rejected")?.reason).toBe("trade-only-on-own-turn");
    expect(h.state.trade).toBeNull();
  });
});
