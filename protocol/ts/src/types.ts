/** Wire types for protocol version 1. Field names and values match `protocol/schemas`. */

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS: readonly number[] = [1];
export const MAX_FRAME_BYTES = 16384;
export const MAX_TEXT_CHARS = 80;
/** Byte-constant frames so the relay can answer with `setWebSocketAutoResponse`. */
export const PING_FRAME = '{"v":1,"type":"ping"}';
export const PONG_FRAME = '{"v":1,"type":"pong"}';

export const ROLES = ['agent', 'browser'] as const;
export const JOB_KINDS = [
  'record-copy',
  'record-watch',
  'compare',
  'disk-scan',
  'simulated',
  'other',
] as const;
export const STEPS = [
  'listing-source',
  'copying',
  'watching',
  'finishing',
  'done',
  'other',
] as const;
export const LABEL_IDS = ['finish-and-check', 'continue', 'confirm', 'other'] as const;
export const EXPECTS = ['next', 'done'] as const;
export const CLOSE_REASONS = [
  'answered-remote',
  'answered-local',
  'auto',
  'superseded',
  'timed-out',
  'job-ended',
] as const;
export const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'] as const;
export const FAILURE_CODES = [
  'cancelled',
  'destination-not-writable',
  'not-enough-space',
  'source-unavailable',
  'internal',
  'other',
] as const;
export const ACTION_KINDS = ['status', 'next', 'done', 'cancel'] as const;
export const REJECT_REASONS = [
  'disarmed',
  'expired',
  'unknown-action',
  'invalid-state',
  'stale-prompt',
  'malformed',
  'rate-limited',
  'locked',
] as const;
export const SESSION_STATES = [
  'idle',
  'running',
  'awaiting-user',
  'completed',
  'cancelled',
  'failed',
] as const;
export const ERROR_CODES = [
  'malformed',
  'unsupported-version',
  'unauthorized',
  'not-paired',
  'locked',
  'expired',
  'too-many-connections',
  'rate-limited',
  'frame-too-large',
  'internal',
] as const;

export type Role = (typeof ROLES)[number];
export type JobKind = (typeof JOB_KINDS)[number];
export type Step = (typeof STEPS)[number];
export type LabelId = (typeof LABEL_IDS)[number];
export type Expects = (typeof EXPECTS)[number];
export type CloseReason = (typeof CLOSE_REASONS)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type FailureCode = (typeof FAILURE_CODES)[number];
export type ActionKind = (typeof ACTION_KINDS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];
export type SessionState = (typeof SESSION_STATES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProgressFields {
  step: Step;
  /** Whole percent, or null while the total is not known yet. */
  percent: number | null;
  filesDone: number;
  filesTotal: number | null;
  bytesDone: number;
  bytesTotal: number | null;
  ok: number;
  skipped: number;
  failed: number;
}

export interface Summary {
  filesPlanned: number;
  bytesPlanned: number;
  ok: number;
  okBytes: number;
  skipped: number;
  failed: number;
  failedBytes: number;
  durationMs: number;
}

export interface PromptObject {
  promptId: string;
  expects: Expects;
  labelId: LabelId;
  blocking: boolean;
  text?: string;
}

export interface TerminalInfo {
  status: TerminalStatus;
  failureCode?: FailureCode;
  summary?: Summary;
}

export interface Hello {
  v: 1;
  type: 'hello';
  role: Role;
  protocolVersions: number[];
  installId?: string;
  sessionId?: string;
  appId?: string;
  agentVersion?: string;
}
export interface AuthChallenge {
  v: 1;
  type: 'auth-challenge';
  nonce: string;
}
export interface AuthResponse {
  v: 1;
  type: 'auth-response';
  agentNonce: string;
  signature: string;
}
export interface AuthOk {
  v: 1;
  type: 'auth-ok';
  serverTimeMs: number;
}

export interface JobStartedEvent {
  kind: 'job-started';
  jobId: string;
  jobKind: JobKind;
}
export interface StepEvent {
  kind: 'step';
  step: Step;
}
export interface ProgressEvent extends ProgressFields {
  kind: 'progress';
}
export interface PromptOpenedEvent extends PromptObject {
  kind: 'prompt-opened';
}
export interface PromptClosedEvent {
  kind: 'prompt-closed';
  promptId: string;
  reason: CloseReason;
}
export interface StatusEvent extends TerminalInfo {
  kind: 'status';
}
export interface ArmedStateEvent {
  kind: 'armed-state';
  armed: boolean;
  expiresAtMs: number | null;
  /** Set by the relay only. */
  viewers?: number;
}
/** An event whose kind or enum value this version does not know. Keeps its `seq`. */
export interface UnknownEvent {
  kind: 'unknown';
}
export type EventBody =
  | JobStartedEvent
  | StepEvent
  | ProgressEvent
  | PromptOpenedEvent
  | PromptClosedEvent
  | StatusEvent
  | ArmedStateEvent
  | UnknownEvent;
export type EventFrame = { v: 1; type: 'event'; seq: number } & EventBody;

export interface Action {
  v: 1;
  type: 'action';
  actionId: string;
  action: ActionKind;
  promptId?: string;
}
export interface ActionResult {
  v: 1;
  type: 'action-result';
  actionId: string;
  outcome: 'accepted' | 'rejected';
  reason?: RejectReason;
  state?: SessionState;
}
export interface Resync {
  v: 1;
  type: 'resync';
  lastSeq: number;
}
export interface ResyncResult {
  v: 1;
  type: 'resync-result';
  fromSeq: number;
  toSeq: number;
  gap: boolean;
}
export interface Snapshot {
  v: 1;
  type: 'snapshot';
  seq: number;
  armed: boolean;
  state: SessionState;
  jobId: string | null;
  jobKind: JobKind | null;
  progress: ProgressFields | null;
  prompt: PromptObject | null;
  terminal: TerminalInfo | null;
}
export interface Ping {
  v: 1;
  type: 'ping';
}
export interface Pong {
  v: 1;
  type: 'pong';
}
export interface ErrorFrame {
  v: 1;
  type: 'error';
  code: ErrorCode;
  fatal: boolean;
}

export type Frame =
  | Hello
  | AuthChallenge
  | AuthResponse
  | AuthOk
  | EventFrame
  | Action
  | ActionResult
  | Resync
  | ResyncResult
  | Snapshot
  | Ping
  | Pong
  | ErrorFrame;
