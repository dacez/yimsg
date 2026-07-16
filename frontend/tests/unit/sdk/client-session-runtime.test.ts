import { describe, expect, it, vi } from 'vitest';
import { ClientSessionRuntime } from '../../../src/sdk/internal/client-session-runtime';
import { SessionLifecycleMachine } from '../../../src/sdk/state/lifecycle';
import type { SyncDomain, SyncStatus } from '../../../src/sdk/types';

function makeRuntime(mode: 'instant' | 'persistent' = 'instant') {
  let connected = false;
  const transport = {
    get connected() {
      return connected;
    },
    connect: vi.fn(() => {
      queueMicrotask(() => {
        connected = true;
        transport.onConnected?.();
      });
    }),
    disconnect: vi.fn(),
    onConnected: null as null | (() => void),
    onDisconnected: null as null | (() => void),
    onNotification: null as null | ((notification: unknown) => void),
    onReconnecting: null as null | (() => void),
  };
  const lifecycle = new SessionLifecycleMachine();
  lifecycle.transition({ mode }, 'session_initializing');
  const runtime = new ClientSessionRuntime({
    transport: transport as never,
    cache: {
      clear: vi.fn(),
    } as never,
    lifecycle,
    connectTimeoutMs: 1000,
    shouldKeepTransportAlive: () => true,
    onConnectionEvent: vi.fn(),
    onMessagesReceived: vi.fn(),
    onContactsChanged: vi.fn(),
    onBlocklistChanged: vi.fn(),
    onMutelistChanged: vi.fn(),
    onUnreadCleared: vi.fn(),
    onConversationDeleted: vi.fn(),
    onMessageDeleted: vi.fn(),
    onSessionKicked: vi.fn(),
    onError: vi.fn(),
    onSync: vi.fn(),
    getBatchMaxLimit: vi.fn(() => 100),
  });

  return {
    runtime,
    transport,
    lifecycle,
    /** 模拟 DataGateway 通过 bindDataGatewayCallbacks 触发 trackSyncDomain。 */
    fireSync(domain: SyncDomain, status: SyncStatus) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).trackSyncDomain(domain, status);
    },
  };
}

describe('ClientSessionRuntime', () => {
  it('并发 ensureConnected 只发起一次连接', async () => {
    const { runtime, transport } = makeRuntime();

    await Promise.all([runtime.ensureConnected(), runtime.ensureConnected()]);

    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  it('后端通知直接交给当前 DataGateway', () => {
    const { runtime, transport } = makeRuntime();
    const handleNotification = vi.fn();
    (runtime as unknown as {
      dataGateway: { handleNotification: ReturnType<typeof vi.fn> };
    }).dataGateway = { handleNotification };

    transport.onNotification?.({ type: 'messages:received' });

    expect(handleNotification).toHaveBeenCalledWith({ type: 'messages:received' });
  });

  it('联系人写后处理统一走 contacts:updated 通知链路', () => {
    const { runtime } = makeRuntime('persistent');
    const handleNotification = vi.fn();
    (runtime as unknown as {
      dataGateway: {
        handleNotification: ReturnType<typeof vi.fn>;
      };
    }).dataGateway = {
      handleNotification,
    };

    runtime.notifyContactsChangedAfterMutation();

    expect(handleNotification).toHaveBeenCalledWith({ type: 'contacts:updated' });
  });

  it('没有 DataGateway 时联系人写后通知不报错', () => {
    const { runtime } = makeRuntime('instant');

    expect(() => runtime.notifyContactsChangedAfterMutation()).not.toThrow();
  });

  describe('getSyncReadiness', () => {
    it('instant 模式 firstSyncComplete 恒为 true，domains 为空', () => {
      const { runtime } = makeRuntime('instant');

      const r = runtime.getSyncReadiness();

      expect(r.firstSyncComplete).toBe(true);
      expect(r.domains).toEqual({});
      expect(Object.isFrozen(r)).toBe(true);
    });

    it('persistent 模式初始 firstSyncComplete 为 false', () => {
      const { runtime } = makeRuntime('persistent');

      const r = runtime.getSyncReadiness();

      expect(r.firstSyncComplete).toBe(false);
      expect(r.domains).toEqual({});
    });

    it('persistent 模式全部域完成后 firstSyncComplete 变为 true', () => {
      const { runtime, fireSync } = makeRuntime('persistent');
      const domains: SyncDomain[] = ['messages', 'conversations', 'contacts', 'blocklist', 'mutelist'];

      for (const d of domains) {
        fireSync(d, 'success');
      }

      const r = runtime.getSyncReadiness();
      expect(r.firstSyncComplete).toBe(true);
      for (const d of domains) {
        expect(r.domains[d]).toBe('success');
      }
    });

    it('persistent 模式部分域失败也计为完成', () => {
      const { runtime, fireSync } = makeRuntime('persistent');

      fireSync('messages', 'success');
      fireSync('conversations', 'success');
      fireSync('contacts', 'failed');
      fireSync('blocklist', 'success');
      fireSync('mutelist', 'success');

      const r = runtime.getSyncReadiness();
      expect(r.firstSyncComplete).toBe(true);
      expect(r.domains['contacts']).toBe('failed');
    });

    it('firstSyncComplete 一旦为 true 不再回退', () => {
      const { runtime, fireSync } = makeRuntime('persistent');
      const domains: SyncDomain[] = ['messages', 'conversations', 'contacts', 'blocklist', 'mutelist'];

      for (const d of domains) {
        fireSync(d, 'success');
      }
      expect(runtime.getSyncReadiness().firstSyncComplete).toBe(true);

      // 后续同步失败不应改变 firstSyncComplete
      fireSync('messages', 'failed');

      expect(runtime.getSyncReadiness().firstSyncComplete).toBe(true);
    });

    it('clearRuntimeState 重置同步就绪状态', () => {
      const { runtime, fireSync } = makeRuntime('persistent');
      const domains: SyncDomain[] = ['messages', 'conversations', 'contacts', 'blocklist', 'mutelist'];

      for (const d of domains) {
        fireSync(d, 'success');
      }
      expect(runtime.getSyncReadiness().firstSyncComplete).toBe(true);

      runtime.clearRuntimeState();

      expect(runtime.getSyncReadiness().firstSyncComplete).toBe(false);
      expect(runtime.getSyncReadiness().domains).toEqual({});
    });

    it('对已完成的域再次同步，domains 更新但 firstSyncComplete 不变', () => {
      const { runtime, fireSync } = makeRuntime('persistent');

      fireSync('messages', 'success');
      fireSync('conversations', 'success');
      fireSync('contacts', 'success');
      fireSync('blocklist', 'success');
      fireSync('mutelist', 'success');
      expect(runtime.getSyncReadiness().firstSyncComplete).toBe(true);

      // 通知触发二次同步
      fireSync('messages', 'success');

      const r = runtime.getSyncReadiness();
      expect(r.firstSyncComplete).toBe(true);
      expect(r.domains['messages']).toBe('success');
    });
  });
});
