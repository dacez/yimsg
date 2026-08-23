// sdkPageSource（组件自带的服务端分页源）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.2。
// 本地切片源已移出组件，用例见 ../views/local-page-source.test.ts。

import { describe, expect, it, vi } from 'vitest';
import { sdkPageSource } from '../../../src/app/bounded-list/page-source';

// ───────────────────────── A 透传 ─────────────────────────

describe('sdkPageSource / A 透传', () => {
  it('A1 原样透传请求，按固定规则把 SDK 响应整理成 PageLoadResult', async () => {
    const fetchRaw = vi.fn(async (req: { cursor?: string; backward: boolean; limit: number; query: { keyword: string } }) => ({
      contacts: [1, 2],
      page: { startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: true, total: 7 },
      raw: req,
    }));
    const source = sdkPageSource(fetchRaw, (raw) => raw.contacts);

    const result = await source.fetch({ cursor: 'c1', backward: true, limit: 40, query: { keyword: 'a' }, freshEdge: 'backward' });
    expect(result.items).toEqual([1, 2]);
    expect(result.startCursor).toBe('s');
    expect(result.endCursor).toBe('e');
    // `page` 的 hasMoreBackward / hasMoreForward 按同名字段原样搬进 PageLoadResult。
    expect(result.hasMoreBackward).toBe(false);
    expect(result.hasMoreForward).toBe(true);
    expect(result.total).toBe(7);
    // 请求原样透传，不做任何字段增删：调用方按需解构（生产里多数只取 cursor/backward/limit，
    // 消息列表另外读 freshEdge 决定首页取哪一端）。
    expect(fetchRaw).toHaveBeenCalledWith({ cursor: 'c1', backward: true, limit: 40, query: { keyword: 'a' }, freshEdge: 'backward' });
  });

  it('A2 reset 语义（cursor 未提供）原样透传为 undefined，不被替换成空串', async () => {
    const fetchRaw = vi.fn(async () => ({
      page: { startCursor: '', endCursor: '', hasMoreBackward: false, hasMoreForward: false },
    }));
    const source = sdkPageSource(fetchRaw, () => [] as number[]);
    await source.fetch({ backward: false, limit: 10, query: undefined, freshEdge: 'backward' });
    expect(fetchRaw.mock.calls[0][0]).toEqual({ cursor: undefined, backward: false, limit: 10, query: undefined, freshEdge: 'backward' });
  });

  it('A3 游标是不透明字符串：任意内容都原样透传，不解析、不构造', async () => {
    const opaque = 'eyJzZXEiOjEyMzQ1Njc4OTAsInVpZCI6Ijk5OSJ9==';
    const fetchRaw = vi.fn(async () => ({
      page: { startCursor: opaque, endCursor: opaque, hasMoreBackward: false, hasMoreForward: false },
    }));
    const source = sdkPageSource(fetchRaw, () => [] as number[]);
    const page = await source.fetch({ cursor: opaque, backward: false, limit: 1, query: undefined, freshEdge: 'backward' });
    expect((fetchRaw.mock.calls[0][0] as { cursor?: string }).cursor).toBe(opaque);
    expect(page.startCursor).toBe(opaque);
  });

  it('A4 底层 fetch 拒绝时错误原样透传（由上层 BoundedList 接管，不在这里吞掉）', async () => {
    const source = sdkPageSource(
      async () => { throw new Error('network down'); },
      () => [] as never[],
    );
    await expect(source.fetch({ backward: false, limit: 10, query: undefined, freshEdge: 'backward' })).rejects.toThrow('network down');
  });

  it('A5 selectItems 自身抛错同样原样透传（响应结构不符合预期时不静默吞掉）', async () => {
    const source = sdkPageSource(
      async () => ({ page: { startCursor: '', endCursor: '', hasMoreBackward: false, hasMoreForward: false } }),
      () => { throw new TypeError('bad shape'); },
    );
    await expect(source.fetch({ backward: false, limit: 10, query: undefined, freshEdge: 'backward' })).rejects.toThrow(TypeError);
  });

  it('A6 selectItems 可以在整理阶段做过滤（组织类联系人不作为会话目标），组件不感知', async () => {
    const source = sdkPageSource(
      async () => ({
        contacts: [{ id: 1, org: false }, { id: 2, org: true }, { id: 3, org: false }],
        page: { startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: false },
      }),
      (raw) => raw.contacts.filter((c) => !c.org),
    );
    const page = await source.fetch({ backward: false, limit: 10, query: undefined, freshEdge: 'backward' });
    expect(page.items.map((c) => c.id)).toEqual([1, 3]);
  });

  it('A7 selectTotal 覆盖 page.total（群成员总数在响应顶层）', async () => {
    const source = sdkPageSource(
      async () => ({
        members: [{ id: 1 }],
        total: 42,
        page: { startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: true, total: 1 },
      }),
      (raw) => raw.members,
      (raw) => raw.total,
    );
    const page = await source.fetch({ backward: false, limit: 10, query: undefined, freshEdge: 'backward' });
    expect(page.total).toBe(42);
  });

  it('A8 响应没给 total 时保持 undefined（窗口据此呈现为「未知」）', async () => {
    const source = sdkPageSource(
      async () => ({ page: { startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: false } }),
      () => [] as number[],
    );
    const page = await source.fetch({ backward: false, limit: 10, query: undefined, freshEdge: 'backward' });
    expect(page.total).toBeUndefined();
  });
});
