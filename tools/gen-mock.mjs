/* 生成「环游都市」主题静态 mock(SVG),给客户过样。与前端配色/布局一致。 */
import { writeFileSync } from "node:fs";

const SEAT = ["#3d7eff", "#ff6f91", "#16c79a", "#f5a623"];
const PAWN = ["🚗", "🎩", "🐕", "🚀"];
const DISTRICTS = [
  { name: "翡翠湾", color: "#16c79a" }, { name: "金沙滩", color: "#f5a623" },
  { name: "霓虹巷", color: "#ff6f91" }, { name: "紫藤台", color: "#9b6dff" },
  { name: "蓝湾港", color: "#3d7eff" }, { name: "朝阳门", color: "#ff5d5d" },
];
// 28 格类型布局(与引擎默认棋盘一致:角 0/7/14/21,其余为地产/机遇命运税)
const corners = { 0: "🏁出发", 7: "🚔拘留所", 14: "🌳公园", 21: "🚨入狱" };
const special = { 3: "❓机遇", 6: "🏦税务", 10: "🃏命运", 17: "❓机遇", 23: "🃏命运", 27: "🏦税务" };
const propSlots = [1, 2, 4, 5, 8, 9, 11, 12, 13, 15, 16, 18, 19, 20, 22, 24, 25, 26];
const groupOf = {}; propSlots.forEach((idx, k) => { groupOf[idx] = DISTRICTS[Math.floor(k / 3)]; });

function ring() {
  const c = [];
  for (let col = 1; col <= 8; col++) c.push([1, col]);
  for (let row = 2; row <= 8; row++) c.push([row, 8]);
  for (let col = 7; col >= 1; col--) c.push([8, col]);
  for (let row = 7; row >= 2; row--) c.push([row, 1]);
  return c;
}
const coords = ring();

// 样例归属/建筑/棋子
const owners = { 1: 0, 2: 0, 4: 1, 8: 2, 11: 0, 16: 3, 19: 1, 24: 2 };
const houses = { 1: 2, 2: 1, 11: 5, 16: 3 };
const pawnsAt = { 0: [0], 5: [1], 11: [2], 18: [3] };
const BLD = { 1: "🏠", 2: "🏘️", 3: "🏢", 4: "🏬", 5: "🏙️" };

const PAD = 16, BOARD = 560, CELL = (BOARD - PAD * 2) / 8, W = 980, H = 600;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="PingFang SC, Microsoft YaHei, sans-serif">`;
svg += `<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b3b6f"/><stop offset="0.5" stop-color="#2a5298"/><stop offset="1" stop-color="#6dd5ed"/></linearGradient></defs>`;
svg += `<rect width="${W}" height="${H}" fill="url(#sky)"/>`;
svg += `<text x="20" y="34" fill="#fff" font-size="22" font-weight="800">🏙️ 环游都市 · 主题预览</text>`;

// 棋盘底
svg += `<rect x="${PAD}" y="48" width="${BOARD - PAD * 2 + PAD * 2 - PAD * 2}" height="${BOARD - PAD}" rx="18" fill="#0f2a52"/>`;
const ox = PAD, oy = 48 + PAD;
for (let i = 0; i < 28; i++) {
  const [row, col] = coords[i];
  const x = ox + (col - 1) * CELL + 3, y = oy + (row - 1) * CELL + 3, w = CELL - 6, h = CELL - 6;
  const isCorner = corners[i], isSpecial = special[i];
  const fill = isCorner ? "#eaf3ff" : isSpecial ? "#fff4ea" : "#ffffff";
  svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}"/>`;
  if (groupOf[i]) {
    svg += `<rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="9" rx="3" fill="${groupOf[i].color}"/>`;
    const n = propSlots.indexOf(i) % 3 + 1;
    svg += `<text x="${x + 5}" y="${y + 28}" font-size="10" font-weight="700" fill="#1f2a44">${groupOf[i].name}·${n}</text>`;
    if (owners[i] !== undefined) svg += `<circle cx="${x + w - 9}" cy="${y + 22}" r="5" fill="${SEAT[owners[i]]}" stroke="#fff" stroke-width="1.5"/>`;
    if (houses[i]) svg += `<text x="${x + w - 20}" y="${y + h - 6}" font-size="14">${BLD[houses[i]]}</text>`;
  } else if (isCorner || isSpecial) {
    const label = isCorner || isSpecial;
    svg += `<text x="${x + w / 2}" y="${y + h / 2 - 2}" font-size="18" text-anchor="middle">${label.slice(0, 2)}</text>`;
    svg += `<text x="${x + w / 2}" y="${y + h / 2 + 16}" font-size="9" text-anchor="middle" fill="#1f2a44">${label.slice(2)}</text>`;
  }
  // 棋子
  (pawnsAt[i] || []).forEach((s, k) => {
    svg += `<circle cx="${x + 14 + k * 12}" cy="${y + h - 14}" r="9" fill="${SEAT[s]}cc"/>`;
    svg += `<text x="${x + 14 + k * 12}" y="${y + h - 10}" font-size="11" text-anchor="middle">${PAWN[s]}</text>`;
  });
}
// 中央 hub
const hx = ox + CELL + 6, hy = oy + CELL + 6, hw = CELL * 6 - 12, hh = CELL * 6 - 12;
svg += `<text x="${hx + hw / 2}" y="${hy + hh / 2 - 30}" font-size="56" text-anchor="middle">🏙️🌆</text>`;
svg += `<text x="${hx + hw / 2}" y="${hy + hh / 2 + 14}" font-size="20" font-weight="800" fill="#fff" text-anchor="middle">轮到 你 · 决策中</text>`;
svg += `<rect x="${hx + hw / 2 - 60}" y="${hy + hh / 2 + 30}" width="50" height="50" rx="12" fill="#fff"/><text x="${hx + hw / 2 - 35}" y="${hy + hh / 2 + 68}" font-size="34" text-anchor="middle">⚃</text>`;
svg += `<rect x="${hx + hw / 2 + 10}" y="${hy + hh / 2 + 30}" width="50" height="50" rx="12" fill="#fff"/><text x="${hx + hw / 2 + 35}" y="${hy + hh / 2 + 68}" font-size="34" text-anchor="middle">⚁</text>`;
svg += `<rect x="${hx + hw / 2 - 38}" y="${hy + hh / 2 + 90}" width="76" height="26" rx="13" fill="rgba(0,0,0,.3)"/><text x="${hx + hw / 2}" y="${hy + hh / 2 + 108}" font-size="15" font-weight="800" fill="#fff" text-anchor="middle">⏱ 18s</text>`;

// 右侧:玩家条 + 结果预览
const px = BOARD + 20;
const names = ["你 🏆", "小明", "阿强", "莉莉"];
const cash = [2240, 1180, 760, 430];
svg += `<text x="${px}" y="74" fill="#fff" font-size="15" font-weight="700">玩家</text>`;
names.forEach((nm, i) => {
  const y = 86 + i * 46;
  svg += `<rect x="${px}" y="${y}" width="340" height="38" rx="12" fill="#fff" ${i === 0 ? 'stroke="#f4b740" stroke-width="2"' : ""}/>`;
  svg += `<circle cx="${px + 22}" cy="${y + 19}" r="13" fill="${SEAT[i]}"/><text x="${px + 22}" y="${y + 24}" font-size="14" text-anchor="middle">${PAWN[i]}</text>`;
  svg += `<text x="${px + 44}" y="${y + 24}" font-size="14" font-weight="600" fill="#1f2a44">${nm}</text>`;
  svg += `<text x="${px + 330}" y="${y + 24}" font-size="14" font-weight="800" fill="#f4b740" text-anchor="end">🪙${cash[i]}</text>`;
});
// 结果卡预览
const ry = 86 + 4 * 46 + 14;
svg += `<rect x="${px}" y="${ry}" width="340" height="${H - ry - 16}" rx="16" fill="#fbfcff"/>`;
svg += `<text x="${px + 170}" y="${ry + 30}" font-size="17" font-weight="800" fill="#1f2a44" text-anchor="middle">🏁 对局结束 · 净资产排名</text>`;
["🥇 你 🪙2240", "🥈 小明 🪙1180", "🥉 阿强 🪙760"].forEach((t, i) => {
  svg += `<rect x="${px + 14}" y="${ry + 46 + i * 34}" width="312" height="28" rx="9" fill="${i === 0 ? "#ffe6a8" : "#f3f7fc"}"/>`;
  svg += `<text x="${px + 24}" y="${ry + 65 + i * 34}" font-size="13" font-weight="${i === 0 ? 800 : 600}" fill="#1f2a44">${t}</text>`;
});
svg += `</svg>`;
writeFileSync(new URL("../public/theme-mock.svg", import.meta.url), svg);
console.log("wrote public/theme-mock.svg");
