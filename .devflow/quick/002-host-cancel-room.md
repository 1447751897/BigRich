---
track: lite
type: fix
status: done
owner: 开发工程师
updated: 2026-05-30
---
# 房主无法取消/解散房间

## 背景(一句话)
房主创建房间后没有取消入口,只能干等——reporter 反馈"创建房间之后无法取消房间"。

## 改动
- 网关新增 `cancelRoom` WS 消息(仅房主可发):广播 `room-closed`、从内存与快照移除房间(`closeRoom`)。
- 前端大厅:房主显示「解散房间」按钮(二次确认),非房主显示「离开房间」按钮;收到 `room-closed` 退回进房页并清 `localStorage`(`resetToEntry`)。
- 解散后该房间码不可再加入(`unknown-room`)。

## 怎么验收
- 网关自测:房主 `cancelRoom` 后,房主与房内玩家均收到 `room-closed`(reason=host-cancelled);随后再 join 返回 `unknown-room`。

## 关联
`src/gateway/server.ts`、`public/index.html`、`public/app.js`。仅最小流程改动,页面美化归迭代 001。
