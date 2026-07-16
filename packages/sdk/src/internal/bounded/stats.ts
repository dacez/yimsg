/**
 * 所有有界集合统一暴露的运行时统计，用于 benchmark / debug / 内存估算校验。
 *
 * 对非 bucket 结构（如 BoundedQueue ring buffer）：bucketCount 记为 1，
 * bucketCapacity 记为 capacity，以保持字段语义统一。
 */
export interface BoundedStats {
  /** 当前条目数。 */
  readonly size: number;
  /** 固定容量上限（运行期不变）。 */
  readonly capacity: number;
  /** bucket 数量（2 的幂）。 */
  readonly bucketCount: number;
  /** 每 bucket 槽位数。 */
  readonly bucketCapacity: number;
  /** 累计因容量满而被拒绝的写入次数。 */
  readonly rejectCount: number;
  /** 累计因淘汰策略而被覆盖的条目次数。 */
  readonly evictionCount: number;
  /** 负载因子 = size / capacity。 */
  readonly loadFactor: number;
}
