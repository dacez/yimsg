export function freezeObject<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function freezeArray<T>(items: T[]): ReadonlyArray<T> {
  return Object.freeze(items);
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  private readonly inner: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]> | Map<K, V>) {
    this.inner = entries instanceof Map ? new Map(entries) : new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.inner.size;
  }

  get(key: K): V | undefined {
    return this.inner.get(key);
  }

  has(key: K): boolean {
    return this.inner.has(key);
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.inner.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  entries(): MapIterator<[K, V]> {
    return this.inner.entries();
  }

  keys(): MapIterator<K> {
    return this.inner.keys();
  }

  values(): MapIterator<V> {
    return this.inner.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlyMap';
  }
}

export function freezeMap<K, V>(entries: Iterable<readonly [K, V]> | Map<K, V>): ReadonlyMap<K, V> {
  return new ReadonlyMapView(entries);
}
