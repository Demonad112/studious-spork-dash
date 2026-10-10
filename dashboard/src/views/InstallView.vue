<script setup lang="ts">
import { ArrowLeft, History, KeyRound, Lock, LockOpen, Pencil, Trash2 } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { ApiError, installAction, listInstalls, renameInstall } from '../lib/api.ts';
import type { InstallSummary } from '../lib/api.ts';
import { useNow } from '../lib/clock.ts';
import { formatDuration } from '../lib/format.ts';
import { LiveSession } from '../lib/live.ts';
import { LiveConnection } from '../lib/socket.ts';
import { installStatus } from '../lib/status.ts';
import ConfirmButton from '../components/ConfirmButton.vue';
import ConnectionIndicator from '../components/ConnectionIndicator.vue';
import ProgressPanel from '../components/ProgressPanel.vue';
import PromptCard from '../components/PromptCard.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SummaryCard from '../components/SummaryCard.vue';
import { useRouter } from 'vue-router';

const props = defineProps<{ id: string }>();
const router = useRouter();
const { now } = useNow();

const session = new LiveSession();
const live = shallowRef(session.current);
const install = ref<InstallSummary | null>(null);
const missing = ref(false);
const manageError = ref<string | null>(null);
const newName = ref('');
let summaryTimer: ReturnType<typeof setInterval> | null = null;

function publish(): void {
  live.value = session.current;
}

const connection = new LiveConnection({
  installId: props.id,
  lastSeq: () => session.lastSeq,
  handlers: {
    onConnected: () => {
      session.setConnection('live', Date.now());
      publish();
    },
    onDisconnected: () => {
      session.setConnection('reconnecting', Date.now());
      publish();
    },
    onFrame: (frame) => {
      const outcome = session.apply(frame, Date.now());
      publish();
      if (outcome.resync) connection.requestResync();
    },
    onFatal: publish,
  },
});

async function loadSummary(): Promise<void> {
  try {
    const found = (await listInstalls()).find((i) => i.installId === props.id) ?? null;
    install.value = found;
    missing.value = found === null;
    if (found !== null && newName.value === '') newName.value = found.displayName;
  } catch {
    // The live socket still works; the summary retries on the next tick.
  }
}

onMounted(() => {
  void loadSummary();
  summaryTimer = setInterval(() => void loadSummary(), 10_000);
  connection.start();
});
onBeforeUnmount(() => {
  connection.stop();
  if (summaryTimer !== null) clearInterval(summaryTimer);
});

const locked = computed(
  () => install.value?.locked === true || install.value?.live.locked === true,
);
const statusKind = computed(() =>
  install.value === null ? 'offline' : installStatus(install.value),
);
const agentConnected = computed(() => install.value?.live.connected ?? live.value.armed);
const expiresIn = computed(() => {
  const at = live.value.expiresAtMs;
  if (at === null || !live.value.armed) return null;
  return Math.max(0, at - (now.value ?? 0));
});

function press(kind: 'next' | 'done'): void {
  const promptId = live.value.prompt?.promptId;
  if (promptId === undefined) return;
  const id = connection.sendAction(kind, promptId);
  if (id === null) return;
  session.startPending(id, kind, promptId);
  publish();
}

function cancel(): void {
  const id = connection.sendAction('cancel');
  if (id === null) return;
  session.startPending(id, 'cancel');
  publish();
}

async function manage(run: () => Promise<unknown>): Promise<void> {
  manageError.value = null;
  try {
    await run();
    await loadSummary();
  } catch (e) {
    manageError.value =
      e instanceof ApiError && e.status === 404
        ? 'This install no longer exists.'
        : 'That did not work. Try again.';
  }
}

async function remove(): Promise<void> {
  await manage(() => installAction(props.id, 'delete'));
  if (manageError.value === null) await router.replace('/');
}
</script>

<template>
  <div class="flex items-center gap-3">
    <RouterLink to="/" class="btn btn-icon" aria-label="Back to installs">
      <ArrowLeft :size="18" aria-hidden="true" />
    </RouterLink>
    <h1 class="page-title m-0 min-w-0 truncate" data-testid="name">
      {{ install?.displayName ?? 'Install' }}
    </h1>
  </div>

  <p v-if="missing" class="m-0 rounded-lg bg-danger-bg p-3 text-danger" role="alert">
    This install does not exist. <RouterLink to="/">Back to installs</RouterLink>
  </p>

  <div class="grid gap-4 lg:grid-cols-[1fr_360px]">
    <div class="flex min-w-0 flex-col gap-4">
      <section class="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div class="flex flex-col gap-2">
          <StatusBadge :kind="statusKind" />
          <ConnectionIndicator
            :connection="live.connection"
            :agent-connected="agentConnected"
            :last-heard-ms="live.lastHeardMs"
            :last-seen-ms="install?.live.lastSeenMs ?? null"
            :now-ms="now ?? 0"
          />
        </div>
        <p v-if="live.armed" class="m-0 text-sm text-muted" data-testid="armed-info">
          {{ live.viewers }} {{ live.viewers === 1 ? 'dashboard' : 'dashboards' }} attached<template
            v-if="expiresIn !== null"
            >, remote control ends in {{ formatDuration(expiresIn) }}</template
          >
        </p>
      </section>

      <p
        v-if="live.connection === 'fatal'"
        class="m-0 rounded-lg bg-danger-bg p-3 text-danger"
        role="alert"
      >
        The relay refused this connection ({{ live.fatalCode }}). Reload the page to try again.
      </p>

      <ProgressPanel
        v-if="live.state === 'running' || live.state === 'awaiting-user'"
        :live="live"
      />
      <section v-else-if="!live.terminal" class="card p-4" data-testid="idle">
        <p class="m-0 font-semibold">
          {{ live.armed ? 'Armed. Waiting for a job.' : 'Remote control is off on the PC.' }}
        </p>
        <p class="m-0 mt-1 text-muted">
          {{
            live.armed
              ? 'Progress appears here as soon as the app starts a job.'
              : 'Turn it on in the app to watch and control a job from here.'
          }}
        </p>
      </section>
      <SummaryCard
        v-if="live.terminal && live.state !== 'running' && live.state !== 'awaiting-user'"
        :terminal="live.terminal"
      />

      <PromptCard
        :live="live"
        :locked="locked"
        @press="press"
        @cancel="cancel"
        @dismiss="
          session.dismissRejection();
          publish();
        "
      />
    </div>

    <aside class="card flex flex-col gap-3 p-4" aria-label="Manage this install">
      <h2 class="m-0 text-base font-semibold">Manage</h2>
      <RouterLink :to="`/i/${id}/audit`" class="btn"
        ><History :size="18" aria-hidden="true" />Audit log</RouterLink
      >
      <p v-if="install?.fingerprint" class="m-0 text-sm text-muted">
        Key fingerprint<br /><span class="font-mono text-text">{{ install.fingerprint }}</span>
      </p>

      <form class="flex gap-2" @submit.prevent="manage(() => renameInstall(id, newName.trim()))">
        <input v-model="newName" class="field" maxlength="40" aria-label="Display name" />
        <button
          type="submit"
          class="btn btn-icon"
          aria-label="Rename"
          :disabled="newName.trim() === ''"
        >
          <Pencil :size="18" aria-hidden="true" />
        </button>
      </form>

      <ConfirmButton
        v-if="!locked"
        label="Revoke"
        confirm-label="Tap again to revoke"
        danger
        testid="revoke"
        @confirm="manage(() => installAction(id, 'revoke'))"
      >
        <Lock :size="18" aria-hidden="true" />
      </ConfirmButton>
      <button
        v-else
        type="button"
        class="btn"
        data-testid="unlock"
        @click="manage(() => installAction(id, 'unlock'))"
      >
        <LockOpen :size="18" aria-hidden="true" />Unlock
      </button>
      <ConfirmButton
        label="Rotate key"
        confirm-label="Tap again to rotate"
        testid="rotate"
        @confirm="manage(() => installAction(id, 'rotate'))"
      >
        <KeyRound :size="18" aria-hidden="true" />
      </ConfirmButton>
      <ConfirmButton
        label="Delete install"
        confirm-label="Tap again to delete"
        danger
        testid="delete"
        @confirm="remove"
      >
        <Trash2 :size="18" aria-hidden="true" />
      </ConfirmButton>
      <p v-if="manageError" class="m-0 rounded-lg bg-danger-bg p-3 text-danger" role="alert">
        {{ manageError }}
      </p>
    </aside>
  </div>
</template>
