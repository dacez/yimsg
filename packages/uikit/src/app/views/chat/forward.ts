import { CONTACT_FRIEND } from '@yimsg/sdk';
import type { Contact, LocalConversation, Message } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from "../../app-instance";
import { describeError } from "../../error-i18n";
import { conversationLabel } from "./helpers";
import { exitMessageSelectionMode } from "./selection";
import { appendLiveMessageToPage } from "./message-page";
import { createBoundedList, sdkPageSource, SelectionStore } from "../../bounded-list";
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

function renderForwardRow(app: AppInstance, label: string, ctx: { readonly selected: boolean; readonly selectable: boolean }): HTMLElement {
  const item = app.dom.ownerDocument.createElement("label");
  item.className = "forward-conversation-item";
  item.innerHTML = `
    <input type="checkbox" ${ctx.selected ? "checked" : ""} ${!ctx.selectable ? "disabled" : ""}>
    <span>${app.escapeHtml(label)}</span>
  `;
  return item;
}

async function showForwardModal(
  app: AppInstance,
  defaultTargetKey: string | null,
  selectedCount: number,
): Promise<{ targetKeys: string[]; comment: string } | null> {
  return new Promise((resolve) => {
    const modal = app.$("modal-content");
    const controller = new AbortController();
    // 共享选中集：两个 tab 的同一个目标勾选状态自动同步，任一实例改动都会通知另一个重渲。
    const selectionStore = new SelectionStore(FORWARD_MAX_TARGETS);
    if (defaultTargetKey) selectionStore.toggle(defaultTargetKey);
    let activeTab: ForwardTargetTab = "conversations";
    let contactKeyword = "";

    const updateSelectedSummary = () => {
      const summary = app.dom.getElementById("forward-target-selected-summary");
      if (!summary) return;
      summary.textContent = app.t("chat.forwardSelectedTargets", {
        n: String(selectionStore.size),
        max: String(FORWARD_MAX_TARGETS),
      });
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
    updateSelectedSummary();

    // 会话候选：有界滑动窗口，游标用服务端整页边界双向续翻；首页在弹窗打开时立即拉取。
    const conversationList = createBoundedList<LocalConversation>({
      id: "forward.conversations",
      scrollElement: app.$("forward-conversation-list"),
      pillHost: false,
      pageSize: APP_CONFIG.list.pageSize,
      maxPages: APP_CONFIG.list.maxPages,
      register: (c) => app.registerBoundedList(c),
      source: sdkPageSource(
        ({ cursor, backward, limit }) => app.client.getConversations({ cursor, backward, limit }),
        (page) => page.conversations,
      ),
      identityOf: (conv) => app.client.describeConversation(conv).key,
      order: "desc",
      selection: { mode: "multi", store: selectionStore },
      renderItem: (conv, ctx) => [renderForwardRow(app, conversationLabel(app, conv), ctx)],
      text: {
        empty: () => app.t("chat.forwardNoConversation"),
        loading: () => app.t("common.loading"),
        tailBoundary: () => app.t("chat.noMoreConversations"),
        retry: () => app.t("common.retry"),
      },
      onItemsChanged: (items) => {
        // 未指定默认目标（无正在打开的会话）时，首页到达后自动预选第一个候选。
        if (selectionStore.size === 0 && items.length > 0) {
          selectionStore.toggle(app.client.describeConversation(items[0]).key);
        }
      },
      onError: (error) => console.warn("[yimsg/uikit] forward conversation list failed:", error),
    });
    void conversationList.reset();

    // 通讯录候选（好友 / 收藏群）：切到该 tab 才首次拉取，避免每次转发都多一次请求。
    // 关键字非空时改走 search_contacts，setQuery 的防抖由组件统一处理。
    const contactList = createBoundedList<Contact, { keyword: string }>({
      id: "forward.contacts",
      scrollElement: app.$("forward-contact-list"),
      pillHost: false,
      pageSize: FORWARD_CONTACT_PAGE_SIZE,
      maxPages: APP_CONFIG.list.maxPages,
      register: (c) => app.registerBoundedList(c),
      initialQuery: { keyword: "" },
      source: sdkPageSource(
        ({ cursor, backward, limit, query }) => query.keyword
          ? app.client.searchContacts({ keyword: query.keyword, status: CONTACT_FRIEND, cursor, backward, limit })
          : app.client.getContacts({ status: CONTACT_FRIEND, cursor, backward, limit }),
        // 组织类通讯录条目不是会话目标，只保留可直接开聊的好友 / 收藏群。
        (page) => page.contacts.filter((c) => contactFriendUid(c) !== "0" || contactGroupId(c) !== "0"),
      ),
      identityOf: (contact) => app.client.describeConversation(forwardContactConv(contact)).key,
      order: "desc",
      selection: { mode: "multi", store: selectionStore },
      renderItem: (contact, ctx) => [renderForwardRow(app, conversationLabel(app, forwardContactConv(contact)), ctx)],
      text: {
        empty: () => app.t(contactKeyword ? "contacts.noSearchResults" : "contacts.noFriends"),
        loading: () => app.t("common.loading"),
        tailBoundary: () => app.t("contacts.noMoreContacts"),
        retry: () => app.t("common.retry"),
      },
      onError: (error) => console.warn("[yimsg/uikit] forward contact list failed:", error),
    });

    // 会话 / 联系人标签里的昵称、群名首次渲染时可能还没入缓存，异步补齐后
    // 靠 display:updated 重绘两个候选列表。
    const onDisplayUpdated = (): void => {
      conversationList.render();
      contactList.render();
    };
    app.client.on("display:updated", onDisplayUpdated);

    const finish = (
      value: { targetKeys: string[]; comment: string } | null,
    ) => {
      controller.abort();
      app.client.off("display:updated", onDisplayUpdated);
      conversationList.dispose();
      contactList.dispose();
      app.$("modal-overlay").classList.add("hidden");
      resolve(value);
    };

    const switchTargetTab = (tab: ForwardTargetTab) => {
      if (activeTab === tab) return;
      activeTab = tab;
      app.dom.querySelectorAll<HTMLElement>("#forward-target-tabs [data-target-tab]").forEach((el) => {
        el.classList.toggle("active", el.dataset.targetTab === tab);
      });
      app.$("forward-conversation-list").classList.toggle("hidden", tab !== "conversations");
      app.$("forward-contact-list").classList.toggle("hidden", tab !== "contacts");
      app.$("forward-contact-search-input").classList.toggle("hidden", tab !== "contacts");
      if (tab === "contacts" && !contactList.getState().loaded) {
        void contactList.reset();
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
        const keyword = contactSearchInput.value.trim();
        if (keyword === contactKeyword) return;
        contactKeyword = keyword;
        contactList.setQuery({ keyword });
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
        if (selectionStore.size === 0) {
          app.showToast(app.t("chat.forwardNoConversation"), "error");
          return;
        }
        finish({ targetKeys: [...selectionStore.snapshotIds()], comment: input.value.trim() });
      },
      { signal: controller.signal },
    );
    input.addEventListener(
      "keydown",
      (e) => {
        if ((e as KeyboardEvent).key !== "Enter") return;
        if (selectionStore.size === 0) {
          app.showToast(app.t("chat.forwardNoConversation"), "error");
          return;
        }
        finish({ targetKeys: [...selectionStore.snapshotIds()], comment: input.value.trim() });
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
