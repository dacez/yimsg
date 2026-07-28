// 提示条辅助（设计方案 §8.1 #9）：三处「有更新」提示条（会话列表、通讯录、消息列表新消息）
// 共用的 ensure / sync 逻辑收敛到这一个函数，取代三份几乎相同的手写代码。

export interface UpdatePillHandle {
  /** 更新可见性与文案；不提供 text 时保留上次文案。 */
  setVisible(visible: boolean, text?: string): void;
  /** 移除 DOM 节点并注销点击监听。 */
  dispose(): void;
}

/**
 * 在 host 下创建（或按约定挂载）一个提示条元素，点击时触发 onClick。
 * host 传 false 时（弹窗内候选列表没有背景刷新）不创建任何 DOM，返回的 handle 是空操作。
 */
export function createUpdatePill(host: HTMLElement | false, onClick: () => void): UpdatePillHandle {
  if (host === false) {
    return {
      setVisible: () => {},
      dispose: () => {},
    };
  }
  const doc = host.ownerDocument;
  const pill = doc.createElement('div');
  pill.className = 'list-updated-pill new-message-pill hidden';
  const handleClick = () => onClick();
  pill.addEventListener('click', handleClick);
  host.appendChild(pill);

  return {
    setVisible(visible: boolean, text?: string) {
      if (text !== undefined) pill.textContent = text;
      pill.classList.toggle('hidden', !visible);
    },
    dispose() {
      pill.removeEventListener('click', handleClick);
      pill.remove();
    },
  };
}
