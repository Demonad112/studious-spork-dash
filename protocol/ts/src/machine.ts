import type {
  Action,
  EventBody,
  JobKind,
  ProgressFields,
  PromptObject,
  RejectReason,
  SessionState,
  Snapshot,
  TerminalInfo,
} from './types.ts';

/**
 * The session state machine. The Rust `Machine` in agent-core implements the same table and both
 * run `protocol/fixtures/state-machine.json`.
 *
 * Idle or terminal + job-started -> running; running + prompt-opened -> awaiting-user;
 * awaiting-user + prompt-closed (the open prompt) -> running; step and progress are legal while
 * running or awaiting-user; status ends a running or awaiting-user job; armed-state and unknown
 * events never change the state. A step named done is an ordinary step.
 */
export class Machine {
  state: SessionState = 'idle';
  jobId: string | null = null;
  jobKind: JobKind | null = null;
  progress: ProgressFields | null = null;
  prompt: PromptObject | null = null;
  terminal: TerminalInfo | null = null;

  get jobActive(): boolean {
    return this.state === 'running' || this.state === 'awaiting-user';
  }

  get isTerminal(): boolean {
    return this.state === 'completed' || this.state === 'cancelled' || this.state === 'failed';
  }

  /** Applies one event. Returns false, changing nothing, when the transition is illegal. */
  apply(body: EventBody): boolean {
    switch (body.kind) {
      case 'job-started':
        if (this.jobActive) return false;
        this.state = 'running';
        this.jobId = body.jobId;
        this.jobKind = body.jobKind;
        this.progress = null;
        this.prompt = null;
        this.terminal = null;
        return true;
      case 'step':
        return this.jobActive;
      case 'progress': {
        if (!this.jobActive) return false;
        const { kind: _kind, ...fields } = body;
        this.progress = fields;
        return true;
      }
      case 'prompt-opened': {
        if (this.state !== 'running') return false;
        const { kind: _kind, ...prompt } = body;
        this.prompt = prompt;
        this.state = 'awaiting-user';
        return true;
      }
      case 'prompt-closed':
        if (this.state !== 'awaiting-user' || this.prompt?.promptId !== body.promptId) return false;
        this.prompt = null;
        this.state = 'running';
        return true;
      case 'status': {
        if (!this.jobActive) return false;
        const { kind: _kind, ...info } = body;
        this.prompt = null;
        this.terminal = info;
        this.state = body.status;
        return true;
      }
      case 'armed-state':
      case 'unknown':
        return true;
    }
  }

  snapshot(seq: number, armed: boolean): Snapshot {
    return {
      v: 1,
      type: 'snapshot',
      seq,
      armed,
      state: this.state,
      jobId: this.jobId,
      jobKind: this.jobKind,
      progress: this.progress,
      prompt: this.prompt,
      terminal: this.terminal,
    };
  }

  /** Restores a machine from a snapshot, for a relay that persisted it. */
  static fromSnapshot(s: Snapshot): Machine {
    const m = new Machine();
    m.state = s.state;
    m.jobId = s.jobId;
    m.jobKind = s.jobKind;
    m.progress = s.progress;
    m.prompt = s.prompt;
    m.terminal = s.terminal;
    return m;
  }
}

/**
 * The pure allowlist decision, shared with the agent through `action-rules.json`.
 * Returns the reject reason, or null when the action may run.
 */
export function decideAction(
  action: Action,
  state: SessionState,
  prompt: Pick<PromptObject, 'promptId' | 'expects'> | null,
  wasIssued: (promptId: string) => boolean,
): RejectReason | null {
  switch (action.action) {
    case 'status':
      return null;
    case 'cancel':
      return state === 'running' || state === 'awaiting-user' ? null : 'invalid-state';
    case 'next':
    case 'done': {
      const id = action.promptId;
      if (id === undefined) return 'malformed';
      if (prompt !== null) {
        if (prompt.promptId !== id) return 'stale-prompt';
        return prompt.expects === action.action ? null : 'invalid-state';
      }
      return wasIssued(id) ? 'stale-prompt' : 'invalid-state';
    }
  }
}
