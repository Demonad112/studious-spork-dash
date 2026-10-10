<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { computed } from 'vue';
import { formatBytes, formatCount, formatDuration, formatRate } from '../lib/format.ts';
import { JOB_KIND_TEXT, STEP_TEXT } from '../lib/labels.ts';
import type { LiveSnapshot } from '../lib/live.ts';

const props = defineProps<{ live: LiveSnapshot }>();

const p = computed(() => props.live.progress);
const stepText = computed(() => {
  const step = props.live.step ?? p.value?.step ?? null;
  return step === null ? 'Starting…' : STEP_TEXT[step];
});
const files = computed(() => {
  const v = p.value;
  if (v === null) return '—';
  return v.filesTotal === null
    ? `${formatCount(v.filesDone)} found`
    : `${formatCount(v.filesDone)} of ${formatCount(v.filesTotal)}`;
});
const size = computed(() => {
  const v = p.value;
  if (v === null) return '—';
  return v.bytesTotal === null
    ? formatBytes(v.bytesDone)
    : `${formatBytes(v.bytesDone)} of ${formatBytes(v.bytesTotal)}`;
});
const speed = computed(() => {
  const r = props.live.rate;
  if (r.bytesPerSecond === null) return '—';
  return formatRate(r.bytesPerSecond);
});
const left = computed(() => {
  const r = props.live.rate;
  return r.etaMs === null ? null : `${formatDuration(r.etaMs)} left`;
});
const notCopied = computed(() => p.value?.failed ?? 0);
const indeterminate = computed(() => p.value === null || p.value.percent === null);
const percent = computed(() => p.value?.percent ?? 0);
</script>

<template>
  <section class="card p-4" aria-label="Live progress">
    <div class="flex items-center justify-between gap-3">
      <p class="m-0 flex items-center gap-2 font-semibold">
        <LoaderCircle class="spin" :size="18" aria-hidden="true" />
        <span>{{ stepText }}</span>
      </p>
      <span v-if="live.jobKind" class="text-sm text-muted">{{ JOB_KIND_TEXT[live.jobKind] }}</span>
    </div>

    <div
      class="relative mt-3 h-1.5 overflow-hidden rounded-full bg-track"
      role="progressbar"
      aria-label="Progress"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="indeterminate ? undefined : percent"
      :aria-valuetext="indeterminate ? 'Total not known yet' : `${percent} percent`"
    >
      <div
        v-if="indeterminate"
        class="indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent"
        data-testid="bar-indeterminate"
      ></div>
      <div
        v-else
        class="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]"
        :style="{ width: `${percent}%` }"
        data-testid="bar-determinate"
      ></div>
    </div>

    <dl class="m-0 mt-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
      <div>
        <dt class="text-sm text-muted">Files</dt>
        <dd class="m-0 font-semibold" data-testid="files">{{ files }}</dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Size</dt>
        <dd class="m-0 font-semibold" data-testid="size">{{ size }}</dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Speed</dt>
        <dd class="m-0 font-semibold" data-testid="speed">
          {{ speed }}
          <span v-if="left" class="block text-sm font-normal text-muted" data-testid="left">{{
            left
          }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Not copied</dt>
        <dd
          class="m-0 font-semibold"
          :class="notCopied > 0 ? 'text-danger' : ''"
          data-testid="not-copied"
        >
          {{ formatCount(notCopied) }}
        </dd>
      </div>
    </dl>
  </section>
</template>
