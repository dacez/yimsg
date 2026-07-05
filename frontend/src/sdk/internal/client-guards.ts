import {
  PreconditionError,
  ValidationError,
} from '../errors';
import type {
  SessionSnapshot,
} from '../types';

export function requireAuthenticated(
  snapshot: SessionSnapshot,
  token: string,
  action: string,
): { uid: string; token: string } {
  const currentUid = snapshot.currentUid;
  if (!currentUid || !token) {
    throw new PreconditionError('AUTH_REQUIRED', `${action} 需要先完成登录或 token 认证`, {
      context: action,
    });
  }
  return { uid: currentUid, token };
}

export function assertNonEmpty(value: string, field: string, action: string): void {
  if (!value.trim()) {
    throw new ValidationError(`${action} 需要有效的 ${field}`, {
      context: action,
      details: { field },
    });
  }
}

export function normalizeDisplayInfoKeys(
  keys: readonly string[],
  action: 'getUserInfos' | 'getGroupInfos',
  batchMaxLimit: number,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = String(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    if (result.length >= batchMaxLimit) {
      throw new ValidationError(`${action} 最多支持 ${batchMaxLimit} 个去重后的 key`, {
        context: action,
        details: { maxKeys: batchMaxLimit, attemptedKey: key },
      });
    }
    result.push(key);
  }
  return result;
}
