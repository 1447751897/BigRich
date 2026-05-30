---
track: lite
type: fix
status: done
owner: 开发工程师
updated: 2026-05-30
---
# 骰子点数不随机(生产用固定种子)

## 背景(一句话)
reporter 实测"按固定流程走下去骰子点数可预期、非随机"——影响所有正式对局的公平性(correctness 级)。

## 改动
- 根因:`gateway/server.ts` 的 `createRoom` 调 `createGame(code, [])` 未传 seed,引擎默认回退到固定种子 `0x1a2b3c4d`,导致**每间房 RNG 起点相同 → 骰子序列恒定可预期**。
- 修复:建房时注入真随机种子 `createGame(code, [], { seed: randomInt(0x100000000) })`(`node:crypto`)。引擎默认种子**仅保留给回归测试复现**,不再落到正式对局。
- 可重放性不破坏:`createGame` 仍接受 `opts.seed`,测试照常注入固定种子(如 `setup.ts` seed=12345)。

## 怎么验收
- 网关自测 `tools/selftest.mjs`:连开 6 间房,首掷点数出现多种不同值(实测 6 种,旧实现恒为同一序列)。
- `npm test` 全绿(含原「同 seed 可复现」用例)。

## 关联
`src/gateway/server.ts`、`src/engine/rng.ts`、`src/engine/engine.ts`(createGame)。
