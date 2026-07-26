import type { GroupMember } from '@yimsg/sdk';
import { CONTACT_FRIEND, GROUP_ROLE_OWNER } from '@yimsg/sdk';
import {
  displayGroupName,
  displayUserName,
} from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from '../../app-instance';
import { describeError } from '../../error-i18n';
import { BoundedStreamWindow } from '../../bounded-stream-window';
import { BoundedPageWindow } from '../../bounded-page-window';
import { panelActionBtn, SVG_REMARK, SVG_BELL, SVG_BELL_OFF, SVG_BAN, SVG_STAR, SVG_STAR_FILLED, SVG_PLUS } from '../panel-action-btn';
import { contactFriendUid } from '../contacts';

export async function showGroupDetail(app: AppInstance, groupId: string) {
  const requestId = ++app.chatState.detailRequestId;

  try {
    // 群资料变更不向全部成员主动广播；显式查看详情时绕过 TTL 强制后台刷新。
    // 方法同步返回当前缓存，服务端结果到达后由 display:updated 刷新本面板和其它可见视图。
    app.client.getGroupInfos([groupId], { forceRefresh: true });
    // 三个独立请求并行执行，比串行节省约 2 个 RTT
    const [firstMemberPage, favoritePage, muted] = await Promise.all([
      app.client.getGroupMembers(groupId, { limit: APP_CONFIG.list.pageSize }),
      app.client.getContacts({ status: CONTACT_FRIEND, groupId, limit: 1 }),
      app.views.sessionPreferences?.isMuted({ groupId }) ?? Promise.resolve(false),
    ]);
    if (app.chatState.detailRequestId !== requestId) return;

    // 群成员是有界滑动窗口（按整页裁剪）：游标用服务端返回的不透明 start / end_cursor，双向续翻。
    // 按 userId 跨页去重，避免成员重排（如角色变更）后同一成员跨页重复显示。
    const memberWindow = new BoundedPageWindow<GroupMember>(
      APP_CONFIG.list.maxPages,
      undefined,
      (member) => member.userId || '0',
    );
    memberWindow.setInitial({
      items: firstMemberPage.members,
      startCursor: firstMemberPage.page.startCursor,
      endCursor: firstMemberPage.page.endCursor,
      hasMoreBackward: firstMemberPage.page.hasMoreBackward,
      hasMoreForward: firstMemberPage.page.hasMoreForward,
    });
    let memberLoading = false;
    // 群成员总数来自服务端 page.total（窗口有界、按整页裁剪，渲染数 ≤ 上限，表头显示的是总数）。
    let memberTotal = firstMemberPage.total;

    app.client.getUserInfos(memberWindow.items.map((member) => member.userId || '0'));
    const favorited = favoritePage.contacts.length > 0;
    const info = app.client.getGroupInfos([groupId]).get(groupId) || { name: '', avatarUrl: '', remarkName: '' };

    const panel = app.$('detail-panel');
    const ownerMember = memberWindow.items.find((member) => member.role === GROUP_ROLE_OWNER);
    const isOwner = ownerMember ? (ownerMember.userId || '0') === app.client.getSessionSnapshot().currentUid : false;
    const groupAvatarHtml = app.avatarInnerHtml({ avatar: info.avatarUrl, nickname: info.name || 'G' });
    const groupName = displayGroupName(info, app.t('detail.group'));
    panel.innerHTML = `
      <div class="detail-header">
        <div class="avatar avatar-xl${isOwner ? ' avatar-clickable' : ''}" id="group-avatar-display"${isOwner ? ` title="${app.t('detail.clickToChangeAvatar')}"` : ''}>${groupAvatarHtml}</div>
        ${isOwner ? '<input type="file" id="group-avatar-picker" accept="image/jpeg,image/png,image/webp" class="hidden">' : ''}
        <div class="detail-name">${app.escapeHtml(groupName)}</div>
        ${info.remarkName ? `<div class="detail-subname">${app.escapeHtml(info.name || app.t('detail.group'))}</div>` : `<div class="detail-subname">${app.t('detail.group')}</div>`}
        <div class="panel-actions">
          ${panelActionBtn(SVG_REMARK, 'panel-action-gray', app.escapeHtml(app.t('detail.setRemark')), 'remark')}
          ${panelActionBtn(muted ? SVG_BELL_OFF : SVG_BELL, muted ? 'panel-action-mute-on' : 'panel-action-gray', app.escapeHtml(app.t('contacts.mute')), 'mute')}
          ${panelActionBtn(favorited ? SVG_STAR_FILLED : SVG_STAR, favorited ? 'panel-action-mute-on' : 'panel-action-gray', app.escapeHtml(favorited ? app.t('detail.unfavoriteGroup') : app.t('detail.favoriteGroup')), 'favorite')}
          ${panelActionBtn(SVG_PLUS, 'panel-action-gray', app.escapeHtml(app.t('detail.addMember')), 'add-member')}
        </div>
      </div>
      <div class="detail-section">
        <h4 id="members-title">${app.t('detail.memberCount', { n: memberTotal >= 0 ? memberTotal : memberWindow.count })}</h4>
        <div id="members-list"></div>
      </div>
    `;
    (panel.querySelector('[data-action="remark"]') as HTMLElement | null)?.setAttribute('id', 'detail-group-remark-btn');
    (panel.querySelector('[data-action="favorite"]') as HTMLElement | null)?.setAttribute('id', 'detail-group-favorite-btn');
    (panel.querySelector('[data-action="add-member"]') as HTMLElement | null)?.setAttribute('id', 'detail-group-addmember-btn');

    if (isOwner) {
      app.$('group-avatar-display').addEventListener('click', () => {
        (app.$('group-avatar-picker') as HTMLInputElement).click();
      });
      app.$('group-avatar-picker').addEventListener('change', async (e) => {
        const input = e.target as HTMLInputElement;
        if (!input.files?.[0]) return;
        const file = input.files[0];
        input.value = '';
        try {
          const data = await app.client.uploadFile(file, 'avatar');
          await app.client.updateGroupInfo(groupId, { name: info.name, avatarUrl: data.url });
          app.showToast(app.t('detail.groupAvatarUpdated'), 'success');
          await showGroupDetail(app, groupId);
        } catch (err) {
          app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
        }
      });
    }

    const membersList = app.$('members-list');
    const memberListView = new BoundedStreamWindow<GroupMember>({
      scrollElement: membersList,
    });
    const renderMemberWindow = () => {
      app.$('members-title').textContent = app.t('detail.memberCount', { n: memberTotal >= 0 ? memberTotal : memberWindow.count });
      const items = memberWindow.items;
      const displayMap = app.client.getUserInfos(items.map((member) => member.userId || '0'));
      memberListView.render({
        items,
        hasMoreBefore: memberWindow.hasMoreBefore,
        hasMoreAfter: memberWindow.hasMoreAfter,
        loadingBefore: memberLoading,
        loadingAfter: memberLoading,
        emptyText: app.t('detail.noMembers'),
        loadingText: app.t('common.loading'),
        bottomBoundaryText: app.t('detail.noMoreMembers'),
        loadBefore: () => { void loadMoreMembers({ mode: 'backward' }); },
        loadAfter: () => { void loadMoreMembers({ mode: 'forward' }); },
        keyOf: (member) => member.userId || '0',
        renderItem: (member) => {
          const uid = member.userId || '0';
          const user = displayMap.get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
          const name = displayUserName(user, uid);
          const avatarHtml = app.avatarInnerHtml({ avatar: user.avatarUrl, nickname: name });
          const div = app.dom.ownerDocument.createElement('div');
          div.className = 'member-item';
          div.dataset.uid = uid;
          // 群主可以把除自己以外的成员移出群聊；群主自己不显示移出按钮（需先转让群主 / 解散群，非本次范围）。
          const canRemove = isOwner && member.role !== GROUP_ROLE_OWNER;
          div.innerHTML = `
            <div class="avatar avatar-sm">${avatarHtml}</div>
            <span class="member-name">${app.escapeHtml(name)}</span>
            ${member.role === GROUP_ROLE_OWNER ? `<span class="member-badge">${app.t('detail.owner')}</span>` : ''}
            ${canRemove ? `<button class="member-remove-btn" data-uid="${app.escapeHtml(uid)}" title="${app.escapeHtml(app.t('detail.removeMember'))}">&minus;</button>` : ''}
          `;
          if (canRemove) {
            div.querySelector('.member-remove-btn')!.addEventListener('click', async (event) => {
              event.stopPropagation();
              const ok = await app.showConfirmModal({
                title: app.t('detail.removeMemberConfirmTitle'),
                desc: app.t('detail.removeMemberConfirmDesc', { name }),
                confirmText: app.t('detail.removeMember'),
                cancelText: app.t('group.cancel'),
                danger: true,
              });
              if (!ok) return;
              try {
                await app.client.removeGroupMember(groupId, uid);
                app.showToast(app.t('detail.memberRemoved'), 'success');
                await showGroupDetail(app, groupId);
              } catch (err) {
                app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
              }
            });
          }
          return [div];
        },
      });
    };
    async function loadMoreMembers(options: { mode: 'forward' | 'backward' }) {
      if (memberLoading) return;
      if (options.mode === 'forward' && !memberWindow.hasMoreAfter) return;
      if (options.mode === 'backward' && !memberWindow.hasMoreBefore) return;
      memberLoading = true;
      renderMemberWindow();
      try {
        const backward = options.mode === 'backward';
        const cursor = (backward ? memberWindow.backwardCursor : memberWindow.forwardCursor) || undefined;
        const page = await app.client.getGroupMembers(groupId, { cursor, backward, limit: APP_CONFIG.list.pageSize });
        if (app.chatState.detailRequestId !== requestId) return;
        const result = {
          items: page.members,
          startCursor: page.page.startCursor,
          endCursor: page.page.endCursor,
          hasMoreBackward: page.page.hasMoreBackward,
          hasMoreForward: page.page.hasMoreForward,
        };
        if (page.total >= 0) memberTotal = page.total;
        if (backward) memberWindow.prependBackward(result);
        else memberWindow.appendForward(result);
      } finally {
        memberLoading = false;
        renderMemberWindow();
      }
    }
    renderMemberWindow();

    panel.querySelector('[data-action="remark"]')!.addEventListener('click', async () => {
      const remark = await app.showTextInputModal({
        title: app.t('contacts.remarkTitle'),
        label: app.t('contacts.remark'),
        placeholder: app.t('contacts.remarkPlaceholder'),
        initialValue: info.remarkName || '',
        confirmText: app.t('settings.save'),
        cancelText: app.t('group.cancel'),
      });
      if (remark === null) return;
      try {
        if (!favorited) await app.client.favoriteGroup(groupId, remark || undefined);
        await app.client.updateRemark({ groupId }, remark);
        app.showToast(app.t('contacts.remarkUpdated'), 'success');
        await showGroupDetail(app, groupId);
      } catch (err) {
        app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
        await showGroupDetail(app, groupId);
      }
    });

    panel.querySelector('[data-action="favorite"]')!.addEventListener('click', async () => {
      try {
        if (favorited) {
          await app.client.unfavoriteGroup(groupId);
          app.showToast(app.t('contacts.groupUnfavorited'), 'success');
        } else {
          await app.client.favoriteGroup(groupId);
          app.showToast(app.t('contacts.groupFavorited'), 'success');
        }
        await showGroupDetail(app, groupId);
      } catch (err) {
        app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
        await showGroupDetail(app, groupId);
      }
    });

    panel.querySelector('[data-action="mute"]')!.addEventListener('click', async () => {
      try {
        if (muted) await app.client.unmuteConversation({ groupId });
        else await app.client.muteConversation({ groupId });
        await showGroupDetail(app, groupId);
      } catch (err) {
        app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
        await showGroupDetail(app, groupId);
      }
    });

    panel.querySelector('[data-action="add-member"]')!.addEventListener('click', async () => {
      await showAddMemberModal(app, groupId);
      if (app.chatState.detailRequestId === requestId) await showGroupDetail(app, groupId);
    });

    app.chatState.detailOpen = true;
    const rightPanel = app.$('right-panel');
    rightPanel.classList.remove('collapsed');
    app.$('view-chat').classList.add('mobile-showing-detail');
  } catch (_) {
    app.showToast(app.t('detail.failedToLoadGroupDetail'), 'error');
  }
}

/**
 * 添加群成员弹窗：一次性全量拉取"好友 - 已在群内的成员"作为候选（与群成员搜索器
 * §7.6 同样的低频操作、一次性全量拉取取舍），点击候选立即调用 addGroupMember 并从
 * 列表移除，不做批量勾选 + 确认二次交互，保持与需求一致的最小复杂度。
 */
async function showAddMemberModal(app: AppInstance, groupId: string): Promise<void> {
  return new Promise((resolve) => {
    const modal = app.$('modal-content');
    const controller = new AbortController();
    let entries: { uid: string; name: string }[] = [];
    let loaded = false;
    let loadFailed = false;

    modal.innerHTML = `
      <div class="modal-title">${app.escapeHtml(app.t('detail.addMember'))}</div>
      <div class="form-group">
        <input class="input" type="text" id="add-member-search" placeholder="${app.escapeHtml(app.t('detail.addMemberSearchPlaceholder'))}" disabled>
      </div>
      <div class="group-member-picker-list" id="add-member-list"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="add-member-done">${app.escapeHtml(app.t('detail.addMemberDone'))}</button>
      </div>
    `;
    app.$('modal-overlay').classList.remove('hidden');

    const searchInput = app.$('add-member-search') as HTMLInputElement;
    const listEl = app.$('add-member-list');

    const finish = () => {
      controller.abort();
      app.closeModal();
      resolve();
    };

    const appendEmptyRow = (text: string) => {
      const row = app.dom.ownerDocument.createElement('div');
      row.className = 'group-member-picker-empty';
      row.textContent = text;
      listEl.appendChild(row);
    };

    const renderList = () => {
      listEl.innerHTML = '';
      if (loadFailed) {
        appendEmptyRow(app.t('detail.addMemberLoadFailed'));
        return;
      }
      if (!loaded) {
        appendEmptyRow(app.t('common.loading'));
        return;
      }
      const query = searchInput.value.trim().toLowerCase();
      const filtered = query
        ? entries.filter((entry) => entry.name.toLowerCase().includes(query))
        : entries;
      if (filtered.length === 0) {
        appendEmptyRow(app.t(query ? 'detail.addMemberNoResults' : 'detail.addMemberEmpty'));
        return;
      }
      for (const entry of filtered) {
        const item = app.dom.ownerDocument.createElement('div');
        item.className = 'group-member-picker-item';
        item.dataset.uid = entry.uid;
        const avatarHtml = app.avatarInnerHtml({ nickname: entry.name });
        item.innerHTML = `<div class="avatar avatar-sm">${avatarHtml}</div><span>${app.escapeHtml(entry.name)}</span>`;
        item.addEventListener('click', () => { void addOne(entry.uid); }, { signal: controller.signal });
        listEl.appendChild(item);
      }
    };

    const addOne = async (uid: string) => {
      try {
        await app.client.addGroupMember(groupId, uid);
        entries = entries.filter((entry) => entry.uid !== uid);
        app.showToast(app.t('detail.memberAdded'), 'success');
        renderList();
      } catch (err) {
        app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
      }
    };

    const loadCandidates = async () => {
      // 全量拉取当前群成员 uid 用于排除，翻页安全上限与群成员搜索器一致（groupMemberPicker.maxPages）。
      const existingUids = new Set<string>();
      let memberCursor: string | undefined;
      for (let page = 0; page < APP_CONFIG.groupMemberPicker.maxPages; page++) {
        const result = await app.client.getGroupMembers(groupId, { cursor: memberCursor, limit: APP_CONFIG.list.pageSize });
        if (controller.signal.aborted) return;
        for (const member of result.members) existingUids.add(member.userId || '0');
        if (!result.page.hasMoreForward) break;
        memberCursor = result.page.endCursor;
      }

      const friendUids: string[] = [];
      let friendCursor: string | undefined;
      for (let page = 0; page < APP_CONFIG.groupMemberPicker.maxPages; page++) {
        const result = await app.client.getContacts({ status: CONTACT_FRIEND, cursor: friendCursor, limit: APP_CONFIG.list.pageSize });
        if (controller.signal.aborted) return;
        for (const contact of result.contacts) {
          const uid = contactFriendUid(contact);
          if (uid !== '0' && !existingUids.has(uid)) friendUids.push(uid);
        }
        if (!result.page.hasMoreForward) break;
        friendCursor = result.page.endCursor;
      }

      const batchMaxLimit = app.client.getClientConfig().batchMaxLimit;
      for (let i = 0; i < friendUids.length; i += batchMaxLimit) {
        app.client.getUserInfos(friendUids.slice(i, i + batchMaxLimit));
      }
      if (controller.signal.aborted) return;

      const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
      entries = friendUids
        .map((uid) => ({ uid, name: displayUserName(app.client.getUserInfos([uid]).get(uid), uid) }))
        .sort((a, b) => collator.compare(a.name, b.name));
      loaded = true;
      searchInput.disabled = false;
      renderList();
    };

    loadCandidates().catch(() => {
      if (controller.signal.aborted) return;
      loadFailed = true;
      renderList();
    });

    renderList();
    searchInput.addEventListener('input', () => renderList(), { signal: controller.signal });
    searchInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish();
    }, { signal: controller.signal });
    app.$('add-member-done').addEventListener('click', finish, { signal: controller.signal });
  });
}

export async function showUserDetail(app: AppInstance, uid: string) {
  const requestId = ++app.chatState.detailRequestId;
  try {
    const panel = app.$('detail-panel');

    // 立即用缓存数据打开面板；随后绕过缓存强制拉取，避免详情长期展示对方的旧昵称或旧头像。
    const renderContent = (profile: { nickname: string; avatarUrl: string; remarkName: string; username: string }, isBlocked: boolean, muted: boolean) => {
      const userName = displayUserName(profile, uid);
      panel.innerHTML = `
        <div class="detail-header">
          <div class="avatar avatar-xl">${app.avatarInnerHtml({ avatar: profile.avatarUrl, nickname: userName })}</div>
          <div class="detail-name">${app.escapeHtml(userName)}</div>
          ${profile.username ? `<div class="detail-username">@${app.escapeHtml(profile.username)}</div>` : ''}
          ${profile.remarkName ? `<div class="detail-subname">${app.escapeHtml(profile.nickname || uid)}</div>` : ''}
          <div class="detail-status-list">
            <span>${app.escapeHtml(app.t(muted ? 'detail.muteEnabled' : 'detail.muteDisabled'))}</span>
            <span>${app.escapeHtml(app.t(isBlocked ? 'detail.blockEnabled' : 'detail.blockDisabled'))}</span>
          </div>
          <div class="panel-actions">
            ${panelActionBtn(SVG_REMARK, 'panel-action-gray', app.escapeHtml(app.t('detail.setRemark')), 'remark')}
            ${panelActionBtn(muted ? SVG_BELL_OFF : SVG_BELL, muted ? 'panel-action-mute-on' : 'panel-action-gray', app.escapeHtml(app.t(muted ? 'detail.disableMute' : 'detail.enableMute')), 'mute')}
            ${panelActionBtn(SVG_BAN, isBlocked ? 'panel-action-block-on' : 'panel-action-gray', app.escapeHtml(app.t(isBlocked ? 'detail.unblockUser' : 'detail.blockUser')), 'block')}
          </div>
        </div>
      `;
      (panel.querySelector('[data-action="mute"]') as HTMLElement | null)?.setAttribute('id', 'detail-user-mutelist-btn');
      (panel.querySelector('[data-action="block"]') as HTMLElement | null)?.setAttribute('id', 'detail-user-block-btn');
      panel.querySelector('[data-action="remark"]')!.addEventListener('click', async () => {
        const remark = await app.showTextInputModal({
          title: app.t('contacts.remarkTitle'),
          label: app.t('contacts.remark'),
          placeholder: app.t('contacts.remarkPlaceholder'),
          initialValue: profile.remarkName || '',
          confirmText: app.t('settings.save'),
          cancelText: app.t('group.cancel'),
        });
        if (remark === null) return;
        try {
          await app.client.updateRemark({ toUid: uid }, remark);
          app.showToast(app.t('contacts.remarkUpdated'), 'success');
          await showUserDetail(app, uid);
        } catch (err) {
          app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
          await showUserDetail(app, uid);
        }
      });
      panel.querySelector('[data-action="mute"]')!.addEventListener('click', async () => {
        try {
          if (muted) await app.client.unmuteConversation({ toUid: uid });
          else await app.client.muteConversation({ toUid: uid });
          await showUserDetail(app, uid);
        } catch (err) {
          app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
          await showUserDetail(app, uid);
        }
      });
      panel.querySelector('[data-action="block"]')!.addEventListener('click', async () => {
        try {
          if (isBlocked) {
            await app.client.unblockUser(uid);
            app.showToast(app.t('detail.unblockUserDone'), 'success');
          } else {
            await app.client.blockUser(uid);
            app.showToast(app.t('detail.blockUserDone'), 'success');
          }
          await showUserDetail(app, uid);
        } catch (err) {
          app.showToast(app.t('detail.failed') + describeError(app, err), 'error');
        }
      });
    };

    // 第一次渲染：同步返回缓存，同时强制安排异步服务端刷新；按钮状态暂用默认值。
    const cachedProfile = app.client.getUserInfos([uid], { forceRefresh: true }).get(uid)
      || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    renderContent(cachedProfile, false, false);
    app.chatState.detailOpen = true;
    app.$('right-panel').classList.remove('collapsed');
    app.$('view-chat').classList.add('mobile-showing-detail');

    // muted/blocked 与资料后台刷新并行；资料到达后由 display:updated 刷新面板和其它可见视图。
    const [isBlocked, muted] = await Promise.all([
      app.views.sessionPreferences?.isUserBlocked(uid) ?? Promise.resolve(false),
      app.views.sessionPreferences?.isMuted({ toUid: uid }) ?? Promise.resolve(false),
    ]);
    if (app.chatState.detailRequestId !== requestId) return;

    // 第二次渲染：重读当前缓存并补齐正确的按钮状态；后台资料稍后到达仍会继续刷新。
    const freshProfile = app.client.getUserInfos([uid]).get(uid)
      || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    renderContent(freshProfile, isBlocked, muted);
  } catch (_) {
    app.showToast(app.t('detail.failedToLoadProfile'), 'error');
  }
}

export function refreshDetailPanel(app: AppInstance) {
  if (!app.chatState.detailOpen) return;
  const panel = app.$('detail-panel');

  const memberItems = panel.querySelectorAll('.member-item');
  const memberIds: string[] = [];
  for (const item of memberItems) {
    const uid = (item as HTMLElement).dataset.uid;
    if (uid) memberIds.push(uid);
  }
  const memberMap = app.client.getUserInfos(memberIds);

  for (const item of memberItems) {
    const uid = (item as HTMLElement).dataset.uid;
    const nameSpan = item.querySelector('.member-name') as HTMLElement | null;
    const avatarDiv = item.querySelector('.avatar') as HTMLElement | null;
    if (!uid || !nameSpan || !avatarDiv) continue;

    const user = memberMap.get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    const name = displayUserName(user, uid);
    nameSpan.textContent = name;
    avatarDiv.innerHTML = app.avatarInnerHtml({ avatar: user.avatarUrl, nickname: name });
  }

  const headerTitle = panel.querySelector('.detail-name') as HTMLElement | null;
  const headerAvatar = panel.querySelector('.detail-header .avatar') as HTMLElement | null;
  if (!headerTitle || !headerAvatar || !app.chatState.currentConvKey) return;

  const conversation = app.client.describeConversation(app.chatState.currentConvKey);
  if (conversation.kind === 'group') {
    const group = app.client.getGroupInfos([conversation.id]).get(conversation.id) || { name: '', avatarUrl: '', remarkName: '' };
    headerTitle.textContent = displayGroupName(group, app.t('detail.group'));
    headerAvatar.innerHTML = app.avatarInnerHtml({ avatar: group.avatarUrl, nickname: group.name || 'G' });
    return;
  }

  const user = app.client.getUserInfos([conversation.id]).get(conversation.id) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
  if (!user.nickname && !user.remarkName && !user.username) return;
  headerTitle.textContent = displayUserName(user, conversation.id);
  headerAvatar.innerHTML = app.avatarInnerHtml({ avatar: user.avatarUrl, nickname: displayUserName(user, conversation.id) });
}

export function rerenderCurrentDetailPanel(app: AppInstance) {
  if (!app.chatState.detailOpen || !app.chatState.currentConvKey) return;
  const conversation = app.client.describeConversation(app.chatState.currentConvKey);
  if (conversation.kind === 'group') {
    void showGroupDetail(app, conversation.id);
    return;
  }
  void showUserDetail(app, conversation.id);
}
