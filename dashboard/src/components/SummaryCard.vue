<script setup lang="ts">
import { CircleAlert, CircleCheck } from '@lucide/vue';
import { computed } from 'vue';
import { formatBytes, formatCount, formatDuration } from '../lib/format.ts';
import { FAILURE_TEXT, STATUS_TEXT } from '../lib/labels.ts';
import type { TerminalInfo } from '@remote-console/protocol';

const props = defineProps<{ terminal: TerminalInfo }>();

const s = computed(() => props.terminal.summary ?? null);
const bad = computed(
  () => props.terminal.status !== 'completed' || (s.value !== null && s.value.failed > 0),
);
const headline = computed(() => {
  if (props.terminal.status !== 'completed') return STATUS_TEXT[props.terminal.status];
  if (s.value === null) return 'Completed';
  return s.value.failed > 0
    ? `${formatCount(s.value.failed)} ${s.value.failed === 1 ? 'item' : 'items'} not copied`
    : 'All copied';
});
</script>

<template>
  <section class="card p-4" aria-label="Result" data-testid="summary">
    <p
      class="m-0 flex items-center gap-2 font-semibold"
      :class="bad ? 'text-danger' : 'text-success'"
    >
      <CircleAlert v-if="bad" :size="18" aria-hidden="true" />
      <CircleCheck v-else :size="18" aria-hidden="true" />
      <span data-testid="headline">{{ headline }}</span>
    </p>
    <p v-if="terminal.failureCode" class="m-0 mt-1 text-muted">
      {{ FAILURE_TEXT[terminal.failureCode] }}
    </p>
    <dl v-if="s" class="m-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
      <div>
        <dt class="text-sm text-muted">Planned</dt>
        <dd class="m-0 font-semibold">
          {{ formatCount(s.filesPlanned) }} files, {{ formatBytes(s.bytesPlanned) }}
        </dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Copied</dt>
        <dd class="m-0 font-semibold">{{ formatCount(s.ok) }}, {{ formatBytes(s.okBytes) }}</dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Skipped identical</dt>
        <dd class="m-0 font-semibold">{{ formatCount(s.skipped) }}</dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Not copied</dt>
        <dd class="m-0 font-semibold" :class="s.failed > 0 ? 'text-danger' : ''">
          {{ formatCount(s.failed) }}, {{ formatBytes(s.failedBytes) }}
        </dd>
      </div>
      <div>
        <dt class="text-sm text-muted">Took</dt>
        <dd class="m-0 font-semibold">{{ formatDuration(s.durationMs) }}</dd>
      </div>
    </dl>
  </section>
</template>
