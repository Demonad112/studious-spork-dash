<script setup lang="ts">
import { ChevronRight, Plus } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, listInstalls } from '../lib/api.ts';
import type { InstallSummary } from '../lib/api.ts';
import { useNow } from '../lib/clock.ts';
import { timeAgo } from '../lib/format.ts';
import { installStatus } from '../lib/status.ts';
import StatusBadge from '../components/StatusBadge.vue';

const installs = ref<InstallSummary[] | null>(null);
const error = ref<string | null>(null);
const { now } = useNow();
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    installs.value = await listInstalls();
    error.value = null;
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 401
        ? 'Not signed in. Reload the page to sign in through Cloudflare Access.'
        : 'Could not load installs. Retrying…';
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});

const rows = computed(() =>
  (installs.value ?? []).map((i) => ({
    i,
    kind: installStatus(i),
    seen:
      i.live.lastSeenMs === null
        ? 'never connected'
        : `last seen ${timeAgo(i.live.lastSeenMs, now.value ?? 0)}`,
  })),
);
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <h1 class="page-title m-0">Installs</h1>
    <RouterLink to="/pair" class="btn btn-primary"
      ><Plus :size="18" aria-hidden="true" />Pair a PC</RouterLink
    >
  </div>

  <p v-if="error" class="m-0 rounded-lg bg-danger-bg p-3 text-danger" role="alert">{{ error }}</p>
  <p v-if="installs === null && !error" class="m-0 text-muted">Loading…</p>
  <section
    v-else-if="installs !== null && installs.length === 0"
    class="card p-6"
    data-testid="empty"
  >
    <p class="m-0 font-semibold">No PCs are paired yet.</p>
    <p class="m-0 mt-1 text-muted">
      Arm remote control in the app on the PC, copy the pairing code it shows, then press “Pair a
      PC”.
    </p>
  </section>

  <ul class="m-0 grid list-none gap-3 p-0 md:grid-cols-2 lg:grid-cols-3">
    <li v-for="r in rows" :key="r.i.installId">
      <RouterLink
        :to="`/i/${r.i.installId}`"
        class="card flex min-h-[44px] items-center justify-between gap-3 p-4 text-text no-underline hover:bg-card-hover"
        data-testid="install"
      >
        <span class="flex min-w-0 flex-col gap-2">
          <span class="truncate font-semibold">{{ r.i.displayName }}</span>
          <StatusBadge :kind="r.kind" />
          <span class="text-sm text-muted">{{ r.seen }}</span>
        </span>
        <ChevronRight :size="20" class="shrink-0 text-faint" aria-hidden="true" />
      </RouterLink>
    </li>
  </ul>
</template>
