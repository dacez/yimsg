/**
 * uint64 键的底层工具。
 *
 * Yimsg 的路由键（uid / group_id / request_id）在协议层都是 uint64，可能超过
 * JS 的安全整数范围（2^53-1）。为了在 TypeScript 中无损表达 uint64，并保持与
 * 后续 Rust / Go / C 版本一致的内存布局，统一用 (hi, lo) 两个 uint32 表示一个 key：
 *
 *   value = (BigInt(hi) << 32) | BigInt(lo)
 *
 * 禁止使用 `"u:123"` 字符串 key 或无界 object map —— 这是有界集合基础设施的硬约束。
 */

const TWO_POW_32 = 0x1_0000_0000n;
const TWO_POW_32_NUMBER = 0x1_0000_0000;
const U32_BIGINT_MASK = 0xffffffffn;

/** uint64 键的拆分表示：高 32 位与低 32 位均为无符号整数。 */
export interface U64Key {
  readonly hi: number;
  readonly lo: number;
}

/**
 * 将十进制 uint64 字符串解析为 (hi, lo)。
 *
 * 仅接受非负十进制整数字符串（如 "0"、"123"、"18446744073709551615"）；
 * 其它输入（含负号、小数点、空串、非数字）抛 RangeError，避免静默写入错误 key。
 */
export function parseU64(value: string): U64Key {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`无效的 uint64 字符串: ${JSON.stringify(value)}`);
  }
  const big = BigInt(value);
  if (big < 0n || big >= TWO_POW_32 * TWO_POW_32) {
    throw new RangeError(`uint64 越界: ${value}`);
  }
  return {
    hi: Number(big >> 32n),
    lo: Number(big & U32_BIGINT_MASK),
  };
}

/** 将 JS number（必须是 [0, 2^64) 的整数）拆分为 (hi, lo)。 */
export function u64FromNumber(value: number): U64Key {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`无效的 uint64 数值: ${value}`);
  }
  // number 超过 2^53 会丢精度，超过安全范围时退回 BigInt 路径由调用方用字符串。
  return {
    hi: Math.floor(value / TWO_POW_32_NUMBER) >>> 0,
    lo: value % TWO_POW_32_NUMBER >>> 0,
  };
}

/** 将 (hi, lo) 还原为十进制 uint64 字符串。 */
export function u64ToString(hi: number, lo: number): string {
  const big = ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)) & (TWO_POW_32 * TWO_POW_32 - 1n);
  return big.toString();
}

/**
 * uint64 -> 32 位桶哈希。
 *
 * 采用 MurmurHash3 的 fmix32 终结器思路混合 hi 与 lo，保证顺序整数 key（如自增
 * request_id）也能均匀散布到各 bucket。跨语言实现只要复刻同一套 32 位运算即可
 * 得到一致结果。
 */
export function hashU64(hi: number, lo: number): number {
  let h = (lo ^ Math.imul(hi >>> 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/** 判断两个 (hi, lo) 是否相等（按 uint32 语义比较）。 */
export function u64Equal(aHi: number, aLo: number, bHi: number, bLo: number): boolean {
  return (aHi >>> 0) === (bHi >>> 0) && (aLo >>> 0) === (bLo >>> 0);
}

/** 返回 >= n 的最小 2 的幂（n<=1 时返回 1）。用于把期望容量对齐到 2 的幂 bucketCount。 */
export function nextPow2(n: number): number {
  if (!Number.isFinite(n) || n <= 1) return 1;
  let p = 1;
  while (p < n && p < 0x4000_0000) p <<= 1;
  return p;
}
