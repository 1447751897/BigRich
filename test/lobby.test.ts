/** lobby 动态加入(JoinSeat)+ 开局流程。 */
import { describe, expect, it } from "vitest";
import { createGame, reduce } from "../src/engine/engine.js";
import { find } from "./setup.js";

describe("lobby JoinSeat", () => {
  it("空房动态加入两人后可开局", () => {
    let s = createGame("r", []); // 空座位建房
    expect(s.players.length).toBe(0);
    s = reduce(s, { type: "JoinSeat", issuer: "host", seatId: "s1", displayName: "房主" }).state;
    s = reduce(s, { type: "JoinSeat", issuer: "host", seatId: "s2", displayName: "小明" }).state;
    expect(s.players.length).toBe(2);
    expect(s.order).toEqual(["s1", "s2"]);
    const r = reduce(s, { type: "StartGame", issuer: "s1" });
    expect(find(r.events, "GameStarted")).toBeTruthy();
    expect(r.state.phase).toBe("playing");
  });

  it("重复座位 / 开局后加入被拒", () => {
    let s = createGame("r", []);
    s = reduce(s, { type: "JoinSeat", issuer: "h", seatId: "s1", displayName: "A" }).state;
    const dup = reduce(s, { type: "JoinSeat", issuer: "h", seatId: "s1", displayName: "A2" });
    expect(find(dup.events, "Rejected")?.reason).toBe("seat-taken");

    s = reduce(s, { type: "JoinSeat", issuer: "h", seatId: "s2", displayName: "B" }).state;
    s = reduce(s, { type: "StartGame", issuer: "s1" }).state;
    const late = reduce(s, { type: "JoinSeat", issuer: "h", seatId: "s3", displayName: "C" });
    expect(find(late.events, "Rejected")?.reason).toBe("game-already-started");
  });
});
