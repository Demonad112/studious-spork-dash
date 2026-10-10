<script setup lang="ts">
import { Monitor, Moon, Sun } from '@lucide/vue';
import { computed } from 'vue';
import { cycleTheme, themeMode } from '../lib/theme.ts';

const label = computed(
  () => ({ system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' })[themeMode.value],
);
</script>

<template>
  <button
    type="button"
    class="btn btn-icon"
    :aria-label="label + '. Press to change.'"
    :title="label"
    @click="cycleTheme"
  >
    <Monitor v-if="themeMode === 'system'" :size="18" aria-hidden="true" />
    <Sun v-else-if="themeMode === 'light'" :size="18" aria-hidden="true" />
    <Moon v-else :size="18" aria-hidden="true" />
  </button>
</template>
