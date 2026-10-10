import { now } from './clock.ts';

export const AUDIT_CAP = 2000;

/** Every audit code the relay writes. Codes only: no payloads, no free text. */
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

export type AuditRow = {
  id: number;
  ts: number;
  code: AuditCode;
  detail: string;
};

const DETAIL = /^[a-z0-9-]{0,32}$/;

export function initAudit(sql: SqlStorage, table = 'audit'): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL)`,
  );
}

/** Appends one row and trims the table to the cap. `detail` must be a short kebab-case code. */
export function appendAudit(sql: SqlStorage, code: AuditCode, detail = '', table = 'audit'): void {
  const safe = DETAIL.test(detail) ? detail : 'invalid';
  sql.exec(`INSERT INTO ${table} (ts, code, detail) VALUES (?, ?, ?)`, now(), code, safe);
  sql.exec(`DELETE FROM ${table} WHERE id <= (SELECT MAX(id) FROM ${table}) - ?`, AUDIT_CAP);
}

export function readAudit(sql: SqlStorage, limit = 200, table = 'audit'): AuditRow[] {
  return sql
    .exec<AuditRow>(`SELECT id, ts, code, detail FROM ${table} ORDER BY id DESC LIMIT ?`, limit)
    .toArray();
}
