import { displayUserName } from '@yimsg/sdk';
import { APP_CONFIG } from '../../app-config';
import type { AppInstance } from '../app-instance';

interface MemberEntry {
  uid: string;
  name: string;
}

export type GroupMemberPickResult =
  | { kind: 'member'; uid: string }
  | { kind: 'all' };

function pinyinCollator(): Intl.Collator {
  return new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
}

/**
 * 带搜索框的群成员选择器：打开时一次性分页拉全量群成员 + 批量拉展示名，
 * 按拼音排序后本地渲染；搜索框在拉取完成前禁用，完成后纯本地按昵称/用户名
 * 过滤，不发起任何服务端搜索请求，也不做跨次调用的缓存（每次打开都是当次
 * 最新的成员与昵称快照）。昵称展示始终读 SDK 的 UserDisplayInfo 缓存视图，
 * 群成员表本身不冗余昵称，避免用户改名后要挨个同步所在群这类一致性负担。
 * 群成员是低频操作，一次性全量拉取带来的等待可接受；异常大群靠
 * APP_CONFIG.groupMemberPicker.maxPages 兜底，不做无界翻页。
 *
 * 供 @ 提及等多处场景复用：resolve `{ kind: 'member', uid }` 或（`includeMentionAll` 开启时）
 * `{ kind: 'all' }`；取消 / Esc / 点击取消按钮 resolve null。`includeMentionAll` 默认关闭——
 * 这个组件本身通用（未来"转让群主"之类只选单个具体成员的场景也会复用），@全体成员只是
 * 调用方按需开启的一个选项，不该对所有调用方都出现。
 */
export async function showGroupMemberPicker(
  app: AppInstance,
  groupId: string,
  options: { excludeUids?: ReadonlyArray<string>; includeMentionAll?: boolean } = {},
): Promise<GroupMemberPickResult | null> {
  const excluded = new Set(options.excludeUids ?? []);
  const collator = pinyinCollator();

  return new Promise((resolve) => {
    const modal = app.$('modal-content');
    const controller = new AbortController();
    let entries: MemberEntry[] = [];
    let loaded = false;
    let loadFailed = false;
    let loadingCount = 0;

    modal.innerHTML = `
      <div class="modal-title">${app.escapeHtml(app.t('groupMemberPicker.title'))}</div>
      <div class="form-group">
        <input class="input" type="text" id="group-member-picker-search" placeholder="${app.escapeHtml(app.t('groupMemberPicker.searchPlaceholder'))}" disabled>
      </div>
      <div class="group-member-picker-list" id="group-member-picker-list"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="group-member-picker-cancel">${app.escapeHtml(app.t('groupMemberPicker.cancel'))}</button>
      </div>
    `;
    app.$('modal-overlay').classList.remove('hidden');

    const searchInput = app.$('group-member-picker-search') as HTMLInputElement;
    const listEl = app.$('group-member-picker-list');

    const finish = (value: GroupMemberPickResult | null) => {
      controller.abort();
      app.client.off('display:updated', onDisplayUpdated);
      app.closeModal();
      resolve(value);
    };

    const nameOf = (uid: string): string => displayUserName(app.client.getUserInfos([uid]).get(uid), uid);

    // "所有人"是静态选项，不依赖群成员拉取结果，也不参与搜索过滤——始终钉在列表最前面。
    const renderMentionAllRow = () => {
      if (!options.includeMentionAll) return;
      const label = app.t('groupMemberPicker.allMembers');
      const item = app.dom.ownerDocument.createElement('div');
      item.className = 'group-member-picker-item group-member-picker-all';
      item.innerHTML = `<div class="avatar avatar-sm">${app.avatarInnerHtml({ nickname: label })}</div><span>${app.escapeHtml(label)}</span>`;
      item.addEventListener('click', () => finish({ kind: 'all' }), { signal: controller.signal });
      listEl.appendChild(item);
    };

    const appendEmptyRow = (text: string) => {
      const row = app.dom.ownerDocument.createElement('div');
      row.className = 'group-member-picker-empty';
      row.textContent = text;
      listEl.appendChild(row);
    };

    const renderList = () => {
      listEl.innerHTML = '';
      renderMentionAllRow();
      if (loadFailed) {
        appendEmptyRow(app.t('groupMemberPicker.loadFailed'));
        return;
      }
      if (!loaded) {
        appendEmptyRow(app.t('groupMemberPicker.loadingCount', { n: loadingCount }));
        return;
      }
      const query = searchInput.value.trim().toLowerCase();
      const filtered = query
        ? entries.filter((entry) => entry.name.toLowerCase().includes(query))
        : entries;
      if (filtered.length === 0) {
        appendEmptyRow(app.t(query ? 'groupMemberPicker.noResults' : 'groupMemberPicker.empty'));
        return;
      }
      for (const entry of filtered) {
        const item = app.dom.ownerDocument.createElement('div');
        item.className = 'group-member-picker-item';
        item.dataset.uid = entry.uid;
        const avatarHtml = app.avatarInnerHtml({ nickname: entry.name });
        item.innerHTML = `<div class="avatar avatar-sm">${avatarHtml}</div><span>${app.escapeHtml(entry.name)}</span>`;
        item.addEventListener('click', () => finish({ kind: 'member', uid: entry.uid }), { signal: controller.signal });
        listEl.appendChild(item);
      }
    };

    // 打开面板期间昵称可能因后台刷新（缓存未命中 → DataGateway 拉取完成）才补齐，
    // 这里订阅 display:updated 只重算受影响成员的展示名并重排，不重新全量拉取。
    const onDisplayUpdated = (event: { keys: readonly string[]; scope: string }) => {
      if (event.scope !== 'user' && event.scope !== 'mixed') return;
      if (!loaded) return;
      const memberUidSet = new Set(entries.map((entry) => entry.uid));
      const touched = event.keys.filter((key) => memberUidSet.has(key));
      if (touched.length === 0) return;
      const nameByUid = new Map(entries.map((entry) => [entry.uid, entry.name] as const));
      for (const uid of touched) nameByUid.set(uid, nameOf(uid));
      entries = entries
        .map((entry) => ({ uid: entry.uid, name: nameByUid.get(entry.uid) ?? entry.name }))
        .sort((a, b) => collator.compare(a.name, b.name));
      renderList();
    };
    app.client.on('display:updated', onDisplayUpdated);

    const loadAllMembers = async () => {
      const uids = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < APP_CONFIG.groupMemberPicker.maxPages; page++) {
        const result = await app.client.getGroupMembers(groupId, { cursor, limit: APP_CONFIG.list.pageSize });
        if (controller.signal.aborted) return;
        for (const member of result.members) {
          if (!excluded.has(member.userId)) uids.add(member.userId);
        }
        loadingCount = uids.size;
        renderList();
        if (!result.page.hasMoreForward) break;
        cursor = result.page.endCursor;
      }

      const uidList = [...uids];
      const batchMaxLimit = app.client.getClientConfig().batchMaxLimit;
      for (let i = 0; i < uidList.length; i += batchMaxLimit) {
        app.client.getUserInfos(uidList.slice(i, i + batchMaxLimit));
      }
      if (controller.signal.aborted) return;

      entries = uidList
        .map((uid) => ({ uid, name: nameOf(uid) }))
        .sort((a, b) => collator.compare(a.name, b.name));
      loaded = true;
      searchInput.disabled = false;
      searchInput.focus();
      renderList();
    };

    loadAllMembers().catch(() => {
      if (controller.signal.aborted) return;
      loadFailed = true;
      renderList();
    });

    renderList();
    searchInput.addEventListener('input', () => renderList(), { signal: controller.signal });
    searchInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish(null);
    }, { signal: controller.signal });
    app.$('group-member-picker-cancel').addEventListener('click', () => finish(null), { signal: controller.signal });
  });
}
