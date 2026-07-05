import type { Message } from '../../../../sdk';
import { STATUS_DELETED } from '../../../../constants';
import type { AppInstance } from '../../app-instance';
import { BoundedPageWindow, type PageLoadResult } from '../../bounded-page-window';

/** 消息分页结果的边界信息（与 SDK getMessages 返回的 page 同构的子集）。 */
export interface MessagePageInfo {
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
}

export interface MessagePageResultLike {
  readonly messages: ReadonlyArray<Message>;
  readonly page: MessagePageInfo;
}

function messageKey(message: Message): string {
  return message.messageId || String(message.seq);
}

/** 每页入窗前的归一化：同 messageId 保留最新状态、删除态剔除、按 seq 升序。 */
function sortUniqueBySeq(messages: ReadonlyArray<Message>): Message[] {
  const byKey = new Map<string, Message>();
  for (const message of messages) {
    const key = messageKey(message);
    if (Number(message.status || 0) === STATUS_DELETED) {
      byKey.delete(key);
      continue;
    }
    byKey.set(key, message);
  }
  return [...byKey.values()].sort((left, right) => left.seq - right.seq);
}

/** 创建消息数据窗口：归一化用 sortUniqueBySeq，按 messageKey 跨页去重，最多保留 messagePageMaxPages 页。 */
export function createMessageWindow(maxPages: number): BoundedPageWindow<Message> {
  // 消息 seq 不可变、各页 keyset 区间天然不相交，跨页去重在这里是防御性兜底（正常永不触发）。
  return new BoundedPageWindow<Message>(maxPages, sortUniqueBySeq, messageKey);
}

function toPageLoad(result: MessagePageResultLike): PageLoadResult<Message> {
  return {
    items: result.messages,
    startCursor: result.page.startCursor,
    endCursor: result.page.endCursor,
    hasMoreBackward: result.page.hasMoreBackward,
    hasMoreForward: result.page.hasMoreForward,
  };
}

function pruneSelection(app: AppInstance): void {
  if (app.chatState.selectedMessageIds.size === 0) return;
  const visibleIds = new Set(app.chatState.currentMessages.map(message => message.messageId));
  for (const id of [...app.chatState.selectedMessageIds]) {
    if (!visibleIds.has(id)) app.chatState.selectedMessageIds.delete(id);
  }
}

// 窗口是唯一事实源；currentMessages / messagePageHasOlder / messagePageHasNewer 是
// 给渲染、锚点、选择栏读取的同步投影，每次窗口变更后刷新。
function syncFromWindow(app: AppInstance): void {
  const window = app.chatState.messageWindow;
  app.chatState.currentMessages = window.items;
  app.chatState.messagePageHasOlder = window.hasMoreBefore;
  app.chatState.messagePageHasNewer = window.hasMoreAfter;
  pruneSelection(app);
}

/** 续翻向前（更旧）使用的不透明游标：窗口首页的 start_cursor。 */
export function messageBackwardCursor(app: AppInstance): string {
  return app.chatState.messageWindow.backwardCursor;
}

/** 续翻向后（更新）使用的不透明游标：窗口尾页的 end_cursor。 */
export function messageForwardCursor(app: AppInstance): string {
  return app.chatState.messageWindow.forwardCursor;
}

export function resetMessagePage(app: AppInstance): number {
  app.chatState.messageWindow.reset();
  app.chatState.currentMessages = [];
  app.chatState.loadingMoreMessages = false;
  app.chatState.loadingNewerMessages = false;
  app.chatState.messagePageHasOlder = false;
  app.chatState.messagePageHasNewer = false;
  app.chatState.pendingNewMessageCount = 0;
  app.chatState.selectedMessageIds.clear();
  app.chatState.expandedQuoteMessageIds.clear();
  return ++app.chatState.messagePageRequestId;
}

export function setInitialMessagePage(app: AppInstance, result: MessagePageResultLike): void {
  app.chatState.messageWindow.setInitial(toPageLoad(result));
  syncFromWindow(app);
}

export function prependOlderMessagesToPage(app: AppInstance, result: MessagePageResultLike): void {
  app.chatState.messageWindow.prependBackward(toPageLoad(result));
  syncFromWindow(app);
}

export function appendNewerMessagesToPage(app: AppInstance, result: MessagePageResultLike): void {
  app.chatState.messageWindow.appendForward(toPageLoad(result));
  syncFromWindow(app);
}

// 删除消息：就地从数据窗口删除该消息，剩余消息自然往上补齐（防抖动），不重拉。返回是否命中。
export function removeMessageFromPage(app: AppInstance, messageId: string): boolean {
  const hit = app.chatState.messageWindow.removeMatching(
    (message) => (message.messageId || String(message.seq)) === messageId,
  );
  if (hit) syncFromWindow(app);
  return hit;
}

export function appendLiveMessageToPage(app: AppInstance, message: Message): void {
  app.chatState.messageWindow.appendLive(message);
  app.chatState.messageWindow.hasMoreAfter = false;
  syncFromWindow(app);
}

// 收到重绘信号但用户未贴底时：标记会话尾部之后还有更新（窗口尾部之外有未加载内容），
// 让触底加载能追平、新消息提示条亮起。
export function markMessagesHasNewer(app: AppInstance): void {
  app.chatState.messageWindow.hasMoreAfter = true;
  syncFromWindow(app);
}
