<script setup lang="ts">
import { Check, CircleStop, ArrowRight } from '@lucide/vue';
import { computed } from 'vue';
import { REJECT_TEXT, promptButtonText } from '../lib/labels.ts';
import ConfirmButton from './ConfirmButton.vue';
import type { LiveSnapshot } from '../lib/live.ts';
import { buttonStates } from '../lib/live.ts';

const props = defineProps<{ live: LiveSnapshot; locked: boolean }>();
const emit = defineEmits<{ press: [kind: 'next' | 'done']; cancel: []; dismiss: [] }>();

const buttons = computed(() => buttonStates(props.live, props.locked));
const prompt = computed(() => props.live.prompt);
const pendingText = computed(() => {
  switch (props.live.pending?.action) {
    case 'cancel':
      return 'Cancelling…';
    case 'done':
      return 'Finishing…';
    case 'next':
      return 'Continuing…';
    default:
      return null;
  }
});
const active = computed(
  () => props.live.state === 'running' || props.live.state === 'awaiting-user',
);
</script>

<template>
  <section v-if="active" class="card p-4" aria-label="Controls">
    <div v-if="prompt" data-testid="prompt">
      <p class="m-0 text-sm font-semibold text-warning">Waiting for you on the PC</p>
      <p v-if="prompt.text" class="m-0 mt-1" data-testid="prompt-text">{{ prompt.text }}</p>
      <p v-if="prompt.blocking" class="m-0 mt-1 text-sm text-muted">
        The job is paused until this is answered.
      </p>
      <p v-else class="m-0 mt-1 text-sm text-muted">The job keeps running while this is open.</p>
    </div>
    <p v-else class="m-0 text-muted" data-testid="no-prompt">
      Nothing to answer right now. The buttons unlock when the PC asks.
    </p>

    <p
      v-if="live.rejected"
      class="mt-3 mb-0 flex items-start justify-between gap-3 rounded-lg bg-danger-bg p-3 text-danger"
      role="alert"
      data-testid="rejected"
    >
      <span>{{ REJECT_TEXT[live.rejected] }}</span>
      <button type="button" class="btn btn-icon" aria-label="Dismiss" @click="emit('dismiss')">
        OK
      </button>
    </p>

    <p v-if="pendingText" class="mt-3 mb-0 font-semibold" role="status" data-testid="pending">
      {{ pendingText }}
    </p>

    <div class="mt-4 flex flex-col gap-3 sm:flex-row">
      <button
        v-if="!prompt || prompt.expects === 'done'"
        type="button"
        class="btn btn-primary"
        :disabled="!buttons.primary"
        data-testid="finish"
        @click="prompt && emit('press', 'done')"
      >
        <Check :size="18" aria-hidden="true" />
        {{ prompt ? promptButtonText(prompt.labelId, 'done') : 'Finish' }}
      </button>
      <button
        v-if="!prompt || prompt.expects === 'next'"
        type="button"
        class="btn"
        :class="prompt ? 'btn-primary' : ''"
        :disabled="!buttons.primary"
        data-testid="next"
        @click="prompt && emit('press', 'next')"
      >
        <ArrowRight :size="18" aria-hidden="true" />
        {{ prompt ? promptButtonText(prompt.labelId, 'next') : 'Next' }}
      </button>
      <ConfirmButton
        label="Cancel job"
        confirm-label="Tap again to cancel"
        danger
        testid="cancel"
        :disabled="!buttons.cancel"
        @confirm="emit('cancel')"
      >
        <CircleStop :size="18" aria-hidden="true" />
      </ConfirmButton>
    </div>
  </section>
</template>
