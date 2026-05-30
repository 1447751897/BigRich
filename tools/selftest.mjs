// 网关级自测:对真实运行的 dev:server 验证三条修复(掷骰随机 / 取消房间 / 再来一局回房间)。
// 用法:PORT=8099 npm run dev:server 后,node tools/selftest.mjs 8099
import WebSocket from "ws";

const PORT = process.argv[2] || "8099";
const URL = `ws://localhost:${PORT}`;

function conn() {
  const ws = new WebSocket(URL);
  ws.q = [];
  ws.waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = ws.waiters.shift();
    if (w) w(msg); else ws.q.push(msg);
  });
  ws.next = () =>
    new Promise((res) => {
      if (ws.q.length) return res(ws.q.shift());
      ws.waiters.push(res);
    });
  ws.send2 = (o) => ws.send(JSON.stringify(o));
  return new Promise((res) => ws.on("open", () => res(ws)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等待某 socket 收到满足谓词的消息(跳过中间广播)。
async function waitFor(ws, pred, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await Promise.race([ws.next(), sleep(timeoutMs).then(() => null)]);
    if (msg && pred(msg)) return msg;
  }
  throw new Error(`超时未等到:${label}`);
}

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

// --- 1) 掷骰随机:多间房第一把点数不应全部相同(旧 bug=固定种子→序列恒定)---------
async function testDice() {
  const seqs = [];
  for (let i = 0; i < 6; i++) {
    const host = await conn();
    host.send2({ t: "create", nickname: "H" });
    const joined = await waitFor(host, (m) => m.t === "joined", "host joined");
    const code = joined.roomCode;
    const guest = await conn();
    guest.send2({ t: "join", roomCode: code, nickname: "G" });
    await waitFor(guest, (m) => m.t === "joined", "guest joined");
    host.send2({ t: "start" });
    await waitFor(host, (m) => m.t === "state" && m.state.phase === "playing", "playing");
    host.send2({ t: "cmd", command: { type: "RollDice" } });
    const rolled = await waitFor(host, (m) => m.t === "state" && (m.events || []).some((e) => e.type === "DiceRolled"), "DiceRolled");
    const d = rolled.events.find((e) => e.type === "DiceRolled").dice;
    seqs.push(d.join(","));
    host.close(); guest.close();
  }
  const distinct = new Set(seqs).size;
  console.log("  各房首掷:", seqs.join(" | "));
  ok(distinct > 1, `掷骰随机:6 间房首掷点数出现 ${distinct} 种不同值(>1 即非固定序列)`);
}

// --- 2) 取消房间:房主解散后,房内全员收到 room-closed ----------------------------
async function testCancel() {
  const host = await conn();
  host.send2({ t: "create", nickname: "H" });
  const joined = await waitFor(host, (m) => m.t === "joined", "host joined");
  const code = joined.roomCode;
  const guest = await conn();
  guest.send2({ t: "join", roomCode: code, nickname: "G" });
  await waitFor(guest, (m) => m.t === "joined", "guest joined");
  host.send2({ t: "cancelRoom" });
  const hc = await waitFor(host, (m) => m.t === "room-closed", "host room-closed");
  const gc = await waitFor(guest, (m) => m.t === "room-closed", "guest room-closed");
  ok(hc.reason === "host-cancelled" && gc.reason === "host-cancelled", "取消房间:房主与玩家均收到 room-closed(host-cancelled)");
  // 房间已移除:再 join 应报 unknown-room
  const g2 = await conn();
  g2.send2({ t: "join", roomCode: code, nickname: "X" });
  const err = await waitFor(g2, (m) => m.t === "error", "join error");
  ok(err.reason === "unknown-room", "取消后房间不可再加入(unknown-room)");
  host.close(); guest.close(); g2.close();
}

// --- 3) 再来一局:打完一局到 ended,房主 restart 后回到 lobby 且保留座位 ------------
function decide(state) {
  if (state.phase !== "playing") return null;
  if (state.turnPhase === "auction") { const b = state.auction.order[state.auction.turnPtr]; return { seat: b, cmd: { type: "PassBid" } }; }
  if (state.turnPhase === "trade") { const a = state.trade?.awaiting; return a ? { seat: a, cmd: { type: "RespondTrade", action: "reject" } } : null; }
  const cur = state.order[state.currentIndex];
  if (state.turnPhase === "awaiting-buy") return { seat: cur, cmd: { type: "DeclineBuy" } };
  if (state.turnPhase === "normal") return { seat: cur, cmd: state.rolledThisTurn ? { type: "EndTurn" } : { type: "RollDice" } };
  return null;
}

async function testRestart() {
  const host = await conn();
  host.send2({ t: "create", nickname: "H" });
  const hj = await waitFor(host, (m) => m.t === "joined", "host joined");
  const code = hj.roomCode, hostSeat = hj.seatId;
  const guest = await conn();
  guest.send2({ t: "join", roomCode: code, nickname: "G" });
  const gj = await waitFor(guest, (m) => m.t === "joined", "guest joined");
  const guestSeat = gj.seatId;
  const sockOf = (seat) => (seat === hostSeat ? host : seat === guestSeat ? guest : null);
  host.send2({ t: "start" });

  // 自动驾驶两座位直到 GameEnded(以 host 广播为准),含防卡死上限。
  let ended = null, last = null, guard = 0;
  while (!ended && guard++ < 4000) {
    const msg = await waitFor(host, (m) => m.t === "state", "state", 15000);
    if ((msg.events || []).some((e) => e.type === "GameEnded")) { ended = msg; break; }
    last = msg.state;
    const d = decide(last);
    if (d) { const s = sockOf(d.seat); if (s) s.send2({ t: "cmd", command: d.cmd }); }
  }
  ok(!!ended, `打满一局到结算(GameEnded,${guard} 步内收束)`);

  // 房主 restart -> 回到 lobby
  host.send2({ t: "restart" });
  const back = await waitFor(host, (m) => m.t === "state" && m.state.phase === "lobby", "back to lobby");
  const st = back.state;
  ok(st.phase === "lobby", "再来一局:对局结束后回到大厅(lobby)");
  ok(st.players.length === 2 && st.players.every((p) => p.cash === st.config.startingCash && p.position === 0), "再来一局:座位保留、数值复位为新局初始");
  // 房主可直接再开
  host.send2({ t: "start" });
  const replay = await waitFor(host, (m) => m.t === "state" && m.state.phase === "playing", "replay playing");
  ok(replay.state.phase === "playing", "再来一局:房主可直接重新开始下一局");
  host.close(); guest.close();
}

(async () => {
  try {
    await testDice();
    await testCancel();
    await testRestart();
  } catch (e) {
    console.error("自测异常:", e.message); failed++;
  }
  console.log(failed === 0 ? "\n全部自测通过 ✅" : `\n有 ${failed} 项未通过 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})();
