import { onScopeDispose, ref } from 'vue';

/** A reactive "now" that ticks once a second, for "x s ago" and countdowns. */
export function useNow(): { now: ReturnType<typeof ref<number>> } {
  const now = ref(Date.now());
  const id = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  onScopeDispose(() => clearInterval(id));
  return { now };
}
