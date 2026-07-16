/**
 * 有界集合（Bounded Collections）基础设施统一出口。
 *
 * 这些结构是 Yimsg SDK 内存可控架构的基石：所有长期驻留集合都必须建立在
 * 固定容量的有界结构之上，禁止无界 Map / Set / Queue 长期增长。
 */

export type { BoundedStats } from './stats';
export {
  parseU64,
  u64FromNumber,
  u64ToString,
  hashU64,
  u64Equal,
  nextPow2,
  type U64Key,
} from './u64';
export {
  BoundedU64Map,
  computeBoundedCapacity,
  estimateBoundedU64MapBytes,
  type BoundedU64MapOptions,
  type EvictionPolicy,
} from './bounded-u64-map';
export {
  BoundedU64Set,
  estimateBoundedU64SetBytes,
  type BoundedU64SetOptions,
} from './bounded-u64-set';
export {
  BoundedQueue,
  estimateBoundedQueueBytes,
  type BoundedQueueOptions,
  type QueueOverflowPolicy,
} from './bounded-queue';
