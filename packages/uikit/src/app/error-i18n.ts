import { isYimsgError } from '@yimsg/sdk';
import type { AppInstance } from './app-instance';

// 服务端 BaseResponse.msg（code=INTERNAL_ERROR 除外）与 SDK 自身抛出的错误都只是稳定的
// 机器可读 code/token，不是人类可读文本；describeError 是把它们变成当前界面语言文案的
// 唯一入口，任何 toast 都不能再直接拼接 (err as Error).message。
export function describeError(app: AppInstance, error: unknown): string {
  if (!isYimsgError(error)) {
    return app.t('error.unknown');
  }

  if (error.kind === 'request') {
    const serverErrorCode = error.details?.serverErrorCode;
    if (typeof serverErrorCode === 'string') {
      if (serverErrorCode === 'INTERNAL_ERROR') {
        // msg 此时可能是服务端内部错误详情，仅供日志排查，绝不展示给用户。
        return app.t('error.internal');
      }
      const token = error.message;
      const tokenKey = `error.${token}`;
      const tokenText = app.t(tokenKey);
      if (tokenText !== tokenKey) {
        return tokenText;
      }
      if (typeof console !== 'undefined') {
        console.warn(`[yimsg] missing i18n mapping for error token "${token}" (${serverErrorCode})`);
      }
      const categoryKey = `error.category.${serverErrorCode}`;
      const categoryText = app.t(categoryKey);
      if (categoryText !== categoryKey) {
        return categoryText;
      }
      return app.t('error.unknown');
    }
    // 没有 serverErrorCode：HTTP 上传等不经过 WS 业务错误协议的失败，按 SDK code 兜底。
  }

  const sdkKey = `error.sdk.${error.code}`;
  const sdkText = app.t(sdkKey);
  return sdkText !== sdkKey ? sdkText : app.t('error.unknown');
}

/**
 * 取服务端稳定错误码（`FORBIDDEN` / `NOT_FOUND` 等），非 WebSocket 业务错误返回 null。
 * 只供"目标是否已经失效"这类必须按错误类别分流的分支使用：可恢复失败（网络、内部错误）
 * 保留当前界面，失效失败才收起面板。展示给用户的文案一律仍走 describeError。
 */
export function serverErrorCodeOf(error: unknown): string | null {
  if (!isYimsgError(error) || error.kind !== 'request') return null;
  const code = error.details?.serverErrorCode;
  return typeof code === 'string' ? code : null;
}
