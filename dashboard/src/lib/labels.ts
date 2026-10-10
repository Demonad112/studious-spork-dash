import type {
  CloseReason,
  FailureCode,
  JobKind,
  LabelId,
  RejectReason,
  SessionState,
  Step,
  TerminalStatus,
} from '@remote-console/protocol';
import type { AuditCode } from './api.ts';

/** Every wire code the UI shows maps to one sentence here. Tests prove none is missing. */

export const STEP_TEXT: Record<Step, string> = {
  'listing-source': 'Listing the source…',
  copying: 'Copying',
  watching: 'Watching the destination',
  finishing: 'Checking what did not arrive…',
  done: 'Step finished',
  other: 'Working…',
};

export const JOB_KIND_TEXT: Record<JobKind, string> = {
  'record-copy': 'Copy',
  'record-watch': 'Watch',
  compare: 'Compare',
  'disk-scan': 'Disk scan',
  simulated: 'Simulated job',
  other: 'Job',
};

export const STATE_TEXT: Record<SessionState, string> = {
  idle: 'Idle',
  running: 'Running',
  'awaiting-user': 'Waiting for you',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const STATUS_TEXT: Record<TerminalStatus, string> = {
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const FAILURE_TEXT: Record<FailureCode, string> = {
  cancelled: 'The job was cancelled.',
  'destination-not-writable': 'The destination is not writable.',
  'not-enough-space': 'There is not enough space at the destination.',
  'source-unavailable': 'The source is not available.',
  internal: 'The app hit an internal error.',
  other: 'The job failed.',
};

/** Prompt button text. `other` falls back to what the prompt expects. */
export const LABEL_TEXT: Record<LabelId, string | null> = {
  'finish-and-check': 'Finish and check',
  continue: 'Continue',
  confirm: 'Confirm',
  other: null,
};

export const CLOSE_TEXT: Record<CloseReason, string> = {
  'answered-remote': 'Answered from here',
  'answered-local': 'Answered on the PC',
  auto: 'Closed automatically',
  superseded: 'Replaced by a newer prompt',
  'timed-out': 'Timed out',
  'job-ended': 'The job ended',
};

export const REJECT_TEXT: Record<RejectReason, string> = {
  disarmed: 'Remote control is off on the PC.',
  expired: 'The remote session has expired.',
  'unknown-action': 'That action is not allowed.',
  'invalid-state': 'That is not available right now.',
  'stale-prompt': 'The prompt had already changed. Check the screen and try again.',
  malformed: 'The request was not understood.',
  'rate-limited': 'Too many requests. Wait a moment.',
  locked: 'This install is revoked. Unlock it first.',
};

export const AUDIT_TEXT: Record<AuditCode, string> = {
  'agent-connected': 'Agent connected',
  'agent-disconnected': 'Agent disconnected',
  'agent-replaced': 'Agent connection replaced',
  'auth-failed': 'Agent authentication failed',
  'auth-timeout': 'Agent authentication timed out',
  'armed-state': 'Arm state changed',
  'session-reset': 'New session started',
  'event-dropped': 'Event dropped',
  'event-gap': 'Event gap detected',
  'agent-error': 'Agent reported an error',
  'action-accepted': 'Action accepted',
  'action-rejected': 'Action rejected',
  'action-result': 'Action result',
  'browser-connected': 'Dashboard connected',
  'browser-disconnected': 'Dashboard disconnected',
  'pair-started': 'Pairing started',
  'pair-approved': 'Pairing approved',
  'pair-rejected': 'Pairing rejected',
  'pair-expired': 'Pairing expired',
  rotated: 'Key rotation started',
  revoked: 'Revoked',
  unlocked: 'Unlocked',
  renamed: 'Renamed',
};

export function promptButtonText(labelId: LabelId, expects: 'next' | 'done'): string {
  return LABEL_TEXT[labelId] ?? (expects === 'done' ? 'Finish' : 'Next');
}
