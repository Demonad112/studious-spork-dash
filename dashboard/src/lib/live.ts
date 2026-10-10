import { Machine, decideAction } from '@remote-console/protocol';
import type {
  ActionKind,
  ActionResult,
  ErrorCode,
  Frame,
  JobKind,
  ProgressFields,
  PromptObject,
  RejectReason,
  SessionState,
  Step,
  TerminalInfo,
} from '@remote-console/protocol';
import { RateTracker } from './rate.ts';
import type { Rate } from './rate.ts';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'fatal';

/** An action the person pressed, from the press until the result (and, for some, the outcome). */
export interface PendingAction {
  actionId: string;
  action: ActionKind;
  promptId?: string;
  /** `sending` until the relay answers, then `requested` until the PC confirms by event. */
  stage: 'sending' | 'requested';
}

export interface LiveSnapshot {
  connection: ConnectionState;
  fatalCode: ErrorCode | null;
  lastSeq: number;
  /** Local time of the last frame of any kind. */
  lastHeardMs: number | null;
  armed: boolean;
  expiresAtMs: number | null;
  viewers: number;
  state: SessionState;
  jobId: string | null;
  jobKind: JobKind | null;
  step: Step | null;
  progress: ProgressFields | null;
  prompt: PromptObject | null;
  terminal: TerminalInfo | null;
  rate: Rate;
  pending: PendingAction | null;
  /** The last rejection, so the UI can say why a press did nothing. */
  rejected: RejectReason | null;
}

export interface ApplyOutcome {
  /** True when a discrete event was missed and the client should ask the relay to resync. */
  resync: boolean;
}

/**
 * Pure view model of one install's session. It folds the relay's frames into the same `Machine`
 * the relay and the agent use, so the dashboard cannot disagree with them about what is legal.
 */
export class LiveSession {
  private machine = new Machine();
  private tracker = new RateTracker();
  private snapshotSeen = false;
  private view: LiveSnapshot = {
    connection: 'connecting',
    fatalCode: null,
    lastSeq: 0,
    lastHeardMs: null,
    armed: false,
    expiresAtMs: null,
    viewers: 0,
    state: 'idle',
    jobId: null,
    jobKind: null,
    step: null,
    progress: null,
    prompt: null,
    terminal: null,
    rate: { bytesPerSecond: null, etaMs: null },
    pending: null,
    rejected: null,
  };

  get lastSeq(): number {
    return this.view.lastSeq;
  }

  get current(): LiveSnapshot {
    return this.view;
  }

  setConnection(connection: ConnectionState, nowMs: number): void {
    if (connection === 'fatal' || this.view.connection === 'fatal') return;
    this.view = {
      ...this.view,
      connection,
      lastHeardMs: connection === 'live' ? nowMs : this.view.lastHeardMs,
      // Pending requests cannot be tracked across a dropped connection: the snapshot that follows
      // a reconnect shows the truth.
      pending: connection === 'live' ? this.view.pending : null,
    };
  }

  /** The press: called before the frame is sent. */
  startPending(actionId: string, action: ActionKind, promptId?: string): void {
    const pending: PendingAction = { actionId, action, stage: 'sending' };
    if (promptId !== undefined) pending.promptId = promptId;
    this.view = { ...this.view, pending, rejected: null };
  }

  clearPending(): void {
    this.view = { ...this.view, pending: null };
  }

  dismissRejection(): void {
    this.view = { ...this.view, rejected: null };
  }

  /** Folds one decoded frame in. `nowMs` is the dashboard's own clock. */
  apply(frame: Frame, nowMs: number): ApplyOutcome {
    this.view = { ...this.view, lastHeardMs: nowMs };
    switch (frame.type) {
      case 'auth-ok':
        this.view = { ...this.view, connection: 'live', fatalCode: null };
        return { resync: false };
      case 'error':
        if (frame.fatal) this.view = { ...this.view, connection: 'fatal', fatalCode: frame.code };
        return { resync: false };
      case 'snapshot':
        this.machine = Machine.fromSnapshot(frame);
        this.snapshotSeen = true;
        this.tracker.reset();
        if (frame.progress !== null) this.tracker.push(nowMs, frame.progress.bytesDone);
        this.view = { ...this.view, lastSeq: frame.seq, armed: frame.armed };
        this.refresh(frame.progress?.step ?? null);
        return { resync: false };
      case 'event':
        return this.applyEvent(frame, nowMs);
      case 'action-result':
        this.applyResult(frame);
        return { resync: false };
      default:
        return { resync: false };
    }
  }

  private applyEvent(frame: Extract<Frame, { type: 'event' }>, nowMs: number): ApplyOutcome {
    if (frame.kind === 'armed-state') {
      this.view = {
        ...this.view,
        armed: frame.armed,
        expiresAtMs: frame.expiresAtMs,
        viewers: frame.viewers ?? this.view.viewers,
      };
      return { resync: false };
    }
    // Progress carries the newest discrete seq and consumes none: latest wins, never deduplicated.
    if (frame.kind === 'progress') {
      if (!this.snapshotSeen) return { resync: true };
      const { kind: _kind, ...fields } = frame;
      if (this.machine.apply(frame)) {
        this.tracker.push(nowMs, fields.bytesDone);
        this.refresh(fields.step);
      }
      return { resync: false };
    }
    if (!this.snapshotSeen) return { resync: true };
    if (frame.seq <= this.view.lastSeq) return { resync: false };
    if (frame.seq > this.view.lastSeq + 1) return { resync: true };
    this.view = { ...this.view, lastSeq: frame.seq };
    if (frame.kind === 'unknown') return { resync: false };
    if (!this.machine.apply(frame)) return { resync: false };
    if (frame.kind === 'job-started') this.tracker.reset();
    this.refresh(frame.kind === 'step' ? frame.step : (this.view.step ?? null), frame.kind);
    return { resync: false };
  }

  private refresh(step: Step | null, kind?: string): void {
    const m = this.machine;
    let pending = this.view.pending;
    if (pending !== null && pending.stage === 'requested') {
      const prompt = m.prompt;
      const promptGone = pending.promptId !== undefined && prompt?.promptId !== pending.promptId;
      if (m.isTerminal || promptGone || (pending.action === 'cancel' && !m.jobActive))
        pending = null;
    }
    this.view = {
      ...this.view,
      state: m.state,
      jobId: m.jobId,
      jobKind: m.jobKind,
      step: kind === 'job-started' ? null : step,
      progress: m.progress,
      prompt: m.prompt,
      terminal: m.terminal,
      rate: this.tracker.read(m.progress?.bytesTotal ?? null),
      pending,
    };
  }

  private applyResult(frame: ActionResult): void {
    const pending = this.view.pending;
    if (pending === null || pending.actionId !== frame.actionId) return;
    if (frame.outcome === 'rejected') {
      this.view = { ...this.view, pending: null, rejected: frame.reason ?? 'invalid-state' };
      return;
    }
    // `status` has nothing to wait for. The others stay "requested" until an event confirms them.
    this.view =
      pending.action === 'status'
        ? { ...this.view, pending: null }
        : { ...this.view, pending: { ...pending, stage: 'requested' } };
  }
}

export interface ButtonStates {
  /** The prompt's own button (Finish or Next), enabled only when the open prompt expects it. */
  primary: boolean;
  cancel: boolean;
}

/**
 * Which buttons may be pressed. Reuses the shared allowlist (`decideAction`), so a button is
 * enabled exactly when the relay would forward the action.
 */
export function buttonStates(v: LiveSnapshot, locked: boolean): ButtonStates {
  const usable = v.connection === 'live' && v.armed && !locked && v.pending === null;
  if (!usable) return { primary: false, cancel: false };
  const prompt = v.prompt;
  const primary =
    prompt !== null &&
    decideAction(
      {
        v: 1,
        type: 'action',
        actionId: 'probe-probe',
        action: prompt.expects,
        promptId: prompt.promptId,
      },
      v.state,
      prompt,
      () => false,
    ) === null;
  const cancel =
    decideAction(
      { v: 1, type: 'action', actionId: 'probe-probe', action: 'cancel' },
      v.state,
      prompt,
      () => false,
    ) === null;
  return { primary, cancel };
}
