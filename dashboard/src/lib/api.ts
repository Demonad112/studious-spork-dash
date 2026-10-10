import type { PairLookupResult, SessionState } from '@remote-console/protocol';

/** Mirrors the relay's audit codes (`relay/src/audit.ts`). A test keeps the two lists equal. */
export type AuditCode =
  | 'agent-connected'
  | 'agent-disconnected'
  | 'agent-replaced'
  | 'auth-failed'
  | 'auth-timeout'
  | 'armed-state'
  | 'session-reset'
  | 'event-dropped'
  | 'event-gap'
  | 'agent-error'
  | 'action-accepted'
  | 'action-rejected'
  | 'action-result'
  | 'browser-connected'
  | 'browser-disconnected'
  | 'pair-started'
  | 'pair-approved'
  | 'pair-rejected'
  | 'pair-expired'
  | 'rotated'
  | 'revoked'
  | 'unlocked'
  | 'renamed';

export interface AuditRow {
  id: number;
  ts: number;
  code: AuditCode;
  detail: string;
}

export interface LiveView {
  connected: boolean;
  armed: boolean;
  expiresAtMs: number | null;
  viewers: number;
  state: SessionState;
  locked: boolean;
  lastSeenMs: number | null;
}

export interface InstallSummary {
  installId: string;
  displayName: string;
  /** `rekey` means a key rotation is waiting for the agent to pair again. */
  status: 'active' | 'rekey';
  locked: boolean;
  createdMs: number;
  fingerprint: string | null;
  live: LiveView;
}

export type InstallAction = 'revoke' | 'unlock' | 'rotate' | 'delete' | 'rename';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'network');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const code =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : 'error';
    throw new ApiError(res.status, code);
  }
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listInstalls(): Promise<InstallSummary[]> {
  return (await request<{ installs: InstallSummary[] }>('/api/installs')).installs;
}

export async function getAudit(installId: string): Promise<AuditRow[]> {
  return (await request<{ rows: AuditRow[] }>(`/api/installs/${installId}/audit`)).rows;
}

export function lookupPairing(pairingCode: string): Promise<PairLookupResult> {
  return post<PairLookupResult>('/api/pair/lookup', { kind: 'pair-lookup', pairingCode });
}

export function approvePairing(
  pairingCode: string,
  displayName: string,
  approve: boolean,
): Promise<{ ok: true }> {
  return post('/api/pair/approve', { kind: 'pair-approve', pairingCode, displayName, approve });
}

export function installAction(
  installId: string,
  action: Exclude<InstallAction, 'rename'>,
): Promise<{ ok: true }> {
  return post(`/api/installs/${installId}/${action}`, {});
}

export function renameInstall(installId: string, displayName: string): Promise<{ ok: true }> {
  return post(`/api/installs/${installId}/rename`, { displayName });
}
