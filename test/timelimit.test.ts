/** P0①:30 分钟时长硬上限接 wall-clock 强制结算。 */
import { describe, expect, it } from "vitest";
import { createGame, reduce } from "../src/engine/engine.js";
import { RoomRuntime, type Scheduler } from "../src/gateway/room.js";
import type { GameEvent } from "../src/engine/types.js";
import { find } from "./setup.js";

/** 多定时器假时钟:记录所有 set 的定时器,可按 ms 触发指定的那个。 */
function multiScheduler() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const sched: Scheduler & { timers: typeof timers; fireLargest: () => void } = {
    set(fn, ms) {
      const h = ++id;
      timers.set(h, { fn, ms });
      return h;
    },
    clear(h) {
      timers.delete(h);
    },
    timers,
    fireLargest() {
      let best = -1;
      let bestMs = -1;
      for (const [h, t] of timers) if (t.ms > bestMs) (bestMs = t.ms), (best = h);
      const t = timers.get(best);
      timers.delete(best);
      t?.fn();
    },
  };
  return sched;
}

describe("时长硬上限强制结算", () => {
  it("引擎 ForceSettle 立即按净资产结算,reason=time-limit", () => {
    let s = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ]);
    s = reduce(s, { type: "StartGame", issuer: "p0" }).state;
    const r = reduce(s, { type: "ForceSettle", issuer: "system", reason: "time-limit" });
    expect(r.state.phase).toBe("ended");
    expect(find(r.events, "GameEnded")?.reason).toBe("time-limit");
    expect(r.state.ranking.length).toBe(2);
  });

  it("ForceSettle 对已结束的对局是 no-op", () => {
    let s = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ]);
    s = reduce(s, { type: "StartGame", issuer: "p0" }).state;
    s = reduce(s, { type: "ForceSettle", issuer: "system", reason: "time-limit" }).state;
    const again = reduce(s, { type: "ForceSettle", issuer: "system", reason: "time-limit" });
    expect(find(again.events, "GameEnded")).toBeUndefined();
  });

  it("RoomRuntime 开局即挂 30 分钟硬上限定时器,到点 -> 强制结算", () => {
    const sched = multiScheduler();
    const seen: GameEvent[] = [];
    const initial = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ]);
    const room = new RoomRuntime(initial, { broadcast: (e) => seen.push(...e), scheduler: sched });
    room.submit({ type: "StartGame", issuer: "p0" });

    // 应存在一个 = hardTimeLimitMin*60000 的定时器(30 分钟 = 1,800,000ms)。
    const capMs = initial.config.hardTimeLimitMin * 60_000;
    expect([...sched.timers.values()].some((t) => t.ms === capMs)).toBe(true);

    // 触发时长最大的定时器(即时长硬上限)。
    sched.fireLargest();
    expect(room.getState().phase).toBe("ended");
    expect(find(seen, "GameEnded")?.reason).toBe("time-limit");
  });

  it("从进行中快照恢复时重新挂上硬上限定时器", () => {
    const sched = multiScheduler();
    let s = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ]);
    s = reduce(s, { type: "StartGame", issuer: "p0" }).state; // 进行中快照
    const room = new RoomRuntime(s, { broadcast: () => {}, scheduler: sched });
    const capMs = s.config.hardTimeLimitMin * 60_000;
    expect([...sched.timers.values()].some((t) => t.ms === capMs)).toBe(true);
    sched.fireLargest();
    expect(room.getState().phase).toBe("ended");
  });
});
