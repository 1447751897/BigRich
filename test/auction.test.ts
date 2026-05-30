/** §4B 拍卖子状态机回归(对照 05-acceptance TC-AUCTION-01..08)。 */
import { describe, expect, it } from "vitest";
import {
  cashOf,
  find,
  ownerOf,
  propertyTiles,
  setCash,
  startedGame,
  step,
  timerEpoch,
  timerKind,
} from "./setup.js";
import type { GameState } from "../src/engine/types.js";

/** 让 p0(当前回合)落到无主地产 tile 并处于待购买决策态。 */
function auctionReady(): { s: GameState; tile: number } {
  const s = startedGame(4);
  const tile = propertyTiles(s)[0]!;
  s.turnPhase = "awaiting-buy";
  s.pendingBuyTile = tile;
  s.rolledThisTurn = true;
  return { s, tile };
}

describe("TC-AUCTION", () => {
  it("TC-AUCTION-01 不买触发拍卖:对全体在局玩家公开,挂起主时钟,自 P 下家起轮转", () => {
    const { s, tile } = auctionReady();
    const h = step(s, { type: "DeclineBuy", issuer: "p0" });
    const started = find(h.events, "AuctionStarted");
    expect(started?.tileIndex).toBe(tile);
    expect(started?.order).toEqual(["p1", "p2", "p3", "p0"]); // 自 P 下家起,P 本人最后
    expect(h.state.turnPhase).toBe("auction");
    expect(timerKind(h.state)).toBe("auction");
  });

  it("TC-AUCTION-02 正常成交:轮流加价,连续一轮无人加价 -> 成交给最高价者并扣现金过户", () => {
    const { s, tile } = auctionReady();
    let h = step(s, { type: "DeclineBuy", issuer: "p0" });
    h = step(h.state, { type: "PlaceBid", issuer: "p1", amount: 100 });
    h = step(h.state, { type: "PassBid", issuer: "p2" });
    h = step(h.state, { type: "PassBid", issuer: "p3" });
    h = step(h.state, { type: "PassBid", issuer: "p0" });
    const resolved = find(h.events, "AuctionResolved");
    expect(resolved?.result).toBe("sold");
    expect(resolved?.winner).toBe("p1");
    expect(resolved?.amount).toBe(100);
    expect(ownerOf(h.state, tile)).toBe("p1");
    expect(h.state.turnPhase).toBe("normal");
    expect(timerKind(h.state)).toBe("turn"); // 恢复主时钟
  });

  it("TC-AUCTION-03 全员放弃流拍:地产维持无主,回 P 回合", () => {
    const { s, tile } = auctionReady();
    let h = step(s, { type: "DeclineBuy", issuer: "p0" });
    h = step(h.state, { type: "PassBid", issuer: "p1" });
    h = step(h.state, { type: "PassBid", issuer: "p2" });
    h = step(h.state, { type: "PassBid", issuer: "p3" });
    h = step(h.state, { type: "PassBid", issuer: "p0" });
    expect(find(h.events, "AuctionResolved")?.result).toBe("passed-in");
    expect(ownerOf(h.state, tile)).toBeNull();
    expect(h.state.turnPhase).toBe("normal");
  });

  it("TC-AUCTION-04 出价原子性·同价:后出的同价被拒,不出现同价并存", () => {
    const { s } = auctionReady();
    let h = step(s, { type: "DeclineBuy", issuer: "p0" });
    h = step(h.state, { type: "PlaceBid", issuer: "p1", amount: 100 }); // p1 先到,成为最高价
    // 轮到 p2,出相同的 100 -> 因"不高于当前最高价"被拒。
    const r = step(h.state, { type: "PlaceBid", issuer: "p2", amount: 100 });
    expect(find(r.events, "Rejected")?.reason).toBe("bid-not-higher-than-current");
    expect(r.state.auction?.currentHigh).toBe(100);
    expect(r.state.auction?.currentHighSeat).toBe("p1"); // 仅先到者生效
  });

  it("TC-AUCTION-05 出价原子性·超额:超过现金被拒,可在本轮内重出合法价", () => {
    const { s } = auctionReady();
    setCash(s, "p1", 50);
    let h = step(s, { type: "DeclineBuy", issuer: "p0" });
    // 轮到 p1(下家),出 100 > 现金 50 -> 被拒。
    let r = step(h.state, { type: "PlaceBid", issuer: "p1", amount: 100 });
    expect(find(r.events, "Rejected")?.reason).toBe("bid-exceeds-cash");
    expect(r.state.auction?.currentHighSeat).toBeNull();
    // p1 仍是当前出价者,改出合法价 40。
    expect(r.state.auction?.order[r.state.auction.turnPtr]).toBe("p1");
    r = step(r.state, { type: "PlaceBid", issuer: "p1", amount: 40 });
    expect(r.state.auction?.currentHigh).toBe(40);
    expect(r.state.auction?.currentHighSeat).toBe("p1");
  });

  it("TC-AUCTION-06 单轮超时=放弃:超时则当前出价者放弃,由此连续一轮无人加价则成交", () => {
    const { s, tile } = auctionReady();
    let h = step(s, { type: "DeclineBuy", issuer: "p0" });
    h = step(h.state, { type: "PlaceBid", issuer: "p1", amount: 100 });
    // 轮到 p2,超时 -> 放弃。
    let ep = timerEpoch(h.state);
    h = step(h.state, { type: "Timeout", issuer: "system", kind: "auction", epoch: ep });
    // 轮到 p3,超时 -> 放弃。
    ep = timerEpoch(h.state);
    h = step(h.state, { type: "Timeout", issuer: "system", kind: "auction", epoch: ep });
    // 轮到 p0,超时 -> 放弃 -> 仅剩 p1 -> 成交。
    ep = timerEpoch(h.state);
    h = step(h.state, { type: "Timeout", issuer: "system", kind: "auction", epoch: ep });
    expect(find(h.events, "AuctionResolved")?.result).toBe("sold");
    expect(ownerOf(h.state, tile)).toBe("p1");
  });

  it("TC-AUCTION-07 掉线者参与:掉线玩家被托管直接放弃,不阻塞轮转", () => {
    const { s } = auctionReady();
    const off = step(s, { type: "SetConnection", issuer: "system", target: "p1", status: "offline" });
    const h = step(off.state, { type: "DeclineBuy", issuer: "p0" });
    // p1 是下家但掉线 -> 应在开拍时被自动放弃,当前轮到 p2。
    expect(h.state.auction?.passed).toContain("p1");
    expect(find(h.events, "BidPassed")).toBeTruthy();
    expect(h.state.auction?.order[h.state.auction.turnPtr]).toBe("p2");
  });

  it("TC-AUCTION-08 成交资金守恒:买方现金减少额=成交价,地产单一归属", () => {
    const { s, tile } = auctionReady();
    const before = cashOf(s, "p1");
    let h = step(s, { type: "DeclineBuy", issuer: "p0" });
    h = step(h.state, { type: "PlaceBid", issuer: "p1", amount: 120 });
    h = step(h.state, { type: "PassBid", issuer: "p2" });
    h = step(h.state, { type: "PassBid", issuer: "p3" });
    h = step(h.state, { type: "PassBid", issuer: "p0" });
    expect(cashOf(h.state, "p1")).toBe(before - 120);
    expect(ownerOf(h.state, tile)).toBe("p1");
    // 单一归属:其它人都不拥有该地产。
    const owners = h.state.properties.filter((p) => p.tileIndex === tile);
    expect(owners.length).toBe(1);
  });
});
