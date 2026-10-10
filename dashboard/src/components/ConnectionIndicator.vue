<script setup lang="ts">
import { Wifi, WifiOff } from '@lucide/vue';
import { computed } from 'vue';
import { timeAgo } from '../lib/format.ts';
import type { ConnectionState } from '../lib/live.ts';

const props = defineProps<{
  connection: ConnectionState;
  agentConnected: boolean;
  lastHeardMs: number | null;
  lastSeenMs: number | null;
  nowMs: number;
}>();

const text = computed(() => {
  if (props.connection === 'fatal') return 'Cannot connect to the relay';
  if (props.connection !== 'live')
    return props.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  if (props.agentConnected) return 'PC connected';
  return props.lastSeenMs === null
    ? 'PC offline'
    : `PC offline, last seen ${timeAgo(props.lastSeenMs, props.nowMs)}`;
});
const good = computed(() => props.connection === 'live' && props.agentConnected);
</script>

<template>
  <p class="m-0 flex items-center gap-2 text-sm" :class="good ? 'text-success' : 'text-muted'">
    <Wifi v-if="good" :size="16" aria-hidden="true" />
    <WifiOff v-else :size="16" aria-hidden="true" />
    <span role="status">{{ text }}</span>
  </p>
</template>
