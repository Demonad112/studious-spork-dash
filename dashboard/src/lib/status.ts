import type { InstallSummary } from './api.ts';

export type InstallStatusKind = 'offline' | 'armed' | 'running' | 'waiting' | 'revoked' | 'rekey';

export const STATUS_KIND_TEXT: Record<InstallStatusKind, string> = {
  offline: 'Offline',
  armed: 'Armed',
  running: 'Running',
  waiting: 'Waiting for you',
  revoked: 'Revoked',
  rekey: 'Needs pairing',
};

/** The one word the installs list shows, in priority order. */
export function installStatus(i: InstallSummary): InstallStatusKind {
  if (i.locked || i.live.locked) return 'revoked';
  if (i.status === 'rekey') return 'rekey';
  if (!i.live.connected || !i.live.armed) return 'offline';
  if (i.live.state === 'awaiting-user') return 'waiting';
  if (i.live.state === 'running') return 'running';
  return 'armed';
}
