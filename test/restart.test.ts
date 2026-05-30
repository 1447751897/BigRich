/** 「再来一局」:对局结束后重置回 lobby,保留座位、可继续开局且骰子流不复位。 */
import { describe, expect, it } from "vitest";
import { createGame, reduce } from "../src/engine/engine.js";
import { find } from "./setup.js";

/** 起一局两人对局,(可选)掷一把推进 RNG 流,再强制结算到 ended。 */
function endedGame(seed?: number, roll = false) {
  let s = createGame(
    "r",
    [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ],
    seed === undefined ? {} : { seed },
  );
  s = reduce(s, { type: "StartGame", issuer: "p0" }).state;
  if (roll) s = reduce(s, { type: "RollDice", issuer: "p0" }).state; // 推进 rngState,模拟对局中已掷过骰
  s = reduce(s, { type: "ForceSettle", issuer: "system", reason: "time-limit" }).state;
  expect(s.phase).toBe("ended");
  return s;
}

describe("RestartGame 再来一局", () => {
  it("把已结束对局重置回 lobby,保留座位与座次,清零游戏内数值", () => {
    let s = endedGame();
    // 制造一些非初始数值,确认会被复位。
    s.players[0]!.cash = 1;
    s.players[0]!.position = 9;
    s.properties[0]!.ownerSeatId = "p0";
    s.properties[0]!.houseLevel = 3;

    const r = reduce(s, { type: "RestartGame", issuer: "p0" });
    expect(find(r.events, "GameReset")).toBeDefined();
    const st = r.state;
    expect(st.phase).toBe("lobby");
    // 座位 / 座次保留
    expect(st.players.map((p) => p.seatId)).toEqual(["p0", "p1"]);
    expect(st.order).toEqual(["p0", "p1"]);
    // 游戏内数值复位
    expect(st.players[0]!.cash).toBe(st.config.startingCash);
    expect(st.players[0]!.position).toBe(0);
    expect(st.players.every((p) => p.status === "active")).toBe(true);
    expect(st.properties.every((p) => p.ownerSeatId === null && p.houseLevel === 0 && !p.mortgaged)).toBe(true);
    expect(st.ranking).toEqual([]);
    expect(st.timer).toBeNull();
  });

  it("重置后可由房主重新开始,且续用 RNG 流(下一局骰子序列不同于上一局开局)", () => {
    // 同一 seed:第一局的首掷
    const first = createGame(
      "r",
      [
        { seatId: "p0", displayName: "A" },
        { seatId: "p1", displayName: "B" },
      ],
      { seed: 42 },
    );
    const firstStarted = reduce(first, { type: "StartGame", issuer: "p0" }).state;
    const firstRoll = find(reduce(firstStarted, { type: "RollDice", issuer: "p0" }).events, "DiceRolled")!.dice;

    // 走到结算(对局中已掷过骰,rngState 已推进),再来一局,重新开始后的首掷
    let s = endedGame(42, true);
    s = reduce(s, { type: "RestartGame", issuer: "p0" }).state;
    expect(s.phase).toBe("lobby");
    const restarted = reduce(s, { type: "StartGame", issuer: "p0" }).state;
    const nextRoll = find(reduce(restarted, { type: "RollDice", issuer: "p0" }).events, "DiceRolled")!.dice;

    // 续用 RNG 流:重开后的骰子不应等于"从同种子重新开局"的首掷(否则就是确定性复位的 bug)。
    expect(nextRoll).not.toEqual(firstRoll);
  });

  it("对非 ended 状态的 RestartGame 是拒绝(lobby/playing 不可重开)", () => {
    const lobby = createGame("r", [{ seatId: "p0", displayName: "A" }]);
    const r = reduce(lobby, { type: "RestartGame", issuer: "p0" });
    expect(find(r.events, "Rejected")?.reason).toBe("game-not-ended");
    expect(r.state.phase).toBe("lobby");
  });
});
