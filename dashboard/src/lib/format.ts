/** Display helpers. Pure functions: no clock, no locale surprises beyond `Intl`. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-CA').format(n);
}

/** "42 s", "3 min 05 s", "2 h 04 min". Rounds down to whole seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  if (h > 0) return `${h} h ${two(m)} min`;
  if (m > 0) return `${m} min ${two(s)} s`;
  return `${s} s`;
}

/** "just now", "12 s ago", "4 min ago", "3 h ago", "2 d ago". */
export function timeAgo(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-CA', { hour12: false });
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-CA', { hour12: false })}`;
}
