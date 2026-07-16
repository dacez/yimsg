import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../../src/internal/events';

// Expose emit for testing
class TestEmitter extends EventEmitter<{
  foo: (x: number) => void;
  bar: (a: string, b: string) => void;
}> {
  public emit<K extends 'foo' | 'bar'>(event: K, ...args: Parameters<{ foo: (x: number) => void; bar: (a: string, b: string) => void }[K]>) {
    super.emit(event, ...args);
  }
}

describe('EventEmitter', () => {
  it('on / emit', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.on('foo', fn);
    emitter.emit('foo', 42);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('off removes listener', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.on('foo', fn);
    emitter.off('foo', fn);
    emitter.emit('foo', 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('once fires only once', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.once('foo', fn);
    emitter.emit('foo', 1);
    emitter.emit('foo', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('multiple listeners', () => {
    const emitter = new TestEmitter();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('foo', fn1);
    emitter.on('foo', fn2);
    emitter.emit('foo', 10);
    expect(fn1).toHaveBeenCalledWith(10);
    expect(fn2).toHaveBeenCalledWith(10);
  });

  it('removeAllListeners for specific event', () => {
    const emitter = new TestEmitter();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('foo', fn1);
    emitter.on('bar', fn2);
    emitter.removeAllListeners('foo');
    emitter.emit('foo', 1);
    emitter.emit('bar', 'a', 'b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledWith('a', 'b');
  });

  it('removeAllListeners clears all', () => {
    const emitter = new TestEmitter();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('foo', fn1);
    emitter.on('bar', fn2);
    emitter.removeAllListeners();
    emitter.emit('foo', 1);
    emitter.emit('bar', 'a', 'b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('emit with no listeners does not throw', () => {
    const emitter = new TestEmitter();
    expect(() => emitter.emit('foo', 1)).not.toThrow();
  });

  it('multi-arg event', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.on('bar', fn);
    emitter.emit('bar', 'hello', 'world');
    expect(fn).toHaveBeenCalledWith('hello', 'world');
  });
});
