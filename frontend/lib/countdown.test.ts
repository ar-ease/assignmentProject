import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCountdown, formatCountdown } from './countdown';

afterEach(() => vi.useRealTimers());

describe('monotonic countdown', () => {
  it('counts elapsed monotonic time and rounds partial seconds up', () => {
    let now = 5_000;
    const countdown = createCountdown(() => now);
    countdown.sync(120);
    expect(countdown.remaining()).toBe(120);
    now += 1_250;
    expect(countdown.remaining()).toBe(119);
    now += 750;
    expect(countdown.remaining()).toBe(118);
    expect(formatCountdown(countdown.remaining())).toBe('01:58');
    expect(formatCountdown(5)).toBe('00:05');
  });

  it('replaces the deadline when a fresh server value arrives', () => {
    let now = 1_000;
    const countdown = createCountdown(() => now);
    countdown.sync(120);
    now += 30_000;
    expect(countdown.remaining()).toBe(90);
    countdown.sync(45);
    expect(countdown.remaining()).toBe(45);
    now += 1_000;
    expect(countdown.remaining()).toBe(44);
  });

  it('clamps at zero even long after the deadline', () => {
    let now = 0;
    const countdown = createCountdown(() => now);
    countdown.sync(2);
    now = 2_000;
    expect(countdown.remaining()).toBe(0);
    now = 999_999;
    expect(countdown.remaining()).toBe(0);
    countdown.sync(0);
    expect(countdown.remaining()).toBe(0);
  });

  it.each([10, -10])('ignores a wall clock skew of %i minutes', (minutes) => {
    vi.useFakeTimers();
    const wallTime = new Date('2026-10-24T12:00:00Z');
    vi.setSystemTime(wallTime);
    let monotonicTime = 4_000;
    const countdown = createCountdown(() => monotonicTime);
    countdown.sync(120);
    monotonicTime += 12_500;
    expect(countdown.remaining()).toBe(108);
    vi.setSystemTime(wallTime.getTime() + minutes * 60_000);
    expect(countdown.remaining()).toBe(108);
    monotonicTime += 1_000;
    expect(countdown.remaining()).toBe(107);
  });
});
