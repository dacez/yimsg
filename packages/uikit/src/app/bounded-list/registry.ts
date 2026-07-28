// BoundedList 注册表：组件构造时自动注册、dispose 时自动注销。
//
// 用途单一：重连成功等「广播一次 invalidate」的场景，调用方不需要感知具体
// 有哪些列表实例，只管调 invalidateAllBoundedLists()。
//
// 注意多实例隔离：本模块是**进程级**注册表，同一页面里并存多个 AppInstance
// （嵌入式 UIKit 的多格子场景）时，各实例应当通过 BoundedListOptions.register
// 把列表登记到自己的注册表，而不是共用这一份，否则同名列表会互相覆盖。

export interface Invalidatable {
  readonly id: string;
  invalidate(): void | Promise<void>;
}

/**
 * 宿主侧的有界列表刷新契约（历史名字，等价于 Invalidatable）：
 * 会话列表、当前会话消息、好友/请求列表等所有「有界列表」通过 invalidate()
 * 注册自己的追平动作。invalidate 语义等价于「收到一条属于本列表的新数据通知」——
 * 具体是立即重拉追平还是推迟（点亮「有更新」提示），由各列表自己按贴顶/可见性
 * 规则决定。调用方（例如重连成功）只管广播 invalidate。
 */
export type BoundedListController = Invalidatable;

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
  for (const instance of [...registry.values()]) {
    // 同步调用（宿主依赖「广播即触发」的时序），但同步抛错与异步拒绝都在这里兜住，
    // 绝不产生未处理的 Promise 拒绝，也不让一个实例的失败中断整轮广播。
    try {
      const result = instance.invalidate();
      if (result) void result.catch((error) => console.warn(`[BoundedList:${instance.id}] invalidate 失败`, error));
    } catch (error) {
      console.warn(`[BoundedList:${instance.id}] invalidate 失败`, error);
    }
  }
}

export function registeredBoundedListIds(): string[] {
  return [...registry.keys()];
}
