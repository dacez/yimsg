/**
 * Type-safe EventEmitter — no DOM dependency, works in Node.js.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

/** 开发模式下每个事件的 listener 数量超过此值时在控制台输出告警（每个事件只告警一次）。 */
const DEV_LISTENER_WARN_THRESHOLD = 10;

export class EventEmitter<Events extends { [K in keyof Events]: Listener } = Record<string, Listener>> {
  private listeners = new Map<keyof Events, Set<Listener>>();
  private readonly warnedEvents = new Set<keyof Events>();

  on<K extends keyof Events>(event: K, fn: Events[K]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener);
    if (set.size > DEV_LISTENER_WARN_THRESHOLD && !this.warnedEvents.has(event)) {
      this.warnedEvents.add(event);
      console.warn(
        `[EventEmitter] 事件 "${String(event)}" 已注册 ${set.size} 个 listener，` +
        `超过告警阈值 ${DEV_LISTENER_WARN_THRESHOLD}，请检查是否存在监听器泄漏。`,
      );
    }
    return this;
  }

  off<K extends keyof Events>(event: K, fn: Events[K]): this {
    this.listeners.get(event)?.delete(fn as Listener);
    return this;
  }

  once<K extends keyof Events>(event: K, fn: Events[K]): this {
    const wrapper = ((...args: unknown[]) => {
      this.off(event, wrapper as Events[K]);
      (fn as Listener)(...args);
    }) as Events[K];
    return this.on(event, wrapper);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      fn(...args);
    }
  }

  /** 返回指定事件当前注册的 listener 数量，可用于测试和泄漏排查。 */
  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: keyof Events): this {
    if (event) {
      this.listeners.delete(event);
      this.warnedEvents.delete(event);
    } else {
      this.listeners.clear();
      this.warnedEvents.clear();
    }
    return this;
  }
}
