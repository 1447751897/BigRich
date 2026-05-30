/** 回合主循环 + 服务端权威 + 收束的核心冒烟测试。 */
import { describe, expect, it } from "vitest";
import { createGame, reduce } from "../src/engine/engine.js";
import { rollDice } from "../src/engine/rng.js";
import { find, startedGame, step, timerKind } from "./setup.js";

describe("core 回合主循环", () => {
  it("服务端权威 RNG:同一 seed 掷骰结果可复现(掷骰只在引擎)", () => {
    const a = rollDice(999);
    const b = rollDice(999);
    expect(a.dice).toEqual(b.dice);
    expect(a.dice[0]).toBeGreaterThanOrEqual(1);
    expect(a.dice[0]).toBeLessThanOrEqual(6);
  });

  it("开局:StartGame 切到 playing、轮到 p0、起步主时钟", () => {
    const s = startedGame(4);
    expect(s.phase).toBe("playing");
    expect(s.order[s.currentIndex]).toBe("p0");
    expect(timerKind(s)).toBe("turn");
  });

  it("掷骰 -> 移动 -> EndTurn 轮转到下一玩家", () => {
    const s = startedGame(2);
    let h = step(s, { type: "RollDice", issuer: "p0" });
    expect(find(h.events, "DiceRolled")?.seatId).toBe("p0");
    expect(find(h.events, "PlayerMoved")?.seatId).toBe("p0");
    // 若落到无主地产则先决策,这里统一先把可能的待购清掉。
    if (h.state.turnPhase === "awaiting-buy") {
      h = step(h.state, { type: "DeclineBuy", issuer: "p0" });
      // 2 人局:p0 不买 -> 拍卖,跑完后回 p0;为简化冒烟,放弃拍卖。
      while (h.state.turnPhase === "auction") {
        const bidder = h.state.auction!.order[h.state.auction!.turnPtr]!;
        h = step(h.state, { type: "PassBid", issuer: bidder });
      }
    }
    h = step(h.state, { type: "EndTurn", issuer: "p0" });
    expect(find(h.events, "TurnChanged")?.seatId).toBe("p1");
  });

  it("非当前回合玩家掷骰被拒(服务端校验)", () => {
    const s = startedGame(2);
    const h = step(s, { type: "RollDice", issuer: "p1" });
    expect(find(h.events, "Rejected")?.reason).toBe("not-your-turn");
  });

  it("回合上限触发结算:任一玩家完成 maxTurnsPerPlayer 即按净资产排名", () => {
    const s = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ], { config: { ...createGame("r2", [{ seatId: "x", displayName: "x" }]).config, maxTurnsPerPlayer: 1 } });
    let h = step(s, { type: "StartGame", issuer: "p0" });
    // p0 掷骰后结束回合 -> turnsTaken=1 == 上限 -> 结算。
    h = step(h.state, { type: "RollDice", issuer: "p0" });
    while (h.state.turnPhase === "awaiting-buy") {
      h = step(h.state, { type: "DeclineBuy", issuer: "p0" });
      while (h.state.turnPhase === "auction") {
        const bidder = h.state.auction!.order[h.state.auction!.turnPtr]!;
        h = step(h.state, { type: "PassBid", issuer: bidder });
      }
    }
    if (h.state.phase === "playing") {
      h = step(h.state, { type: "EndTurn", issuer: "p0" });
    }
    expect(h.state.phase).toBe("ended");
    expect(find(h.events, "GameEnded")?.ranking.length).toBe(2);
  });
});
