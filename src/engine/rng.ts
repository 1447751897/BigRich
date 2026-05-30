/**
 * 服务端权威 RNG(硬约束:掷骰绝不在客户端生成)。
 *
 * 用确定性 PRNG(mulberry32),种子作为状态的一部分存在 GameState.rngState 里。
 * 这样掷骰既是服务端裁决,又可复现(便于回归测试与崩溃恢复后一致)。
 */

/** 推进 PRNG,返回 [0,1) 浮点与新状态。 */
export function nextFloat(state: number): { value: number; state: number } {
  // mulberry32
  let t = (state + 0x6d2b79f5) | 0;
  let next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}

/** 掷一颗 1..6 的骰子。 */
export function rollDie(state: number): { die: number; state: number } {
  const { value, state: next } = nextFloat(state);
  return { die: 1 + Math.floor(value * 6), state: next };
}

/** 掷两颗骰子。 */
export function rollDice(state: number): { dice: [number, number]; state: number } {
  const a = rollDie(state);
  const b = rollDie(a.state);
  return { dice: [a.die, b.die], state: b.state };
}
