// BoundedList 注册表：组件构造时自动注册、dispose 时自动注销，取代旧版
// bounded-list.ts 里手写的三段 registerBoundedList（设计方案 §4.7、§8.2 阶段5）。
//
// 用途单一：重连成功等「广播一次 invalidate」的场景，调用方不需要感知具体
// 有哪些列表实例，只管调 invalidateAllBoundedLists()。

export interface Invalidatable {
  readonly id: string;
  invalidate(): void | Promise<void>;
}

const registry = new Map<string, Invalidatable>();

/** 同 id 重复注册会覆盖旧实例（旧实例应当已经 dispose）。 */
export function registerBoundedList(instance: Invalidatable): void {
  registry.set(instance.id, instance);
}

export function unregisterBoundedList(instance: Invalidatable): void {
  if (registry.get(instance.id) === instance) registry.delete(instance.id);
}

/** 广播给全部已注册列表各一次 invalidate()，等价于重连后「有新数据」通知。 */
export function invalidateAllBoundedLists(): void {
  for (const instance of registry.values()) void instance.invalidate();
}

export function registeredBoundedListIds(): string[] {
  return [...registry.keys()];
}
