"use strict";
/* 环游都市 BigRich 前端:WebSocket 瘦客户端,所有规则结果以服务端事件/状态为准。
   只做表现(主题/动画/音效),绝不在客户端决定骰子点数。 */

// --- 主题(自创、去 IP 化)---------------------------------------------------
const SEAT_COLORS = ["#3d7eff", "#ff6f91", "#16c79a", "#f5a623", "#9b6dff", "#ff5d5d", "#00b8d9", "#8d6e63"];
const PAWN_ICONS = ["🚗", "🎩", "🐕", "🚀", "⛵", "🎸", "🦊", "🐱"];
const DISTRICTS = {
  teal: { name: "翡翠湾", color: "#16c79a" },
  amber: { name: "金沙滩", color: "#f5a623" },
  coral: { name: "霓虹巷", color: "#ff6f91" },
  violet: { name: "紫藤台", color: "#9b6dff" },
  indigo: { name: "蓝湾港", color: "#3d7eff" },
  crimson: { name: "朝阳门", color: "#ff5d5d" },
};
const TYPE_ICON = { start: "🏁", jail: "🚔", gotojail: "🚨", freeparking: "🌳", chance: "❓", fate: "🃏", tax: "🏦" };
const TYPE_NAME = { start: "出发", jail: "拘留所", gotojail: "入狱", freeparking: "中央公园", chance: "机遇", fate: "命运", tax: "税务局" };
const BUILDINGS = { 1: "🏠", 2: "🏘️", 3: "🏢", 4: "🏬", 5: "🏙️" };
const DICE_FACES = [" ", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const coin = (n) => `🪙${n}`;

const $ = (id) => document.getElementById(id);
let ws = null;
let me = { seatId: null, token: null, host: false, roomCode: null };
let last = null;
const pawnEls = {};

// --- 连接 -------------------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { setConn("已连接", true); tryReconnect(); };
  ws.onclose = () => { setConn("断开,重连中…", false); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}
function setConn(t, ok) { const c = $("conn"); c.textContent = t; c.classList.toggle("ok", !!ok); }
function tryReconnect() {
  const saved = JSON.parse(localStorage.getItem("bigrich") || "null");
  if (saved && saved.token && saved.roomCode) send({ t: "reconnect", roomCode: saved.roomCode, token: saved.token });
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function cmd(command) { send({ t: "cmd", command }); }

function handle(msg) {
  if (msg.t === "error") { $("entryErr").textContent = errText(msg.reason); return; }
  if (msg.t === "joined") {
    me = { seatId: msg.seatId, token: msg.token, host: msg.host, roomCode: msg.roomCode };
    localStorage.setItem("bigrich", JSON.stringify({ token: msg.token, roomCode: msg.roomCode }));
    $("roomChip").classList.remove("hidden");
    $("roomCode").textContent = msg.roomCode;
    $("entry").classList.add("hidden");
    render(msg.state, []);
    return;
  }
  if (msg.t === "state") render(msg.state, msg.events);
}

// --- 渲染主流程 -------------------------------------------------------------
function render(state, events) {
  const prev = last;
  last = state;
  processEvents(events, state, prev);

  if (state.phase === "lobby") {
    $("game").classList.add("hidden"); $("lobby").classList.remove("hidden");
    renderLobby(state); return;
  }
  $("lobby").classList.add("hidden"); $("game").classList.remove("hidden");
  renderBoard(state);
  renderPawns(state);
  renderPlayers(state);
  renderHub(state);
  renderActionBar(state);
  renderSheet(state);
  renderCountdown(state);
  if (state.phase === "ended") renderResult(state);
}

function renderLobby(state) {
  $("lobbyCode").textContent = me.roomCode;
  $("lobbyLink").textContent = `${location.origin}/?room=${me.roomCode}`;
  const list = $("seatList"); list.innerHTML = "";
  state.players.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span style="font-size:16px">${PAWN_ICONS[i]}</span> <b style="color:${SEAT_COLORS[i]}">${esc(p.displayName)}</b>${p.seatId === me.seatId ? " (你)" : ""}${i === 0 ? " · 房主" : ""}`;
    list.appendChild(li);
  });
  const canStart = me.host && state.players.length >= 2;
  $("btnStart").classList.toggle("hidden", !me.host);
  $("btnStart").disabled = !canStart;
  $("startHint").textContent = me.host ? (canStart ? "" : "至少 2 人才能开始") : "等待房主开始…";
}

// 8×8 外圈坐标(行,列 1..8),顺时针,共 28 格。
function ringCoords() {
  const c = [];
  for (let col = 1; col <= 8; col++) c.push([1, col]);
  for (let row = 2; row <= 8; row++) c.push([row, 8]);
  for (let col = 7; col >= 1; col--) c.push([8, col]);
  for (let row = 7; row >= 2; row--) c.push([row, 1]);
  return c;
}
function tileName(t) {
  if (t.type === "property") {
    const d = DISTRICTS[t.property.groupId];
    const n = (t.name.match(/\d+/) || [""])[0];
    return `${d ? d.name : t.name}·${n}`;
  }
  return TYPE_NAME[t.type] || t.name;
}

function renderBoard(state) {
  const board = $("board"); board.innerHTML = "";
  const coords = ringCoords();
  const seatIdx = (sid) => state.order.indexOf(sid);
  const curPos = state.players.find((p) => p.seatId === state.order[state.currentIndex])?.position;
  state.config.tiles.forEach((t, i) => {
    const [row, col] = coords[i] || [1, 1];
    const el = document.createElement("div");
    el.className = "tile";
    el.style.gridRow = row; el.style.gridColumn = col;
    if (i === curPos) el.classList.add("cur");
    let inner = "";
    if (t.type === "property") {
      const ps = state.properties.find((p) => p.tileIndex === i);
      const d = DISTRICTS[t.property.groupId];
      if (ps && ps.mortgaged) el.classList.add("mtg");
      inner += `<div class="band" style="background:${d ? d.color : "#888"}"></div>`;
      inner += `<div class="nm">${esc(tileName(t))}</div><div class="pr">${t.property.price}</div>`;
      if (ps && ps.ownerSeatId !== null) inner += `<div class="owner" style="background:${SEAT_COLORS[seatIdx(ps.ownerSeatId)]}"></div>`;
      if (ps && ps.houseLevel > 0) inner += `<div class="bld">${BUILDINGS[ps.houseLevel] || ""}</div>`;
    } else {
      inner += `<div class="ico">${TYPE_ICON[t.type] || ""}</div><div class="nm">${esc(tileName(t))}</div>`;
      if (t.type === "tax") inner += `<div class="pr">-${t.taxAmount}</div>`;
    }
    el.innerHTML = inner;
    board.appendChild(el);
  });
}

function renderPawns(state) {
  const layer = $("pawnLayer");
  const coords = ringCoords();
  const byTile = {};
  state.players.forEach((p) => { if (p.status !== "spectating") (byTile[p.position] = byTile[p.position] || []).push(p.seatId); });
  state.players.forEach((p, i) => {
    let el = pawnEls[p.seatId];
    if (p.status === "spectating") { if (el) { el.remove(); delete pawnEls[p.seatId]; } return; }
    if (!el) {
      el = document.createElement("div"); el.className = "pawn"; el.textContent = PAWN_ICONS[i];
      el.style.background = SEAT_COLORS[i] + "cc";
      layer.appendChild(el); pawnEls[p.seatId] = el;
    }
    el.classList.toggle("me", p.seatId === me.seatId);
    const [row, col] = coords[p.position] || [1, 1];
    const g = byTile[p.position] || [p.seatId]; const k = g.indexOf(p.seatId); const n = g.length;
    const ox = (k - (n - 1) / 2) * 3.2;
    el.style.left = `calc(${((col - 0.5) / 8) * 100}% + ${ox}%)`;
    el.style.top = `${((row - 0.5) / 8) * 100}%`;
  });
}

function renderPlayers(state) {
  const curSeat = state.order[state.currentIndex];
  const html = (p, i, compact) => {
    const cls = "pl" + (p.seatId === curSeat ? " cur" : "") + (p.status !== "active" ? " out" : "") + (p.seatId === me.seatId ? " me" : "");
    const tag = p.connection !== "online" ? `<span class="tag">${p.connection === "ai" ? "托管" : "掉线"}</span>` : (p.inJail ? `<span class="tag">狱</span>` : "");
    const ava = `<span class="ava" style="background:${SEAT_COLORS[i]}">${PAWN_ICONS[i]}</span>`;
    return `<div class="${cls}">${ava}<span class="nm">${esc(p.displayName)}</span>${tag}<span class="cash">${coin(p.cash)}</span></div>`;
  };
  $("players").innerHTML = state.players.map((p, i) => html(p, i)).join("");
  $("avatars").innerHTML = state.players.map((p, i) => html(p, i, true)).join("");
}

function myTurn(state) { return state.order[state.currentIndex] === me.seatId; }

function renderHub(state) {
  const curSeat = state.order[state.currentIndex];
  const cur = state.players.find((p) => p.seatId === curSeat);
  let label = "—";
  if (state.phase === "playing") {
    const who = cur ? (cur.seatId === me.seatId ? "轮到你" : `轮到 ${cur.displayName}`) : "";
    const phaseTxt = { "awaiting-buy": "· 决定是否购买", trade: "· 交易中", auction: "· 拍卖中" }[state.turnPhase] || "";
    label = `${who} ${phaseTxt}`;
  } else if (state.phase === "ended") label = "对局结束";
  $("turnInfo").textContent = label;
}

// 主操作条:当前可用的主要动作
function renderActionBar(state) {
  const bar = $("actionBar"); bar.innerHTML = "";
  if (state.phase !== "playing") return;
  const mine = myTurn(state);
  if (state.turnPhase === "normal" && mine) {
    if (!state.rolledThisTurn) bar.appendChild(btn("🎲 掷骰", () => { sfx("click"); cmd({ type: "RollDice" }); }));
    else {
      bar.appendChild(btn("结束回合", () => { sfx("click"); cmd({ type: "EndTurn" }); }));
      if (myProps(state).length || others(state).length) bar.appendChild(btn("地产 / 交易", () => openManage(state), "ghost"));
    }
  } else if (state.turnPhase === "awaiting-buy" && mine) {
    const price = state.config.tiles[state.pendingBuyTile]?.property?.price;
    bar.appendChild(btn(`购买 ${coin(price)}`, () => { sfx("buy"); cmd({ type: "BuyProperty" }); }));
    bar.appendChild(btn("不买 · 拍卖", () => { sfx("click"); cmd({ type: "DeclineBuy" }); }, "ghost"));
  } else if (!mine && (state.turnPhase === "normal" || state.turnPhase === "awaiting-buy")) {
    const who = state.players.find((p) => p.seatId === state.order[state.currentIndex]);
    bar.appendChild(hint(`等待 ${who ? who.displayName : "对手"} 行动…`));
  }
}

// --- 弹层 sheet:交易 / 拍卖 / 地产管理 -------------------------------------
let sheetMode = null;
function openSheet(title, node, mode) {
  $("sheetTitle").textContent = title;
  const body = $("sheetBody"); body.innerHTML = ""; body.appendChild(node);
  $("sheet").classList.remove("hidden"); sheetMode = mode || title;
}
function closeSheet() { $("sheet").classList.add("hidden"); sheetMode = null; }
function openManage(state) { sfx("click"); openSheet("地产 / 交易", manageNode(state), "manage"); }

// 按 state 自动弹出需要"我"立刻处理的强交互(交易响应 / 拍卖出价)
function renderSheet(state) {
  if (state.phase !== "playing") { if (sheetMode) closeSheet(); return; }
  const needTrade = state.turnPhase === "trade" && state.trade && state.trade.awaiting === me.seatId;
  const needBid = state.turnPhase === "auction" && state.auction && state.auction.order[state.auction.turnPtr] === me.seatId;
  if (needTrade) { openSheet("收到交易报价", tradeRespondNode(state), "trade-resp"); return; }
  if (needBid) { openSheet("拍卖竞价", auctionNode(state), "auction"); return; }
  // 这两类强交互结束后,自动收起对应弹层(手动打开的 manage 不动)
  if (sheetMode === "trade-resp" || sheetMode === "auction") closeSheet();
}

function manageNode(state) {
  const wrap = document.createElement("div");
  // 地产管理
  const mp = myProps(state);
  const mgr = document.createElement("div"); mgr.className = "panel";
  mgr.innerHTML = `<h4>我的地产</h4>`;
  if (!mp.length) mgr.innerHTML += `<div class="hint">暂无地产</div>`;
  mp.forEach((ps) => {
    const t = state.config.tiles[ps.tileIndex];
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<span style="flex:1">${esc(tileName(t))} ${ps.mortgaged ? "(抵押中)" : ""} ${ps.houseLevel ? BUILDINGS[ps.houseLevel] : ""}</span>`;
    if (!ps.mortgaged) {
      row.appendChild(btn("盖楼", () => { sfx("buy"); cmd({ type: "BuildHouse", tileIndex: ps.tileIndex }); }, "ghost"));
      row.appendChild(btn("抵押", () => { sfx("click"); cmd({ type: "Mortgage", tileIndex: ps.tileIndex }); }, "ghost"));
    } else row.appendChild(btn("赎回", () => { sfx("click"); cmd({ type: "Redeem", tileIndex: ps.tileIndex }); }, "ghost"));
    mgr.appendChild(row);
  });
  wrap.appendChild(mgr);
  // 发起交易
  const op = others(state);
  if (op.length) wrap.appendChild(tradeProposeNode(state, op));
  return wrap;
}

function tradeProposeNode(state, op) {
  const panel = document.createElement("div"); panel.className = "panel";
  panel.innerHTML = `<h4>发起交易</h4>`;
  const sel = document.createElement("select");
  op.forEach((p) => { const o = document.createElement("option"); o.value = p.seatId; o.textContent = p.displayName; sel.appendChild(o); });
  const selRow = document.createElement("div"); selRow.className = "row"; selRow.append("对方:", sel); panel.appendChild(selRow);

  const giveWrap = document.createElement("div"); giveWrap.className = "row"; giveWrap.innerHTML = "<div style='width:100%'>给出我的地产:</div>";
  myProps(state).forEach((ps) => giveWrap.appendChild(checkbox("give", ps.tileIndex, tileName(state.config.tiles[ps.tileIndex]))));
  panel.appendChild(giveWrap);

  const getWrap = document.createElement("div"); getWrap.className = "row";
  const refreshGet = () => {
    getWrap.innerHTML = "<div style='width:100%'>索取对方地产:</div>";
    state.properties.filter((p) => p.ownerSeatId === sel.value).forEach((ps) => getWrap.appendChild(checkbox("get", ps.tileIndex, tileName(state.config.tiles[ps.tileIndex]))));
  };
  sel.onchange = refreshGet; refreshGet(); panel.appendChild(getWrap);

  const gc = numInput("我付"); const rc = numInput("要现金");
  const cashRow = document.createElement("div"); cashRow.className = "row"; cashRow.append(gc.label, rc.label); panel.appendChild(cashRow);
  panel.appendChild(btn("发送报价", () => {
    sfx("click");
    cmd({ type: "ProposeTrade", counterparty: sel.value, giveProperties: checked(giveWrap, "give"), giveCash: +gc.input.value || 0, getProperties: checked(getWrap, "get"), getCash: +rc.input.value || 0 });
    closeSheet();
  }));
  return panel;
}

function tradeRespondNode(state) {
  const o = state.trade;
  const panel = document.createElement("div"); panel.className = "panel";
  const names = (arr) => arr.map((i) => tileName(state.config.tiles[i])).join("、") || "—";
  panel.innerHTML = `<div>对方给:地产[${esc(names(o.giveProperties))}] + ${coin(o.giveCash)}</div>
    <div>对方要:地产[${esc(names(o.getProperties))}] + ${coin(o.getCash)}</div>`;
  const row = document.createElement("div"); row.className = "row";
  row.appendChild(btn("接受", () => { sfx("buy"); cmd({ type: "RespondTrade", action: "accept" }); }));
  row.appendChild(btn("拒绝", () => { sfx("click"); cmd({ type: "RespondTrade", action: "reject" }); }, "ghost"));
  if (!o.counterUsed && me.seatId === o.counterparty) {
    row.appendChild(btn("还价 +50(仅1次)", () => { sfx("click"); cmd({ type: "RespondTrade", action: "counter", counter: { giveProperties: o.giveProperties, giveCash: o.giveCash + 50, getProperties: o.getProperties, getCash: o.getCash } }); }, "ghost"));
  }
  panel.appendChild(row);
  return panel;
}

function auctionNode(state) {
  const a = state.auction; const t = state.config.tiles[a.tileIndex];
  const panel = document.createElement("div"); panel.className = "panel";
  panel.innerHTML = `<h4>${esc(tileName(t))}</h4><div>当前最高价:${coin(a.currentHigh)}${a.currentHighSeat ? " · " + esc(seatName(state, a.currentHighSeat)) : ""}</div>`;
  const inp = numInput("出价"); inp.input.value = a.currentHigh + 10;
  const row = document.createElement("div"); row.className = "row"; row.appendChild(inp.label);
  row.appendChild(btn("加价", () => { sfx("click"); cmd({ type: "PlaceBid", amount: +inp.input.value || 0 }); }));
  row.appendChild(btn("放弃", () => { sfx("click"); cmd({ type: "PassBid" }); }, "ghost"));
  panel.appendChild(row);
  return panel;
}

// --- 掷骰动画(强制定格到服务端点数)---------------------------------------
let diceTimer = null;
function animateDice(dice) {
  clearInterval(diceTimer); diceTimer = null;
  const d0 = $("die0"), d1 = $("die1"), box = $("dice");
  const lock = () => { d0.textContent = DICE_FACES[dice[0]]; d1.textContent = DICE_FACES[dice[1]]; box.classList.remove("rolling"); };
  if (animMode() === "off") { lock(); return; }
  box.classList.add("rolling");
  const dur = animMode() === "lite" ? 350 : 750;
  const rnd = () => 1 + Math.floor(Math.random() * 6); // 仅视觉滚动,非游戏结果
  diceTimer = setInterval(() => { d0.textContent = DICE_FACES[rnd()]; d1.textContent = DICE_FACES[rnd()]; }, 70);
  setTimeout(() => { clearInterval(diceTimer); diceTimer = null; lock(); }, dur);
}

// --- 倒计时 -----------------------------------------------------------------
let cdTimer = null, cdEpoch = -1, cdDeadline = 0;
function renderCountdown(state) {
  const el = $("countdown");
  if (state.phase !== "playing" || !state.timer) { el.classList.add("hidden"); clearInterval(cdTimer); cdTimer = null; cdEpoch = -1; return; }
  if (state.timer.epoch !== cdEpoch) { cdEpoch = state.timer.epoch; cdDeadline = Date.now() + state.timer.durationMs; }
  el.classList.remove("hidden");
  const tick = () => {
    const s = Math.max(0, Math.ceil((cdDeadline - Date.now()) / 1000));
    el.textContent = `⏱ ${s}s`;
    el.classList.toggle("urgent", s <= 5);
  };
  tick();
  if (!cdTimer) cdTimer = setInterval(tick, 250);
}

// --- 结果页 -----------------------------------------------------------------
let endReason = "";
function renderResult(state) {
  const why = { "time-limit": "30 分钟时长到点结算", "turn-limit": "回合上限到点结算", "last-standing": "仅剩一人" }[endReason] || "";
  const items = state.ranking.map((r, i) => {
    const idx = state.order.indexOf(r.seatId);
    return `<li class="${i === 0 ? "win" : ""}"><span class="rk">${r.rank}</span>
      <span class="ava" style="background:${SEAT_COLORS[idx]};width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center">${PAWN_ICONS[idx]}</span>
      <span style="flex:1">${esc(seatName(state, r.seatId))}${i === 0 ? " 🏆" : ""}</span>
      <b>${coin(r.netWorth)}</b></li>`;
  }).join("");
  $("result").classList.remove("hidden");
  $("result").innerHTML = `<div class="box"><h2>🏁 对局结束</h2>${why ? `<p class="hint">${why}</p>` : ""}<ol>${items}</ol><button class="big" onclick="location.reload()">再来一局</button></div>`;
}

// --- 事件 -> 音效 / 动画 / 日志 ---------------------------------------------
function processEvents(events, state, prev) {
  if (!events || !events.length) return;
  const log = $("log");
  for (const e of events) {
    if (e.type === "GameEnded") endReason = e.reason;
    if (e.type === "DiceRolled") { animateDice(e.dice); sfx("dice"); }
    else if (e.type === "PlayerMoved" && e.from !== e.to) sfx("move");
    else if (e.type === "PropertyBought" || e.type === "HouseBuilt") sfx("buy");
    else if (e.type === "RentPaid" || e.type === "TaxPaid") sfx("rent");
    else if (e.type === "CardDrawn") sfx("card");
    else if (e.type === "SentToJail") sfx("jail");
    else if (e.type === "AuctionResolved" && e.result === "sold") sfx("buy");
    else if (e.type === "TradeResolved" && e.result === "accepted") sfx("buy");
    else if (e.type === "PlayerBankrupt") sfx("bankrupt");
    else if (e.type === "GameEnded") sfx("win");
    else if (e.type === "TurnChanged" && e.seatId === me.seatId) sfx("yourturn");
    const txt = eventText(e, state);
    if (txt) { const d = document.createElement("div"); d.textContent = txt; log.appendChild(d); }
  }
  while (log.childElementCount > 120) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// --- 音效引擎(Web Audio 合成,无外部素材;首次手势解锁)---------------------
let actx = null, master = null;
let audio = JSON.parse(localStorage.getItem("br_audio") || '{"muted":false,"vol":0.6}');
function ensureAudio() {
  if (actx) { if (actx.state === "suspended") actx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  actx = new AC(); master = actx.createGain(); master.connect(actx.destination); applyAudio();
}
function applyAudio() { if (master) master.gain.value = audio.muted ? 0 : audio.vol; }
function saveAudio() { localStorage.setItem("br_audio", JSON.stringify(audio)); }
function blip(freq, t0, dur, type, peak) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type || "sine"; o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak || 0.6, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function sfx(name) {
  if (!actx || audio.muted) return;
  const t = actx.currentTime;
  switch (name) {
    case "dice": for (let i = 0; i < 4; i++) blip(180 + Math.random() * 120, t + i * 0.05, 0.05, "square", 0.25); break;
    case "move": blip(520, t, 0.06, "triangle", 0.3); break;
    case "buy": blip(523, t, 0.1, "sine", 0.5); blip(784, t + 0.08, 0.14, "sine", 0.5); break;
    case "rent": blip(660, t, 0.08, "sine", 0.4); blip(880, t + 0.06, 0.1, "sine", 0.4); break;
    case "card": blip(700, t, 0.08, "triangle", 0.4); blip(990, t + 0.07, 0.1, "triangle", 0.4); break;
    case "jail": blip(200, t, 0.25, "sawtooth", 0.4); break;
    case "bankrupt": blip(400, t, 0.18, "sawtooth", 0.4); blip(260, t + 0.16, 0.28, "sawtooth", 0.4); break;
    case "yourturn": blip(880, t, 0.12, "sine", 0.5); break;
    case "click": blip(420, t, 0.04, "square", 0.25); break;
    case "win": [523, 659, 784, 1047].forEach((f, i) => blip(f, t + i * 0.12, 0.18, "sine", 0.5)); break;
  }
}

// --- 动画档位 + 降级 --------------------------------------------------------
let animPref = localStorage.getItem("br_anim") || "full";
function animMode() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "off";
  return animPref;
}
function applyAnim() { document.body.dataset.anim = animMode(); }
function probeFps() {
  if (animPref !== "full") return;
  let frames = 0; const start = performance.now();
  const loop = (now) => {
    frames++;
    if (now - start < 1000) requestAnimationFrame(loop);
    else if (frames < 40) { animPref = "lite"; localStorage.setItem("br_anim", "lite"); $("animSel").value = "lite"; applyAnim(); }
  };
  requestAnimationFrame(loop);
}

// --- 小工具 -----------------------------------------------------------------
function btn(text, fn, cls) { const b = document.createElement("button"); b.textContent = text; if (cls) b.className = cls; b.onclick = fn; return b; }
function hint(text) { const s = document.createElement("span"); s.className = "hint"; s.textContent = text; return s; }
function checkbox(group, val, label) { const s = document.createElement("label"); s.className = "opt"; s.innerHTML = `<input type="checkbox" data-group="${group}" value="${val}"/> ${esc(label)}`; return s; }
function checked(scope, group) { return [...scope.querySelectorAll(`input[data-group="${group}"]:checked`)].map((e) => +e.value); }
function numInput(ph) { const label = document.createElement("label"); label.className = "opt"; const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.value = "0"; label.append(ph + " ", input); return { label, input }; }
function myProps(state) { return state.properties.filter((p) => p.ownerSeatId === me.seatId); }
function others(state) { return state.players.filter((p) => p.seatId !== me.seatId && p.status === "active"); }
function seatName(state, sid) { return state.players.find((p) => p.seatId === sid)?.displayName || sid; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function eventText(e, s) {
  const nm = (sid) => seatName(s, sid);
  const tn = (i) => tileName(s.config.tiles[i]);
  switch (e.type) {
    case "SeatJoined": return `${esc(e.displayName)} 进入房间`;
    case "GameStarted": return "🎮 游戏开始!";
    case "TurnChanged": return `轮到 ${nm(e.seatId)}`;
    case "DiceRolled": return `${nm(e.seatId)} 掷出 ${e.dice[0]}+${e.dice[1]}${e.doubles ? "(双)" : ""}`;
    case "PlayerMoved": return e.passedStart ? `${nm(e.seatId)} 经过出发点 +奖励` : null;
    case "PropertyOffered": return `${nm(e.seatId)} 落在无主地产(可买 ${coin(e.price)})`;
    case "PropertyBought": return `${nm(e.seatId)} 买下 ${tn(e.tileIndex)}`;
    case "RentPaid": return `${nm(e.from)} 付租 ${coin(e.amount)} 给 ${nm(e.to)}`;
    case "TaxPaid": return `${nm(e.seatId)} 缴税 ${coin(e.amount)}`;
    case "CardDrawn": return `${nm(e.seatId)} 抽卡:${esc(e.text)}`;
    case "SentToJail": return `${nm(e.seatId)} 进了拘留所`;
    case "LeftJail": return `${nm(e.seatId)} 离开拘留所`;
    case "HouseBuilt": return `${nm(e.seatId)} 在 ${tn(e.tileIndex)} 盖到 ${e.level} 级`;
    case "Mortgaged": return `${nm(e.seatId)} 抵押 ${tn(e.tileIndex)} 得 ${coin(e.amount)}`;
    case "Redeemed": return `${nm(e.seatId)} 赎回 ${tn(e.tileIndex)}`;
    case "TradeProposed": return `${nm(e.offer.initiator)} 向 ${nm(e.offer.counterparty)} 发起交易`;
    case "TradeCountered": return `收到还价`;
    case "TradeResolved": return `交易${e.result === "accepted" ? "成交" : "作废"}${e.reason ? "(" + e.reason + ")" : ""}`;
    case "AuctionStarted": return `开始拍卖 ${tn(e.tileIndex)}`;
    case "BidPlaced": return `${nm(e.seatId)} 出价 ${coin(e.amount)}`;
    case "BidPassed": return `${nm(e.seatId)} 放弃`;
    case "AuctionResolved": return e.result === "sold" ? `${nm(e.winner)} 以 ${coin(e.amount)} 拍得` : "流拍";
    case "PlayerBankrupt": return `💥 ${nm(e.seatId)} 破产出局`;
    case "ConnectionChanged": return `${nm(e.seatId)} ${e.status === "online" ? "重连回来" : e.status === "ai" ? "由 AI 托管" : "掉线"}`;
    case "GameEnded": return "🏁 对局结算!";
    default: return null;
  }
}
function errText(reason) {
  return { "unknown-room": "房间不存在", "game-already-started": "游戏已开始,无法加入", "session-not-found": "会话失效,请重新进房", "only-host-can-start": "只有房主能开始", "room-full": "房间已满(上限 8 人)" }[reason] || reason;
}

// --- 绑定 -------------------------------------------------------------------
$("btnCreate").onclick = () => { ensureAudio(); send({ t: "create", nickname: $("nickname").value }); };
$("btnJoin").onclick = () => { ensureAudio(); send({ t: "join", roomCode: $("joinCode").value.toUpperCase(), nickname: $("nickname").value }); };
$("btnStart").onclick = () => { ensureAudio(); send({ t: "start" }); };
$("sheetClose").onclick = closeSheet;
$("sheetBackdrop").onclick = closeSheet;

$("muteBtn").onclick = () => { ensureAudio(); audio.muted = !audio.muted; $("muteBtn").textContent = audio.muted ? "🔇" : "🔊"; applyAudio(); saveAudio(); };
$("volume").value = Math.round(audio.vol * 100);
$("muteBtn").textContent = audio.muted ? "🔇" : "🔊";
$("volume").oninput = (e) => { audio.vol = (+e.target.value) / 100; audio.muted = false; $("muteBtn").textContent = "🔊"; applyAudio(); saveAudio(); };

$("animSel").value = animPref;
$("animSel").onchange = (e) => { animPref = e.target.value; localStorage.setItem("br_anim", animPref); applyAnim(); };

// 首次用户手势解锁 AudioContext(浏览器 autoplay 策略)
window.addEventListener("pointerdown", ensureAudio, { once: true });
window.addEventListener("keydown", ensureAudio, { once: true });

// ?room=XXXX 自动填充
const params = new URLSearchParams(location.search);
if (params.get("room")) $("joinCode").value = params.get("room").toUpperCase();

applyAnim();
probeFps();
connect();
