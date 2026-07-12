/**
 * mode.ts — UIKit `mode` 参数的运行时解析。
 *
 * 本模块只做"纯编排"：把 `UIKitMode` 映射成 YimsgClient 的业务会话启动参数。
 * 不直接操作 DOM / Shadow，便于单元测试覆盖三条分支。
 */

import type { YimsgClient } from '../sdk';
import type { UIKitMode } from './options';

/** 初始化过程中用于通告降级 / 清理失败的回调。 */
type ModeErrorReporter = (error: Error, context: string) => void;

interface StartSessionByModeOptions {
  readonly mode: UIKitMode;
  readonly instanceId?: string;
}

/**
 * 根据 `mode` 解析并调用 `client.startSession`。
 *
 * 行为矩阵：
 * | mode        | startSession 参数              |
 * |-------------|---------------------------------|
 * | `memory`    | `{ storage: 'memory' }`         |
 * | `persistent`| `{ storage: 'persistent' }`     |
 */
export async function startSessionByMode(
  client: Pick<YimsgClient, 'startSession'>,
  options: UIKitMode | StartSessionByModeOptions,
  onError: ModeErrorReporter,
): Promise<void> {
  const resolved = typeof options === 'string' ? { mode: options } : options;
  const { mode, instanceId } = resolved;
  const result = await client.startSession({
    storage: mode === 'memory' ? 'memory' : 'persistent',
    instanceId,
  });

  if (result.degraded) {
    onError(new Error('持久化会话不可用，已降级为 memory 模式'), 'mode:persistent-fallback');
  }
}
