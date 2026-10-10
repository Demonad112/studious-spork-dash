<script setup lang="ts">
import { Radio } from '@lucide/vue';
import ThemeToggle from './components/ThemeToggle.vue';
</script>

<template>
  <div class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-4 py-4">
    <header class="flex items-center justify-between gap-3">
      <RouterLink to="/" class="flex items-center gap-2 text-text no-underline">
        <Radio :size="22" aria-hidden="true" />
        <span class="font-semibold">Remote console</span>
      </RouterLink>
      <ThemeToggle />
    </header>
    <main class="flex flex-1 flex-col gap-4">
      <RouterView />
    </main>
  </div>
</template>
