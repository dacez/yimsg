/**
 * 有界集合（Bounded Collections）基础设施统一出口。
 *
 * 这些结构是 Yimsg SDK 长期驻留集合的基石：所有长期驻留集合都必须建立在
 * 「容量在构造时指定、size 永不超过 capacity」的有界结构之上，禁止无界
 * Map / Set / Queue 长期增长。
 *
 * 其中 BoundedU64Set / BoundedQueue 基于定长 TypedArray，额外提供「运行期字节
 * 上界可静态精确计算」的强保证；FifoU64Map 放弃了这一强保证（改用原生 Map 实现），
 * 仅保留「entry 数量有界 + FIFO 淘汰」，换取实现简单与任意值类型支持，详见
 * fifo-u64-map.ts 顶部注释。
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
  FifoU64Map,
  estimateFifoU64MapBytes,
  type FifoU64MapOptions,
} from './fifo-u64-map';
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
