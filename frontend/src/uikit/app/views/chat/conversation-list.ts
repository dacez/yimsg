import type { ConversationDescriptor, ConversationTarget, LocalConversation } from "../../../../sdk";
import { displayGroupName, displayUserName, formatTime } from "../../../../sdk";
import { APP_CONFIG } from "../../../../app-config";
import { CONTACT_FRIEND } from "../../../../constants";
import type { AppInstance } from "../../app-instance";
import { msgPreview } from "./helpers";
import { applyConversationGuards } from "./composer";
import { closeMessageActionMenu, exitMessageSelectionMode } from "./selection";
import { pushRoute, replaceRoute } from "../../router";
import {
  getOrCreateBoundedStreamWindow,
  BoundedStreamWindow,
} from "../../bounded-stream-window";
import { resetMessagePage, setInitialMessagePage } from "./message-page";
import { contactFriendUid } from "../contacts";

// 判断 DM 对端是否好友，用于标记"临时会话"：私聊已不要求好友关系（见 sendDM），
// 前端按已同步的联系人状态本地判断是否提示。结果按 uid 懒加载缓存在 chatState 上，
// 未知时不展示标签，查询回来后触发一次重渲。
async function ensureFriendStatus(app: AppInstance, uids: readonly string[]): Promise<void> {
  const cache = app.chatState.friendStatusCache;
  const unknown = [...new Set(uids)].filter((uid) => uid !== "0" && !cache.has(uid));
  if (unknown.length === 0) return;
  try {
    const page = await app.client.getContacts({
      friendUids: unknown,
      status: CONTACT_FRIEND,
      limit: unknown.length,
    });
    const friends = new Set(page.contacts.map((c) => contactFriendUid(c)));
    for (const uid of unknown) cache.set(uid, friends.has(uid));
  } catch (error) {
    console.warn("ensureFriendStatus failed:", error);
    return;
  }
  renderConversationPage(app);
  refreshChatHeader(app);
}

// isTempSession：只在明确查到"不是好友"时才提示，避免未知状态下的误报。
function isTempSession(app: AppInstance, friendUid: string): boolean {
  return app.chatState.friendStatusCache.get(friendUid) === false;
}

// 设置聊天头部标题 + "临时会话"标签；群名 / 好友昵称取自 DisplayInfoCache 的同步快照，
// 首次打开陌生对端时可能还没缓存，靠 refreshChatHeader 在展示资料到达后补上。
function updateChatHeaderTitle(app: AppInstance, conversation: ConversationDescriptor, conv: LocalConversation): void {
  let title = "";
  let tempSession = false;
  if (conversation.kind === "group") {
    const groupId = conv.groupId || "0";
    title = displayGroupName(app.client.getGroupInfos([groupId]).get(groupId), app.t("chat.group"));
  } else {
    const friendUid = conv.friendUid || "0";
    title = displayUserName(app.client.getUserInfos([friendUid]).get(friendUid), friendUid);
    void ensureFriendStatus(app, [friendUid]);
    tempSession = isTempSession(app, friendUid);
  }

  app.$("chat-title").textContent = title;
  app.$("chat-title").parentElement?.querySelector(".temp-session-badge")?.remove();
  if (tempSession) {
    const badge = app.dom.ownerDocument.createElement("span");
    badge.className = "temp-session-badge";
    badge.textContent = app.t("chat.tempSession");
    app.$("chat-title").insertAdjacentElement("afterend", badge);
  }
}

// refreshChatHeader：display:updated 等异步展示资料到达后，重算当前打开会话的标题 / 临时会话标签。
export function refreshChatHeader(app: AppInstance): void {
  const conv = app.chatState.currentConversation;
  if (!conv || !app.chatState.currentConvKey) return;
  updateChatHeaderTitle(app, app.client.describeConversation(conv), conv);
}

// 贴顶判定阈值（px）：背景刷新只在贴顶时直接重拉，否则只点亮"列表有更新"提示。
const LIST_TOP_STICKY_PX = 4;
const CONVERSATION_PILL_ID = "conversation-update-pill";
const conversationListViews = new WeakMap<AppInstance, BoundedStreamWindow<LocalConversation>>();

function getConversationListView(app: AppInstance): BoundedStreamWindow<LocalConversation> {
  return getOrCreateBoundedStreamWindow(conversationListViews, app, () => new BoundedStreamWindow<LocalConversation>({
    scrollElement: app.$("conversation-list"),
    onScroll: () => maybeCatchUpStale(app),
  }));
}

interface RenderConversationListOptions {
  readonly force?: boolean;
  // 无条件重拉首页并滚回顶部：本端发送消息后让该会话「移动到顶部」，不点亮提示条。
  readonly toTop?: boolean;
  // force 背景刷新时受影响的会话 key（如 messages:received 的 conversationKeys）：
  // 用户不在顶部时不重排，但对仍在数据窗口内的这些会话定向拉取并就地更新未读/预览。
  readonly keys?: ReadonlyArray<string>;
}

// "列表有更新"且用户已滚回顶部：自动重拉首页追平。
function maybeCatchUpStale(app: AppInstance): void {
  if (
    app.chatState.conversationListStale &&
    app.$("conversation-list").scrollTop <= LIST_TOP_STICKY_PX &&
    !app.chatState.conversationPageLoading
  ) {
    void loadConversations(app, { mode: "reset" });
  }
}

// 会话列表是有界滑动窗口（conversationWindow，按整页裁剪）：
// - reset：无游标拉首页（最活跃端）重建窗口，实时重排 / 备注变更都走 reset；
// - forward：触底用尾页 end_cursor 向后拉一页追加，超限裁掉首部并标记 hasMoreBefore；
// - backward：触顶用首页 start_cursor 向前拉回被裁掉的更活跃页。
async function loadConversations(
  app: AppInstance,
  options: { mode: "reset" | "forward" | "backward" },
): Promise<void> {
  if (app.chatState.conversationPageLoading) return;
  const window = app.chatState.conversationWindow;
  if (options.mode === "forward" && !window.hasMoreAfter) return;
  if (options.mode === "backward" && !window.hasMoreBefore) return;

  const requestId = ++app.chatState.conversationPageRequestId;
  app.chatState.conversationPageLoading = true;
  try {
    const backward = options.mode === "backward";
    const cursor =
      options.mode === "reset"
        ? undefined
        : (backward ? window.backwardCursor : window.forwardCursor) || undefined;
    // reset 时拉取首页后才知道整体未读数；续翻只需调整窗口，未读数沿用已有值。
    const [page, unreadCount] = await Promise.all([
      app.client.getConversations({ cursor, backward, limit: APP_CONFIG.list.pageSize }),
      options.mode === "reset"
        ? app.client.getUnreadCount()
        : Promise.resolve(app.chatState.conversationTotalUnreadCount),
    ]);
    if (requestId !== app.chatState.conversationPageRequestId) return;

    const result = {
      items: page.conversations,
      startCursor: page.page.startCursor,
      endCursor: page.page.endCursor,
      hasMoreBackward: page.page.hasMoreBackward,
      hasMoreForward: page.page.hasMoreForward,
    };
    if (options.mode === "reset") window.setInitial(result);
    else if (options.mode === "forward") window.appendForward(result);
    else window.prependBackward(result);

    app.chatState.conversationTotalUnreadCount = unreadCount;
    app.chatState.conversationPageLoaded = true;
    if (options.mode === "reset") app.chatState.conversationListStale = false;
  } catch (error) {
    console.warn("loadConversations failed:", error);
  } finally {
    if (requestId === app.chatState.conversationPageRequestId) {
      app.chatState.conversationPageLoading = false;
    }
  }
  // 渲染放在清除 loading 之后：render 末尾的触界检测会在视窗未填满且仍有更多时
  // 链式补页，直到窗口被覆盖或全部加载完。
  if (requestId === app.chatState.conversationPageRequestId) {
    renderConversationPage(app);
    // reset 语义是回到「最活跃端」重建首页：render 的锚点恢复会把原视口顶部条目顶在
    // 原位，把新置顶 / 新增的会话挤出视口（贴顶时表现为「要下拉才看得到新会话」、
    // 下一条消息又因 scrollTop>4 点亮提示条）。渲染后显式归零覆盖锚点恢复，
    // 确保贴顶时自动刷新到最顶端（与消息列表贴底时 scrollToBottom 对称）。
    if (options.mode === "reset") app.$("conversation-list").scrollTop = 0;
  }
}

// 背景刷新（新消息、会话重排）时若用户不在列表顶部，不重拉数据、列表不动，
// 只点亮"列表有更新"提示条；点击或滚回顶部后再追平。
function ensureConversationUpdatePill(app: AppInstance): HTMLElement {
  const existing = app.dom.getElementById(CONVERSATION_PILL_ID);
  if (existing) return existing;
  const pill = app.dom.ownerDocument.createElement("button");
  pill.id = CONVERSATION_PILL_ID;
  pill.type = "button";
  pill.className = "new-message-pill list-updated-pill hidden";
  pill.addEventListener("click", () => {
    app.$("conversation-list").scrollTop = 0;
    void loadConversations(app, { mode: "reset" });
  });
  app.$("conversation-list").parentElement?.appendChild(pill);
  return pill;
}

function syncConversationUpdatePill(app: AppInstance): void {
  const pill = ensureConversationUpdatePill(app);
  pill.textContent = app.t("chat.listUpdated");
  pill.classList.toggle("hidden", !app.chatState.conversationListStale);
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

function renderConversationPage(app: AppInstance): void {
  // 列表有更新且用户已滚回顶部：自动追平（重拉首页）。
  maybeCatchUpStale(app);
  const windowConversations = app.chatState.conversationWindow.items;
  const currentConversation = app.chatState.currentConversation;
  const includeCurrentEmptyConversation = Boolean(
    currentConversation &&
    currentConversation.lastSeq === 0 &&
    (!currentConversation.groupId || currentConversation.groupId === "0") &&
    !windowConversations.some(
      (conv) =>
        app.client.describeConversation(conv).key ===
        app.chatState.currentConvKey,
    ),
  );
  // 仅展示用的占位会话固定在窗口条目头部，与窗口条目合并后统一全量渲染。
  const conversations =
    includeCurrentEmptyConversation && currentConversation
      ? [currentConversation, ...windowConversations]
      : windowConversations;

  if (!app.chatState.conversationPageLoaded) return;

  app.setNavBadge(
    '.nav-item[data-view="chat"]',
    app.chatState.conversationTotalUnreadCount > 0,
  );

  const view = getConversationListView(app);
  const window = app.chatState.conversationWindow;

  // 窗口有界，全量渲染：为窗口内全部会话预取展示信息（昵称、群名）。
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const dmPeerUids: string[] = [];
  for (const conv of conversations) {
    const conversation = app.client.describeConversation(conv);
    if (conversation.kind === "group") {
      groupIds.push(conv.groupId || "0");
      const lastMessage = conv.lastMessage;
      if (lastMessage && lastMessage.senderId !== "0")
        userIds.push(lastMessage.senderId);
    } else {
      const friendUid = conv.friendUid || "0";
      userIds.push(friendUid);
      dmPeerUids.push(friendUid);
    }
  }
  const userDisplayMap = app.client.getUserInfos(userIds);
  const groupDisplayMap = app.client.getGroupInfos(groupIds);
  void ensureFriendStatus(app, dmPeerUids);

  view.render({
    items: conversations,
    hasMoreBefore: window.hasMoreBefore,
    hasMoreAfter: window.hasMoreAfter,
    loadingBefore: app.chatState.conversationPageLoading,
    loadingAfter: app.chatState.conversationPageLoading,
    loaded: app.chatState.conversationPageLoaded,
    emptyText: app.t("chat.noConversations"),
    loadingText: app.t("common.loading"),
    bottomBoundaryText: app.t("chat.noMoreConversations"),
    loadBefore: () => { void loadConversations(app, { mode: "backward" }); },
    loadAfter: () => { void loadConversations(app, { mode: "forward" }); },
    keyOf: (conv) => app.client.describeConversation(conv).key,
    renderItem: (conv) => {
    const conversation = app.client.describeConversation(conv);
    const key = conversation.key;
    const isGroup = conversation.kind === "group";

    let name = "";
    let avatarText = "";
    let avatarUrl = "";
    let tempSession = false;
    if (isGroup) {
      const group = groupDisplayMap.get(conv.groupId || "0") || {
        name: "",
        avatarUrl: "",
        remarkName: "",
      };
      name = displayGroupName(group, app.t("chat.group"));
      avatarText = name[0];
      avatarUrl = group.avatarUrl || "";
    } else {
      const friendUid = conv.friendUid || "0";
      const user = userDisplayMap.get(friendUid) || {
        nickname: "",
        avatarUrl: "",
        remarkName: "",
        username: "",
      };
      name = displayUserName(user, friendUid);
      avatarText = name[0];
      avatarUrl = user.avatarUrl || "";
      tempSession = isTempSession(app, friendUid);
    }

    const lastMessage = conv.lastMessage;
    const preview = lastMessage
      ? msgPreview(app, lastMessage, isGroup, userDisplayMap)
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
    const tempBadge = tempSession
      ? `<span class="temp-session-badge">${app.escapeHtml(app.t("chat.tempSession"))}</span>`
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
              ${tempBadge}
            </div>
            <span class="conversation-time">${timeStr}</span>
          </div>
          <span class="conversation-preview">${app.escapeHtml(preview)}</span>
        </div>
      `;
    div.addEventListener("click", () => {
      void openConversation(app, conv);
    });
    return [div];
    },
  });
  syncConversationUpdatePill(app);
}

function keyToTarget(key: string): ConversationTarget {
  return key.startsWith("g:")
    ? { groupId: key.slice(2) }
    : { toUid: key.slice(2) };
}

// 轻通知后定向刷新：clearunread / delete / messages:received 等收到后，对仍在数据窗口内的会话
// 调 getConversations({ targets }) 拉当前状态并就地更新窗口；拉取后不存在 = 已删除，
// 从窗口移除、剩余条目往上补齐。命中条目都不在数据窗口（不可见）时不做定向拉取，但仍刷新未读角标
// 并重渲（同步提示条），靠后续贴顶 / 全量刷新追平排序。
export async function refreshConversations(app: AppInstance, keys: string[]): Promise<void> {
  const window = app.chatState.conversationWindow;
  const describe = (conv: LocalConversation) => app.client.describeConversation(conv).key;
  const inWindow = [...new Set(keys)].filter((k) =>
    window.items.some((conv) => describe(conv) === k),
  );

  // 命中数据窗口的会话才定向拉取并就地更新；不在窗口（不可见）的会话不拉，
  // 但仍需刷新未读角标并重渲（同步提示条），让总角标和「列表有更新」提示及时反映。
  if (inWindow.length > 0) {
    let fresh: ReadonlyArray<LocalConversation> | null = null;
    try {
      fresh = (await app.client.getConversations({ targets: inWindow.map(keyToTarget) })).conversations;
    } catch (error) {
      console.warn("refreshConversations failed:", error);
    }
    if (fresh) {
      const byKey = new Map(fresh.map((conv) => [describe(conv), conv]));
      let currentRemoved = false;
      for (const k of inWindow) {
        const updated = byKey.get(k);
        if (updated) {
          window.updateMatching((conv) => describe(conv) === k, () => updated);
        } else {
          window.removeMatching((conv) => describe(conv) === k);
          if (app.chatState.currentConvKey === k) currentRemoved = true;
        }
      }
      if (currentRemoved && app.chatState.currentConvKey) {
        void refreshUnreadBadge(app);
        // 当前打开的会话被删除：关闭回空态（内部会重渲列表）。
        closeStaleConversation(app, app.chatState.currentConvKey);
        return;
      }
    }
  }

  void refreshUnreadBadge(app);
  // 删除后窗口变短：renderConversationPage 末尾触界检测会按真实长度链式补页。
  renderConversationPage(app);
}

export function renderConversationList(
  app: AppInstance,
  options: RenderConversationListOptions = {},
) {
  app.setNavBadge(
    '.nav-item[data-view="chat"]',
    app.chatState.conversationTotalUnreadCount > 0,
  );
  if (!app.chatState.conversationPageLoaded) {
    void loadConversations(app, { mode: "reset" });
    return;
  }
  // 本端发送：无论当前滚动位置都重拉首页（newest），让发出的会话（seq 最大）回到顶部并置顶视口。
  // reset 重拉渲染后由 loadConversations 统一把滚动容器归零（覆盖锚点恢复），无需在此重复处理。
  if (options.toTop) {
    void loadConversations(app, { mode: "reset" });
    return;
  }
  if (options.force) {
    const container = app.$("conversation-list");
    if (container.scrollTop <= LIST_TOP_STICKY_PX) {
      void loadConversations(app, { mode: "reset" });
      return;
    }
    // 用户正在浏览列表中段：列表不重排，只点亮提示条。
    app.chatState.conversationListStale = true;
    if (options.keys && options.keys.length > 0) {
      // 收到消息等事件携带受影响会话 key：对仍在数据窗口内的会话定向拉取并就地更新，
      // 让未读角标和最新预览即时反映，而不必等用户滚回顶部重排（不在窗口的由其内部兜底刷新角标）。
      void refreshConversations(app, [...options.keys]);
      return;
    }
    void refreshUnreadBadge(app);
  }
  renderConversationPage(app);
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
  replaceRoute({ view: "chat" });
  renderConversationList(app, { force: true });
}

export async function openConversation(
  app: AppInstance,
  conv: LocalConversation,
) {
  const conversation = app.client.describeConversation(conv);
  const isPlaceholderGroup =
    conversation.kind === "group" && conv.lastSeq === 0 && !conv.lastMessage;
  app.emitConversationOpen(conversation);
  pushRoute({ view: "chat", conversation: conversation.target });
  app.chatState.currentConvKey = conversation.key;
  app.chatState.currentConversation = conv;
  const messagePageRequestId = resetMessagePage(app);
  exitMessageSelectionMode(app);
  closeMessageActionMenu(app);

  if (app.chatState.detailOpen) {
    app.chatState.detailOpen = false;
    app.chatState.detailRequestId++;
    app.$("right-panel").classList.add("collapsed");
    app.$("view-chat").classList.remove("mobile-showing-detail");
  }

  if ((conv.unreadCount || 0) > 0) {
    app.client.clearUnread(conversation.target).catch(() => {});
  }

  renderConversationList(app);
  updateChatHeaderTitle(app, conversation, conv);
  app.$("chat-header").classList.remove("hidden");
  app
    .$("chat-header")
    .setAttribute("data-mobile-back", app.t("auth.mobileBack"));
  app.$("message-input-area").classList.remove("hidden");
  app.$("chat-empty").classList.add("hidden");
  applyConversationGuards(app);
  app.$("view-chat").classList.add("mobile-showing-chat");

  const target: ConversationTarget = conversation.target;
  try {
    const result = await app.client.getMessages({
      target,
      backward: true,
      limit: APP_CONFIG.chat.messagePageSize,
    });
    if (
      messagePageRequestId !== app.chatState.messagePageRequestId ||
      app.chatState.currentConvKey !== conversation.key
    )
      return;
    if (isPlaceholderGroup && result.messages.length === 0) {
      closeStaleConversation(app, conversation.key);
      return;
    }
    setInitialMessagePage(app, result);
    app.views.chat?.renderMessages();
    app.views.chat?.scrollToBottom();
  } catch (_) {
    app.showToast(app.t("chat.failedToLoadMessages"), "error");
  }
}
