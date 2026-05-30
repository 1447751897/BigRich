/** P0②:快照落盘 + 重启恢复(含重启后凭 token 重连)。 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGame, reduce } from "../src/engine/engine.js";
import { GameGateway } from "../src/gateway/server.js";
import { FileSnapshotStore, MemorySnapshotStore, type RoomSnapshot } from "../src/gateway/snapshot.js";

const gateways: GameGateway[] = [];
afterAll(async () => {
  gateways.forEach((g) => g.close());
  await new Promise((r) => setTimeout(r, 100));
});

function sampleSnapshot(): RoomSnapshot {
  let s = createGame("ABCD", [
    { seatId: "ABCD-1", displayName: "A" },
    { seatId: "ABCD-2", displayName: "B" },
  ]);
  s = reduce(s, { type: "StartGame", issuer: "ABCD-1" }).state;
  return { code: "ABCD", hostSeat: "ABCD-1", seatCounter: 2, sessions: [{ seatId: "ABCD-1", token: "t1" }, { seatId: "ABCD-2", token: "t2" }], state: s };
}

describe("快照落盘", () => {
  it("FileSnapshotStore 保存/加载/删除 round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "bigrich-snap-"));
    try {
      const store = new FileSnapshotStore(dir);
      const snap = sampleSnapshot();
      store.save(snap);
      const loaded = store.loadAll();
      expect(loaded.length).toBe(1);
      expect(loaded[0]!.code).toBe("ABCD");
      expect(loaded[0]!.state.phase).toBe("playing");
      expect(loaded[0]!.state.players.length).toBe(2);
      expect(loaded[0]!.sessions.length).toBe(2);
      store.remove("ABCD");
      expect(store.loadAll().length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("网关重启:从共享快照恢复进行中的房间,旧 token 仍可重连", async () => {
    const store = new MemorySnapshotStore();

    // 第一台网关:建房 + 进房 + 开局。
    const gw1 = new GameGateway(0, undefined, store);
    gateways.push(gw1);
    await gw1.listen();
    const p1 = gw1.actualPort();

    const host = await joinClient(p1, { create: true, nickname: "房主" });
    await joinClient(p1, { roomCode: host.roomCode, nickname: "小明" });
    await new Promise((r) => setTimeout(r, 40));
    host.ws.send(JSON.stringify({ t: "start" }));
    await new Promise((r) => setTimeout(r, 60));
    host.ws.close();

    // 模拟重启:新网关共享同一 store,应恢复该房间。
    const gw2 = new GameGateway(0, undefined, store);
    gateways.push(gw2);
    await gw2.listen();
    const p2 = gw2.actualPort();

    // 用旧 token 重连到新网关。
    const reconnected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${p2}`);
      ws.on("open", () => ws.send(JSON.stringify({ t: "reconnect", roomCode: host.roomCode, token: host.token })));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "joined") resolve(m);
      });
    });

    expect((reconnected as any).state.phase).toBe("playing");
    expect((reconnected as any).seatId).toBe(host.seatId);
  }, 15000);
});

function joinClient(port: number, opts: { create?: boolean; roomCode?: string; nickname: string }) {
  return new Promise<{ ws: WebSocket; seatId: string; roomCode: string; token: string }>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => {
      ws.send(JSON.stringify(opts.create ? { t: "create", nickname: opts.nickname } : { t: "join", roomCode: opts.roomCode, nickname: opts.nickname }));
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "joined") resolve({ ws, seatId: m.seatId, roomCode: m.roomCode, token: m.token });
    });
  });
}
