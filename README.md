# BigRich

轻量级、可联机的「大富翁类」多人对战游戏(去 IP 化命名)。免下载免注册、点链接开房同玩,2–8 人实时对局。

> 开发文档见 `.devflow/project/`(需求 → 设计 → 技术选型 → MVP → 验收)。先读文档,再读代码。

## 架构一句话
**服务端权威 + 单房间单写者 + 端无关规则引擎**。掷骰/资金/结算/成交全部服务端裁决(防作弊);
每个房间一条有序命令队列串行处理(交易同价/拍卖超额等竞态从根上消除);
规则引擎是纯逻辑 `reduce(state, command) -> { state, events }`,不依赖传输/渲染/系统时钟,Web/H5 与小程序共享同一引擎与协议。

## 技术栈
- **TypeScript + Node.js (≥20)**
- 实时传输:**WebSocket**(`ws`)
- 并发:单房间单写者(有序队列)
- 存储:内存主存 + JSON 快照(变更驱动)
- 测试:**vitest**

## 目录
```
src/engine/    端无关规则引擎(纯逻辑)
  config.ts      §4A 数值基线 -> GameConfig(全部参数化,不写死)
  rng.ts         服务端权威掷骰(确定性 PRNG,可复现)
  types.ts       状态 / 命令(Intent) / 事件(Event)
  engine.ts      reduce 主入口 + 回合主循环
  trade.ts       交易子状态机(20s/还价1次/超时掉线兜底)
  auction.ts     拍卖子状态机(每轮10s/出价原子性/连续无加价成交)
  mortgage.ts    抵押/赎回
  helpers.ts     共享纯辅助(租金/破产/结算/计时器)
src/gateway/   连接/房间层(不含规则)
  room.ts        单写者房间运行时 + 真实时钟(到点投递 Timeout)
  server.ts      WebSocket 网关骨架
  seams.ts       三个预留口子:身份② / 合规③ / 嵌入①(首版 no-op)
test/          §4B 回归 + 回合主循环 + 单写者/时钟集成(29 用例)
```

## 开发
```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest:29 用例(含 05-acceptance §4B 全部 seed)
npm run dev:server  # 启动 WebSocket 网关(默认 ws://localhost:8080)
```

## 硬约束(实现必须满足)
- 服务端权威:骰子绝不在客户端生成。
- 端无关:规则引擎与渲染/传输彻底解耦。
- §4A 数值走 `GameConfig` 参数化,不写死。
- 三口子(嵌入/外部账号/合规)只留 seam,首版不实现。
