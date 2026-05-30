/**
 * 房间运行时(RoomRuntime)—— 单房间单写者(ADR D-001)。
 *
 * - 一条有序命令队列、串行处理:交易同价/拍卖超额等竞态从根上消除。
 * - 唯一权威时钟(D-004):监听引擎产出的 TimerStarted/TimerCleared 事件,
 *   用真实 setTimeout 调度,到点把合成的 Timeout 命令投回队列(超时与真人命令同路)。
 * - 内存主存 + 快照(D-005):每次权威变更后回调 onSnapshot,交由外层落盘(JSON)。
 * - 这一层不含任何游戏规则,规则全部在端无关引擎里。
 */
import { reduce } from "../engine/engine.js";
import type { Command, GameEvent, GameState, TimerKind } from "../engine/types.js";

export type Broadcast = (events: GameEvent[], state: GameState) => void;
export type SnapshotSink = (state: GameState) => void;

export interface RoomRuntimeOptions {
  /** 广播事件 + 最新状态给房内所有连接(含观战)。 */
  broadcast: Broadcast;
  /** 每次权威变更后落快照(可选)。 */
  onSnapshot?: SnapshotSink;
  /** 定时器实现(默认 setTimeout;测试可注入假时钟)。 */
  scheduler?: Scheduler;
}

export interface Scheduler {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    // 不阻止进程/测试 worker 退出:计时器只在有活连接时才有意义。
    if (typeof (h as { unref?: () => void }).unref === "function") (h as { unref: () => void }).unref();
    return h as unknown as number;
  },
  clear: (h) => clearTimeout(h),
};

export class RoomRuntime {
  private state: GameState;
  private queue: Command[] = [];
  private processing = false;
  private timerHandle: number | null = null;
  /** 独立的"对局时长硬上限"定时器(D-004 互斥时钟之外的全局 wall-clock,后台常驻)。 */
  private gameCapHandle: number | null = null;
  private readonly opts: Required<Pick<RoomRuntimeOptions, "broadcast">> & RoomRuntimeOptions;
  private readonly scheduler: Scheduler;

  constructor(initial: GameState, opts: RoomRuntimeOptions) {
    this.state = initial;
    this.opts = opts;
    this.scheduler = opts.scheduler ?? realScheduler;
    // 崩溃/重启后从快照恢复且对局进行中:重新挂上时长硬上限(按完整时长重计,见 04-mvp 限制说明)。
    if (initial.phase === "playing") this.scheduleGameCap();
  }

  getState(): GameState {
    return this.state;
  }

  /** 外部(网关/AI/定时器)提交一条命令到房间队列。 */
  submit(cmd: Command): void {
    this.queue.push(cmd);
    this.drain();
  }

  /** 串行处理:同一时刻只有一条命令在改状态(单写者)。 */
  private drain(): void {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const cmd = this.queue.shift()!;
        const { state, events } = reduce(this.state, cmd);
        this.state = state;
        this.applyTimers(events);
        this.opts.broadcast(events, state);
        this.opts.onSnapshot?.(state);
      }
    } finally {
      this.processing = false;
    }
  }

  /** 根据引擎事件驱动真实定时器:TimerStarted -> 调度;TimerCleared -> 取消;开局/结束 -> 管理时长硬上限。 */
  private applyTimers(events: GameEvent[]): void {
    for (const ev of events) {
      if (ev.type === "TimerCleared") {
        this.cancelTimer();
      } else if (ev.type === "TimerStarted") {
        this.scheduleTimer(ev.kind, ev.epoch, ev.durationMs);
      } else if (ev.type === "GameStarted") {
        this.scheduleGameCap();
      } else if (ev.type === "GameEnded") {
        this.cancelGameCap();
      }
    }
  }

  /** 调度对局时长硬上限:到点投递 ForceSettle,引擎按净资产排名强制结束(PRD ≤30 分钟收束 P0)。 */
  private scheduleGameCap(): void {
    this.cancelGameCap();
    const ms = this.state.config.hardTimeLimitMin * 60_000;
    this.gameCapHandle = this.scheduler.set(() => {
      this.gameCapHandle = null;
      this.submit({ type: "ForceSettle", issuer: "system", reason: "time-limit" });
    }, ms);
  }

  private cancelGameCap(): void {
    if (this.gameCapHandle !== null) {
      this.scheduler.clear(this.gameCapHandle);
      this.gameCapHandle = null;
    }
  }

  private scheduleTimer(kind: TimerKind, epoch: number, ms: number): void {
    this.cancelTimer();
    this.timerHandle = this.scheduler.set(() => {
      this.timerHandle = null;
      // 到点投递合成 Timeout 命令;过期的(epoch 不匹配)由引擎自行忽略。
      this.submit({ type: "Timeout", issuer: "system", kind, epoch });
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timerHandle !== null) {
      this.scheduler.clear(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
