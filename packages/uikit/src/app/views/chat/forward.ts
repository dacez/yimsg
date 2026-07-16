import type { LocalConversation, Message } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from "../../app-instance";
import { conversationLabel } from "./helpers";
import { exitMessageSelectionMode } from "./selection";
import { appendLiveMessageToPage } from "./message-page";
import { BoundedStreamWindow } from "../../bounded-stream-window";
import { BoundedPageWindow } from "../../bounded-page-window";
import { conversationIdentity } from "../../list-identity";

const FORWARD_MAX_TARGETS = APP_CONFIG.forward.maxTargets;

async function showForwardModal(
  app: AppInstance,
  defaultTargetKey: string | null,
  selectedCount: number,
): Promise<{ targetKeys: string[]; comment: string } | null> {
  const firstPage = await app.client.getConversations({
    limit: APP_CONFIG.list.pageSize,
  });
  if (firstPage.conversations.length === 0) {
    app.showToast(app.t("chat.forwardNoConversation"), "error");
    return null;
  }

  return new Promise((resolve) => {
    const modal = app.$("modal-content");
    const controller = new AbortController();
    const selectedKeys = new Set<string>();
    if (defaultTargetKey) selectedKeys.add(defaultTargetKey);
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

    const finish = (
      value: { targetKeys: string[]; comment: string } | null,
    ) => {
      controller.abort();
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

    modal.innerHTML = `
      <div class="modal-title">${app.escapeHtml(app.t("chat.forwardTitle"))}</div>
      <div class="forward-selected-summary">${app.escapeHtml(app.t("chat.multiSelectCount", { n: String(selectedCount) }))}</div>
      <div class="forward-selected-summary" id="forward-target-selected-summary"></div>
      <div class="form-group">
        <label>${app.escapeHtml(app.t("chat.forwardSearchPlaceholder"))}</label>
        <input class="input" type="text" placeholder="${app.escapeHtml(app.t("chat.forwardSearchPlaceholder"))}" disabled>
      </div>
      <div class="form-group">
        <label>${app.escapeHtml(app.t("chat.forwardTarget"))}</label>
        <div class="forward-conversation-list" id="forward-conversation-list"></div>
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
      lastError = (e as Error).message;
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
