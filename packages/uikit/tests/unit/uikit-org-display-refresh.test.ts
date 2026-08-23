import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInstance } from '../../src/app/app-instance';
import { openOrgAdmin } from '../../src/app/views/org-admin';

// 回归的 bug：BUG-005。组织 / tag 的展示名走 DisplayInfoCache（TTL 7 天），且写操作不回写
// 本地缓存、org:updated 也只同步结构边不带名字，所以发起改名的那一端在 TTL 内永远读到旧名——
// 服务端已经改好、别的账号首次拉取就是新名，只有操作者自己的弹层标题、面包屑一直不变。
// 修复口径：点击驱动的入口（打开弹层、切换节点、每次写操作成功后）绕过 TTL 强刷；
// display:updated 驱动的重绘只读缓存，否则"强刷 → display:updated → 再强刷"会无限循环。

interface FakeEl {
  id: string;
  innerHTML: string;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  addEventListener(type: string, handler: () => void | Promise<void>): void;
  click(): Promise<void>;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  value: string;
}

function createFakeEl(id: string): FakeEl {
  const classes = new Set<string>();
  const handlers: Array<() => void | Promise<void>> = [];
  const el: FakeEl = {
    id,
    innerHTML: '',
    value: '',
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, handler) => { if (type === 'click') handlers.push(handler); },
    click: async () => { for (const h of [...handlers]) await h(); },
    // 弹层用 querySelector('#oa-close') 判断"当前显示的是不是自己的列表视图"。
    querySelector: (sel) => (el.innerHTML.includes(sel.replace('#', 'id="')) || el.innerHTML.includes(sel.replace('#', ''))) ? el : null,
    // 本用例只覆盖空组织根节点：没有子部门 / 成员行，列表选择器一律返回空。
    querySelectorAll: () => [],
  };
  return el;
}

function createHarness(options: { onRename?: () => void } = {}) {
  const elements = new Map<string, FakeEl>();
  const $ = (id: string): FakeEl => {
    let el = elements.get(id);
    if (!el) { el = createFakeEl(id); elements.set(id, el); }
    return el;
  };

  const orgInfoCalls: Array<{ forceRefresh: boolean }> = [];
  const tagInfoCalls: Array<{ forceRefresh: boolean }> = [];
  let displayHandler: (() => void) | null = null;
  let orgName = '旧组织名';
  const renameOrg = vi.fn(async (_orgId: string, name: string) => {
    orgName = name;
    options.onRename?.();
  });

  const app = {
    $: (id: string) => $(id),
    t: (key: string) => key,
    escapeHtml: (text: string) => text,
    showToast: vi.fn(),
    closeModal: vi.fn(),
    showTextInputModal: vi.fn(async () => '新组织名'),
    showConfirmModal: vi.fn(async () => true),
    client: {
      getTags: vi.fn(async () => ({ tags: [] })),
      listOrgAdmins: vi.fn(async () => []),
      getUserInfos: vi.fn(() => new Map()),
      getTagInfos: vi.fn((_orgId: string, _ids: string[], opts: { forceRefresh?: boolean } = {}) => {
        tagInfoCalls.push({ forceRefresh: opts.forceRefresh === true });
        return new Map();
      }),
      // 只有强刷才会绕过 TTL 拿到服务端最新组织名；不强刷时读到的仍是缓存里的旧值。
      getOrgInfos: vi.fn((ids: string[], opts: { forceRefresh?: boolean } = {}) => {
        const forceRefresh = opts.forceRefresh === true;
        orgInfoCalls.push({ forceRefresh });
        return new Map(ids.map(id => [id, { name: forceRefresh ? orgName : '旧组织名', avatarUrl: '' }]));
      }),
      renameOrg,
      on: (event: string, handler: () => void) => { if (event === 'display:updated') displayHandler = handler; },
      off: () => { displayHandler = null; },
    },
  } as unknown as AppInstance;

  return {
    app,
    $,
    orgInfoCalls,
    tagInfoCalls,
    renameOrg,
    emitDisplayUpdated: () => displayHandler?.(),
  };
}

beforeEach(() => {
  // 弹层用 MutationObserver 监听自身关闭；node 环境没有该全局，装一个惰性桩。
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
});

describe('org-admin 展示资料刷新策略', () => {
  it('打开管理弹层时绕过 TTL 强刷组织与 tag 展示名', async () => {
    const h = createHarness();
    await openOrgAdmin(h.app, '100', '100');

    expect(h.orgInfoCalls).toHaveLength(1);
    expect(h.orgInfoCalls[0].forceRefresh).toBe(true);
    expect(h.tagInfoCalls[0].forceRefresh).toBe(true);
  });

  it('改名成功后当前弹层标题立即变成新名称（BUG-005 主现场）', async () => {
    const h = createHarness();
    await openOrgAdmin(h.app, '100', '100');
    expect(h.$('modal-content').innerHTML).toContain('旧组织名');

    await h.$('oa-rename').click();

    expect(h.renameOrg).toHaveBeenCalledWith('100', '新组织名');
    // 写操作后的重绘必须强刷：否则读回的仍是 TTL 未过期的旧名。
    expect(h.orgInfoCalls[h.orgInfoCalls.length - 1].forceRefresh).toBe(true);
    expect(h.$('modal-content').innerHTML).toContain('新组织名');
    expect(h.$('modal-content').innerHTML).not.toContain('旧组织名');
  });

  it('display:updated 触发的重绘只读缓存，不再次强刷（防无限循环）', async () => {
    const h = createHarness();
    await openOrgAdmin(h.app, '100', '100');
    const beforeCount = h.orgInfoCalls.length;

    h.emitDisplayUpdated();
    await vi.waitFor(() => expect(h.orgInfoCalls.length).toBeGreaterThan(beforeCount));

    for (const call of h.orgInfoCalls.slice(beforeCount)) {
      expect(call.forceRefresh).toBe(false);
    }
    for (const call of h.tagInfoCalls.slice(beforeCount)) {
      expect(call.forceRefresh).toBe(false);
    }
  });
});
