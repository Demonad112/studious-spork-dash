<script setup lang="ts">
import { computed } from 'vue';
import { STATUS_KIND_TEXT } from '../lib/status.ts';
import type { InstallStatusKind } from '../lib/status.ts';

const props = defineProps<{ kind: InstallStatusKind }>();

const tone = computed(() => {
  switch (props.kind) {
    case 'armed':
    case 'running':
      return 'text-success';
    case 'waiting':
      return 'text-warning';
    case 'revoked':
      return 'text-danger bg-danger-bg';
    default:
      return 'text-muted';
  }
});
</script>

<template>
  <span
    class="inline-flex items-center gap-2 rounded-full border border-stroke px-3 py-1 text-sm font-semibold"
    :class="tone"
  >
    <span class="inline-block size-2 rounded-full bg-current" aria-hidden="true"></span>
    {{ STATUS_KIND_TEXT[kind] }}
  </span>
</template>
