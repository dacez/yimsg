import type {
  ConnectionState,
  SessionMode,
  SessionSnapshot,
  SessionState,
  SessionStateChangedEvent,
  SessionTransitionReason,
} from '../types';
import { freezeObject } from '../internal/readonly';

type MutableLifecycleState = {
  sessionState: SessionState;
  connectionState: ConnectionState;
  mode: SessionMode;
  currentUid: string;
};

type LifecyclePatch = Partial<MutableLifecycleState>;

function isAuthenticatedState(state: SessionState): boolean {
  return state === 'authenticated' || state === 'initializing' || state === 'ready';
}

function isInitializedState(state: SessionState): boolean {
  return state === 'ready';
}

export class SessionLifecycleMachine {
  private state: MutableLifecycleState = {
    sessionState: 'idle',
    connectionState: 'disconnected',
    mode: 'memory',
    currentUid: '',
  };

  private transitionListener: ((event: SessionStateChangedEvent) => void) | null = null;

  setTransitionListener(listener: ((event: SessionStateChangedEvent) => void) | null): void {
    this.transitionListener = listener;
  }

  /**
   * 返回生命周期快照。
   *
   * 注意：`syncReadiness` 在此处为占位值；真实同步就绪状态由
   * `YimsgClient.getSessionSnapshot()` 通过 `ClientSessionRuntime` 合并提供。
   * 生命周期机自身不追踪同步域进度。
   */
  getSnapshot(): SessionSnapshot {
    return freezeObject({
      sessionState: this.state.sessionState,
      connectionState: this.state.connectionState,
      mode: this.state.mode,
      currentUid: this.state.currentUid,
      isAuthenticated: isAuthenticatedState(this.state.sessionState),
      isSessionInitialized: isInitializedState(this.state.sessionState),
      syncReadiness: freezeObject({ domains: {}, firstSyncComplete: false }),
    });
  }

  get sessionState(): SessionState {
    return this.state.sessionState;
  }

  get connectionState(): ConnectionState {
    return this.state.connectionState;
  }

  transition(patch: LifecyclePatch, reason: SessionTransitionReason): SessionStateChangedEvent | null {
    const from = this.getSnapshot();
    const nextState: MutableLifecycleState = {
      sessionState: patch.sessionState ?? this.state.sessionState,
      connectionState: patch.connectionState ?? this.state.connectionState,
      mode: patch.mode ?? this.state.mode,
      currentUid: patch.currentUid ?? this.state.currentUid,
    };

    if (
      from.sessionState === nextState.sessionState
      && from.connectionState === nextState.connectionState
      && from.mode === nextState.mode
      && from.currentUid === nextState.currentUid
    ) {
      return null;
    }

    this.state = nextState;
    const event = freezeObject({
      from,
      to: this.getSnapshot(),
      reason,
    });
    this.transitionListener?.(event);
    return event;
  }
}
