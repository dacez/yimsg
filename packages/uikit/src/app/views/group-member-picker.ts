import { displayUserName } from '@yimsg/sdk';
import { APP_CONFIG } from '../../app-config';
import type { AppInstance } from '../app-instance';
import { createBoundedList, localPageSource, standaloneList } from '../bounded-list';

export type GroupMemberPickResult =
  | { kind: 'member'; uid: string }
  | { kind: 'all' };

type PickerEntry =
  | { readonly kind: 'member'; readonly uid: string }
  | { readonly kind: 'all' };

const ALL_MEMBERS_IDENTITY = '__all__';

function pinyinCollator(): Intl.Collator {
  return new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
}

function entryName(app: AppInstance, entry: PickerEntry): string {
  if (entry.kind === 'all') return app.t('groupMemberPicker.allMembers');
  return displayUserName(app.client.getUserInfos([entry.uid]).get(entry.uid), entry.uid);
}

async function loadAllMemberEntries(
  app: AppInstance,
  groupId: string,
  excluded: ReadonlySet<string>,
  onProgress: ((loaded: number) => void) | undefined,
): Promise<PickerEntry[]> {
  const uids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < APP_CONFIG.groupMemberPicker.maxPages; page++) {
    const result = await app.client.getGroupMembers(groupId, { cursor, limit: APP_CONFIG.list.pageSize });
    for (const member of result.members) {
      if (!excluded.has(member.userId)) uids.add(member.userId);
    }
    onProgress?.(uids.size);
    if (!result.page.hasMoreForward) break;
    cursor = result.page.endCursor;
  }

  const uidList = [...uids];
  const batchMaxLimit = app.client.getClientConfig().batchMaxLimit;
  for (let i = 0; i < uidList.length; i += batchMaxLimit) {
    app.client.getUserInfos(uidList.slice(i, i + batchMaxLimit));
  }

  return uidList.map((uid) => ({ kind: 'member', uid }));
}

/**
 * 带搜索框的群成员选择器：打开时一次性分页拉全量群成员 + 批量拉展示名，
 * 按拼音排序后交给 BoundedList 渲染（localPageSource：数据侧一次性全量拉取，
 * 渲染侧有界窗口，DOM 节点数恒定 ≤ pageSize×maxPages，不再是"过滤后的全部条目"
 * 逐个 appendChild）。搜索框在拉取完成前禁用，完成后纯本地按昵称/用户名过滤，
 * 不发起任何服务端搜索请求。展示名在 renderItem 里现读 SDK 的 UserDisplayInfo
 * 缓存，display:updated 到来后宿主只需 render() 就能看到最新名字；排序在首次
 * 拉取时按当时可得的名字算一次，不会因为之后异步到达的昵称重新排序——群成员
 * 选择是低频操作，这个折衷可接受。
 * 群成员是低频操作，一次性全量拉取带来的等待可接受；异常大群靠
 * APP_CONFIG.groupMemberPicker.maxPages 兜底，不做无界翻页。
 *
 * 供 @ 提及等多处场景复用：resolve `{ kind: 'member', uid }` 或（`includeMentionAll` 开启时）
 * `{ kind: 'all' }`；取消 / Esc / 点击取消按钮 resolve null。`includeMentionAll` 默认关闭。
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

    const onDisplayUpdated = (): void => list.render();

    const finish = (value: GroupMemberPickResult | null) => {
      controller.abort();
      app.client.off('display:updated', onDisplayUpdated);
      list.dispose();
      app.closeModal();
      resolve(value);
    };

    const list = createBoundedList<PickerEntry, { keyword: string }>({
      id: 'group-member-picker',
      scrollElement: app.$('group-member-picker-list'),
      // 弹窗内一次性候选列表，生命周期短于一次重连，不接入宿主广播。
      register: standaloneList,
      pillHost: false,
      pageSize: APP_CONFIG.list.pageSize,
      maxPages: APP_CONFIG.groupMemberPicker.maxPages,
      initialQuery: { keyword: '' },
      source: localPageSource({
        order: 'desc',
        loadAll: () => loadAllMemberEntries(app, groupId, excluded, (n) => {
          loadingCount = n;
        }),
        // "所有人"是静态选项，不依赖群成员拉取结果，钉在头部，不参与过滤与分页；
        // 这里的 filter/compare 只处理真实成员条目。
        filter: (entry, query) => !query.keyword || entryName(app, entry).toLowerCase().includes(query.keyword.toLowerCase()),
        compare: (a, b) => collator.compare(entryName(app, a), entryName(app, b)),
      }),
      identityOf: (entry) => entry.kind === 'all' ? ALL_MEMBERS_IDENTITY : entry.uid,
      order: 'desc',
      selection: { mode: 'single' },
      pinnedItems: () => options.includeMentionAll ? [{ kind: 'all' }] : [],
      renderItem: (entry) => {
        const name = entryName(app, entry);
        const item = app.dom.ownerDocument.createElement('div');
        item.className = 'group-member-picker-item' + (entry.kind === 'all' ? ' group-member-picker-all' : '');
        item.innerHTML = `<div class="avatar avatar-sm">${app.avatarInnerHtml({ nickname: name })}</div><span>${app.escapeHtml(name)}</span>`;
        return [item];
      },
      text: {
        empty: () => searchInput.value.trim()
          ? app.t('groupMemberPicker.noResults')
          : app.t('groupMemberPicker.empty'),
        loading: () => app.t('groupMemberPicker.loadingCount', { n: loadingCount }),
        error: () => app.t('groupMemberPicker.loadFailed'),
        retry: () => app.t('common.retry'),
      },
      onActivate: (entry) => finish(entry.kind === 'all' ? { kind: 'all' } : { kind: 'member', uid: entry.uid }),
      onLoadStateChange: (s) => { searchInput.disabled = !s.loaded; if (s.loaded) searchInput.focus(); },
      onError: (error) => console.warn('[yimsg/uikit] group member picker failed:', error),
    });
    void list.reset();
    app.client.on('display:updated', onDisplayUpdated);

    searchInput.addEventListener('input', () => list.setQuery({ keyword: searchInput.value.trim() }), { signal: controller.signal });
    searchInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish(null);
    }, { signal: controller.signal });
    app.$('group-member-picker-cancel').addEventListener('click', () => finish(null), { signal: controller.signal });
  });
}
