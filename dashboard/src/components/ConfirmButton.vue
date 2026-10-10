<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
  testid?: string;
}>();
const emit = defineEmits<{ confirm: [] }>();

const armed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function disarm(): void {
  armed.value = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function press(): void {
  if (props.disabled) return;
  if (armed.value) {
    disarm();
    emit('confirm');
    return;
  }
  armed.value = true;
  timer = setTimeout(disarm, 4000);
}

onBeforeUnmount(disarm);
</script>

<template>
  <button
    type="button"
    class="btn"
    :class="{ 'btn-danger': danger }"
    :disabled="disabled"
    :data-testid="testid"
    @click="press"
    @blur="disarm"
  >
    <slot />
    {{ armed ? confirmLabel : label }}
  </button>
</template>
