/**
 * WebSocket 网关(ADR D-002:实时传输 = WebSocket)。
 *
 * 职责(不含游戏规则):
 * - 会话/连接管理,Intent(JSON)上行 -> 解析成引擎 Command -> 投递房间单写者队列;
 * - 引擎 Event/State 下行广播给房内所有连接(含观战);
 * - 承载三个预留口子:身份(②)、合规(③)、嵌入(①)。
 *
 * 端无关:消息体是 JSON、与端无关;Web/H5 与小程序各写自己的传输适配,协议共享。
 * 这是首版可运行骨架,重连/快照落盘等可在此基础上补全(见 04-mvp 路线)。
 */
import { WebSocketServer, type WebSocket } from "ws";
import { createGame } from "../engine/engine.js";
import type { Command, GameEvent, GameState, SeatId } from "../engine/types.js";
import { RoomRuntime } from "./room.js";
import {
  AnonymousIdentityProvider,
  NoopComplianceGate,
  NoopEmbedHost,
  type ComplianceGate,
  type EmbedHost,
  type IdentityProvider,
} from "./seams.js";

interface Conn {
  ws: WebSocket;
  roomId: string;
  seatId: SeatId;
}

interface Room {
  runtime: RoomRuntime;
  conns: Set<Conn>;
}

/** 上行 Intent 信封:{ roomId, command }。command 是引擎 Command(issuer 由网关按会话回填)。 */
interface IntentEnvelope {
  roomId: string;
  command: Omit<Command, "issuer"> & { issuer?: SeatId };
}

export class GameGateway {
  private rooms = new Map<string, Room>();
  private wss: WebSocketServer;

  constructor(
    port: number,
    private deps: { identity: IdentityProvider; compliance: ComplianceGate; embed: EmbedHost } = {
      identity: new AnonymousIdentityProvider(),
      compliance: new NoopComplianceGate(),
      embed: new NoopEmbedHost(),
    },
  ) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** 演示用:直接建房(生产中走 Intent/REST,这里给最简入口)。 */
  createRoom(roomId: string, seats: { seatId: SeatId; displayName: string }[], seed?: number): void {
    const initial: GameState = createGame(roomId, seats, seed !== undefined ? { seed } : {});
    const room: Room = {
      conns: new Set(),
      runtime: new RoomRuntime(initial, {
        broadcast: (events, state) => this.broadcast(roomId, events, state),
        onSnapshot: () => {
          /* D-005:此处可写 JSON 快照;首版留空,内存即权威态 */
        },
      }),
    };
    this.rooms.set(roomId, room);
  }

  private onConnection(ws: WebSocket): void {
    ws.on("message", (raw) => {
      let env: IntentEnvelope;
      try {
        env = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "Rejected", reason: "bad-json" }));
        return;
      }
      const room = this.rooms.get(env.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: "Rejected", reason: "unknown-room" }));
        return;
      }
      // 绑定连接到房间(首版:命令自带 issuer;生产应由会话 token 解析,见身份 seam ②)。
      const issuer = env.command.issuer;
      if (!issuer) {
        ws.send(JSON.stringify({ type: "Rejected", reason: "missing-issuer" }));
        return;
      }
      const conn: Conn = { ws, roomId: env.roomId, seatId: issuer };
      room.conns.add(conn);
      ws.once("close", () => {
        room.conns.delete(conn);
        // 掉线:标记该 seat offline,交由 AI 托管(引擎 §4C),不卡全场。
        room.runtime.submit({ type: "SetConnection", issuer: "system", target: issuer, status: "offline" });
      });
      room.runtime.submit({ ...env.command, issuer } as Command);
    });
  }

  private broadcast(roomId: string, events: GameEvent[], state: GameState): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const payload = JSON.stringify({ events, state });
    for (const c of room.conns) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }
    const ended = events.find((e) => e.type === "GameEnded");
    if (ended && ended.type === "GameEnded") {
      this.deps.embed.onGameEnded({
        roomId,
        ranking: ended.ranking.map((r) => ({ seatId: r.seatId, rank: r.rank })),
      });
    }
  }

  close(): void {
    this.wss.close();
  }
}

// 直接运行:tsx src/gateway/server.ts
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const gw = new GameGateway(port);
  // 演示房间。
  gw.createRoom("demo", [
    { seatId: "p0", displayName: "玩家0" },
    { seatId: "p1", displayName: "玩家1" },
  ]);
  // eslint-disable-next-line no-console
  console.log(`[BigRich] WebSocket 网关已启动 ws://localhost:${port}  (demo 房间已创建)`);
}
