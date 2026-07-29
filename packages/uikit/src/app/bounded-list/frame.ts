// 帧调度：把「本帧内合并多次请求，且能被 dispose 安全取消」这件事收敛成一处。
//
// 这里曾经有三份几乎一样的实现（渲染引擎一份、组件外壳两份），token / cancel 语义
// 各写一遍，差异只有「环境没有 requestAnimationFrame 时怎么兜底」一个选择。

/** 可重复调用、同帧内只跑一次、可取消的调度器。 */
export type FrameScheduler = (() => void) & { cancel: () => void };

/** 没有 requestAnimationFrame 时的兜底方式。 */
export type FrameFallback =
  /** 同步执行。渲染路径用它：测试与非浏览器环境下行为可预期。 */
  | 'sync'
  /**
   * 放进微任务。需要「一定要晚于当前同步代码」的场景用它——例如容量追平，
   * 调用它的那段代码往往还要继续修改窗口状态，同步跑会读到中间态。
   */
  | 'microtask';

/**
 * 创建一个同帧内合并的调度器。
 *
 * 取消用递增 token 而不是 cancelAnimationFrame：即使已经排队的 rAF 回调后续真的
 * 触发，run() 发现 token 不匹配也会安全跳过，不依赖环境是否真正支持取消
 * （fake DOM 测试环境里 rAF 只是把回调塞进数组，并不响应 cancelAnimationFrame）。
 */
export function frameScheduler(callback: () => void, fallback: FrameFallback = 'sync'): FrameScheduler {
  let scheduled = false;
  let token = 0;

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    const myToken = ++token;
    const run = (): void => {
      if (myToken !== token) return;
      scheduled = false;
      callback();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => run());
    } else if (fallback === 'microtask') {
      globalThis.queueMicrotask(run);
    } else {
      run();
    }
  };

  schedule.cancel = (): void => {
    scheduled = false;
    token += 1;
  };
  return schedule;
}

/** 一次性排帧；没有 requestAnimationFrame 时同步执行。调用方自己带 disposed 守卫。 */
export function nextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => callback());
    return;
  }
  callback();
}
