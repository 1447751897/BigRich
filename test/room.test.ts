/** 房间运行时(单写者 + 真实时钟驱动)集成测试,用可控假时钟。 */
import { describe, expect, it } from "vitest";
import { createGame } from "../src/engine/engine.js";
import { RoomRuntime, type Scheduler } from "../src/gateway/room.js";
import type { GameEvent } from "../src/engine/types.js";

/** 假时钟:记录最近一次调度的回调,手动 fire 触发。 */
function fakeScheduler(): Scheduler & { fire: () => void; pending: boolean } {
  let cb: (() => void) | null = null;
  return {
    set(fn) {
      cb = fn;
      return 1;
    },
    clear() {
      cb = null;
    },
    get pending() {
      return cb !== null;
    },
    fire() {
      const f = cb;
      cb = null;
      f?.();
    },
  };
}

describe("RoomRuntime 单写者 + 时钟", () => {
  it("引擎 TimerStarted -> 调度真实定时器;到点投递 Timeout 推进回合", () => {
    const sched = fakeScheduler();
    const seen: GameEvent[] = [];
    const initial = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ], { seed: 7 });
    const room = new RoomRuntime(initial, {
      broadcast: (events) => seen.push(...events),
      scheduler: sched,
    });

    room.submit({ type: "StartGame", issuer: "p0" });
    expect(room.getState().phase).toBe("playing");
    expect(room.getState().order[room.getState().currentIndex]).toBe("p0");
    expect(sched.pending).toBe(true); // 开局起了 turn 主时钟

    // 主时钟到点:网关投递 Timeout(turn)-> 引擎合成默认操作(自动掷骰/结束回合)。
    sched.fire();

    // 回合应已推进(p0 超时默认操作后轮转,或触发了拍卖等子流程)。
    const ev = seen.filter((e) => e.type === "TurnChanged");
    expect(ev.length).toBeGreaterThanOrEqual(1);
    // 仍有活跃时钟在跑(新回合的主时钟,或子流程时钟)。
    expect(sched.pending).toBe(true);
  });

  it("命令串行:连续 submit 不重入,顺序处理(单写者)", () => {
    const sched = fakeScheduler();
    const initial = createGame("r", [
      { seatId: "p0", displayName: "A" },
      { seatId: "p1", displayName: "B" },
    ], { seed: 7 });
    const room = new RoomRuntime(initial, { broadcast: () => {}, scheduler: sched });
    room.submit({ type: "StartGame", issuer: "p0" });
    // p1 抢跑(非其回合)应被引擎拒绝,不破坏状态。
    room.submit({ type: "RollDice", issuer: "p1" });
    expect(room.getState().phase).toBe("playing");
    expect(room.getState().order[room.getState().currentIndex]).toBe("p0");
  });
});
