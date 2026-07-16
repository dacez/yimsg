/**
 * 有界集合（Bounded Collections）基础设施统一出口。
 *
 * 这些结构是 Yimsg SDK 长期驻留集合的基石：所有长期驻留集合都必须建立在
 * 「容量在构造时指定、size 永不超过 capacity」的有界结构之上，禁止无界
 * Map / Set / Queue 长期增长。
 *
 * `FifoMap<K,V>` / `FifoSet<T>` 基于原生 Map / Set 实现，key / value 均为任意
 * 类型，放弃了「运行期字节上界可静态精确计算」这一强保证，只保留「entry 数量
 * 有界 + FIFO 淘汰」，换取实现简单与通用性；`BoundedQueue` 基于定长数组环形
 * 缓冲，额外提供「运行期字节上界可静态精确计算」的强保证。三者是项目内全部
 * 长期驻留 Map / Set / Queue 状态的统一实现。
 */

export type { BoundedStats } from './stats';
export {
  FifoMap,
  type FifoMapOptions,
} from './fifo-map';
export {
  FifoSet,
  type FifoSetOptions,
} from './fifo-set';
export {
  BoundedQueue,
  estimateBoundedQueueBytes,
  type BoundedQueueOptions,
  type QueueOverflowPolicy,
} from './bounded-queue';
