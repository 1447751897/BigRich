/**
 * 端到端:启动真实网关,两个 WebSocket 客户端 建房→进房→开局→完整对战→结算。
 * 验证「点链接就能玩、跑通完整一局」的闭环走的是真实 WS 协议 + 单写者 + 引擎。
 */
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { GameGateway } from "../src/gateway/server.js";

let gw: GameGateway | null = null;
afterAll(async () => {
  gw?.close();
  await new Promise((r) => setTimeout(r, 100)); // 让连接/server 完成关闭
});

/** 一个自动驾驶的客户端:收到 state 就按 happy-path 替自己的座位行动,直到对局结束。 */
function autoClient(port: number, opts: { create?: boolean; roomCode?: string; nickname: string }) {
  return new Promise<{ ws: WebSocket; seatId: string; roomCode: string; onState: (cb: (s: any) => void) => void }>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    let seatId = "";
    let roomCode = "";
    const stateCbs: ((s: any) => void)[] = [];
    ws.on("open", () => {
      if (opts.create) ws.send(JSON.stringify({ t: "create", nickname: opts.nickname }));
      else ws.send(JSON.stringify({ t: "join", roomCode: opts.roomCode, nickname: opts.nickname }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "joined") {
        seatId = msg.seatId;
        roomCode = msg.roomCode;
        resolve({ ws, seatId, roomCode, onState: (cb) => stateCbs.push(cb) });
      } else if (msg.t === "state") {
        drive(ws, seatId, msg.state);
        for (const cb of stateCbs) cb(msg.state);
      }
    });
  });
}

/** happy-path 自动决策:轮到自己就掷骰/买或不买/结束;拍卖出价者放弃;交易响应方拒绝。 */
function drive(ws: WebSocket, seatId: string, s: any) {
  if (s.phase !== "playing") return;
  const send = (command: any) => ws.send(JSON.stringify({ t: "cmd", command }));
  if (s.turnPhase === "auction" && s.auction?.order[s.auction.turnPtr] === seatId) {
    return send({ type: "PassBid" });
  }
  if (s.turnPhase === "trade" && s.trade?.awaiting === seatId) {
    return send({ type: "RespondTrade", action: "reject" });
  }
  const cur = s.order[s.currentIndex];
  if (cur !== seatId) return;
  if (s.turnPhase === "awaiting-buy") {
    const price = s.config.tiles[s.pendingBuyTile]?.property?.price ?? 0;
    const cash = s.players.find((p: any) => p.seatId === seatId)?.cash ?? 0;
    return send(cash - price >= 300 ? { type: "BuyProperty" } : { type: "DeclineBuy" });
  }
  if (s.turnPhase === "normal") {
    return send(s.rolledThisTurn ? { type: "EndTurn" } : { type: "RollDice" });
  }
}

describe("端到端:完整一局闭环", () => {
  it("两人建房进房开局,自动跑到结算并广播排名", async () => {
    gw = new GameGateway(0);
    await gw.listen();
    const port = gw.actualPort();

    const a = await autoClient(port, { create: true, nickname: "房主" });
    const b = await autoClient(port, { join: true as any, roomCode: a.roomCode, nickname: "小明" });

    const ended = new Promise<any>((resolve) => {
      a.onState((s) => {
        if (s.phase === "ended") resolve(s);
      });
    });

    // 房主开局(等 b 入座后)。
    await new Promise((r) => setTimeout(r, 50));
    a.ws.send(JSON.stringify({ t: "start" }));

    const finalState = (await Promise.race([
      ended,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 未在 20s 内结算")), 20000)),
    ])) as any;

    expect(finalState.phase).toBe("ended");
    expect(finalState.ranking.length).toBe(2);
    expect(finalState.ranking[0].rank).toBe(1);
    a.ws.close();
    b.ws.close();
  }, 25000);
});
