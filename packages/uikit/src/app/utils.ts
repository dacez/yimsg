import type { AppInstance } from './app-instance';
import type { ResolvedLayout } from './session-storage';

export function isMobileInteractionLayout(app: AppInstance, resolvedLayout?: ResolvedLayout): boolean {
  if (resolvedLayout === 'mobile') return true;
  const view = app.dom.ownerDocument.defaultView;
  const shell = app.dom.root.querySelector<HTMLElement>('.mc-app-shell');
  return app.dom.layoutHost.dataset.layout === 'mobile' ||
    app.dom.ownerDocument.body.dataset.layout === 'mobile' ||
    shell?.dataset.layout === 'mobile' ||
    view?.matchMedia('(hover: none), (pointer: coarse)').matches === true ||
    (view?.innerWidth ?? Number.POSITIVE_INFINITY) <= 640;
}

/** 搜索框防抖的默认毫秒数：输入停顿多久之后才真正发请求。 */
export const SEARCH_DEBOUNCE_MS = 300;

export interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  /** 立刻执行一次并取消待触发的那次（回车、清空关键字这类「不该等」的输入用）。 */
  flush(...args: A): void;
  /** 取消待触发的那次；宿主销毁时调用。 */
  cancel(): void;
}

/**
 * 输入防抖：连续调用只有最后一次在停顿 ms 之后生效。
 *
 * 放在宿主侧而不是 BoundedList 里：防抖是「这个搜索框希望多久之后才查」的交互决定，
 * 与「列表怎么分页」无关。同一个列表在不同宿主里完全可以要不同的节奏，甚至不要防抖。
 */
export function debounce<A extends readonly unknown[]>(fn: (...args: A) => void, ms = SEARCH_DEBOUNCE_MS): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const debounced = ((...args: A): void => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as Debounced<A>;
  debounced.flush = (...args: A): void => {
    cancel();
    fn(...args);
  };
  debounced.cancel = cancel;
  return debounced;
}
