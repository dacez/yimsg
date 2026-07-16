/**
 * uikit mode 解析单元测试。
 *
 * 覆盖 `startSessionByMode` 的业务映射：
 * - `instant`：启动内存会话；
 * - `persistent`：请求持久化会话；
 * - 持久化不可用：SDK 降级为内存会话，UIKit 报告 `mode:persistent-fallback`。
 *
 * 持久存储清除本地数据不再是一个独立的挂载模式，改为设置页「清除数据」按钮，
 * 见 `packages/uikit/tests/unit/uikit-settings-clear-data.test.ts`。
 */

import { describe, expect, it, vi } from 'vitest';
import { startSessionByMode } from '../../src/mode';

function makeClient(opts: {
  degraded?: boolean;
}) {
  const startSession = vi.fn(async (args: {
    storage?: 'instant' | 'persistent';
    instanceId?: string;
  }) => {
    const requestedStorage = args.storage ?? 'instant';
    const degraded = Boolean(opts.degraded && requestedStorage === 'persistent');
    return {
      requestedStorage,
      actualStorage: degraded ? 'instant' : requestedStorage,
      requestedFileSystem: requestedStorage === 'persistent' ? 'opfs' : null,
      actualFileSystem: degraded ? null : (requestedStorage === 'persistent' ? 'opfs' : null),
      mode: degraded || requestedStorage === 'instant' ? 'instant' : 'persistent',
      degraded,
      persistentStorageAvailable: !degraded,
      resetLocalData: 'none',
      resetLocalDataError: null,
    };
  });
  return { startSession };
}

describe('startSessionByMode', () => {
  it('instant：直接启动内存会话，不关心持久化能力', async () => {
    const client = makeClient({});
    const onError = vi.fn();
    await startSessionByMode(client, 'instant', onError);
    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(client.startSession).toHaveBeenCalledWith({
      storage: 'instant',
      instanceId: undefined,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('persistent：请求持久化会话', async () => {
    const client = makeClient({});
    const onError = vi.fn();
    await startSessionByMode(client, 'persistent', onError);
    expect(client.startSession).toHaveBeenCalledWith({
      storage: 'persistent',
      instanceId: undefined,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('persistent 透传 instanceId', async () => {
    const client = makeClient({});
    const onError = vi.fn();
    await startSessionByMode(client, { mode: 'persistent', instanceId: 'grid-a' }, onError);
    expect(client.startSession).toHaveBeenCalledWith({
      storage: 'persistent',
      instanceId: 'grid-a',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('persistent + 持久化不可用：报告 mode:persistent-fallback', async () => {
    const client = makeClient({ degraded: true });
    const onError = vi.fn();
    await startSessionByMode(client, 'persistent', onError);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, ctx] = onError.mock.calls[0]!;
    expect(ctx).toBe('mode:persistent-fallback');
    expect(err).toBeInstanceOf(Error);
  });
});
