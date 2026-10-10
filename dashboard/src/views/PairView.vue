<script setup lang="ts">
import { normalizePairingCode } from '@remote-console/protocol';
import { ArrowLeft, ShieldCheck } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { ApiError, approvePairing, lookupPairing } from '../lib/api.ts';

const typed = ref('');
const found = ref<{ fingerprint: string; rekey: boolean } | null>(null);
const name = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const done = ref<'approved' | 'rejected' | null>(null);

const code = computed(() => normalizePairingCode(typed.value));
const nameOk = computed(() => {
  const n = name.value.trim();
  // eslint-disable-next-line no-control-regex
  return [...n].length >= 1 && [...n].length <= 40 && !/[\u0000-\u001f\u007f]/.test(n);
});

async function lookup(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const r = await lookupPairing(code.value);
    found.value = { fingerprint: r.fingerprint, rekey: r.rekey };
  } catch (e) {
    found.value = null;
    error.value =
      e instanceof ApiError && e.status === 404
        ? 'That code was not found or has expired. Ask the PC for a new one.'
        : e instanceof ApiError && e.status === 400
          ? 'That does not look like a pairing code.'
          : 'Could not reach the relay. Try again.';
  } finally {
    busy.value = false;
  }
}

async function decide(approve: boolean): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await approvePairing(
      code.value,
      approve ? name.value.trim() : name.value.trim() || 'rejected',
      approve,
    );
    done.value = approve ? 'approved' : 'rejected';
  } catch {
    error.value = 'That did not work. The code may have expired. Ask the PC for a new one.';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  // A QR code opens /pair#<code>. The fragment never reaches a server log; clear it from the URL.
  const fromHash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (fromHash !== '') {
    typed.value = fromHash;
    history.replaceState(null, '', location.pathname);
    void lookup();
  }
});
</script>

<template>
  <div class="flex items-center gap-3">
    <RouterLink to="/" class="btn btn-icon" aria-label="Back"
      ><ArrowLeft :size="18" aria-hidden="true"
    /></RouterLink>
    <h1 class="page-title m-0">Pair a PC</h1>
  </div>

  <section v-if="done" class="card p-4" data-testid="done">
    <p class="m-0 font-semibold" :class="done === 'approved' ? 'text-success' : 'text-muted'">
      {{
        done === 'approved'
          ? 'Approved. The PC will connect the next time remote control is armed.'
          : 'Rejected.'
      }}
    </p>
    <RouterLink to="/" class="btn btn-primary mt-4">Back to installs</RouterLink>
  </section>

  <form v-else-if="!found" class="card flex max-w-xl flex-col gap-3 p-4" @submit.prevent="lookup">
    <label for="code" class="font-semibold">Pairing code from the PC</label>
    <input
      id="code"
      v-model="typed"
      class="field"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      inputmode="text"
      placeholder="ABCD-1234"
      aria-describedby="code-help"
    />
    <p id="code-help" class="m-0 text-sm text-muted">
      Eight characters. Spaces and hyphens are ignored. Codes expire after a few minutes.
    </p>
    <p v-if="error" class="m-0 rounded-lg bg-danger-bg p-3 text-danger" role="alert">{{ error }}</p>
    <button
      type="submit"
      class="btn btn-primary"
      :disabled="busy || code.length !== 8"
      data-testid="lookup"
    >
      Look up
    </button>
  </form>

  <section v-else class="card flex max-w-xl flex-col gap-3 p-4" data-testid="found">
    <p class="m-0 flex items-center gap-2 font-semibold">
      <ShieldCheck :size="18" aria-hidden="true" />
      Check this matches the PC
    </p>
    <p class="m-0 text-sm text-muted">
      The PC shows the same key fingerprint. Approve only if they match.
    </p>
    <p
      class="m-0 break-all rounded-lg bg-subtle p-3 font-mono text-lg font-semibold"
      data-testid="fingerprint"
    >
      {{ found.fingerprint }}
    </p>
    <p v-if="found.rekey" class="m-0 rounded-lg bg-subtle p-3 text-warning" data-testid="rekey">
      This PC is already paired. Approving replaces its key.
    </p>
    <label for="name" class="font-semibold">Name for this PC</label>
    <input
      id="name"
      v-model="name"
      class="field"
      maxlength="40"
      autocomplete="off"
      placeholder="Front desk PC"
    />
    <p v-if="error" class="m-0 rounded-lg bg-danger-bg p-3 text-danger" role="alert">{{ error }}</p>
    <div class="flex flex-col gap-3 sm:flex-row">
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy || !nameOk"
        data-testid="approve"
        @click="decide(true)"
      >
        Approve
      </button>
      <button
        type="button"
        class="btn btn-danger"
        :disabled="busy"
        data-testid="reject"
        @click="decide(false)"
      >
        Reject
      </button>
    </div>
  </section>
</template>
