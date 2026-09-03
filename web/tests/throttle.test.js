import { describe, it, expect, vi } from 'vitest';
import { throttle, debounce } from '../src/util/throttle.js';

describe('throttle', () => {
  it('默认 trailing：第一次立即调用，后续节流到 wait 末', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(); t(); t();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('leading=false：第一次延后到 wait', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100, { leading: false });
    t();
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('debounce', () => {
  it('连续触发只在 wait 静默后调用一次', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d(); d(); d();
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
