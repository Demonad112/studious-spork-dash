import { describe, expect, it } from 'vitest';
import { LiveSession, buttonStates } from '../src/lib/live.ts';
import { AUTH_OK, JOB, PROMPT, ev, progress, snap } from './helpers.ts';

function started(): LiveSession {
  const s = new LiveSession();
  s.apply(AUTH_OK, 0);
  s.apply(snap({ seq: 0 }), 0);
  s.apply(ev(1, { kind: 'job-started', jobId: JOB, jobKind: 'simulated' }), 0);
  return s;
}

describe('live session', () => {
  it('a snapshot replaces the whole view and sets the sequence number', () => {
    const s = new LiveSession();
    s.apply(AUTH_OK, 0);
    s.apply(
      snap({ seq: 7, state: 'running', jobId: JOB, jobKind: 'record-copy', progress: progress() }),
      5,
    );
    expect(s.current.lastSeq).toBe(7);
    expect(s.current.state).toBe('running');
    expect(s.current.progress?.filesDone).toBe(1);
    expect(s.current.step).toBe('copying');
  });

  it('events that arrive in order move the state machine', () => {
    const s = started();
    expect(s.current.state).toBe('running');
    s.apply(
      ev(2, {
        kind: 'prompt-opened',
        promptId: PROMPT,
        expects: 'done',
        labelId: 'continue',
        blocking: false,
      }),
      0,
    );
    expect(s.current.state).toBe('awaiting-user');
    expect(s.current.prompt?.promptId).toBe(PROMPT);
    s.apply(ev(3, { kind: 'prompt-closed', promptId: PROMPT, reason: 'answered-local' }), 0);
    expect(s.current.state).toBe('running');
    expect(s.current.prompt).toBeNull();
  });

  it('a duplicate or old event is ignored', () => {
    const s = started();
    const out = s.apply(ev(1, { kind: 'job-started', jobId: 'c'.repeat(32), jobKind: 'other' }), 0);
    expect(out.resync).toBe(false);
    expect(s.current.jobId).toBe(JOB);
  });

  it('a skipped sequence number asks for a resync and changes nothing', () => {
    const s = started();
    const out = s.apply(ev(3, { kind: 'step', step: 'finishing' }), 0);
    expect(out.resync).toBe(true);
    expect(s.current.lastSeq).toBe(1);
  });

  it('an event before any snapshot asks for a resync', () => {
    const s = new LiveSession();
    expect(s.apply(ev(1, { kind: 'job-started', jobId: JOB, jobKind: 'other' }), 0).resync).toBe(
      true,
    );
  });

  it('progress never consumes a sequence number and is always taken', () => {
    const s = started();
    s.apply(ev(1, { kind: 'progress', ...progress({ percent: 20 }) }), 0);
    s.apply(ev(1, { kind: 'progress', ...progress({ percent: 30 }) }), 0);
    expect(s.current.progress?.percent).toBe(30);
    expect(s.current.lastSeq).toBe(1);
    expect(s.apply(ev(2, { kind: 'step', step: 'finishing' }), 0).resync).toBe(false);
  });

  it('a step named done is not terminal', () => {
    const s = started();
    s.apply(ev(2, { kind: 'step', step: 'done' }), 0);
    expect(s.current.state).toBe('running');
    expect(s.current.terminal).toBeNull();
  });

  it('only a status event ends the job and the summary stays afterwards', () => {
    const s = started();
    s.apply(
      ev(2, {
        kind: 'status',
        status: 'completed',
        summary: {
          filesPlanned: 3,
          bytesPlanned: 30,
          ok: 2,
          okBytes: 20,
          skipped: 0,
          failed: 1,
          failedBytes: 10,
          durationMs: 1000,
        },
      }),
      0,
    );
    expect(s.current.state).toBe('completed');
    expect(s.current.terminal?.summary?.failed).toBe(1);
    s.apply(
      { v: 1, type: 'event', seq: 0, kind: 'armed-state', armed: false, expiresAtMs: null },
      0,
    );
    expect(s.current.terminal?.status).toBe('completed');
  });

  it('a new job clears the previous terminal summary', () => {
    const s = started();
    s.apply(ev(2, { kind: 'status', status: 'cancelled' }), 0);
    s.apply(ev(3, { kind: 'job-started', jobId: 'c'.repeat(32), jobKind: 'other' }), 0);
    expect(s.current.terminal).toBeNull();
    expect(s.current.state).toBe('running');
  });

  it('armed-state updates the arm flag, the expiry and the viewer count', () => {
    const s = started();
    s.apply(
      {
        v: 1,
        type: 'event',
        seq: 0,
        kind: 'armed-state',
        armed: true,
        expiresAtMs: 99,
        viewers: 2,
      },
      0,
    );
    expect(s.current.expiresAtMs).toBe(99);
    expect(s.current.viewers).toBe(2);
  });

  it('a fatal error frame ends the connection state and a later hello does not undo it', () => {
    const s = new LiveSession();
    s.apply({ v: 1, type: 'error', code: 'unauthorized', fatal: true }, 0);
    expect(s.current.connection).toBe('fatal');
    expect(s.current.fatalCode).toBe('unauthorized');
    s.setConnection('reconnecting', 1);
    expect(s.current.connection).toBe('fatal');
  });

  it('a speed appears once bytes have been rising for a second', () => {
    const s = started();
    s.apply(ev(1, { kind: 'progress', ...progress({ bytesDone: 0 }) }), 1000);
    s.apply(ev(1, { kind: 'progress', ...progress({ bytesDone: 3000 }) }), 4000);
    expect(s.current.rate.bytesPerSecond).toBeCloseTo(1000);
    expect(s.current.rate.etaMs).toBeCloseTo(7000);
  });
});

describe('pending actions', () => {
  function awaiting(expects: 'done' | 'next'): LiveSession {
    const s = started();
    s.apply(
      ev(2, {
        kind: 'prompt-opened',
        promptId: PROMPT,
        expects,
        labelId: 'other',
        blocking: false,
      }),
      0,
    );
    return s;
  }

  it('an accepted done stays requested until the prompt closes', () => {
    const s = awaiting('done');
    s.startPending('act-00000001', 'done', PROMPT);
    expect(s.current.pending?.stage).toBe('sending');
    s.apply({ v: 1, type: 'action-result', actionId: 'act-00000001', outcome: 'accepted' }, 0);
    expect(s.current.pending?.stage).toBe('requested');
    s.apply(ev(3, { kind: 'prompt-closed', promptId: PROMPT, reason: 'answered-remote' }), 0);
    expect(s.current.pending).toBeNull();
  });

  it('an accepted cancel stays requested until the status event arrives', () => {
    const s = started();
    s.startPending('act-00000002', 'cancel');
    s.apply({ v: 1, type: 'action-result', actionId: 'act-00000002', outcome: 'accepted' }, 0);
    expect(s.current.pending?.stage).toBe('requested');
    s.apply(ev(2, { kind: 'status', status: 'cancelled', failureCode: 'cancelled' }), 0);
    expect(s.current.pending).toBeNull();
  });

  it('a rejection clears the pending state and records the reason', () => {
    const s = awaiting('done');
    s.startPending('act-00000003', 'done', PROMPT);
    s.apply(
      {
        v: 1,
        type: 'action-result',
        actionId: 'act-00000003',
        outcome: 'rejected',
        reason: 'stale-prompt',
      },
      0,
    );
    expect(s.current.pending).toBeNull();
    expect(s.current.rejected).toBe('stale-prompt');
  });

  it('a result for some other action is ignored', () => {
    const s = awaiting('done');
    s.startPending('act-00000004', 'done', PROMPT);
    s.apply({ v: 1, type: 'action-result', actionId: 'act-99999999', outcome: 'accepted' }, 0);
    expect(s.current.pending?.stage).toBe('sending');
  });

  it('dropping the connection forgets the pending request', () => {
    const s = awaiting('done');
    s.startPending('act-00000005', 'done', PROMPT);
    s.setConnection('reconnecting', 1);
    expect(s.current.pending).toBeNull();
  });
});

describe('button states', () => {
  function view(expects: 'done' | 'next' | null, over: { armed?: boolean } = {}): LiveSession {
    const s = started();
    if (over.armed === false)
      s.apply(
        { v: 1, type: 'event', seq: 0, kind: 'armed-state', armed: false, expiresAtMs: null },
        0,
      );
    if (expects !== null)
      s.apply(
        ev(2, {
          kind: 'prompt-opened',
          promptId: PROMPT,
          expects,
          labelId: 'other',
          blocking: true,
        }),
        0,
      );
    return s;
  }

  it('the prompt button is enabled only when a prompt is open', () => {
    expect(buttonStates(view(null).current, false).primary).toBe(false);
    expect(buttonStates(view('done').current, false).primary).toBe(true);
    expect(buttonStates(view('next').current, false).primary).toBe(true);
  });

  it('cancel is enabled while a job runs and not after it ends', () => {
    const s = view(null);
    expect(buttonStates(s.current, false).cancel).toBe(true);
    s.apply(ev(2, { kind: 'status', status: 'completed' }), 0);
    expect(buttonStates(s.current, false).cancel).toBe(false);
  });

  it('nothing is enabled when disarmed, locked, reconnecting or waiting on a request', () => {
    expect(buttonStates(view('done', { armed: false }).current, false)).toEqual({
      primary: false,
      cancel: false,
    });
    expect(buttonStates(view('done').current, true)).toEqual({ primary: false, cancel: false });
    const s = view('done');
    s.setConnection('reconnecting', 1);
    expect(buttonStates(s.current, false)).toEqual({ primary: false, cancel: false });
    const t = view('done');
    t.startPending('act-00000006', 'done', PROMPT);
    expect(buttonStates(t.current, false)).toEqual({ primary: false, cancel: false });
  });
});
