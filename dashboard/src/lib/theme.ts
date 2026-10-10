import { ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'rc-theme';
const ORDER: ThemeMode[] = ['system', 'light', 'dark'];

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const themeMode = ref<ThemeMode>('system');

/** The theme the page shows right now. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode, systemDark());
}

export function initTheme(): void {
  themeMode.value = stored();
  applyTheme(themeMode.value);
  if (typeof matchMedia === 'function')
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (themeMode.value === 'system') applyTheme('system');
    });
}

export function cycleTheme(): void {
  const next = ORDER[(ORDER.indexOf(themeMode.value) + 1) % ORDER.length]!;
  themeMode.value = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage can be blocked; the theme still applies for this visit.
  }
  applyTheme(next);
}
