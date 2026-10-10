import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, timeAgo } from '../src/lib/format.ts';

describe('format', () => {
  it('writes byte sizes with a sensible number of digits', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15.0 MB');
    expect(formatBytes(300 * 1024 ** 3)).toBe('300 GB');
  });

  it('writes durations in the two biggest units', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(7_440_000)).toBe('2 h 04 min');
  });

  it('writes how long ago something was', () => {
    expect(timeAgo(1000, 2000)).toBe('just now');
    expect(timeAgo(0, 90_000)).toBe('1 min ago');
  });
});
