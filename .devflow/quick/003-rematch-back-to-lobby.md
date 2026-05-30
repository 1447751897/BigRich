---
track: lite
type: fix
status: done
owner: 开发工程师
updated: 2026-05-30
---
# 再来一局未回房间(停留结算页)

## 背景(一句话)
结算后点「再来一局」应回到房间等房主重开,现状是 `location.reload()` 重连后仍是 ended 状态、停在结算页。

## 改动
- 引擎新增 `RestartGame` 命令:把 `ended` 重置回 `lobby`,**保留座位/座次/配置**,游戏内数值(现金/位置/地产/名次/计时器)复位;**续用 `rngState`**(不复位),保证下一局骰子序列不同,又不在纯函数引擎里引入随机源。发 `GameReset` 事件。非 ended 调用返回 `game-not-ended`。
- 网关新增 `restart` WS 消息(仅房主):提交 `RestartGame`,重置后重新落快照、可再加入新玩家、房主可直接重开。
- 前端结算页「再来一局」改为:房主点击发 `restart`(不再 reload),非房主显示"等待房主开始下一局";回到 lobby 时隐藏结算层。

## 怎么验收
- 引擎回归 `test/restart.test.ts`(3 例):重置回 lobby、座位保留+数值复位、续用 RNG 流(重开首掷 ≠ 同种子新局首掷)、非 ended 拒绝。
- 网关自测:打满一局到 GameEnded → 房主 restart → 回 lobby(座位保留、数值复位)→ 可直接重新开始。

## 关联
`src/engine/types.ts`、`src/engine/engine.ts`、`src/gateway/server.ts`、`public/app.js`。
