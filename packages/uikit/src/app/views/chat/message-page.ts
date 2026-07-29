import type { Message } from '@yimsg/sdk';
import { STATUS_DELETED } from '@yimsg/sdk/uikit-internal';
import type { AppInstance } from '../../app-instance';

/** 消息身份键：BoundedList 的 identityOf，同时用于跨页去重与渲染锚点。 */
export function messageKey(message: Message): string {
  return message.messageId || String(message.seq);
}

/** 每页 / 每次本地并入前的归一化：同 messageId 保留最新状态、删除态剔除、按 seq 升序。 */
export function sortUniqueBySeq(messages: readonly Message[]): Message[] {
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

// 窗口是唯一事实源；currentMessages 是给渲染之外的读取方（选择栏等）看的同步投影，
// 每次窗口变更（BoundedList 的 onItemsChanged）后刷新，并顺带修剪已滚出窗口的选中 id。
export function syncCurrentMessages(app: AppInstance, items: readonly Message[]): void {
  app.chatState.currentMessages = [...items];
  if (app.chatState.selectedMessageIds.size === 0) return;
  const visibleIds = new Set(items.map((message) => message.messageId));
  for (const id of [...app.chatState.selectedMessageIds]) {
    if (!visibleIds.has(id)) app.chatState.selectedMessageIds.delete(id);
  }
}

/**
 * 切换会话 / 锚点跳转前的同步状态清理：选中态、待发送占位状态、高亮消息与世代计数器。
 * 实际的窗口重置与首页拉取交给调用方随后调用 `getMessageList(app).reset(...)`——
 * BoundedList 自身的 requestId 机制已经保证旧请求不会覆盖新窗口，这里的世代计数器
 * 只用于调用方（message-search.ts 的锚点跳转）在 await 之后判断自己是否仍是最新一次意图。
 */
export function resetMessagePage(app: AppInstance): number {
  app.chatState.highlightMessageId = null;
  app.chatState.selectedMessageIds.clear();
  app.chatState.pendingMessageIds.clear();
  return ++app.chatState.messageGeneration;
}

/** 本端产生的新条目（本地发送 / 转发成功回包）：先跨页去重，再并入新鲜端。 */
export function appendLiveMessageToPage(app: AppInstance, message: Message): void {
  app.chatState.messageList?.upsertLocal(message);
}

/** 就地删除窗口内该消息（messages:deleted）。返回是否命中。 */
export function removeMessageFromPage(app: AppInstance, messageId: string): boolean {
  return app.chatState.messageList?.removeLocal(messageId) ?? false;
}
