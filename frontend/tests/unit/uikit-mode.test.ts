/**
 * uikit mode 解析单元测试。
 *
 * 覆盖 `startSessionByMode` 的业务映射：
 * - `memory`：启动内存会话；
 * - `persistent`：请求持久化会话；
 * - 持久化不可用：SDK 降级为内存会话，UIKit 报告 `mode:persistent-fallback`；
 * - `persistent-cleardata`：请求重置当前用户本地会话数据后启动持久化会话；
 * - 重置失败：继续启动，但 onError 收到 `mode:reset-local-data`。
 */

import { describe, expect, it, vi } from 'vitest';
import { startSessionByMode } from '../../src/uikit/mode';

function makeClient(opts: {
  degraded?: boolean;
  resetThrows?: boolean;
}) {
  const startSession = vi.fn(async (args: {
    storage?: 'memory' | 'persistent';
    resetLocalData?: false | 'none' | 'current-user' | 'all';
    instanceId?: string;
  }) => {
    const requestedStorage = args.storage ?? 'memory';
    const degraded = Boolean(opts.degraded && requestedStorage === 'persistent');
    const resetLocalData = args.resetLocalData ?? 'none';
    return {
      requestedStorage,
      actualStorage: degraded ? 'memory' : requestedStorage,
      requestedFileSystem: requestedStorage === 'persistent' ? 'opfs' : null,
      actualFileSystem: degraded ? null : (requestedStorage === 'persistent' ? 'opfs' : null),
      mode: degraded || requestedStorage === 'memory' ? 'memory' : 'persistent',
      degraded,
      persistentStorageAvailable: !degraded,
      resetLocalData,
      resetLocalDataError: opts.resetThrows ? new Error('cleanup failed') : null,
    };
  });
  return { startSession };
}

describe('startSessionByMode', () => {
  it('memory：直接启动内存会话，不关心持久化能力', async () => {
    const client = makeClient({});
    const onError = vi.fn();
    await startSessionByMode(client, 'memory', onError);
    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(client.startSession).toHaveBeenCalledWith({
      storage: 'memory',
      resetLocalData: 'none',
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
      resetLocalData: 'none',
      instanceId: undefined,
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

  it('persistent-cleardata：请求重置当前用户本地会话数据后启动持久化会话', async () => {
    const client = makeClient({});
    const onError = vi.fn();
    await startSessionByMode(client, { mode: 'persistent-cleardata', instanceId: 'grid-a' }, onError);
    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(client.startSession).toHaveBeenCalledWith({
      storage: 'persistent',
      resetLocalData: 'current-user',
      instanceId: 'grid-a',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('persistent-cleardata + 重置失败：继续启动，但上报 mode:reset-local-data', async () => {
    const client = makeClient({ resetThrows: true });
    const onError = vi.fn();
    await startSessionByMode(client, { mode: 'persistent-cleardata', instanceId: 'grid-a' }, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, ctx] = onError.mock.calls[0]!;
    expect(ctx).toBe('mode:reset-local-data');
    expect((err as Error).message).toBe('cleanup failed');
  });

  it('persistent-cleardata + 持久化不可用：报告降级，不额外报告重置失败', async () => {
    const client = makeClient({ degraded: true });
    const onError = vi.fn();
    await startSessionByMode(client, 'persistent-cleardata', onError);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'mode:persistent-fallback');
  });
});
