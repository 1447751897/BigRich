/**
 * WebSocket 网关(ADR D-002)+ 房间大厅/会话 + 静态前端服务。
 *
 * 职责(不含游戏规则,规则全在端无关引擎):
 * - HTTP 提供前端静态页(public/);
 * - WS 承载大厅协议(create/join/start/reconnect)与对局意图(cmd);
 * - Intent 上行 -> 回填 issuer=会话座位 -> 投递房间单写者队列;Event/State 下行广播;
 * - 掉线 -> 标记 offline 交 AI 托管(§4C),session token 支持重连恢复(资产/进度不丢);
 * - 三口子(身份②/合规③/嵌入①)在此承载,首版 no-op。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { createGame } from "../engine/engine.js";
import type { Command, GameEvent, GameState, SeatId } from "../engine/types.js";
import { aiDefaultCommand } from "./ai.js";
import { RoomRuntime } from "./room.js";
import { FileSnapshotStore, type SnapshotStore } from "./snapshot.js";
import {
  AnonymousIdentityProvider,
  NoopComplianceGate,
  NoopEmbedHost,
  type ComplianceGate,
  type EmbedHost,
  type IdentityProvider,
} from "./seams.js";

interface Session {
  seatId: SeatId;
  token: string;
  ws: WebSocket | null;
}

interface Room {
  code: string;
  runtime: RoomRuntime;
  hostSeat: SeatId | null;
  sessions: Map<string, Session>; // token -> session
  seatToken: Map<SeatId, string>; // seatId -> token
  seatCounter: number;
}

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export class GameGateway {
  private rooms = new Map<string, Room>();
  private wss: WebSocketServer;
  private httpServer;

  constructor(
    private port: number,
    private deps: { identity: IdentityProvider; compliance: ComplianceGate; embed: EmbedHost } = {
      identity: new AnonymousIdentityProvider(),
      compliance: new NoopComplianceGate(),
      embed: new NoopEmbedHost(),
    },
    private store: SnapshotStore = new FileSnapshotStore(),
  ) {
    this.httpServer = createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.restoreFromSnapshots();
  }

  /** 启动时从快照恢复未结束的房间(D-005:重启/崩溃后资产/进度不丢)。 */
  private restoreFromSnapshots(): void {
    for (const snap of this.store.loadAll()) {
      if (snap.state.phase === "ended") {
        this.store.remove(snap.code);
        continue;
      }
      const room: Room = {
        code: snap.code,
        hostSeat: snap.hostSeat,
        sessions: new Map(snap.sessions.map((s) => [s.token, { seatId: s.seatId, token: s.token, ws: null }])),
        seatToken: new Map(snap.sessions.map((s) => [s.seatId, s.token])),
        seatCounter: snap.seatCounter,
        runtime: undefined as unknown as RoomRuntime,
      };
      // 恢复时把全部座位标记 offline,等客户端持 token 重连(此前在线者重连即恢复)。
      room.runtime = new RoomRuntime(snap.state, { broadcast: (events, state) => this.afterCommand(room, events, state) });
      this.rooms.set(snap.code, room);
    }
  }

  private persist(room: Room): void {
    this.store.save({
      code: room.code,
      hostSeat: room.hostSeat,
      sessions: [...room.sessions.values()].map((s) => ({ seatId: s.seatId, token: s.token })),
      seatCounter: room.seatCounter,
      state: room.runtime.getState(),
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.httpServer.listen(this.port, () => resolve()));
  }

  /** 实际监听端口(构造传 0 时由系统分配,测试用)。 */
  actualPort(): number {
    const a = this.httpServer.address();
    return typeof a === "object" && a ? a.port : this.port;
  }

  close(): void {
    this.wss.close();
    this.httpServer.close();
  }

  // --- 静态前端 -------------------------------------------------------------
  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const urlPath = (req.url ?? "/").split("?")[0]!;
    let rel = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404");
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  }

  // --- 房间 -----------------------------------------------------------------
  private newRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    do {
      code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  private createRoom(code: string): Room {
    // 生产建房注入真随机种子(crypto):每局 RNG 起点不同,掷骰不可预期。
    // 引擎默认种子仅供回归测试复现,绝不落到正式对局(修复"骰子点数按固定流程可预期")。
    const initial: GameState = createGame(code, [], { seed: randomInt(0x100000000) });
    const room: Room = {
      code,
      hostSeat: null,
      sessions: new Map(),
      seatToken: new Map(),
      seatCounter: 0,
      runtime: undefined as unknown as RoomRuntime,
    };
    room.runtime = new RoomRuntime(initial, {
      broadcast: (events, state) => this.afterCommand(room, events, state),
    });
    this.rooms.set(code, room);
    this.persist(room);
    return room;
  }

  /** 解散房间:通知房内全部连接退回大厅,移除内存房间与落盘快照。 */
  private closeRoom(room: Room, reason: string): void {
    const payload = JSON.stringify({ t: "room-closed", reason });
    for (const sess of room.sessions.values()) {
      if (sess.ws && sess.ws.readyState === sess.ws.OPEN) sess.ws.send(payload);
    }
    this.rooms.delete(room.code);
    this.store.remove(room.code);
  }

  // --- 连接与协议 -----------------------------------------------------------
  private onConnection(ws: WebSocket): void {
    let bound: { room: Room; token: string } | null = null;

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.send(ws, { t: "error", reason: "bad-json" });
      }

      switch (msg.t) {
        case "create": {
          const room = this.createRoom(this.newRoomCode());
          const seat = this.assignSeat(room, ws, msg.nickname);
          room.hostSeat = seat.seatId;
          bound = { room, token: seat.token };
          room.runtime.submit({ type: "JoinSeat", issuer: seat.seatId, seatId: seat.seatId, displayName: seat.displayName });
          this.send(ws, { t: "joined", roomCode: room.code, seatId: seat.seatId, token: seat.token, host: true, state: room.runtime.getState() });
          break;
        }
        case "join": {
          const room = this.rooms.get(String(msg.roomCode ?? "").toUpperCase());
          if (!room) return this.send(ws, { t: "error", reason: "unknown-room" });
          if (room.runtime.getState().phase !== "lobby") return this.send(ws, { t: "error", reason: "game-already-started" });
          const seat = this.assignSeat(room, ws, msg.nickname);
          bound = { room, token: seat.token };
          room.runtime.submit({ type: "JoinSeat", issuer: seat.seatId, seatId: seat.seatId, displayName: seat.displayName });
          this.send(ws, { t: "joined", roomCode: room.code, seatId: seat.seatId, token: seat.token, host: false, state: room.runtime.getState() });
          break;
        }
        case "reconnect": {
          const room = this.rooms.get(String(msg.roomCode ?? "").toUpperCase());
          const sess = room?.sessions.get(String(msg.token ?? ""));
          if (!room || !sess) return this.send(ws, { t: "error", reason: "session-not-found" });
          sess.ws = ws;
          bound = { room, token: sess.token };
          room.runtime.submit({ type: "SetConnection", issuer: "system", target: sess.seatId, status: "online" });
          this.send(ws, { t: "joined", roomCode: room.code, seatId: sess.seatId, token: sess.token, host: room.hostSeat === sess.seatId, state: room.runtime.getState() });
          break;
        }
        case "start": {
          if (!bound) return this.send(ws, { t: "error", reason: "not-in-room" });
          const sess = bound.room.sessions.get(bound.token)!;
          if (bound.room.hostSeat !== sess.seatId) return this.send(ws, { t: "error", reason: "only-host-can-start" });
          bound.room.runtime.submit({ type: "StartGame", issuer: sess.seatId });
          break;
        }
        case "restart": {
          // 「再来一局」:仅房主可发起,把已结束的对局重置回大厅,保留座位、等待房主重新开始(可再加入新玩家)。
          if (!bound) return this.send(ws, { t: "error", reason: "not-in-room" });
          const sess = bound.room.sessions.get(bound.token)!;
          if (bound.room.hostSeat !== sess.seatId) return this.send(ws, { t: "error", reason: "only-host-can-restart" });
          bound.room.runtime.submit({ type: "RestartGame", issuer: sess.seatId });
          break;
        }
        case "cancelRoom": {
          // 房主取消/解散房间:广播 room-closed,房内玩家被清退回大厅,房间与快照一并移除。
          if (!bound) return this.send(ws, { t: "error", reason: "not-in-room" });
          const sess = bound.room.sessions.get(bound.token)!;
          if (bound.room.hostSeat !== sess.seatId) return this.send(ws, { t: "error", reason: "only-host-can-cancel" });
          this.closeRoom(bound.room, "host-cancelled");
          bound = null;
          break;
        }
        case "cmd": {
          if (!bound) return this.send(ws, { t: "error", reason: "not-in-room" });
          const sess = bound.room.sessions.get(bound.token)!;
          const command = { ...msg.command, issuer: sess.seatId } as Command;
          bound.room.runtime.submit(command);
          break;
        }
        default:
          this.send(ws, { t: "error", reason: "unknown-message" });
      }
    });

    ws.on("close", () => {
      if (!bound) return;
      const sess = bound.room.sessions.get(bound.token);
      if (sess && sess.ws === ws) {
        sess.ws = null;
        // 掉线:标记 offline -> AI 托管接管(不卡场);session 保留以便重连。
        bound.room.runtime.submit({ type: "SetConnection", issuer: "system", target: sess.seatId, status: "offline" });
      }
    });
  }

  private assignSeat(room: Room, ws: WebSocket, nickname: unknown): Session & { displayName: string } {
    const seatId = `${room.code}-${++room.seatCounter}`;
    const token = randomUUID();
    const displayName = (typeof nickname === "string" && nickname.trim() ? nickname.trim() : `玩家${room.seatCounter}`).slice(0, 16);
    const session: Session = { seatId, token, ws };
    room.sessions.set(token, session);
    room.seatToken.set(seatId, token);
    return { ...session, displayName };
  }

  /** 每条命令处理后:广播给房内所有连接 + 驱动 AI 托管推进。 */
  private afterCommand(room: Room, events: GameEvent[], state: GameState): void {
    const payload = JSON.stringify({ t: "state", events, state });
    for (const sess of room.sessions.values()) {
      if (sess.ws && sess.ws.readyState === sess.ws.OPEN) sess.ws.send(payload);
    }
    // 快照落盘(D-005):每次权威变更后持久化;结束则清理。
    const ended = events.find((e) => e.type === "GameEnded");
    if (ended && ended.type === "GameEnded") {
      this.store.remove(room.code);
      // 嵌入口子①:对局结束回调宿主。
      this.deps.embed.onGameEnded({ roomId: room.code, ranking: ended.ranking.map((r) => ({ seatId: r.seatId, rank: r.rank })) });
    } else {
      this.persist(room);
    }
    // AI 托管:若此刻该行动者非在线,替其发默认命令(快速防卡场,不依赖 25s 超时)。
    const ai = aiDefaultCommand(state);
    if (ai) room.runtime.submit(ai);
  }

  private send(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }
}

// 直接运行:tsx src/gateway/server.ts(跨平台判断入口,避免 Windows file:// 斜杠差异)
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = entry !== "" && fileURLToPath(import.meta.url) === entry;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const gw = new GameGateway(port);
  gw.listen().then(() => {
    // eslint-disable-next-line no-console
    console.log(`[BigRich] http://localhost:${port}  打开即可建房/试玩(WebSocket 同端口)`);
  });
}
