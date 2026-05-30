"use strict";
/* BigRich 最小可玩前端:WebSocket + 纯渲染,所有规则结果以服务端事件/状态为准(端无关瘦客户端)。 */

const SEAT_COLORS = ["#58a6ff", "#f85149", "#3fb950", "#d29922", "#bc8cff", "#ff7b72", "#39c5cf", "#db61a2"];
const GROUP_COLORS = { teal: "#39c5cf", amber: "#d29922", coral: "#ff7b72", violet: "#bc8cff", indigo: "#58a6ff", crimson: "#f85149" };

const $ = (id) => document.getElementById(id);
let ws = null;
let me = { seatId: null, token: null, host: false, roomCode: null };
let last = null; // 最近一次 state

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { $("conn").textContent = "已连接"; $("conn").classList.add("ok"); tryReconnect(); };
  ws.onclose = () => { $("conn").textContent = "连接断开,重试中…"; $("conn").classList.remove("ok"); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function tryReconnect() {
  const saved = JSON.parse(localStorage.getItem("bigrich") || "null");
  if (saved && saved.token && saved.roomCode) {
    send({ t: "reconnect", roomCode: saved.roomCode, token: saved.token });
  }
}

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function cmd(command) { send({ t: "cmd", command }); }

function handle(msg) {
  if (msg.t === "error") { $("entryErr").textContent = errText(msg.reason); return; }
  if (msg.t === "joined") {
    me = { seatId: msg.seatId, token: msg.token, host: msg.host, roomCode: msg.roomCode };
    localStorage.setItem("bigrich", JSON.stringify({ token: msg.token, roomCode: msg.roomCode }));
    showRoom(msg.state);
    render(msg.state, []);
    return;
  }
  if (msg.t === "state") { render(msg.state, msg.events); }
}

function showRoom(state) {
  $("entry").classList.add("hidden");
  $("lobbyCode").textContent = me.roomCode;
  const url = `${location.origin}/?room=${me.roomCode}`;
  $("lobbyLink").textContent = url;
  if (state.phase === "lobby") { $("lobby").classList.remove("hidden"); $("game").classList.add("hidden"); }
}

// --- 渲染 ------------------------------------------------------------------
function render(state, events) {
  last = state;
  appendLog(events, state);
  if (state.phase === "lobby") { renderLobby(state); return; }
  $("lobby").classList.add("hidden");
  $("game").classList.remove("hidden");
  renderBoard(state);
  renderPlayers(state);
  renderActions(state);
  renderSub(state);
  if (state.phase === "ended") renderResult(state);
}

function renderLobby(state) {
  $("lobby").classList.remove("hidden");
  const list = $("seatList");
  list.innerHTML = "";
  state.players.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${SEAT_COLORS[i]}">●</span> ${esc(p.displayName)}${p.seatId === me.seatId ? " (你)" : ""}${p.seatId === state.players[0]?.seatId ? " · 房主" : ""}`;
    list.appendChild(li);
  });
  const canStart = me.host && state.players.length >= 2;
  $("btnStart").classList.toggle("hidden", !me.host);
  $("btnStart").disabled = !canStart;
  $("startHint").textContent = me.host ? (canStart ? "" : "至少 2 人才能开始") : "等待房主开始…";
}

// 8x8 外圈坐标,顺时针,共 28 格。
function ringCoords() {
  const c = [];
  for (let col = 1; col <= 8; col++) c.push([1, col]);        // top
  for (let row = 2; row <= 8; row++) c.push([row, 8]);        // right
  for (let col = 7; col >= 1; col--) c.push([8, col]);        // bottom
  for (let row = 7; row >= 2; row--) c.push([row, 1]);        // left
  return c; // 8+7+7+6 = 28
}

function renderBoard(state) {
  const board = $("board");
  board.innerHTML = "";
  const coords = ringCoords();
  const curSeat = state.order[state.currentIndex];
  const seatIdx = (sid) => state.order.indexOf(sid);
  state.config.tiles.forEach((t, i) => {
    const [row, col] = coords[i] || [1, 1];
    const el = document.createElement("div");
    el.className = "tile";
    el.style.gridRow = row; el.style.gridColumn = col;
    if (["start", "jail", "gotojail", "freeparking"].includes(t.type)) el.classList.add("corner");
    if (["chance", "fate", "tax"].includes(t.type)) el.classList.add("special");
    let inner = "";
    if (t.type === "property") {
      const ps = state.properties.find((p) => p.tileIndex === i);
      inner += `<div class="grp" style="background:${GROUP_COLORS[t.property.groupId] || "#555"}"></div>`;
      inner += `<div class="nm">${esc(t.name)}</div><div class="pr">$${t.property.price}</div>`;
      if (ps && ps.ownerSeatId !== null) {
        inner += `<div class="owner" style="color:${SEAT_COLORS[seatIdx(ps.ownerSeatId)]}">${ps.mortgaged ? "抵" : "●"}</div>`;
        if (ps.houseLevel > 0) inner += `<div class="houses">${ps.houseLevel === 5 ? "旅馆" : "🏠" + ps.houseLevel}</div>`;
      }
    } else {
      inner += `<div class="nm">${esc(t.name)}</div>`;
      if (t.type === "tax") inner += `<div class="pr">-$${t.taxAmount}</div>`;
    }
    // 棋子
    const here = state.players.filter((p) => p.position === i && p.status !== "spectating");
    if (here.length) {
      inner += `<div class="pawns">${here.map((p) => `<span class="pawn" style="background:${SEAT_COLORS[seatIdx(p.seatId)]}"></span>`).join("")}</div>`;
    }
    el.innerHTML = inner;
    if (t.index === (last.players.find(p=>p.seatId===curSeat)?.position)) el.classList.add("cur");
    board.appendChild(el);
  });
}

function renderPlayers(state) {
  const box = $("players");
  box.innerHTML = "";
  const curSeat = state.order[state.currentIndex];
  state.players.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "pl" + (p.seatId === curSeat ? " cur" : "") + (p.status !== "active" ? " out" : "");
    const tag = p.connection !== "online" ? `<span class="tag">[${p.connection === "ai" ? "托管" : "掉线"}]</span>` : (p.inJail ? `<span class="tag">[狱]</span>` : "");
    div.innerHTML = `<span class="dot" style="background:${SEAT_COLORS[i]}"></span>
      <span class="nm">${esc(p.displayName)}${p.seatId === me.seatId ? " (你)" : ""} ${tag}</span>
      <span class="cash">$${p.cash}</span>`;
    box.appendChild(div);
  });
}

function myTurn(state) { return state.order[state.currentIndex] === me.seatId; }

function renderActions(state) {
  const a = $("actions");
  a.innerHTML = "";
  if (state.phase !== "playing") return;
  const mine = myTurn(state);

  if (state.turnPhase === "normal" && mine) {
    if (!state.rolledThisTurn) a.appendChild(btn("掷骰", () => cmd({ type: "RollDice" })));
    else a.appendChild(btn("结束回合", () => cmd({ type: "EndTurn" }), "ghost"));
  }
  if (state.turnPhase === "awaiting-buy" && mine) {
    const price = state.config.tiles[state.pendingBuyTile]?.property?.price;
    a.appendChild(btn(`购买 ($${price})`, () => cmd({ type: "BuyProperty" })));
    a.appendChild(btn("不买(进入拍卖)", () => cmd({ type: "DeclineBuy" }), "ghost"));
  }
}

// 子面板:盖房/抵押(自回合 normal)、交易发起、交易响应、拍卖出价
function renderSub(state) {
  const s = $("subpanel");
  s.innerHTML = "";
  if (state.phase !== "playing") return;
  const mine = myTurn(state);

  if (state.turnPhase === "normal" && mine) {
    s.appendChild(buildManagePanel(state));
    s.appendChild(buildTradePanel(state));
  }
  if (state.turnPhase === "trade" && state.trade && state.trade.awaiting === me.seatId) {
    s.appendChild(tradeRespondPanel(state));
  }
  if (state.turnPhase === "auction" && state.auction && state.auction.order[state.auction.turnPtr] === me.seatId) {
    s.appendChild(auctionPanel(state));
  }
}

function myProps(state) {
  return state.properties.filter((p) => p.ownerSeatId === me.seatId);
}

function buildManagePanel(state) {
  const wrap = document.createElement("div");
  const owned = myProps(state);
  if (!owned.length) return wrap;
  wrap.innerHTML = "<h4>我的地产</h4>";
  owned.forEach((ps) => {
    const t = state.config.tiles[ps.tileIndex];
    const line = document.createElement("div");
    line.style.margin = "4px 0";
    line.innerHTML = `<span>${esc(t.name)} ${ps.mortgaged ? "(已抵押)" : ""} ${ps.houseLevel ? "房" + ps.houseLevel : ""}</span> `;
    if (!ps.mortgaged) {
      line.appendChild(btn("盖房", () => cmd({ type: "BuildHouse", tileIndex: ps.tileIndex }), "ghost"));
      line.appendChild(btn("抵押", () => cmd({ type: "Mortgage", tileIndex: ps.tileIndex }), "ghost"));
    } else {
      line.appendChild(btn("赎回", () => cmd({ type: "Redeem", tileIndex: ps.tileIndex }), "ghost"));
    }
    wrap.appendChild(line);
  });
  return wrap;
}

function buildTradePanel(state) {
  const wrap = document.createElement("div");
  const others = state.players.filter((p) => p.seatId !== me.seatId && p.status === "active");
  if (!others.length) return wrap;
  wrap.innerHTML = "<h4>发起交易</h4>";
  const sel = document.createElement("select");
  others.forEach((p) => { const o = document.createElement("option"); o.value = p.seatId; o.textContent = p.displayName; sel.appendChild(o); });
  wrap.appendChild(sel);

  const giveWrap = document.createElement("div"); giveWrap.innerHTML = "<div>给出我的:</div>";
  myProps(state).forEach((ps) => giveWrap.appendChild(checkbox("give", ps.tileIndex, state.config.tiles[ps.tileIndex].name)));
  wrap.appendChild(giveWrap);

  const getWrap = document.createElement("div"); getWrap.innerHTML = "<div>索取对方:</div>";
  const refreshGet = () => {
    getWrap.innerHTML = "<div>索取对方:</div>";
    state.properties.filter((p) => p.ownerSeatId === sel.value).forEach((ps) => getWrap.appendChild(checkbox("get", ps.tileIndex, state.config.tiles[ps.tileIndex].name)));
  };
  sel.onchange = refreshGet; refreshGet();
  wrap.appendChild(getWrap);

  const giveCash = numInput("我付现金"); const getCash = numInput("要现金");
  wrap.appendChild(giveCash.label); wrap.appendChild(getCash.label);
  wrap.appendChild(btn("发送报价", () => {
    cmd({
      type: "ProposeTrade", counterparty: sel.value,
      giveProperties: checked(giveWrap, "give"), giveCash: +giveCash.input.value || 0,
      getProperties: checked(getWrap, "get"), getCash: +getCash.input.value || 0,
    });
  }));
  return wrap;
}

function tradeRespondPanel(state) {
  const wrap = document.createElement("div");
  const o = state.trade;
  const names = (arr) => arr.map((i) => state.config.tiles[i].name).join("、") || "—";
  wrap.innerHTML = `<h4>收到交易报价</h4>
    <div>对方给:地产[${names(o.giveProperties)}] + $${o.giveCash}</div>
    <div>对方要:地产[${names(o.getProperties)}] + $${o.getCash}</div>`;
  wrap.appendChild(btn("接受", () => cmd({ type: "RespondTrade", action: "accept" })));
  wrap.appendChild(btn("拒绝", () => cmd({ type: "RespondTrade", action: "reject" }), "ghost"));
  if (!o.counterUsed && me.seatId === o.counterparty) {
    wrap.appendChild(btn("还价(仅1次)", () => {
      // 简单还价:把现金对调 +50 示意,真实可扩展为完整表单。
      cmd({ type: "RespondTrade", action: "counter", counter: { giveProperties: o.giveProperties, giveCash: o.giveCash + 50, getProperties: o.getProperties, getCash: o.getCash } });
    }, "ghost"));
  }
  return wrap;
}

function auctionPanel(state) {
  const wrap = document.createElement("div");
  const a = state.auction;
  const t = state.config.tiles[a.tileIndex];
  wrap.innerHTML = `<h4>拍卖:${esc(t.name)}</h4><div>当前最高价:$${a.currentHigh}${a.currentHighSeat ? "(" + seatName(state, a.currentHighSeat) + ")" : ""}</div>`;
  const inp = numInput("出价"); wrap.appendChild(inp.label);
  wrap.appendChild(btn("加价", () => cmd({ type: "PlaceBid", amount: +inp.input.value || 0 })));
  wrap.appendChild(btn("放弃", () => cmd({ type: "PassBid" }), "ghost"));
  return wrap;
}

let endReason = "";
function renderResult(state) {
  const box = $("result");
  box.classList.remove("hidden");
  const lines = state.ranking.map((r) => `<li>${seatName(state, r.seatId)} — 净资产 $${r.netWorth}</li>`).join("");
  const why = { "time-limit": "30 分钟时长到点结算", "turn-limit": "回合上限到点结算", "last-standing": "仅剩一人" }[endReason] || "";
  box.innerHTML = `<div class="box"><h2>对局结束</h2>${why ? `<p class="hint">${why}</p>` : ""}<ol>${lines}</ol><button onclick="location.reload()">再来一局</button></div>`;
}

// --- 工具 ------------------------------------------------------------------
function btn(text, fn, cls) { const b = document.createElement("button"); b.textContent = text; if (cls) b.className = cls; b.onclick = fn; return b; }
function checkbox(group, val, label) {
  const span = document.createElement("label"); span.className = "opt";
  span.innerHTML = `<input type="checkbox" data-group="${group}" value="${val}"/> ${esc(label)}`;
  return span;
}
function checked(scope, group) { return [...scope.querySelectorAll(`input[data-group="${group}"]:checked`)].map((e) => +e.value); }
function numInput(ph) { const label = document.createElement("label"); const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.value = "0"; input.style.width = "80px"; label.textContent = ph + " "; label.appendChild(input); return { label, input }; }
function seatName(state, sid) { return state.players.find((p) => p.seatId === sid)?.displayName || sid; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function appendLog(events, state) {
  if (!events || !events.length) return;
  const log = $("log");
  for (const e of events) {
    if (e.type === "GameEnded") endReason = e.reason;
    const txt = eventText(e, state);
    if (!txt) continue;
    const d = document.createElement("div"); d.textContent = txt; log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
}

function eventText(e, s) {
  const nm = (sid) => seatName(s, sid);
  switch (e.type) {
    case "SeatJoined": return `${esc(e.displayName)} 进入房间`;
    case "GameStarted": return "游戏开始!";
    case "TurnChanged": return `轮到 ${nm(e.seatId)}`;
    case "DiceRolled": return `${nm(e.seatId)} 掷出 ${e.dice[0]}+${e.dice[1]}${e.doubles ? "(双数)" : ""}`;
    case "PlayerMoved": return e.passedStart ? `${nm(e.seatId)} 经过起点 +奖励` : null;
    case "PropertyOffered": return `${nm(e.seatId)} 落在无主地产(可买 $${e.price})`;
    case "PropertyBought": return `${nm(e.seatId)} 买下 ${s.config.tiles[e.tileIndex].name}`;
    case "RentPaid": return `${nm(e.from)} 付租 $${e.amount} 给 ${nm(e.to)}`;
    case "TaxPaid": return `${nm(e.seatId)} 缴税 $${e.amount}`;
    case "CardDrawn": return `${nm(e.seatId)} 抽卡:${e.text}`;
    case "SentToJail": return `${nm(e.seatId)} 入狱`;
    case "LeftJail": return `${nm(e.seatId)} 出狱`;
    case "HouseBuilt": return `${nm(e.seatId)} 在 ${s.config.tiles[e.tileIndex].name} 盖到 ${e.level} 级`;
    case "Mortgaged": return `${nm(e.seatId)} 抵押 ${s.config.tiles[e.tileIndex].name} 得 $${e.amount}`;
    case "Redeemed": return `${nm(e.seatId)} 赎回 ${s.config.tiles[e.tileIndex].name}`;
    case "TradeProposed": return `${nm(e.offer.initiator)} 向 ${nm(e.offer.counterparty)} 发起交易`;
    case "TradeCountered": return `收到还价`;
    case "TradeResolved": return `交易${e.result === "accepted" ? "成交" : "作废"}${e.reason ? "(" + e.reason + ")" : ""}`;
    case "AuctionStarted": return `开始拍卖 ${s.config.tiles[e.tileIndex].name}`;
    case "BidPlaced": return `${nm(e.seatId)} 出价 $${e.amount}`;
    case "BidPassed": return `${nm(e.seatId)} 放弃`;
    case "AuctionResolved": return e.result === "sold" ? `${nm(e.winner)} 以 $${e.amount} 拍得` : "流拍";
    case "PlayerBankrupt": return `${nm(e.seatId)} 破产出局`;
    case "ConnectionChanged": return `${nm(e.seatId)} ${e.status === "online" ? "重连回来" : e.status === "ai" ? "由 AI 托管" : "掉线"}`;
    case "GameEnded": return "对局结算!" + ({ "time-limit": "(30 分钟时长到点)", "turn-limit": "(回合上限到点)", "last-standing": "(仅剩一人)" }[e.reason] || "");
    case "Rejected": return null; // 非法操作静默
    default: return null;
  }
}

function errText(reason) {
  return {
    "unknown-room": "房间不存在", "game-already-started": "游戏已开始,无法加入",
    "session-not-found": "会话失效,请重新进房", "only-host-can-start": "只有房主能开始",
    "room-full": "房间已满(上限 8 人)",
  }[reason] || reason;
}

// --- 绑定 ------------------------------------------------------------------
$("btnCreate").onclick = () => send({ t: "create", nickname: $("nickname").value });
$("btnJoin").onclick = () => send({ t: "join", roomCode: $("joinCode").value.toUpperCase(), nickname: $("nickname").value });
$("btnStart").onclick = () => send({ t: "start" });

// 链接带 ?room=XXXX 时自动填充
const params = new URLSearchParams(location.search);
if (params.get("room")) $("joinCode").value = params.get("room").toUpperCase();

connect();
