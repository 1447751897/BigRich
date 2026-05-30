/**
 * 快照落盘(ADR D-005:内存主存 + 快照)。
 *
 * 每次权威变更后,网关把"房间快照"(引擎全量状态 + 房主/会话映射)写到本地 JSON;
 * 进程重启/崩溃后,网关启动时加载未结束的房间快照,恢复权威状态与会话(资产/进度不丢)。
 * GameState 全量可 JSON 序列化(无函数、RNG 为数字),故快照即可满足恢复需求。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GameState, SeatId } from "../engine/types.js";

/** 房间级快照:引擎状态 + 网关侧需要的会话信息(用于重启后重连)。 */
export interface RoomSnapshot {
  code: string;
  hostSeat: SeatId | null;
  sessions: { seatId: SeatId; token: string }[];
  seatCounter: number;
  state: GameState;
}

export interface SnapshotStore {
  save(snap: RoomSnapshot): void;
  loadAll(): RoomSnapshot[];
  remove(code: string): void;
}

/** 内存实现(测试/单实例可用)。 */
export class MemorySnapshotStore implements SnapshotStore {
  private map = new Map<string, RoomSnapshot>();
  save(snap: RoomSnapshot): void {
    this.map.set(snap.code, structuredClone(snap));
  }
  loadAll(): RoomSnapshot[] {
    return [...this.map.values()].map((s) => structuredClone(s));
  }
  remove(code: string): void {
    this.map.delete(code);
  }
}

/** 本地 JSON 文件实现:snapshots/<code>.json。写入用 temp+rename 保证原子性。 */
export class FileSnapshotStore implements SnapshotStore {
  constructor(private dir = "snapshots") {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private path(code: string): string {
    return join(this.dir, `${code}.json`);
  }

  save(snap: RoomSnapshot): void {
    const tmp = this.path(snap.code) + ".tmp";
    writeFileSync(tmp, JSON.stringify(snap), "utf8");
    renameSync(tmp, this.path(snap.code)); // 原子替换,避免半写文件
  }

  loadAll(): RoomSnapshot[] {
    if (!existsSync(this.dir)) return [];
    const out: RoomSnapshot[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RoomSnapshot);
      } catch {
        // 损坏的快照跳过,不阻塞启动
      }
    }
    return out;
  }

  remove(code: string): void {
    const p = this.path(code);
    if (existsSync(p)) rmSync(p);
  }
}
