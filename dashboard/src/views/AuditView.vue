<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { ApiError, getAudit } from '../lib/api.ts';
import type { AuditRow } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { AUDIT_TEXT } from '../lib/labels.ts';

const props = defineProps<{ id: string }>();
const rows = ref<AuditRow[] | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    rows.value = await getAudit(props.id);
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 404
        ? 'This install no longer exists.'
        : 'Could not load the audit log.';
  }
});
</script>

<template>
  <div class="flex items-center gap-3">
    <RouterLink :to="`/i/${id}`" class="btn btn-icon" aria-label="Back"
      ><ArrowLeft :size="18" aria-hidden="true"
    /></RouterLink>
    <h1 class="page-title m-0">Audit log</h1>
  </div>
  <p v-if="error" class="m-0 rounded-lg bg-danger-bg p-3 text-danger" role="alert">{{ error }}</p>
  <p v-else-if="rows === null" class="m-0 text-muted">Loading…</p>
  <p v-else-if="rows.length === 0" class="m-0 text-muted" data-testid="empty">
    Nothing recorded yet.
  </p>
  <ul v-else class="card m-0 list-none p-0" data-testid="rows">
    <li
      v-for="r in rows"
      :key="r.id"
      class="flex flex-col gap-1 border-b border-stroke px-4 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
    >
      <time class="shrink-0 text-sm text-muted sm:w-44">{{ formatDateTime(r.ts) }}</time>
      <span class="font-semibold">{{ AUDIT_TEXT[r.code] ?? r.code }}</span>
      <span v-if="r.detail" class="text-sm text-muted">{{ r.detail }}</span>
    </li>
  </ul>
</template>
