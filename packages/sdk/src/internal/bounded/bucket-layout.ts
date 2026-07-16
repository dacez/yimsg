/**
 * 固定桶容量对齐计算 —— 供 BoundedU64Set / BoundedQueue 等定长数组结构复用。
 */

import { nextPow2 } from './u64';

/** 计算给定参数下的实际固定容量（bucketCount * bucketCapacity）。纯函数，供内存估算复用。 */
export function computeBoundedCapacity(
  capacity: number,
  bucketCapacity = 8,
  loadFactor = 1,
): { bucketCount: number; bucketCapacity: number; capacity: number } {
  const safeBucketCap = Math.max(1, Math.floor(bucketCapacity));
  const safeLoad = loadFactor > 0 && loadFactor <= 1 ? loadFactor : 1;
  const desiredSlots = Math.max(0, Math.ceil(capacity / safeLoad));
  // 期望容量为 0 时不分配任何 bucket（容量 0 集合拒绝一切写入），保证内存估算可归零。
  if (desiredSlots <= 0) return { bucketCount: 0, bucketCapacity: safeBucketCap, capacity: 0 };
  const bucketCount = nextPow2(Math.ceil(desiredSlots / safeBucketCap));
  return { bucketCount, bucketCapacity: safeBucketCap, capacity: bucketCount * safeBucketCap };
}
