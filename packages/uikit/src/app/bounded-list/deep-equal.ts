// 结构相等比较：只看结构不看引用。
//
// 组件里有两处需要它，此前各写了一份、语义还不一样：渲染引擎判断「这一行的数据变了
// 没有，能不能复用已有 DOM」，组件外壳判断「当前查询条件是不是仍等于初始查询条件」
// （据此决定空态显示「暂无数据」还是「无搜索结果」）。后者曾经用 JSON.stringify，
// 对 `{a:1,b:2}` 与 `{b:2,a:1}` 会给出不同结果，键序不同就误判成「已过滤」。
//
// 合并后取语义更完整的一份：环引用用 WeakMap 记账，Date / TypedArray 按值比较，
// 原型不同直接判不等（不把 class 实例当成普通对象逐键比）。

/**
 * 深度上限。超过即判不等，两个用途都只往安全方向退化：查询条件退化成「视为已过滤」
 * （空态显示「无搜索结果」而不是「暂无数据」），行数据退化成「重跑一次 renderItem」。
 * 列表条目和查询条件的实际嵌套都远浅于此。
 */
const MAX_DEPTH = 8;

/**
 * 深度结构比较。命中以下任一情况即视为不相等（宁可判不等，代价只是多渲染一次）：
 * 原型不同、深度超过 MAX_DEPTH、非普通对象且不是已知的可比类型。
 */
export function valuesEquivalent(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
  depth = 0,
): boolean {
  if (Object.is(left, right)) return true;
  if (depth > MAX_DEPTH) return false;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;

  // 环引用：同一个左值只允许对应同一个右值，否则两棵图结构不同。
  const remembered = seen.get(left);
  if (remembered) return remembered === right;
  seen.set(left, right);

  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    if (left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return leftBytes.every((value, index) => value === rightBytes[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => valuesEquivalent(value, right[index], seen, depth + 1));
  }

  const prototype = Object.getPrototypeOf(left);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key)
      && valuesEquivalent(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        seen,
        depth + 1,
      ));
}
