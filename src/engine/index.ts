/** 端无关规则引擎对外出口。客户端/网关只依赖这里。 */
export * from "./types.js";
export { defaultConfig } from "./config.js";
export { createGame, reduce } from "./engine.js";
export { netWorth, activePlayers } from "./helpers.js";
export { rollDice } from "./rng.js";
