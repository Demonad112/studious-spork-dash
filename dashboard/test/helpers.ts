import type {
  EventBody,
  EventFrame,
  Frame,
  ProgressFields,
  Snapshot,
} from '@remote-console/protocol';

export const JOB = 'a'.repeat(32);
export const PROMPT = 'b'.repeat(32);

export function progress(over: Partial<ProgressFields> = {}): ProgressFields {
  return {
    step: 'copying',
    percent: 10,
    filesDone: 1,
    filesTotal: 10,
    bytesDone: 1000,
    bytesTotal: 10_000,
    ok: 1,
    skipped: 0,
    failed: 0,
    ...over,
  };
}

export function ev(seq: number, body: EventBody): EventFrame {
  return { v: 1, type: 'event', seq, ...body } as EventFrame;
}

export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    type: 'snapshot',
    seq: 0,
    armed: true,
    state: 'idle',
    jobId: null,
    jobKind: null,
    progress: null,
    prompt: null,
    terminal: null,
    ...over,
  };
}

export const AUTH_OK: Frame = { v: 1, type: 'auth-ok', serverTimeMs: 1 };
