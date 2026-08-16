// 结构相等比较：只看结构不看引用。
//
// 唯一用途是渲染引擎判断「这一行的数据变了没有，能不能复用已有 DOM」。列表条目全是
// SDK 下发的 JSON 形状 DTO（见 packages/sdk/src/models.ts）：只有原始值、数组和普通
// 对象，没有 Date、没有 TypedArray、没有环引用，所以这里也只处理这三类。
//
// **不能退化成 JSON.stringify**：它对 `{a:1,b:2}` 与 `{b:2,a:1}` 给出不同结果，
// 键序不同就会把没变化的行判成已变化（`BL-UNIT-BUG-012`）。

/**
 * 深度上限。超过即判不等，退化方向是安全的：多跑一次 renderItem 而已。
 * 列表条目的实际嵌套远浅于此，同时这条上限也保证了递归一定终止——即使真的传进来一个
 * 环引用，最深 MAX_DEPTH 层之后就返回 false，不需要额外的环引用记账。
 */
const MAX_DEPTH = 8;

/**
 * 深度结构比较。命中以下任一情况即视为不相等：
 * 深度超过 MAX_DEPTH、原型不同、不是数组也不是普通对象。
 */
export function valuesEquivalent(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > MAX_DEPTH) return false;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;

  const prototype = Object.getPrototypeOf(left);
  if (prototype !== Object.getPrototypeOf(right)) return false;

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => valuesEquivalent(value, right[index], depth + 1));
  }
  // 普通对象之外（class 实例等）一律判不等，不逐键拆解。
  if (prototype !== Object.prototype && prototype !== null) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key)
      && valuesEquivalent((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1));
}
