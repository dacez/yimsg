import type { ConversationDescriptor, ConversationTarget, LocalConversation } from '@yimsg/sdk';
import { displayGroupName, displayUserName, formatTime } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from "../../app-instance";
import { msgPreview } from "./helpers";
import { applyConversationGuards } from "./composer";
import { closeMessageActionMenu, exitMessageSelectionMode } from "./selection";
import { closeMessageSearchPanel } from "./message-search";
import { createBoundedList, serverPageSource, type BoundedList, type RenderItemContext } from "../../bounded-list";
import { conversationIdentity } from "../../list-identity";
import { resetMessagePage } from "./message-page";
import { getMessageList } from "./message-list";

// 设置聊天头部标题；群名 / 好友昵称取自 DisplayInfoCache 的同步快照，
// 首次打开陌生对端时可能还没缓存，靠 refreshChatHeader 在展示资料到达后补上。
function updateChatHeaderTitle(app: AppInstance, conversation: ConversationDescriptor, conv: LocalConversation): void {
  let title = "";
  if (conversation.kind === "group") {
    const groupId = conv.groupId || "0";
    title = displayGroupName(app.client.getGroupInfos([groupId]).get(groupId), app.t("chat.group"));
  } else {
    const friendUid = conv.friendUid || "0";
    title = displayUserName(app.client.getUserInfos([friendUid]).get(friendUid), friendUid);
  }

  app.$("chat-title").textContent = title;
}

// refreshChatHeader：display:updated 等异步展示资料到达后，重算当前打开会话的标题。
export function refreshChatHeader(app: AppInstance): void {
  const conv = app.chatState.currentConversation;
  if (!conv || !app.chatState.currentConvKey) return;
  updateChatHeaderTitle(app, app.client.describeConversation(conv), conv);
}

function keyToTarget(key: string): ConversationTarget {
  return key.startsWith("g:")
    ? { groupId: key.slice(2) }
    : { toUid: key.slice(2) };
}

// SDK 通知里的会话 key 是 describeConversation() 口径（"u:<uid>" / "g:<gid>"），
// BoundedList 的 identityOf 用的是路由身份口径（conversationIdentity，"friendUid:groupId"）。
// 两套口径彻底解耦（见设计方案 §4.2「身份键」），跨边界时必须显式转换，不能混用。
function sdkKeyToIdentity(key: string): string {
  return key.startsWith("g:") ? `0:${key.slice(2)}` : `${key.slice(2)}:0`;
}

function identityToTarget(identity: string): ConversationTarget {
  const separator = identity.indexOf(":");
  const uid = separator >= 0 ? identity.slice(0, separator) : identity;
  const groupId = separator >= 0 ? identity.slice(separator + 1) : "0";
  return groupId !== "0" ? { groupId } : { toUid: uid };
}

async function refreshUnreadBadge(app: AppInstance): Promise<void> {
  try {
    const unreadCount = await app.client.getUnreadCount();
    app.chatState.conversationTotalUnreadCount = unreadCount;
    app.setNavBadge('.nav-item[data-view="chat"]', unreadCount > 0);
  } catch (error) {
    console.warn("refreshUnreadBadge failed:", error);
  }
}

// 仅展示用的「空会话占位」（刚从通讯录点开、还没有任何消息的会话）：固定钉在窗口条目头部，
// 不进数据窗口，不参与分页与身份去重。真实存在消息的会话不会有 lastSeq===0，不会与窗口内条目冲突。
function pinnedConversations(app: AppInstance): readonly LocalConversation[] {
  const current = app.chatState.currentConversation;
  if (!current) return [];
  const isEmptyPlaceholder = current.lastSeq === 0 && (!current.groupId || current.groupId === "0");
  return isEmptyPlaceholder ? [current] : [];
}

function collectDisplayMaps(app: AppInstance, conversations: readonly LocalConversation[]) {
  const userIds: string[] = [];
  const groupIds: string[] = [];
  for (const conv of conversations) {
    const conversation = app.client.describeConversation(conv);
    if (conversation.kind === "group") {
      groupIds.push(conv.groupId || "0");
      const lastMessage = conv.lastMessage;
      if (lastMessage && lastMessage.senderId !== "0") userIds.push(lastMessage.senderId);
    } else {
      userIds.push(conv.friendUid || "0");
    }
  }
  return {
    userDisplayMap: app.client.getUserInfos(userIds),
    groupDisplayMap: app.client.getGroupInfos(groupIds),
  };
}

function renderConversationRow(
  app: AppInstance,
  conv: LocalConversation,
  ctx: RenderItemContext<LocalConversation>,
  displayMaps: { userDisplayMap: ReturnType<typeof app.client.getUserInfos>; groupDisplayMap: ReturnType<typeof app.client.getGroupInfos> },
): HTMLElement {
  const conversation = app.client.describeConversation(conv);
  const key = conversation.key;
  const isGroup = conversation.kind === "group";

  let name = "";
  let avatarText = "";
  let avatarUrl = "";
  if (isGroup) {
    const group = displayMaps.groupDisplayMap.get(conv.groupId || "0") || { name: "", avatarUrl: "", remarkName: "" };
    name = displayGroupName(group, app.t("chat.group"));
    avatarText = name[0];
    avatarUrl = group.avatarUrl || "";
  } else {
    const friendUid = conv.friendUid || "0";
    const user = displayMaps.userDisplayMap.get(friendUid) || { nickname: "", avatarUrl: "", remarkName: "", username: "" };
    name = displayUserName(user, friendUid);
    avatarText = name[0];
    avatarUrl = user.avatarUrl || "";
  }

  const lastMessage = conv.lastMessage;
  const preview = lastMessage
    ? msgPreview(app, lastMessage, isGroup, displayMaps.userDisplayMap)
    : "";
  const timeStr = lastMessage ? formatTime(lastMessage.sentAt) : "";
  const unread = conv.unreadCount || 0;

  const div = app.dom.ownerDocument.createElement("div");
  div.className =
    "conversation-item" +
    (app.chatState.currentConvKey === key ? " active" : "");
  div.dataset.key = key;
  const badge =
    unread > 0
      ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>`
      : "";
  div.innerHTML = `
      <div class="avatar-wrapper">
        <div class="avatar avatar-md">${app.avatarInnerHtml({ avatar: avatarUrl, nickname: avatarText })}</div>
        ${badge}
      </div>
      <div class="conversation-info">
        <div class="conversation-top">
          <div class="conversation-name-row">
            <span class="conversation-name">${app.escapeHtml(name)}</span>
          </div>
          <span class="conversation-time">${timeStr}</span>
        </div>
        <span class="conversation-preview">${app.escapeHtml(preview)}</span>
      </div>
    `;
  void ctx;
  return div;
}

function getConversationList(app: AppInstance): BoundedList<LocalConversation> {
  if (app.chatState.conversationList) return app.chatState.conversationList;

  let displayMaps: ReturnType<typeof collectDisplayMaps> | null = null;
  let windowItems: readonly LocalConversation[] = [];

  const list = createBoundedList<LocalConversation>({
    id: "conversations",
    scrollElement: app.$("conversation-list"),
    pageSize: APP_CONFIG.list.pageSize,
    maxPages: APP_CONFIG.list.maxPages,
    register: (controller) => app.registerBoundedList(controller),
    source: serverPageSource(
      ({ cursor, backward, limit }) => app.client.getConversations({ cursor, backward, limit }),
      (page) => ({
        items: page.conversations,
        startCursor: page.page.startCursor,
        endCursor: page.page.endCursor,
        hasMoreHead: page.page.hasMoreBackward,
        hasMoreTail: page.page.hasMoreForward,
      }),
    ),
    fetchByIdentity: (ids) =>
      app.client.getConversations({ targets: ids.map(identityToTarget) }).then((p) => p.conversations),
    identityOf: conversationIdentity,
    order: "desc",
    // 占位会话一旦真实存在（发出的消息落库后重拉首页能拉到同身份的真实条目），
    // 就不再钉在头部：组件按身份去重 pinnedItems 与窗口条目，窗口是权威，这里直接
    // 把占位会话全交出去即可。
    pinnedItems: () => pinnedConversations(app),
    renderItem: (conv, ctx) => {
      if (ctx.index === 0) {
        displayMaps = collectDisplayMaps(app, [...pinnedConversations(app), ...windowItems]);
      }
      return [renderConversationRow(app, conv, ctx, displayMaps!)];
    },
    text: {
      empty: () => app.t("chat.noConversations"),
      loading: () => app.t("common.loading"),
      tailBoundary: () => app.t("chat.noMoreConversations"),
      updatePill: () => app.t("chat.listUpdated"),
      retry: () => app.t("common.retry"),
    },
    onActivate: (conv) => { void openConversation(app, conv); },
    onItemsChanged: (items) => { windowItems = items; },
    onLoadStateChange: () => {
      app.setNavBadge('.nav-item[data-view="chat"]', app.chatState.conversationTotalUnreadCount > 0);
    },
  });

  app.chatState.conversationList = list;
  app.registerDisposer(() => list.dispose());
  void list.reset();
  void refreshUnreadBadge(app);
  return list;
}

interface RenderConversationListOptions {
  readonly force?: boolean;
  // 无条件重拉首页并滚回顶部：本端发送消息后让该会话「移动到顶部」，不点亮提示条。
  readonly toTop?: boolean;
  // force 背景刷新时受影响的会话 key（如 messages:received 的 conversationKeys）：
  // 用户不在顶部时不重排，但对仍在数据窗口内的这些会话定向拉取并就地更新未读/预览。
  readonly keys?: ReadonlyArray<string>;
}

async function promoteConversations(app: AppInstance, keys: ReadonlyArray<string>): Promise<void> {
  const list = getConversationList(app);
  if (keys.length === 0) {
    list.invalidate();
    app.$("conversation-list").scrollTop = 0;
    return;
  }
  try {
    const page = await app.client.getConversations({
      targets: keys.map(keyToTarget),
    });
    // getConversations 返回新到旧顺序；head 端逐条 upsert 时反向并入，保持服务端顺序。
    for (const conversation of [...page.conversations].reverse()) {
      list.upsertLocal(conversation);
    }
    app.$("conversation-list").scrollTop = 0;
  } catch (error) {
    console.warn("promoteConversations failed:", error);
    list.invalidate({ identities: keys.map(sdkKeyToIdentity) });
  }
}

export function renderConversationList(
  app: AppInstance,
  options: RenderConversationListOptions = {},
): void {
  const list = getConversationList(app);

  if (options.toTop) {
    // 本端发送：只拉受影响会话并移到 head，新旧兄弟节点都由有键协调器保留；
    // 无论当前滚动位置都回到顶部，这是主动行为，不点亮提示条。
    void promoteConversations(app, options.keys ?? []);
    void refreshUnreadBadge(app);
    return;
  }

  if (options.force) {
    if (options.keys && options.keys.length > 0) {
      // 收到消息等事件携带受影响会话 key：对仍在数据窗口内的会话定向拉取并就地更新，
      // 让未读角标和最新预览即时反映，而不必等用户滚回顶部重排。
      void refreshConversations(app, [...options.keys]);
      return;
    }
    // 贴顶直接追平重拉，否则只点亮「列表有更新」提示——决策全部收敛在 invalidate 内部。
    list.invalidate();
    void refreshUnreadBadge(app);
    return;
  }

  list.render();
}

// 轻通知后定向刷新：clearunread / delete / messages:received 等收到后，对仍在数据窗口内的会话
// 定向拉取当前状态并就地更新窗口；拉取后不存在 = 已删除，从窗口移除、剩余条目往上补齐。
// 当前打开的会话在受影响 key 之列时，额外确认它是否已被删除并在必要时关回空态。
export async function refreshConversations(app: AppInstance, keys: string[]): Promise<void> {
  const list = getConversationList(app);
  list.invalidate({ identities: keys.map(sdkKeyToIdentity) });

  const currentKey = app.chatState.currentConvKey;
  if (currentKey && keys.includes(currentKey)) {
    try {
      const fresh = await app.client.getConversations({ targets: [keyToTarget(currentKey)] });
      if (fresh.conversations.length === 0) closeStaleConversation(app, currentKey);
    } catch (error) {
      console.warn("refreshConversations failed:", error);
    }
  }
  void refreshUnreadBadge(app);
}

function closeStaleConversation(app: AppInstance, expectedKey: string): void {
  if (app.chatState.currentConvKey !== expectedKey) return;
  app.chatState.currentConvKey = null;
  app.chatState.currentConversation = null;
  resetMessagePage(app);
  exitMessageSelectionMode(app);
  closeMessageActionMenu(app);
  app.$("chat-title").textContent = "";
  app.$("chat-header").classList.add("hidden");
  app.$("message-input-area").classList.add("hidden");
  app.$("chat-empty").classList.remove("hidden");
  app.$("message-list").innerHTML = "";
  app.$("view-chat").classList.remove("mobile-showing-chat");
  app.$("view-chat").classList.remove("mobile-showing-detail");
  renderConversationList(app, { force: true });
}

// 会话 UI 骨架初始化（置为当前会话、清空未读、渲染头部/输入框等），不含消息拉取。
// openConversation（拉最新页）与全局搜索的锚点跳转（openConversationShellForJump）共用，
// 避免"先拉最新页渲染一次、再立刻被锚点页覆盖重渲一次"的双重渲染与 scrollToBottom 竞态。
function openConversationShell(
  app: AppInstance,
  conv: LocalConversation,
): ConversationDescriptor {
  const conversation = app.client.describeConversation(conv);
  app.emitConversationOpen(conversation);
  app.chatState.currentConvKey = conversation.key;
  app.chatState.currentConversation = conv;
  resetMessagePage(app);
  exitMessageSelectionMode(app);
  closeMessageActionMenu(app);
  closeMessageSearchPanel(app);

  if (app.chatState.detailOpen) {
    app.chatState.detailOpen = false;
    app.chatState.detailRequestId++;
    app.$("right-panel").classList.add("collapsed");
    app.$("view-chat").classList.remove("mobile-showing-detail");
  }

  if ((conv.unreadCount || 0) > 0) {
    app.client.clearUnread(conversation.target).catch(() => {});
  }

  // 群资料变更不向全部成员主动广播；用户显式进入群聊时绕过 TTL 强制后台刷新，
  // 返回后由 display:updated 统一重绘当前标题、会话列表和已打开的详情面板。
  if (conversation.kind === "group") {
    app.client.getGroupInfos([conversation.id], { forceRefresh: true });
  }

  renderConversationList(app);
  updateChatHeaderTitle(app, conversation, conv);
  app.$("chat-header").classList.remove("hidden");
  app.$("message-input-area").classList.remove("hidden");
  app.$("chat-empty").classList.add("hidden");
  applyConversationGuards(app);
  app.$("view-chat").classList.add("mobile-showing-chat");
  return conversation;
}

export async function openConversation(
  app: AppInstance,
  conv: LocalConversation,
) {
  const conversation = openConversationShell(app, conv);
  const isPlaceholderGroup =
    conversation.kind === "group" && conv.lastSeq === 0 && !conv.lastMessage;

  // reset() 内部吞掉网络错误（失败态反映在 getState().failed，并经由消息列表的
  // onError 回调统一提示，见 message-list.ts），这里只需要处理"占位群且首页为空"
  // 这条业务分支，以及切换期间又切走的丢弃判断。
  const messageList = getMessageList(app);
  await messageList.reset({ query: {} });
  if (app.chatState.currentConvKey !== conversation.key) return;
  const state = messageList.getState();
  if (isPlaceholderGroup && !state.failed && state.count === 0) {
    closeStaleConversation(app, conversation.key);
  }
}

// 全局搜索点开消息结果专用：只做会话骨架初始化，不拉最新页——消息加载交给调用方
// 用 jumpToMessageInConversation 以锚点方式一次性拉取，避免上面提到的双重渲染竞态。
export function openConversationShellForJump(
  app: AppInstance,
  conv: LocalConversation,
): ConversationDescriptor {
  return openConversationShell(app, conv);
}
