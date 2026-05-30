/**
 * 验收测试(05-acceptance):补全 P0 中此前缺少自动化覆盖的两项 —— 走真实 WS 网关:
 *   ③ 断线重连:重连后资产/进度不丢、连接恢复 online;
 *   ④ 防作弊(网关层):issuer 服务端绑定(他人不能替你行动)+ 掷骰只在服务端(客户端伪造 dice 被忽略)。
 * (① 完整一局闭环见 e2e.test.ts;② 回合上限收束见 core.test.ts;§4B 交易/拍卖/抵押见各自用例。)
 */
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { GameGateway } from "../src/gateway/server.js";
import { rollDice } from "../src/engine/rng.js";

let gw: GameGateway | null = null;
afterAll(async () => {
  gw?.close();
  await new Promise((r) => setTimeout(r, 100));
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 裸客户端:收集消息、按谓词等待、跟踪最新 state。 */
function rawClient(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  let lastState: any = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    inbox.push(m);
    if (m.t === "state" && m.state) lastState = m.state;
    if (m.t === "joined" && m.state) lastState = m.state;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(m)) {
        waiters[i]!.resolve(m);
        waiters.splice(i, 1);
      }
    }
  });
  const ready = new Promise<void>((res) => ws.on("open", () => res()));
  function waitFor(pred: (m: any) => boolean): Promise<any> {
    const existing = inbox.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((res) => waiters.push({ pred, resolve: res }));
  }
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  return {
    ws,
    ready,
    waitFor,
    send,
    get lastState() {
      return lastState;
    },
  };
}

const curSeat = (s: any) => s.order[s.currentIndex];

describe("验收:断线重连 + 网关防作弊(真实 WS)", () => {
  it("重连后资产/进度不丢且连接恢复;他人不能替你行动;客户端伪造骰子被忽略", async () => {
    gw = new GameGateway(0);
    await gw.listen();
    const port = gw.actualPort();

    // 建房 + 进房
    const a = rawClient(port);
    await a.ready;
    a.send({ t: "create", nickname: "房主" });
    const ja = await a.waitFor((m) => m.t === "joined");
    const roomCode = ja.roomCode as string;
    const tokenA = ja.token as string;
    const seatA = ja.seatId as string;

    const b = rawClient(port);
    await b.ready;
    b.send({ t: "join", roomCode, nickname: "小明" });
    const jb = await b.waitFor((m) => m.t === "joined");
    const seatB = jb.seatId as string;

    // 开局(房主 a)。等到 playing 且轮到 a。
    a.send({ t: "start" });
    await b.waitFor((m) => m.t === "state" && m.state.phase === "playing" && curSeat(m.state) === seatA);

    // ── 防作弊①:非当前回合的 b 试图掷骰 -> 服务端按 issuer=座位B 裁决,拒绝 not-your-turn ──
    b.send({ t: "cmd", command: { type: "RollDice" } });
    const rej = await b.waitFor(
      (m) => m.t === "state" && m.events?.some((e: any) => e.type === "Rejected" && e.reason === "not-your-turn"),
    );
    expect(rej).toBeTruthy();

    // ── 防作弊②:a 掷骰但伪造 dice=[6,6];掷骰只在服务端,客户端值被忽略 ──
    a.send({ t: "cmd", command: { type: "RollDice", dice: [6, 6] } });
    const rolled = await a.waitFor(
      (m) => m.t === "state" && m.events?.some((e: any) => e.type === "DiceRolled" && e.seatId === seatA),
    );
    const diceEv = rolled.events.find((e: any) => e.type === "DiceRolled" && e.seatId === seatA);
    const serverDice = rollDice(0x1a2b3c4d).dice; // 网关用默认 seed,首掷可复现
    expect(diceEv.dice).toEqual(serverDice);
    expect(diceEv.dice).not.toEqual([6, 6]); // 默认 seed 首掷不是 6/6,确认未采用客户端值

    // 结清 a 的回合:落到无主地产则买入(留下可校验资产),否则直接结束。
    if (a.lastState?.turnPhase === "awaiting-buy") {
      a.send({ t: "cmd", command: { type: "BuyProperty" } });
      await a.waitFor((m) => m.t === "state" && m.state.turnPhase === "normal" && curSeat(m.state) === seatA);
    }
    a.send({ t: "cmd", command: { type: "EndTurn" } });
    // 轮到 b(在线真人)-> 不触发 AI 托管,局面在此稳定,排除竞态。
    await b.waitFor((m) => m.t === "state" && curSeat(m.state) === seatB);

    // 重连前快照(权威状态,a/b 同源)。
    const snap = b.lastState;
    const p0snap = snap.players.find((p: any) => p.seatId === seatA);
    const ownedSnap = snap.properties
      .filter((ps: any) => ps.ownerSeatId === seatA)
      .map((ps: any) => ps.tileIndex)
      .sort((x: number, y: number) => x - y);

    // ── 断线:关闭 a。此刻轮到在线的 b,AI 不会替 a 行动,资产不被搅动。 ──
    a.ws.close();
    await delay(120);

    // ── 重连:用 token 回到原局,服务端回推全量状态快照。 ──
    const a2 = rawClient(port);
    await a2.ready;
    a2.send({ t: "reconnect", roomCode, token: tokenA });
    const ja2 = await a2.waitFor((m) => m.t === "joined");
    const rs = ja2.state;
    const p0re = rs.players.find((p: any) => p.seatId === seatA);
    const ownedRe = rs.properties
      .filter((ps: any) => ps.ownerSeatId === seatA)
      .map((ps: any) => ps.tileIndex)
      .sort((x: number, y: number) => x - y);

    // 资产/进度不丢:现金、位置、已完成回合数、持有地产一致;连接恢复 online。
    expect(rs.phase).toBe(snap.phase);
    expect(p0re.cash).toBe(p0snap.cash);
    expect(p0re.position).toBe(p0snap.position);
    expect(p0re.turnsTaken).toBe(p0snap.turnsTaken);
    expect(ownedRe).toEqual(ownedSnap);
    expect(p0re.connection).toBe("online");

    a2.ws.close();
    b.ws.close();
  }, 20000);
});
