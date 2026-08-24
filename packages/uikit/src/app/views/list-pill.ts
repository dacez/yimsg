// 有界列表的「有更新 / 重试」提示条：宿主侧的一小段 DOM，不是 BoundedList 的一部分。
//
// 组件只负责报状态（`BoundedListState` 的 `stale` 与 `failed`）和提供追平入口
// （`catchUp()`）。要不要提示、长什么样、挂在哪，是宿主的决定：十二个生产列表里只有五个
// 需要提示条，弹窗内的候选列表压根没有背景刷新可提示。把这段 DOM 留在组件里，就会出现
// 「配了文案但宿主关掉了提示条，于是文案永远不显示」这种没人察觉的死配置。
//
// 一个节点承担两种语义，靠 failed 区分：
// - 首屏失败：显示 retry 文案，点击重拉首页；
// - 有未追平的更新：显示 updated 文案，点击贴回新鲜端并追平。
// 两种情况下点击都是 `catchUp()`，宿主不必分辨当前是哪一种。

import type { BoundedListState } from '../bounded-list';

export interface ListPillText {
  /** 「有更新」文案；不提供则该列表只在首屏失败时显示提示条。 */
  readonly updated?: () => string;
  /** 首屏失败时的重试文案；不提供则失败后不显示重试入口。 */
  readonly retry?: () => string;
}

export interface ListPillHandle {
  /** 按最新状态更新可见性与文案；宿主在 `onLoadStateChange` 里调用。 */
  sync(state: BoundedListState): void;
  /** 移除 DOM 节点并注销点击监听。 */
  dispose(): void;
}

/**
 * 在 host 下创建一个提示条并接上点击回调（通常是 `() => list.catchUp()`）。
 *
 * 文案取值为 undefined 时不显示：没有文案就不该出现一个空白的可点节点。
 *
 * `host` 为空（宿主没有可挂载的容器）时返回空操作句柄，不创建任何 DOM。「这个列表没有
 * 提示条」是一种正常状态而不是错误——十二个生产列表里有七个就是如此。
 */
export function createListPill(
  host: HTMLElement | null | undefined,
  onClick: () => void,
  text: ListPillText,
): ListPillHandle {
  if (!host) return { sync: () => {}, dispose: () => {} };
  const pill = host.ownerDocument.createElement('div');
  pill.className = 'list-updated-pill hidden';
  const handleClick = () => onClick();
  pill.addEventListener('click', handleClick);
  host.appendChild(pill);

  return {
    sync(state: BoundedListState) {
      const label = state.failed ? text.retry?.() : (state.stale ? text.updated?.() : undefined);
      if (label !== undefined) pill.textContent = label;
      pill.classList.toggle('hidden', label === undefined);
    },
    dispose() {
      pill.removeEventListener('click', handleClick);
      pill.remove();
    },
  };
}
