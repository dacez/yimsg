import { CONTACT_FRIEND, CONTACT_PENDING_INCOMING, CONTACT_PENDING_OUTGOING } from '@yimsg/sdk';
import { ORG_CHILD_PERSON, ORG_CHILD_TAG } from '@yimsg/sdk/uikit-internal';
import { APP_CONFIG } from '../../app-config';
import { describeError } from '../error-i18n';
import type { Contact, ContactPage, LocalConversation } from '@yimsg/sdk';
import { displayGroupName, displayUserName } from '@yimsg/sdk';
import type { AppInstance } from '../app-instance';
import { createBoundedList, serverPageSource, standaloneList, type BoundedList, type PageLoadResult, type RenderItemContext } from '../bounded-list';
import { contactIdentity } from '../list-identity';
import { panelActionBtn, SVG_CHAT, SVG_REMARK, SVG_BELL, SVG_BELL_OFF, SVG_BAN, SVG_TRASH } from './panel-action-btn';
import { openOrgAdmin } from './org-admin';

const FRIEND_PAGE_SIZE = APP_CONFIG.list.pageSize;
const REQUEST_PAGE_SIZE = APP_CONFIG.list.pageSize;
const MEMBER_SELECT_MAX_SELECTED = APP_CONFIG.memberPicker.maxSelected;
const CONTACTS_LEFT_MIN_WIDTH = 220;
const CONTACTS_LEFT_MAX_WIDTH = 520;
const CONTACTS_DETAIL_MIN_WIDTH = 320;
const CONTACTS_RESIZER_WIDTH = 8;

export function contactFriendUid(contact: Contact): string {
  return 'toUid' in contact.target ? String(contact.target.toUid) : '0';
}

export function contactGroupId(contact: Contact): string {
  return 'groupId' in contact.target ? String(contact.target.groupId) : '0';
}

function contactOrgId(contact: Contact): string {
  return 'orgId' in contact.target ? String(contact.target.orgId) : '0';
}

// 渲染锚点键与跨页去重身份键共用同一稳定身份（friendUid:groupId:orgId），保证两者口径一致。
const contactKey = contactIdentity;

function contactPageLoad(page: ContactPage, items?: ReadonlyArray<Contact>): PageLoadResult<Contact> {
  return {
    items: items ?? page.contacts,
    startCursor: page.page.startCursor,
    endCursor: page.page.endCursor,
    hasMoreHead: page.page.hasMoreBackward,
    hasMoreTail: page.page.hasMoreForward,
    total: page.page.total,
  };
}

/** BoundedList 的 identityOf 用 `uid:gid:oid` 三段身份；批量定向刷新按段拆分成三个数组一次性请求。 */
function fetchContactsByIdentity(app: AppInstance, ids: readonly string[]): Promise<readonly Contact[]> {
  const friendUids: string[] = [];
  const groupIds: string[] = [];
  const orgIds: string[] = [];
  for (const id of ids) {
    const [uid, gid, oid] = id.split(':');
    if (uid && uid !== '0') friendUids.push(uid);
    if (gid && gid !== '0') groupIds.push(gid);
    if (oid && oid !== '0') orgIds.push(oid);
  }
  if (friendUids.length === 0 && groupIds.length === 0 && orgIds.length === 0) return Promise.resolve([]);
  return app.client.getContacts({ friendUids, groupIds, orgIds }).then((page) => page.contacts);
}

export function createContactsView(app: AppInstance) {
  const state = app.contactsState;
  // 好友列表关键字过滤：非空时改走 search_contacts，与 get_contacts 共用同一个
  // BoundedList 实例与游标机制（source 内部按 query.keyword 分支）。
  let friendKeyword = '';
  // 当前右侧详情面板展示的联系人 key。
  let selectedContactKey: string | null = null;
  // 组织架构浏览器状态：当前组织与面包屑展开栈（tagId 序列，根即 orgId；
  // 面包屑即导航栈，不反推 DAG 路径）。展示名走 getOrgInfos/getTagInfos 缓存，实时查，不额外存储。
  let orgPanelOrgId: string | null = null;
  let orgPanelStack: string[] = [];
  // 防止快速切换联系人时旧请求覆盖新渲染。
  let detailRequestId = 0;

  function isFriendsTabActive(): boolean {
    return !app.$('friends-tab').classList.contains('hidden');
  }

  function isRequestsTabActive(): boolean {
    return !app.$('requests-tab').classList.contains('hidden');
  }

  function renderContactRow(f: Contact, ctx: RenderItemContext<Contact>): HTMLElement[] {
    const uid = contactFriendUid(f);
    const gid = contactGroupId(f);
    const oid = contactOrgId(f);
    const isGroup = gid !== '0';
    void ctx;
    if (oid !== '0') {
      // 组织条目：名称来自组织资料缓存（惰性拉取），点开进入组织架构浏览器。
      const orgName = f.remarkName || app.client.getOrgInfos([oid]).get(oid)?.name || app.t('contacts.orgLoading');
      const key = contactKey(f);
      const div = app.dom.ownerDocument.createElement('div');
      div.className = 'contact-item' + (selectedContactKey === key ? ' contact-selected' : '');
      div.innerHTML = `
        <div class="avatar">${app.escapeHtml(orgName[0] || '?')}</div>
        <div class="contact-info">
          <div class="contact-name contact-name-with-badge" title="${app.escapeHtml(orgName)}"><span class="contact-name-text">${app.escapeHtml(orgName)}</span><span class="contact-org-badge">${app.escapeHtml(app.t('contacts.orgBadge'))}</span></div>
        </div>
      `;
      return [div];
    }
    const cachedUserDisplay = app.client.getUserInfos([uid]).get(uid);
    const cachedGroupDisplay = app.client.getGroupInfos([gid]).get(gid);
    const userDisplay = {
      nickname: cachedUserDisplay?.nickname || '',
      avatarUrl: cachedUserDisplay?.avatarUrl || '',
      remarkName: cachedUserDisplay?.remarkName || f.remarkName || '',
      username: cachedUserDisplay?.username || '',
    };
    const groupDisplay = {
      name: cachedGroupDisplay?.name || '',
      avatarUrl: cachedGroupDisplay?.avatarUrl || '',
      remarkName: cachedGroupDisplay?.remarkName || f.remarkName || '',
    };
    const name = isGroup ? displayGroupName(groupDisplay, gid) : displayUserName(userDisplay, uid);
    const key = contactKey(f);
    const div = app.dom.ownerDocument.createElement('div');
    div.className = 'contact-item' + (selectedContactKey === key ? ' contact-selected' : '');
    div.innerHTML = `
      <div class="avatar">${app.escapeHtml(name[0] || '?')}</div>
      <div class="contact-info">
        <div class="contact-name">${app.escapeHtml(name)}</div>
      </div>
    `;
    return [div];
  }

  function getFriendList(): BoundedList<Contact, { keyword: string }> {
    if (state.friendList) return state.friendList;
    const list = createBoundedList<Contact, { keyword: string }>({
      id: 'contacts.friends',
      scrollElement: app.$('friends-tab'),
      pageSize: FRIEND_PAGE_SIZE,
      maxPages: APP_CONFIG.list.maxPages,
      register: (controller) => app.registerBoundedList(controller),
      isActive: isFriendsTabActive,
      initialQuery: { keyword: '' },
      source: serverPageSource(
        ({ cursor, backward, limit, query }) => query.keyword
          ? app.client.searchContacts({ keyword: query.keyword, status: CONTACT_FRIEND, cursor, backward, limit })
          : app.client.getContacts({ status: CONTACT_FRIEND, cursor, backward, limit }),
        (page) => contactPageLoad(page),
      ),
      fetchByIdentity: (ids) => fetchContactsByIdentity(app, ids),
      identityOf: contactKey,
      order: 'desc',
      renderItem: (contact, ctx) => renderContactRow(contact, ctx),
      onActivate: (contact) => { void showContactDetail(contact); },
      text: {
        empty: () => app.t('contacts.noFriends'),
        emptyFiltered: () => app.t('contacts.noSearchResults'),
        loading: () => app.t('common.loading'),
        tailBoundary: () => app.t('contacts.noMoreContacts'),
        updatePill: () => app.t('contacts.listUpdated'),
        retry: () => app.t('common.retry'),
      },
      onError: (error) => console.warn('[yimsg/uikit] friends list failed:', error),
    });
    state.friendList = list;
    app.registerDisposer(() => list.dispose());
    void list.reset();
    return list;
  }

  function renderRequestRow(r: Contact): HTMLElement[] {
    const uid = contactFriendUid(r);
    const ud = app.client.getUserInfos([uid]).get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    const name = displayUserName(ud, uid);
    const div = app.dom.ownerDocument.createElement('div');
    div.className = 'request-item';
    div.innerHTML = `
      <div class="avatar avatar-md">${app.escapeHtml(name[0] || '?')}</div>
      <div class="request-info"><div class="request-name">${app.escapeHtml(name)}</div></div>
      <div class="request-actions">
        <button class="btn btn-sm btn-primary" data-action="accept">${app.t('contacts.accept')}</button>
        <button class="btn btn-sm btn-danger" data-action="reject">${app.t('contacts.reject')}</button>
      </div>
    `;
    div.querySelector('[data-action="accept"]')!.addEventListener('click', (event) => {
      event.stopPropagation();
      void acceptFriend(uid);
    });
    div.querySelector('[data-action="reject"]')!.addEventListener('click', (event) => {
      event.stopPropagation();
      void rejectFriend(uid);
    });
    return [div];
  }

  function getRequestList(): BoundedList<Contact> {
    if (state.requestList) return state.requestList;
    const list = createBoundedList<Contact>({
      id: 'contacts.requests',
      scrollElement: app.$('requests-incoming'),
      pageSize: REQUEST_PAGE_SIZE,
      maxPages: APP_CONFIG.list.maxPages,
      register: (controller) => app.registerBoundedList(controller),
      isActive: isRequestsTabActive,
      source: serverPageSource(
        ({ cursor, backward, limit }) => app.client.getContacts({ status: CONTACT_PENDING_INCOMING, cursor, backward, limit }),
        (page) => contactPageLoad(page),
      ),
      fetchByIdentity: (ids) => fetchContactsByIdentity(app, ids),
      identityOf: contactKey,
      order: 'desc',
      renderItem: (contact) => renderRequestRow(contact),
      text: {
        empty: () => app.t('contacts.noPendingRequests'),
        loading: () => app.t('common.loading'),
        tailBoundary: () => app.t('contacts.noMoreRequests'),
        updatePill: () => app.t('contacts.listUpdated'),
        retry: () => app.t('common.retry'),
      },
      onLoadStateChange: (s) => updateContactBadges(s.total >= 0 ? s.total : s.count),
      onError: (error) => console.warn('[yimsg/uikit] request list failed:', error),
    });
    state.requestList = list;
    app.registerDisposer(() => list.dispose());
    void list.reset();
    return list;
  }

  function renderOutgoingRow(r: Contact): HTMLElement[] {
    const uid = contactFriendUid(r);
    const ud = app.client.getUserInfos([uid]).get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    const name = displayUserName(ud, uid);
    const div = app.dom.ownerDocument.createElement('div');
    div.className = 'request-item request-outgoing';
    div.innerHTML = `
      <div class="avatar avatar-md">${app.escapeHtml(name[0] || '?')}</div>
      <div class="request-info"><div class="request-name">${app.escapeHtml(name)}</div></div>
      <div class="request-status">${app.escapeHtml(app.t('contacts.waitingVerification'))}</div>
    `;
    return [div];
  }

  // 我发出的待处理请求：仅信息展示（"等待验证"），不带接受/拒绝按钮，不参与选中。
  // 展示但不可操作是为了避免申请方误以为能对自己发出的请求做处理——接收方才能接受/拒绝。
  function getOutgoingRequestList(): BoundedList<Contact> {
    if (state.outgoingRequestList) return state.outgoingRequestList;
    const list = createBoundedList<Contact>({
      id: 'contacts.outgoingRequests',
      scrollElement: app.$('requests-outgoing'),
      pillHost: false,
      pageSize: REQUEST_PAGE_SIZE,
      maxPages: APP_CONFIG.list.maxPages,
      register: (controller) => app.registerBoundedList(controller),
      isActive: isRequestsTabActive,
      source: serverPageSource(
        ({ cursor, backward, limit }) => app.client.getContacts({ status: CONTACT_PENDING_OUTGOING, cursor, backward, limit }),
        (page) => contactPageLoad(page),
      ),
      identityOf: contactKey,
      order: 'desc',
      renderItem: (contact) => renderOutgoingRow(contact),
      text: {
        loading: () => app.t('common.loading'),
        retry: () => app.t('common.retry'),
      },
      onLoadStateChange: (s) => {
        const title = app.dom.getElementById('requests-outgoing-title');
        if (!title) return;
        title.textContent = app.t('contacts.pendingOutgoing');
        title.classList.toggle('hidden', s.count === 0);
      },
      onError: (error) => console.warn('[yimsg/uikit] outgoing requests failed:', error),
    });
    state.outgoingRequestList = list;
    app.registerDisposer(() => list.dispose());
    void list.reset();
    return list;
  }

  // 关键字变化：更新查询条件并重拉首页（组件内置 300ms 防抖）。
  function applyFriendKeywordChange(rawKeyword: string): void {
    const keyword = rawKeyword.trim();
    if (keyword === friendKeyword) return;
    friendKeyword = keyword;
    getFriendList().setQuery({ keyword });
  }

  // 请求 tab 的「待我处理」与「我发出的」两个列表一起重拉首页。
  async function loadRequests(): Promise<void> {
    await Promise.all([getRequestList().reset(), getOutgoingRequestList().reset()]);
  }

  async function loadContacts(options: { background?: boolean } = {}): Promise<void> {
    if (options.background) {
      // 背景刷新：贴顶直接追平，否则只点亮各自的「有更新」提示条，不打断浏览。
      getRequestList().invalidate();
      getOutgoingRequestList().invalidate();
      if (isFriendsTabActive()) getFriendList().invalidate();
      return;
    }
    if (state.contactsLoading) return;
    state.contactsLoading = true;
    try {
      await loadRequests();
      if (isFriendsTabActive()) await getFriendList().reset();
    } finally {
      state.contactsLoading = false;
    }
  }

  function refreshContactsDisplay(): void {
    getFriendList().render();
    getRequestList().render();
    getOutgoingRequestList().render();
    if (orgPanelOrgId) void renderOrgPanel();
  }

  function clampContactsLeftWidth(rawWidth: number): number {
    const viewWidth = app.$('view-contacts').getBoundingClientRect().width || 0;
    const maxByView = viewWidth - CONTACTS_DETAIL_MIN_WIDTH - CONTACTS_RESIZER_WIDTH;
    const maxWidth = Math.max(CONTACTS_LEFT_MIN_WIDTH, Math.min(CONTACTS_LEFT_MAX_WIDTH, maxByView));
    return Math.round(Math.min(maxWidth, Math.max(CONTACTS_LEFT_MIN_WIDTH, rawWidth)));
  }

  function setupContactsResizer(): void {
    const left = app.dom.querySelector<HTMLElement>('.contacts-left');
    const handle = app.dom.getElementById<HTMLElement>('contacts-resizer');
    if (!left || !handle) return;

    const doc = app.dom.ownerDocument;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const setWidth = (width: number) => {
      left.style.width = `${clampContactsLeftWidth(width)}px`;
    };
    const finishDrag = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      app.dom.layoutHost.classList.remove('contacts-resizing');
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || app.dom.layoutHost.dataset.layout === 'mobile') return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = left.getBoundingClientRect().width;
      handle.classList.add('dragging');
      app.dom.layoutHost.classList.add('contacts-resizing');
      handle.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      event.preventDefault();
      setWidth(startWidth + event.clientX - startX);
    };
    const onDoubleClick = () => {
      left.style.width = '';
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('dblclick', onDoubleClick);
    doc.addEventListener('pointermove', onPointerMove);
    doc.addEventListener('pointerup', finishDrag);
    doc.addEventListener('pointercancel', finishDrag);
    app.registerDisposer(() => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('dblclick', onDoubleClick);
      doc.removeEventListener('pointermove', onPointerMove);
      doc.removeEventListener('pointerup', finishDrag);
      doc.removeEventListener('pointercancel', finishDrag);
    });
  }

  async function searchUser() {
    const input = app.$('search-username') as HTMLInputElement;
    const username = input.value.trim();
    if (!username) return;

    try {
      const p = await app.client.searchUser(username);
      const container = app.$('search-results');
      if (!p) {
        container.innerHTML = `<div class="empty-state">${app.t('contacts.userNotFound')}</div>`;
        return;
      }
      container.innerHTML = `
        <div class="search-result">
          <div class="avatar avatar-md">${app.escapeHtml((p.nickname || '?')[0])}</div>
          <div class="search-result-info">
            <div style="font-weight:500">${app.escapeHtml(p.nickname)}</div>
            <div style="font-size:12px;color:var(--text-secondary)">@${app.escapeHtml(p.username)}</div>
          </div>
          <button class="btn btn-sm btn-primary" id="add-friend-btn">${app.t('contacts.add')}</button>
        </div>
      `;
      app.$('add-friend-btn').addEventListener('click', () => void addFriend(String(p.uid)));
    } catch (e) {
      app.showToast(app.t('contacts.searchFailed') + describeError(app, e), 'error');
    }
  }

  async function addFriend(friendUid: string) {
    try {
      const remark = await app.showTextInputModal({
        title: app.t('contacts.addWithRemark'),
        label: app.t('contacts.remark'),
        placeholder: app.t('contacts.remarkPlaceholder'),
        initialValue: '',
        confirmText: app.t('contacts.add'),
        cancelText: app.t('group.cancel'),
      });
      if (remark === null) return;
      await app.client.addFriend(friendUid, remark || undefined);
      app.showToast(app.t('contacts.friendRequestSent'), 'success');
    } catch (e) {
      app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
    }
  }

  async function acceptFriend(friendUid: string) {
    try {
      await app.client.acceptFriend(friendUid);
      app.showToast(app.t('contacts.friendAdded'), 'success');
      await getRequestList().reset();
    } catch (e) {
      app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
    }
  }

  async function rejectFriend(friendUid: string) {
    try {
      await app.client.rejectFriend(friendUid);
      app.showToast(app.t('contacts.requestRejected'), 'success');
      await getRequestList().reset();
    } catch (e) {
      app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
    }
  }

  function updateContactBadges(pendingCount: number) {
    // 只用红点表达「有待处理请求」，不再展示精确数字；请求 tab 标题恒为「请求」。
    // pendingCount 必须只统计 PENDING_INCOMING（待我处理），不能包含自己发出的 PENDING_OUTGOING，
    // 否则用户发起请求后红点会被自己点亮，语义就错了。
    app.setNavBadge('.nav-item[data-view="contacts"]', pendingCount > 0);
    // 先重置文案再挂红点：textContent 赋值会清空子节点，必须在 setNavBadge 之前做。
    const reqTab = app.dom.querySelector('[data-ctab="requests"]');
    if (reqTab) reqTab.textContent = app.t('contacts.requests');
    app.setNavBadge('[data-ctab="requests"]', pendingCount > 0);
  }

  async function deleteFriend(friendUid: string) {
    try {
      await app.client.deleteFriend(friendUid);
      app.showToast(app.t('contacts.friendDeleted'), 'success');
      showContactDetail(null);
    } catch (e) {
      app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
    }
  }

  async function unfavoriteGroup(groupId: string) {
    try {
      await app.client.unfavoriteGroup(groupId);
      app.showToast(app.t('contacts.groupUnfavorited'), 'success');
      showContactDetail(null);
      await loadContacts();
    } catch (e) {
      app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
    }
  }

  async function editContactRemark(contact: Contact) {
    const groupId = contactGroupId(contact);
    const friendUid = contactFriendUid(contact);
    const isGroup = groupId !== '0';
    const userDisplay = !isGroup ? app.client.getUserInfos([friendUid]).get(friendUid) : null;
    const groupDisplay = isGroup ? app.client.getGroupInfos([groupId]).get(groupId) : null;
    const currentRemark = isGroup
      ? (groupDisplay?.remarkName || '')
      : (userDisplay?.remarkName || '');
    const remark = await app.showTextInputModal({
      title: app.t('contacts.remarkTitle'),
      label: app.t('contacts.remark'),
      placeholder: app.t('contacts.remarkPlaceholder'),
      initialValue: currentRemark,
      confirmText: app.t('settings.save'),
      cancelText: app.t('group.cancel'),
    });
    if (remark === null) return;
    try {
      if (isGroup) await app.client.updateRemark({ groupId }, remark);
      else await app.client.updateRemark({ toUid: friendUid }, remark);
      app.showToast(app.t('contacts.remarkUpdated'), 'success');
      await getFriendList().reset();
      app.views.chat?.renderConversationList();
    } catch (e) {
      app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
    }
  }

  /** 组织架构浏览器：面包屑 + 当前层子项（子 tag 与人按服务端绝对排序混合）。 */
  async function renderOrgPanel(): Promise<void> {
    const orgId = orgPanelOrgId;
    if (!orgId) return;
    const reqId = ++detailRequestId;
    const panel = app.$('contacts-detail-panel');
    if (!panel) return;
    const currentTagId = orgPanelStack[orgPanelStack.length - 1];
    let tags: Awaited<ReturnType<typeof app.client.getTags>>['tags'];
    try {
      const page = await app.client.getTags({ orgId, tagId: currentTagId, limit: 200 });
      tags = page.tags;
    } catch (e) {
      app.showToast(app.t('contacts.orgLoadFailed') + describeError(app, e), 'error');
      return;
    }
    if (reqId !== detailRequestId || orgPanelOrgId !== orgId) return;

    // 人员昵称/头像走既有 uidCache；子 tag 名走 tag 展示资料缓存，组织根名走组织展示资料缓存。
    // 面包屑上的祖先 tag（orgPanelStack 里非 orgId 的部分）不在当前层子项里，需要一并批量取，
    // 否则面包屑首次经过某一层时会一直显示 tagId 而不是名字。
    const memberUids = tags.filter(i => i.childType === ORG_CHILD_PERSON).map(i => i.childId);
    const childTagIds = tags.filter(i => i.childType === ORG_CHILD_TAG).map(i => i.childId);
    const ancestorTagIds = orgPanelStack.filter(id => id !== orgId);
    const userDisplayMap = app.client.getUserInfos(memberUids);
    const tagDisplayMap = app.client.getTagInfos(orgId, [...new Set([...childTagIds, ...ancestorTagIds])]);
    const orgDisplayMap = app.client.getOrgInfos([orgId]);

    const crumbNameOf = (tagId: string): string => tagId === orgId
      ? (orgDisplayMap.get(tagId)?.name || app.t('contacts.orgLoading'))
      : (tagDisplayMap.get(tagId)?.name || tagId);

    const crumbsHtml = orgPanelStack
      .map((tagId, i) => `<button class="org-crumb${i === orgPanelStack.length - 1 ? ' org-crumb-current' : ''}" data-crumb="${i}">${app.escapeHtml(crumbNameOf(tagId))}</button>`)
      .join('<span class="org-crumb-sep">/</span>');
    const rowsHtml = tags.map((item, idx) => {
      if (item.childType === ORG_CHILD_TAG) {
        const name = tagDisplayMap.get(item.childId)?.name || '';
        return `
          <div class="contact-item org-tag-row" data-idx="${idx}">
            <div class="avatar">${app.escapeHtml((name || '?')[0] || '?')}</div>
            <div class="contact-info"><div class="contact-name">${app.escapeHtml(name || item.childId)}</div></div>
            <span class="org-row-arrow">›</span>
          </div>`;
      }
      const ud = userDisplayMap.get(item.childId);
      const displayName = ud?.remarkName || ud?.nickname || '';
      const memberName = displayName || app.t('common.loading');
      const titleHtml = item.title ? `<span class="org-member-title">${app.escapeHtml(item.title)}</span>` : '';
      return `
        <div class="contact-item org-member-row" data-idx="${idx}">
          <div class="avatar">${app.escapeHtml(displayName[0] || '?')}</div>
          <div class="contact-info"><div class="contact-name">${app.escapeHtml(memberName)} ${titleHtml}</div></div>
        </div>`;
    }).join('');

    panel.innerHTML = `
      <button class="contacts-detail-back" id="contacts-detail-back">← ${app.escapeHtml(app.t('contacts.friends'))}</button>
      <div class="org-panel">
        <div class="org-crumbs">
          ${crumbsHtml}
          <button class="btn btn-sm btn-secondary org-manage-btn" id="contacts-org-manage">${app.escapeHtml(app.t('orgAdmin.manageBtn'))}</button>
        </div>
        <div class="org-items">${rowsHtml || `<div class="contacts-detail-empty">${app.escapeHtml(app.t('contacts.orgEmpty'))}</div>`}</div>
      </div>
    `;
    app.$('contacts-org-manage')?.addEventListener('click', () => {
      void openOrgAdmin(app, orgId, currentTagId);
    });
    app.$('contacts-detail-back')?.addEventListener('click', () => {
      orgPanelOrgId = null;
      orgPanelStack = [];
      void showContactDetail(null);
    });
    panel.querySelectorAll('[data-crumb]').forEach(el => {
      el.addEventListener('click', () => {
        const idx = Number((el as HTMLElement).dataset.crumb);
        if (idx < orgPanelStack.length - 1) {
          orgPanelStack = orgPanelStack.slice(0, idx + 1);
          void renderOrgPanel();
        }
      });
    });
    panel.querySelectorAll('.org-tag-row').forEach(el => {
      el.addEventListener('click', () => {
        const item = tags[Number((el as HTMLElement).dataset.idx)];
        orgPanelStack = [...orgPanelStack, item.childId];
        void renderOrgPanel();
      });
    });
    panel.querySelectorAll('.org-member-row').forEach(el => {
      el.addEventListener('click', () => {
        const item = tags[Number((el as HTMLElement).dataset.idx)];
        // 人条目点开进入既有单聊入口（与好友详情"聊天"按钮同路径）。
        app.views.chat?.switchView('chat');
        const conv: LocalConversation = { groupId: '0', friendUid: item.childId, lastSeq: 0, lastMessage: null };
        void app.views.chat?.openConversation(conv);
      });
    });
  }

  /** 打开组织条目：初始化面包屑为组织根（tagId=orgId）并渲染架构浏览器。 */
  async function showOrgDetail(contact: Contact): Promise<void> {
    const orgId = contactOrgId(contact);
    selectedContactKey = contactKey(contact);
    app.$('view-contacts')?.classList.add('mobile-showing-detail');
    getFriendList().render();
    orgPanelOrgId = orgId;
    orgPanelStack = [orgId];
    await renderOrgPanel();
  }

  /** 组织架构变更（org:updated）：刷新打开中的组织面板。 */
  function refreshOrgPanel(orgIds: ReadonlyArray<string>): void {
    if (orgPanelOrgId && orgIds.includes(orgPanelOrgId)) void renderOrgPanel();
  }

  async function showContactDetail(contact: Contact | null): Promise<void> {
    const reqId = ++detailRequestId;
    const panel = app.$('contacts-detail-panel');
    const viewContacts = app.$('view-contacts');
    if (!panel || !viewContacts) return;

    if (!contact) {
      selectedContactKey = null;
      viewContacts.classList.remove('mobile-showing-detail');
      panel.innerHTML = `<div class="contacts-detail-empty">${app.escapeHtml(app.t('contacts.selectContact'))}</div>`;
      getFriendList().render();
      return;
    }

    if (contactOrgId(contact) !== '0') {
      return showOrgDetail(contact);
    }
    orgPanelOrgId = null;
    orgPanelStack = [];

    selectedContactKey = contactKey(contact);
    viewContacts.classList.add('mobile-showing-detail');
    getFriendList().render();

    const uid = contactFriendUid(contact);
    const gid = contactGroupId(contact);
    const isGroup = gid !== '0';

    const [isMuted, isBlocked] = await Promise.all([
      app.views.sessionPreferences?.isMuted(isGroup ? { groupId: gid } : { toUid: uid }) ?? Promise.resolve(false),
      !isGroup
        ? (app.views.sessionPreferences?.isUserBlocked(uid) ?? Promise.resolve(false))
        : Promise.resolve(false),
    ]);
    if (reqId !== detailRequestId) return;

    const cachedUserInfo = !isGroup ? (app.client.getUserInfos([uid]).get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' }) : null;
    const cachedGroupInfo = isGroup ? (app.client.getGroupInfos([gid]).get(gid) || { name: '', avatarUrl: '', remarkName: '' }) : null;

    const userDisplay = {
      nickname: cachedUserInfo?.nickname || '',
      remarkName: cachedUserInfo?.remarkName || contact.remarkName || '',
      username: cachedUserInfo?.username || '',
    };
    const groupDisplay = {
      name: cachedGroupInfo?.name || '',
      remarkName: cachedGroupInfo?.remarkName || contact.remarkName || '',
    };

    const name = isGroup ? displayGroupName(groupDisplay, gid) : displayUserName(userDisplay, uid);
    let subName = '';
    if (isGroup && (contact.remarkName || cachedGroupInfo?.remarkName) && cachedGroupInfo?.name) {
      subName = cachedGroupInfo.name;
    } else if (!isGroup && (contact.remarkName || cachedUserInfo?.remarkName) && cachedUserInfo?.nickname) {
      subName = cachedUserInfo.nickname;
    }

    const usernameHtml = !isGroup && userDisplay.username
      ? `<div class="detail-username">@${app.escapeHtml(userDisplay.username)}</div>`
      : '';
    const subNameHtml = subName
      ? `<div class="detail-subname">${app.escapeHtml(subName)}</div>`
      : '';
    const deleteLabel = isGroup ? app.t('contacts.unfavorite') : app.t('contacts.delete');

    panel.innerHTML = `
      <button class="contacts-detail-back" id="contacts-detail-back">← ${app.escapeHtml(app.t('contacts.friends'))}</button>
      <div class="contacts-detail-body">
        <div class="avatar avatar-xl">${app.escapeHtml(name[0] || '?')}</div>
        <div class="detail-name">${app.escapeHtml(name)}</div>
        ${usernameHtml}
        ${subNameHtml}
        <div class="panel-actions">
          ${panelActionBtn(SVG_CHAT, 'panel-action-primary', app.escapeHtml(app.t('contacts.chat')), 'chat')}
          ${panelActionBtn(SVG_REMARK, 'panel-action-gray', app.escapeHtml(app.t('contacts.remark')), 'remark')}
          ${panelActionBtn(isMuted ? SVG_BELL_OFF : SVG_BELL, isMuted ? 'panel-action-mute-on' : 'panel-action-gray', app.escapeHtml(app.t('contacts.mute')), 'mute')}
          ${!isGroup ? panelActionBtn(SVG_BAN, isBlocked ? 'panel-action-block-on' : 'panel-action-gray', app.escapeHtml(app.t('contacts.blocklist')), 'block') : ''}
          ${panelActionBtn(SVG_TRASH, 'panel-action-danger', app.escapeHtml(deleteLabel), 'delete')}
        </div>
      </div>
    `;

    panel.querySelector('[data-action="chat"]')!.addEventListener('click', () => openContact(contact));
    panel.querySelector('[data-action="remark"]')!.addEventListener('click', () => void editContactRemark(contact));
    panel.querySelector('[data-action="mute"]')!.addEventListener('click', async () => {
      try {
        if (isMuted) await app.client.unmuteConversation(isGroup ? { groupId: gid } : { toUid: uid });
        else await app.client.muteConversation(isGroup ? { groupId: gid } : { toUid: uid });
        void showContactDetail(contact);
      } catch (e) {
        app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
      }
    });
    panel.querySelector('[data-action="block"]')?.addEventListener('click', async () => {
      try {
        if (isBlocked) {
          await app.client.unblockUser(uid);
          app.showToast(app.t('detail.unblockUserDone'), 'success');
        } else {
          await app.client.blockUser(uid);
          app.showToast(app.t('detail.blockUserDone'), 'success');
        }
        void showContactDetail(contact);
      } catch (e) {
        app.showToast(app.t('contacts.failed') + describeError(app, e), 'error');
      }
    });
    panel.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
      if (isGroup) void unfavoriteGroup(gid);
      else void deleteFriend(uid);
    });
    app.$('contacts-detail-back')?.addEventListener('click', () => void showContactDetail(null));
  }

  function openContact(contact: Contact) {
    app.views.chat?.switchView('chat');
    const groupId = contactGroupId(contact);
    const friendUid = contactFriendUid(contact);
    const isGroup = groupId !== '0';
    const conv: LocalConversation = isGroup
      ? { groupId, friendUid: '0', lastSeq: 0, lastMessage: null }
      : { groupId: '0', friendUid, lastSeq: 0, lastMessage: null };
    void app.views.chat?.openConversation(conv);
  }

  async function showCreateGroupModal() {
    const modal = app.$('modal-content');
    modal.innerHTML = `
      <div class="modal-title">${app.t('group.createTitle')}</div>
      <div class="form-group">
        <label>${app.t('group.groupName')}</label>
        <input class="input" type="text" id="group-name-input" placeholder="${app.t('group.groupNamePlaceholder')}">
      </div>
      <div class="form-group">
        <label>${app.t('group.selectMembers')}</label>
        <div class="member-select-list" id="member-select-list"></div>
      </div>
      <div class="member-picker-count" id="member-count">${app.t('group.selectedCount', { n: 0 })}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="modal-cancel">${app.t('group.cancel')}</button>
        <button class="btn btn-primary" id="modal-create">${app.t('group.create')}</button>
      </div>
    `;

    app.$('modal-overlay').classList.remove('hidden');
    const listEl = app.$('member-select-list');

    let selectedUids: readonly string[] = [];
    const updateSelectedCount = (count: number) => {
      app.$('member-count').textContent = app.t('group.selectedCount', { n: count });
    };

    // 建群候选只展示用户好友（过滤掉收藏群）；分页游标仍用服务端整页边界，按整页裁剪。
    // 选中态交给组件内置 SelectionStore（multi + max），点击行内任意位置即翻转选中，
    // 达上限时未选中的候选自动禁用勾选框，不需要再手写"上限拦截 + 提示"。
    const memberList = createBoundedList<Contact>({
      id: 'contacts.createGroupMembers',
      scrollElement: listEl,
      // 建群弹窗内的一次性候选列表，随弹窗销毁，不接入宿主广播。
      register: standaloneList,
      pillHost: false,
      pageSize: FRIEND_PAGE_SIZE,
      maxPages: APP_CONFIG.list.maxPages,
      source: serverPageSource(
        ({ cursor, backward, limit }) => app.client.getContacts({ status: CONTACT_FRIEND, cursor, backward, limit }),
        (page) => contactPageLoad(page, page.contacts.filter((contact) => contactFriendUid(contact) !== '0')),
      ),
      identityOf: (contact) => contactFriendUid(contact),
      order: 'desc',
      selection: { mode: 'multi', max: MEMBER_SELECT_MAX_SELECTED, onExceed: () => {
        app.showToast(app.t('group.selectedLimit', { n: MEMBER_SELECT_MAX_SELECTED }), 'error');
      } },
      renderItem: (contact, ctx) => {
        const uid = contactFriendUid(contact);
        const ud = app.client.getUserInfos([uid]).get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
        const name = displayUserName(ud, uid);
        const item = app.dom.ownerDocument.createElement('label');
        item.className = 'member-select-item';
        item.innerHTML = `
          <input type="checkbox" value="${uid}" ${ctx.selected ? 'checked' : ''} ${!ctx.selectable ? 'disabled' : ''}>
          <div class="avatar avatar-sm">${app.escapeHtml(name[0] || '?')}</div>
          <span>${app.escapeHtml(name)}</span>
        `;
        return [item];
      },
      text: {
        empty: () => app.t('contacts.noFriends'),
        loading: () => app.t('common.loading'),
        tailBoundary: () => app.t('contacts.noMoreContacts'),
        retry: () => app.t('common.retry'),
      },
      onSelectionChange: (snapshot) => {
        selectedUids = [...snapshot.ids];
        updateSelectedCount(snapshot.count);
      },
      onError: (error) => console.warn('[yimsg/uikit] create-group member list failed:', error),
    });
    void memberList.reset();

    // 候选好友昵称首次渲染时大概率还没进缓存（惰性拉取），异步补齐后要靠
    // display:updated 重绘，否则行内会一直停留在 uid 兜底文案上。
    const onDisplayUpdated = (): void => memberList.render();
    app.client.on('display:updated', onDisplayUpdated);
    const closeModal = () => {
      app.client.off('display:updated', onDisplayUpdated);
      memberList.dispose();
    };

    app.$('modal-cancel').addEventListener('click', () => { closeModal(); app.closeModal(); });
    app.$('modal-create').addEventListener('click', async () => {
      if (selectedUids.length === 0) { app.showToast(app.t('group.selectAtLeastOne'), 'error'); return; }
      // 未填群名时默认用成员昵称逗号拼接，最多截取 8 个字。
      let name = (app.$('group-name-input') as HTMLInputElement).value.trim();
      if (!name) {
        name = selectedUids
          .map((uid) => displayUserName(app.client.getUserInfos([uid]).get(uid), uid))
          .join(',')
          .slice(0, 8);
      }
      const memberUids = [...selectedUids, app.client.getSessionSnapshot().currentUid];
      try {
        await app.client.createGroup(name, memberUids);
        app.showToast(app.t('group.groupCreated'), 'success');
        closeModal();
        app.closeModal();
      } catch (e) {
        app.showToast(app.t('group.failed') + describeError(app, e), 'error');
      }
    });
  }

  /** 创建组织：创建方自动成为组织根管理员，随后把自己挂为组织根的普通成员，使其出现在自己的通讯录里。 */
  async function showCreateOrgModal() {
    const name = await app.showTextInputModal({
      title: app.t('orgAdmin.createOrgPromptTitle'),
      label: app.t('orgAdmin.createOrgPromptLabel'),
      confirmText: app.t('orgAdmin.createBtn'),
      cancelText: app.t('orgAdmin.cancelBtn'),
    });
    if (!name) return;
    try {
      const orgId = await app.client.createOrg(name);
      const myUid = app.client.getSessionSnapshot().currentUid;
      await app.client.addOrgMember(orgId, orgId, myUid);
      app.showToast(app.t('orgAdmin.actionSucceeded'), 'success');
    } catch (e) {
      app.showToast(app.t('orgAdmin.actionFailed') + describeError(app, e), 'error');
    }
  }

  function setupContacts() {
    // 初始化右侧详情面板空状态
    const panel = app.$('contacts-detail-panel');
    if (panel) {
      panel.innerHTML = `<div class="contacts-detail-empty">${app.escapeHtml(app.t('contacts.selectContact'))}</div>`;
    }

    app.dom.querySelectorAll<HTMLElement>('[data-ctab]').forEach(tab => {
      tab.addEventListener('click', () => {
        app.dom.querySelectorAll('[data-ctab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        app.$('friends-tab').classList.toggle('hidden', tab.dataset.ctab !== 'friends');
        app.$('requests-tab').classList.toggle('hidden', tab.dataset.ctab !== 'requests');
        app.$('search-tab').classList.toggle('hidden', tab.dataset.ctab !== 'search');
        app.$('friends-search-row').classList.toggle('hidden', tab.dataset.ctab !== 'friends');
        if (tab.dataset.ctab === 'friends') {
          void loadContacts();
        } else if (tab.dataset.ctab === 'requests') {
          void loadRequests();
        }
      });
    });

    app.$('search-btn').addEventListener('click', () => void searchUser());
    app.$('search-username').addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void searchUser();
    });

    const friendsSearchInput = app.$('friends-search-input') as HTMLInputElement;
    friendsSearchInput.addEventListener('input', () => {
      applyFriendKeywordChange(friendsSearchInput.value);
    });
    friendsSearchInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      applyFriendKeywordChange(friendsSearchInput.value);
    });

    app.$('create-group-btn').addEventListener('click', () => void showCreateGroupModal());
    app.$('create-org-btn').addEventListener('click', () => void showCreateOrgModal());
    setupContactsResizer();
  }

  return {
    setupContacts,
    loadContacts,
    refreshContactsDisplay,
    updateContactBadges,
    refreshOrgPanel,
    showCreateGroupModal,
  };
}
