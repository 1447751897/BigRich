# 开发流程总览(devflow)

> devflow_template_version: 1.2
> 接手本项目?先读这里(或运行 `brief`)。文档是事实来源;如与代码不符,以最新讨论为准并立刻更新本文件。
> 最近一次 check:2026-05-30,未决 0 条(首版 baseline 五阶段均已 done)。
> 模板迁移:2026-05-30 由 1.1 升级到 **1.2**(`02-design` 补「界面设计」、`05-acceptance` 补「界面/体验验收」;baseline 与迭代 001 均已补,仅加结构、未改既有内容)。

## 项目 baseline 进度

| 阶段     | 文件                       | 状态        | 负责人           | 更新日期   |
|---------|----------------------------|-------------|-----------------|-----------|
| 产品需求 | project/01-requirements.md | done        | 产品经理         | 2026-05-30 |
| 方案设计 | project/02-design.md       | done        | 架构师           | 2026-05-30 |
| 技术选型 | project/03-tech-stack.md   | done        | 架构师/开发工程师 | 2026-05-30 |
| MVP     | project/04-mvp.md          | done        | 开发工程师       | 2026-05-30 |
| 验收测试 | project/05-acceptance.md   | done        | 测试工程师       | 2026-05-30 |

> 说明:首版 baseline 五阶段(`01`~`05`)均已 `done` 并定稿——`05-acceptance` 已由测试工程师补全 P0 用例 + §5 结论=**通过**并签字(PR #9 合并入 main),首版正式定稿。后续大功能见下方迭代列表。

## 迭代列表

| 编号 | 名称 | 目录 | 当前阶段 | 状态 |
|------|------|------|----------|------|
| 001  | 页面美化/体验升级 → 视觉重构(正统大富翁质感/克制配色) | iterations/001-page-beautify/ | 已收尾(PR #16 合入 main)、长期结论已回流 baseline | archived |

## 轻量改动(quick)

| 编号 | 名称 | 类型 | 文件 | 状态 |
|------|------|------|------|------|
| 001  | 骰子点数不随机(生产固定种子) | fix | quick/001-dice-true-random.md | done |
| 002  | 房主无法取消/解散房间 | fix | quick/002-host-cancel-room.md | done |
| 003  | 再来一局未回房间(停留结算页) | fix | quick/003-rematch-back-to-lobby.md | done |

## 防腐约定(重要)

- 改代码若影响某阶段结论,必须同步更新对应文档,否则文档失效、团队会退回读代码。
- 每份文档以 frontmatter 的 status/updated 为准;评审通过才置 done。
- 大功能做完跑 `archive` 回流 baseline;定期跑 `check` 抓陈旧。
- 缺陷/小优化走 `quick`,别硬塞进迭代全流程。
