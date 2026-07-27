import { CONTACT_FRIEND } from '@yimsg/sdk';
import type { Contact, LocalConversation, Message } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from "../../app-instance";
import { describeError } from "../../error-i18n";
import { conversationLabel } from "./helpers";
import { exitMessageSelectionMode } from "./selection";
import { appendLiveMessageToPage } from "./message-page";
import { BoundedStreamWindow } from "../../bounded-stream-window";
import { BoundedPageWindow } from "../../bounded-page-window";
import { conversationIdentity, contactIdentity } from "../../list-identity";
import { contactFriendUid, contactGroupId } from "../contacts";

const FORWARD_MAX_TARGETS = APP_CONFIG.forward.maxTargets;
const FORWARD_CONTACT_PAGE_SIZE = APP_CONFIG.list.pageSize;

type ForwardTargetTab = "conversations" | "contacts";

// 转发目标里的联系人条目只关心可直接开聊的好友 / 收藏群，组织类通讯录条目不是会话目标，过滤掉。
function forwardContactConv(contact: Contact): LocalConversation {
  const groupId = contactGroupId(contact);
  const isGroup = groupId !== "0";
  return isGroup
    ? { groupId, friendUid: "0", lastSeq: 0, lastMessage: null }
    : { groupId: "0", friendUid: contactFriendUid(contact), lastSeq: 0, lastMessage: null };
}

async function showForwardModal(
  app: AppInstance,
  defaultTargetKey: string | null,
  selectedCount: number,
): Promise<{ targetKeys: string[]; comment: string } | null> {
  const firstPage = await app.client.getConversations({
    limit: APP_CONFIG.list.pageSize,
  });

  return new Promise((resolve) => {
    const modal = app.$("modal-content");
    const controller = new AbortController();
    const selectedKeys = new Set<string>();
    if (defaultTargetKey) selectedKeys.add(defaultTargetKey);
    let activeTab: ForwardTargetTab = "conversations";
    let loading = false;
    let forwardListView: BoundedStreamWindow<LocalConversation> | null = null;
    // 会话候选是有界滑动窗口（按整页裁剪）：游标用服务端返回的不透明边界游标，双向续翻。
    const convWindow = new BoundedPageWindow<LocalConversation>(APP_CONFIG.list.maxPages, undefined, conversationIdentity);
    convWindow.setInitial({
      items: firstPage.conversations,
      startCursor: firstPage.page.startCursor,
      endCursor: firstPage.page.endCursor,
      hasMoreBackward: firstPage.page.hasMoreBackward,
      hasMoreForward: firstPage.page.hasMoreForward,
    });

    // 通讯录候选（好友 / 收藏群）：切到「通讯录」tab 时才首次拉取，避免每次转发都多一次请求。
    // 与好友列表关键字过滤同一套机制：关键字非空时改走 search_contacts，游标/窗口机制不变。
    let contactKeyword = "";
    let contactKeywordDebounce: ReturnType<typeof setTimeout> | null = null;
    let contactsLoading = false;
    let contactsLoaded = false;
    let contactRequestId = 0;
    let contactListView: BoundedStreamWindow<Contact> | null = null;
    const contactWindow = new BoundedPageWindow<Contact>(APP_CONFIG.list.maxPages, undefined, contactIdentity);

    const finish = (
      value: { targetKeys: string[]; comment: string } | null,
    ) => {
      controller.abort();
      if (contactKeywordDebounce) clearTimeout(contactKeywordDebounce);
      app.$("modal-overlay").classList.add("hidden");
      resolve(value);
    };

    const pickDefaultIfNeeded = (
      conversations: readonly LocalConversation[],
    ) => {
      if (selectedKeys.size === 0 && conversations.length > 0) {
        selectedKeys.add(app.client.describeConversation(conversations[0]).key);
      }
    };

    const updateSelectedSummary = () => {
      const summary = app.dom.getElementById("forward-target-selected-summary");
      if (!summary) return;
      summary.textContent = app.t("chat.forwardSelectedTargets", {
        n: String(selectedKeys.size),
        max: String(FORWARD_MAX_TARGETS),
      });
    };

    const renderConversationItems = () => {
      const list = app.dom.getElementById("forward-conversation-list");
      if (!list) return;
      if (!forwardListView) {
        forwardListView = new BoundedStreamWindow<LocalConversation>({
          scrollElement: list,
        });
      }

      const items = convWindow.items;
      pickDefaultIfNeeded(items);
      forwardListView.render({
        items,
        hasMoreBefore: convWindow.hasMoreBefore,
        hasMoreAfter: convWindow.hasMoreAfter,
        loadingBefore: loading,
        loadingAfter: loading,
        emptyText: app.t("chat.forwardNoConversation"),
        loadingText: app.t("common.loading"),
        bottomBoundaryText: app.t("chat.noMoreConversations"),
        loadBefore: () => { void maybeLoadMore({ mode: "backward" }); },
        loadAfter: () => { void maybeLoadMore({ mode: "forward" }); },
        keyOf: (conv) => app.client.describeConversation(conv).key,
        renderItem: (conv) => {
          const key = app.client.describeConversation(conv).key;
          const checked = selectedKeys.has(key) ? "checked" : "";
          const item = app.dom.ownerDocument.createElement("label");
          item.className = "forward-conversation-item";
          item.innerHTML = `
            <input type="checkbox" name="forward-target" value="${app.escapeHtml(key)}" ${checked}>
            <span>${app.escapeHtml(conversationLabel(app, conv))}</span>
          `;
          item.querySelector("input")!.addEventListener(
            "change",
            (event) => {
              const input = event.currentTarget as HTMLInputElement;
              if (input.checked) {
                if (selectedKeys.size >= FORWARD_MAX_TARGETS && !selectedKeys.has(key)) {
                  input.checked = false;
                  app.showToast(app.t("chat.forwardTargetLimit", { max: String(FORWARD_MAX_TARGETS) }), "error");
                  return;
                }
                selectedKeys.add(key);
              } else {
                selectedKeys.delete(key);
              }
              updateSelectedSummary();
              // 同一个目标可能同时出现在「通讯录」tab，需要重渲染那边的勾选框保持同步。
              if (contactsLoaded || contactsLoading) renderContactItems();
            },
            { signal: controller.signal },
          );
          return [item];
        },
      });
      updateSelectedSummary();
    };

    const maybeLoadMore = async (options: { mode: "forward" | "backward" }) => {
      if (loading) return;
      if (options.mode === "forward" && !convWindow.hasMoreAfter) return;
      if (options.mode === "backward" && !convWindow.hasMoreBefore) return;
      loading = true;
      renderConversationItems();
      try {
        const backward = options.mode === "backward";
        const cursor = (backward ? convWindow.backwardCursor : convWindow.forwardCursor) || undefined;
        const page = await app.client.getConversations({ cursor, backward, limit: APP_CONFIG.list.pageSize });
        const result = {
          items: page.conversations,
          startCursor: page.page.startCursor,
          endCursor: page.page.endCursor,
          hasMoreBackward: page.page.hasMoreBackward,
          hasMoreForward: page.page.hasMoreForward,
        };
        if (backward) convWindow.prependBackward(result);
        else convWindow.appendForward(result);
      } finally {
        loading = false;
        renderConversationItems();
      }
    };

    const renderContactItems = () => {
      const list = app.dom.getElementById("forward-contact-list");
      if (!list) return;
      if (!contactListView) {
        contactListView = new BoundedStreamWindow<Contact>({
          scrollElement: list,
        });
      }

      contactListView.render({
        items: contactWindow.items,
        loaded: contactsLoaded,
        hasMoreBefore: contactWindow.hasMoreBefore,
        hasMoreAfter: contactWindow.hasMoreAfter,
        loadingBefore: contactsLoading,
        loadingAfter: contactsLoading,
        emptyText: app.t(contactKeyword ? "contacts.noSearchResults" : "contacts.noFriends"),
        loadingText: app.t("common.loading"),
        bottomBoundaryText: app.t("contacts.noMoreContacts"),
        loadBefore: () => { void maybeLoadMoreContacts({ mode: "backward" }); },
        loadAfter: () => { void maybeLoadMoreContacts({ mode: "forward" }); },
        keyOf: (contact) => app.client.describeConversation(forwardContactConv(contact)).key,
        renderItem: (contact) => {
          const conv = forwardContactConv(contact);
          const key = app.client.describeConversation(conv).key;
          const checked = selectedKeys.has(key) ? "checked" : "";
          const item = app.dom.ownerDocument.createElement("label");
          item.className = "forward-conversation-item";
          item.innerHTML = `
            <input type="checkbox" name="forward-target" value="${app.escapeHtml(key)}" ${checked}>
            <span>${app.escapeHtml(conversationLabel(app, conv))}</span>
          `;
          item.querySelector("input")!.addEventListener(
            "change",
            (event) => {
              const input = event.currentTarget as HTMLInputElement;
              if (input.checked) {
                if (selectedKeys.size >= FORWARD_MAX_TARGETS && !selectedKeys.has(key)) {
                  input.checked = false;
                  app.showToast(app.t("chat.forwardTargetLimit", { max: String(FORWARD_MAX_TARGETS) }), "error");
                  return;
                }
                selectedKeys.add(key);
              } else {
                selectedKeys.delete(key);
              }
              updateSelectedSummary();
              // 同一个目标可能同时出现在「最近会话」tab，需要重渲染那边的勾选框保持同步。
              renderConversationItems();
            },
            { signal: controller.signal },
          );
          return [item];
        },
      });
      updateSelectedSummary();
    };

    const maybeLoadMoreContacts = async (options: { mode: "reset" | "forward" | "backward" }) => {
      if (contactsLoading) return;
      if (options.mode === "forward" && !contactWindow.hasMoreAfter) return;
      if (options.mode === "backward" && !contactWindow.hasMoreBefore) return;
      const requestId = ++contactRequestId;
      contactsLoading = true;
      if (options.mode === "reset") {
        contactWindow.reset();
        contactsLoaded = false;
      }
      renderContactItems();
      try {
        const backward = options.mode === "backward";
        const cursor = options.mode === "reset"
          ? undefined
          : (backward ? contactWindow.backwardCursor : contactWindow.forwardCursor) || undefined;
        const page = contactKeyword
          ? await app.client.searchContacts({ keyword: contactKeyword, status: CONTACT_FRIEND, cursor, backward, limit: FORWARD_CONTACT_PAGE_SIZE })
          : await app.client.getContacts({ status: CONTACT_FRIEND, cursor, backward, limit: FORWARD_CONTACT_PAGE_SIZE });
        if (requestId !== contactRequestId) return;
        // 组织类通讯录条目不是会话目标，只保留可直接开聊的好友 / 收藏群。
        const targets = page.contacts.filter((c) => contactFriendUid(c) !== "0" || contactGroupId(c) !== "0");
        const result = {
          items: targets,
          startCursor: page.page.startCursor,
          endCursor: page.page.endCursor,
          hasMoreBackward: page.page.hasMoreBackward,
          hasMoreForward: page.page.hasMoreForward,
        };
        if (options.mode === "reset") contactWindow.setInitial(result);
        else if (options.mode === "forward") contactWindow.appendForward(result);
        else contactWindow.prependBackward(result);
        contactsLoaded = true;
      } catch (_) {
        app.showToast(app.t(contactKeyword ? "contacts.searchContactsFailed" : "contacts.failedToLoadContacts"), "error");
      } finally {
        if (requestId === contactRequestId) {
          contactsLoading = false;
          renderContactItems();
        }
      }
    };

    modal.innerHTML = `
      <div class="modal-title">${app.escapeHtml(app.t("chat.forwardTitle"))}</div>
      <div class="forward-selected-summary">${app.escapeHtml(app.t("chat.multiSelectCount", { n: String(selectedCount) }))}</div>
      <div class="forward-selected-summary" id="forward-target-selected-summary"></div>
      <div class="form-group">
        <label>${app.escapeHtml(app.t("chat.forwardTarget"))}</label>
        <div class="tabs" id="forward-target-tabs">
          <button type="button" class="tab active" data-target-tab="conversations">${app.escapeHtml(app.t("chat.forwardTabConversations"))}</button>
          <button type="button" class="tab" data-target-tab="contacts">${app.escapeHtml(app.t("chat.forwardTabContacts"))}</button>
        </div>
        <input class="input hidden" type="text" id="forward-contact-search-input" placeholder="${app.escapeHtml(app.t("chat.forwardSearchPlaceholder"))}">
        <div class="forward-conversation-list" id="forward-conversation-list"></div>
        <div class="forward-conversation-list hidden" id="forward-contact-list"></div>
      </div>
      <div class="form-group">
        <label>${app.escapeHtml(app.t("chat.forwardComment"))}</label>
        <input class="input" type="text" id="forward-comment-input" placeholder="${app.escapeHtml(app.t("chat.forwardCommentPlaceholder"))}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="forward-cancel-btn">${app.escapeHtml(app.t("chat.forwardCancel"))}</button>
        <button class="btn btn-primary" id="forward-confirm-btn">${app.escapeHtml(app.t("chat.forwardConfirm"))}</button>
      </div>
    `;
    app.$("modal-overlay").classList.remove("hidden");

    renderConversationItems();

    const switchTargetTab = (tab: ForwardTargetTab) => {
      if (activeTab === tab) return;
      activeTab = tab;
      app.dom.querySelectorAll<HTMLElement>("#forward-target-tabs [data-target-tab]").forEach((el) => {
        el.classList.toggle("active", el.dataset.targetTab === tab);
      });
      app.$("forward-conversation-list").classList.toggle("hidden", tab !== "conversations");
      app.$("forward-contact-list").classList.toggle("hidden", tab !== "contacts");
      app.$("forward-contact-search-input").classList.toggle("hidden", tab !== "contacts");
      if (tab === "contacts" && !contactsLoaded && !contactsLoading) {
        void maybeLoadMoreContacts({ mode: "reset" });
      }
    };
    app.dom.querySelectorAll<HTMLElement>("#forward-target-tabs [data-target-tab]").forEach((el) => {
      el.addEventListener(
        "click",
        () => switchTargetTab(el.dataset.targetTab as ForwardTargetTab),
        { signal: controller.signal },
      );
    });

    const contactSearchInput = app.$("forward-contact-search-input") as HTMLInputElement;
    contactSearchInput.addEventListener(
      "input",
      () => {
        if (contactKeywordDebounce) clearTimeout(contactKeywordDebounce);
        const value = contactSearchInput.value;
        contactKeywordDebounce = setTimeout(() => {
          const keyword = value.trim();
          if (keyword === contactKeyword) return;
          contactKeyword = keyword;
          void maybeLoadMoreContacts({ mode: "reset" });
        }, 300);
      },
      { signal: controller.signal },
    );

    const input = app.$("forward-comment-input") as HTMLInputElement;
    input.focus();

    app.$("forward-cancel-btn").addEventListener("click", () => finish(null), {
      signal: controller.signal,
    });
    app.$("forward-confirm-btn").addEventListener(
      "click",
      () => {
        if (selectedKeys.size === 0) {
          app.showToast(app.t("chat.forwardNoConversation"), "error");
          return;
        }
        finish({ targetKeys: [...selectedKeys], comment: input.value.trim() });
      },
      { signal: controller.signal },
    );
    input.addEventListener(
      "keydown",
      (e) => {
        if ((e as KeyboardEvent).key !== "Enter") return;
        if (selectedKeys.size === 0) {
          app.showToast(app.t("chat.forwardNoConversation"), "error");
          return;
        }
        finish({ targetKeys: [...selectedKeys], comment: input.value.trim() });
      },
      { signal: controller.signal },
    );
  });
}

export async function forwardMessages(app: AppInstance, messages: Message[]) {
  if (messages.length === 0) return;

  const result = await showForwardModal(
    app,
    app.chatState.currentConvKey,
    messages.length,
  );
  if (!result) return;

  let successCount = 0;
  let failedCount = 0;
  let lastError = "";
  const targetKeys = result.targetKeys;
  for (const targetKey of targetKeys) {
    try {
      const descriptor = app.client.describeConversation(targetKey);
      const sendResult = await app.client.forwardMessages(
        descriptor.target,
        messages.slice(0, APP_CONFIG.forward.maxItems),
        result.comment || app.t("chat.forwardDefaultComment"),
      );
      if (app.chatState.currentConvKey === targetKey) {
        appendLiveMessageToPage(app, sendResult.message);
        app.views.chat?.renderMessages();
        app.views.chat?.scrollToBottom();
      }
      successCount++;
    } catch (e) {
      failedCount++;
      lastError = describeError(app, e);
    }
  }

  exitMessageSelectionMode(app);
  if (failedCount === 0) {
    app.showToast(app.t("chat.forwardSuccess"));
  } else if (successCount > 0) {
    app.showToast(
      app.t("chat.forwardPartialFailed", {
        success: String(successCount),
        failed: String(failedCount),
        total: String(targetKeys.length),
      }),
      "error",
    );
  } else {
    app.showToast(
      app.t("chat.forwardAllFailed", { total: String(targetKeys.length) }) +
        lastError,
      "error",
    );
  }
}
