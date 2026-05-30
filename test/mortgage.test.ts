/** §4B 抵押/赎回回归(对照 05-acceptance TC-MORTGAGE-01..04)。 */
import { describe, expect, it } from "vitest";
import { rentFor } from "../src/engine/helpers.js";
import { cashOf, find, propertyTiles, setOwner, startedGame, step } from "./setup.js";

function mortgageScenario() {
  const s = startedGame(4);
  const tile = propertyTiles(s)[0]!; // p0 当前回合,持有这块地产
  setOwner(s, tile, "p0");
  const price = s.config.tiles[tile]!.property!.price;
  return { s, tile, price };
}

describe("TC-MORTGAGE", () => {
  it("TC-MORTGAGE-01 抵押取现:获现金≈地产价 50%,标记被抵押", () => {
    const { s, tile, price } = mortgageScenario();
    const before = cashOf(s, "p0");
    const h = step(s, { type: "Mortgage", issuer: "p0", tileIndex: tile });
    const ev = find(h.events, "Mortgaged");
    expect(ev?.amount).toBe(Math.floor(price * 0.5));
    expect(cashOf(h.state, "p0")).toBe(before + Math.floor(price * 0.5));
    expect(h.state.properties.find((p) => p.tileIndex === tile)?.mortgaged).toBe(true);
  });

  it("TC-MORTGAGE-02 赎回:付 抵押价 + 10% 利息,恢复可收租", () => {
    const { s, tile, price } = mortgageScenario();
    let h = step(s, { type: "Mortgage", issuer: "p0", tileIndex: tile });
    const afterMortgage = cashOf(h.state, "p0");
    h = step(h.state, { type: "Redeem", issuer: "p0", tileIndex: tile });
    const cost = Math.ceil(Math.floor(price * 0.5) * 1.1);
    expect(find(h.events, "Redeemed")?.amount).toBe(cost);
    expect(cashOf(h.state, "p0")).toBe(afterMortgage - cost);
    expect(h.state.properties.find((p) => p.tileIndex === tile)?.mortgaged).toBe(false);
  });

  it("TC-MORTGAGE-03 被抵押地产不收租:他人落到不触发过路费", () => {
    const { s, tile } = mortgageScenario();
    // 抵押前该地产有正租金。
    expect(rentFor(s, tile)).toBeGreaterThan(0);
    // 抵押后,引擎落点结算的租金为 0(resolveLanding/helpers.rentFor 守卫)。
    const h = step(s, { type: "Mortgage", issuer: "p0", tileIndex: tile });
    expect(h.state.properties.find((p) => p.tileIndex === tile)?.mortgaged).toBe(true);
    expect(rentFor(h.state, tile)).toBe(0);
  });

  it("TC-MORTGAGE-04 仅自回合:非自回合尝试抵押被拒", () => {
    const { s } = mortgageScenario();
    const other = propertyTiles(s)[1]!;
    setOwner(s, other, "p1");
    // 当前是 p0 回合;p1 尝试抵押自己的地产 -> 被拒。
    const h = step(s, { type: "Mortgage", issuer: "p1", tileIndex: other });
    expect(find(h.events, "Rejected")?.reason).toBe("mortgage-only-on-own-turn");
  });
});
