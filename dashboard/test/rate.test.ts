import { describe, expect, it } from 'vitest';
import { RateTracker } from '../src/lib/rate.ts';

describe('rate tracker', () => {
  it('shows nothing before a second of samples exists', () => {
    const r = new RateTracker();
    r.push(0, 0);
    r.push(500, 500);
    expect(r.read(10_000)).toEqual({ bytesPerSecond: null, etaMs: null });
  });

  it('shows a speed after one second and a time left after three', () => {
    const r = new RateTracker();
    r.push(0, 0);
    r.push(1000, 1000);
    expect(r.read(10_000).bytesPerSecond).toBeCloseTo(1000);
    expect(r.read(10_000).etaMs).toBeNull();
    r.push(3000, 3000);
    expect(r.read(10_000).etaMs).toBeCloseTo(7000);
  });

  it('gives no time left when the total is unknown', () => {
    const r = new RateTracker();
    r.push(0, 0);
    r.push(4000, 4000);
    expect(r.read(null).etaMs).toBeNull();
  });

  it('starts again when the byte count goes backwards', () => {
    const r = new RateTracker();
    r.push(0, 0);
    r.push(2000, 2000);
    r.push(3000, 0);
    expect(r.read(10_000)).toEqual({ bytesPerSecond: null, etaMs: null });
  });

  it('uses only the last ten seconds', () => {
    const r = new RateTracker();
    r.push(0, 0);
    r.push(5000, 50_000);
    r.push(20_000, 50_100);
    r.push(21_000, 50_200);
    expect(r.read(null).bytesPerSecond).toBeLessThan(200);
  });
});
