---
stage: tech-stack
status: in_review
owner: 架构师
updated: 2026-05-30
---
# 技术选型 — 迭代:页面美化(增量)

> 仅记录相对 baseline 的**增量选型**。结论:**本迭代不引入任何新运行时依赖**,沿用原生 CSS + Web Audio + 少量原生 JS。

## 4. 迭代增量

### D-101 动画/音频:原生实现,不引入新依赖
- 状态:accepted(架构师;开发工程师实现时如遇硬阻塞可在此 superseded 记录)
- 日期:2026-05-30
- 背景:PM §5④ 问是否引入轻量动画/音频库(如 howler.js)。现状 `public/` 是**无构建链的 vanilla JS**(index.html/app.js/style.css 直出),引第三方库需引入打包或 CDN,增加体积与维护面。
- 选项与结论:
  - **动画 → 原生 CSS `transform`/`transition`/`@keyframes` + 少量 JS 编排队列**(掷骰骰子用 CSS 3D);淘汰 GSAP/anime.js(需求规模用不上)。
  - **音频 → 原生 Web Audio API**(共享 `AudioContext` + `AudioBuffer` 预解码缓存,手势内 `resume()` 解锁);淘汰 **howler.js**(其主要价值是跨端兼容封装,但本迭代仅 Web/H5、需求简单,原生 + 一个薄封装函数即可,省一个依赖)。
- 影响:`public/` 保持零依赖、无构建步骤;实现集中在 `public/`(可按需拆分 `audio.js`/`anim.js`/主题 CSS 变量),不碰 `src/`,不影响 38 测试。

### 选型总表(增量)
| 领域 | 选用 | 候选 | 理由 |
|------|------|------|------|
| 动画 | 原生 CSS + JS 编排 | GSAP / anime.js / 全 canvas | 规模小、零依赖、无构建链、改动面小 |
| 音频 | 原生 Web Audio API | howler.js | 仅 Web/H5、需求简单,原生足够,省依赖 |
| 素材 | CC0/自制(放 `public/audio`、主题 CSS/SVG) | 商业素材库 | 去 IP + 免版权 + 体积可控 |
| 构建/打包 | 维持无构建(直出静态) | 引入 Vite/打包 | 当前规模不需要,保持简单 |

> 若 04-mvp 实现中发现原生方案在某点成本过高(如复杂逐格缓动编排),再按 devflow 动作 G 在此新增 ADR superseded D-101,不静默改。

## 5. 变更记录
| 日期 | 旧 → 新 | 原因 | 关联决策 |
|------|---------|------|----------|
| 2026-05-30 | (空) → D-101 原生实现、不引入新依赖 | 架构师 02-design 推导:`public/` 无构建链,规模小,原生 CSS+Web Audio 足够 | D-101 |
