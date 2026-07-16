import { DEFAULT_MAX_BATCH_LIMIT, DEFAULT_MAX_PAGE_LIMIT } from './sdk-defaults';

/**
 * 前端保留 500 硬封顶，防止认证前选项或异常服务端响应绕过服务端配置约束。
 *
 * @param limit 调用方传入的可选 limit。
 * @param fallback limit 无效或未传时使用的默认值。
 * @param maxLimit 调用方允许的最大值，会继续与 DEFAULT_MAX_BATCH_LIMIT 取较小值。
 * @returns 介于 1 和有效上限之间的整数 limit。
 *
 * 通常外部调用 `clampBatchLimit()` 使用批量接口默认上限；只有需要自定义
 * fallback 或方法级上限时才直接调用该函数。
 */
function clampPositiveLimit(limit: number | undefined, fallback: number, maxLimit: number): number {
  const normalizedMax = Math.max(1, Math.min(maxLimit, DEFAULT_MAX_BATCH_LIMIT));
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return Math.min(fallback, normalizedMax);
  return Math.min(Math.max(1, Math.floor(limit)), normalizedMax);
}

export function clampOptionalPageLimit(limit: number | undefined, maxLimit = DEFAULT_MAX_PAGE_LIMIT): number | undefined {
  if (typeof limit !== 'number') return limit;
  return Math.min(Math.max(0, Math.floor(limit)), Math.min(maxLimit, DEFAULT_MAX_PAGE_LIMIT));
}

export function clampBatchLimit(limit: number | undefined): number {
  return clampPositiveLimit(limit, DEFAULT_MAX_BATCH_LIMIT, DEFAULT_MAX_BATCH_LIMIT);
}

/** 按 batchSize 串行拆分输入，逐批调用 getBatch 并合并所有返回项。 */
export async function collectSerialBatches<TInput, TOutput>(
  inputs: readonly TInput[],
  batchSize: number,
  getBatch: (batch: TInput[]) => Promise<TOutput[]>,
): Promise<TOutput[]> {
  const limit = clampBatchLimit(batchSize);
  const result: TOutput[] = [];
  for (let i = 0; i < inputs.length; i += limit) {
    const batch = inputs.slice(i, i + limit);
    const items = await getBatch(batch);
    result.push(...items);
  }
  return result;
}
