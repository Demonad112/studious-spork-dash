/**
 * Speed and time left, worked out here from byte deltas. The agent never sends them.
 * Samples carry the dashboard's own receive time, so clock differences do not matter.
 */

export const SPEED_AFTER_MS = 1000;
export const ETA_AFTER_MS = 3000;
const WINDOW_MS = 10_000;

interface Sample {
  atMs: number;
  bytes: number;
}

export interface Rate {
  /** Bytes per second, or null until a second of samples exists. */
  bytesPerSecond: number | null;
  /** Milliseconds left, or null until three seconds of samples exist or the total is unknown. */
  etaMs: number | null;
}

export class RateTracker {
  private samples: Sample[] = [];
  private firstMs = 0;

  reset(): void {
    this.samples = [];
    this.firstMs = 0;
  }

  /** Records a sample. A byte count that goes backwards starts a fresh window. */
  push(atMs: number, bytes: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last === undefined || bytes < last.bytes) {
      this.samples = [];
      this.firstMs = atMs;
    }
    this.samples.push({ atMs, bytes });
    const cutoff = atMs - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]!.atMs <= cutoff) this.samples.shift();
  }

  read(bytesTotal: number | null): Rate {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined) return { bytesPerSecond: null, etaMs: null };
    const spanMs = last.atMs - first.atMs;
    const sinceStart = last.atMs - this.firstMs;
    if (spanMs <= 0 || sinceStart < SPEED_AFTER_MS) return { bytesPerSecond: null, etaMs: null };
    const bytesPerSecond = ((last.bytes - first.bytes) / spanMs) * 1000;
    let etaMs: number | null = null;
    if (sinceStart >= ETA_AFTER_MS && bytesTotal !== null && bytesPerSecond > 0)
      etaMs = (Math.max(0, bytesTotal - last.bytes) / bytesPerSecond) * 1000;
    return { bytesPerSecond, etaMs };
  }
}
