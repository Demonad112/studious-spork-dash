import { DurableObject } from 'cloudflare:workers';
import { appendAudit, initAudit, readAudit } from './audit.ts';
import type { AuditRow } from './audit.ts';
import { fingerprint, isValidPublicKey, pairStatusMessage, verifySignature } from './agent-auth.ts';
import { now } from './clock.ts';
import {
  PAIRING_CAP_PER_IP,
  PAIRING_CAP_TOTAL,
  PAIRING_TTL_MS,
  PAIR_STATUS_WINDOW_MS,
  generatePairingCode,
  hashPairingCode,
} from './pairing.ts';
import type { PairingStatus } from '@remote-console/protocol';

export type InstallStatus = 'active' | 'rekey';

export interface InstallRecord {
  installId: string;
  displayName: string;
  /** Empty while the install waits to be paired again after a rotation. */
  publicKey: string;
  status: InstallStatus;
  locked: boolean;
  createdMs: number;
}

export type PairStartOutcome =
  | { ok: true; pairingCode: string; fingerprint: string; expiresInSec: number }
  | { ok: false; error: 'invalid-key' | 'already-paired' | 'too-many-pending' | 'rate-limited' };

export type PairStatusOutcome =
  { ok: true; status: PairingStatus } | { ok: false; error: 'stale-timestamp' | 'unauthorized' };

/** How long a decided pairing stays readable by the agent that asked for it. */
const DECIDED_KEEP_MS = 60 * 60 * 1000;
const REGISTRY_AUDIT = 'registry_audit';
const REGISTRY_AUDIT_ROWS = 500;

interface InstallRow extends Record<string, SqlStorageValue> {
  install_id: string;
  display_name: string;
  public_key: string;
  status: string;
  locked: number;
  created_ms: number;
}

interface PendingRow extends Record<string, SqlStorageValue> {
  code_hash: string;
  install_id: string;
  public_key: string;
  ip_hash: string;
  created_ms: number;
  expires_ms: number;
  state: string;
}

function toRecord(r: InstallRow): InstallRecord {
  return {
    installId: r.install_id,
    displayName: r.display_name,
    publicKey: r.public_key,
    status: r.status === 'rekey' ? 'rekey' : 'active',
    locked: r.locked === 1,
    createdMs: r.created_ms,
  };
}

/** Installs, pending pairings and the pairing audit. One instance for the whole relay. */
export class RegistryDO extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS installs (install_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, public_key TEXT NOT NULL, status TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS pending (code_hash TEXT PRIMARY KEY, install_id TEXT NOT NULL, public_key TEXT NOT NULL, ip_hash TEXT NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, state TEXT NOT NULL)`,
    );
    initAudit(sql, REGISTRY_AUDIT);
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private purge(): void {
    const t = now();
    // Pending rows past their ttl are dead; decided rows are kept a while for the agent to read.
    this.sql.exec(
      `DELETE FROM pending WHERE state = 'pending' AND expires_ms < ?`,
      t - DECIDED_KEEP_MS,
    );
    this.sql.exec(
      `DELETE FROM pending WHERE state <> 'pending' AND created_ms < ?`,
      t - DECIDED_KEEP_MS,
    );
  }

  private audit(code: Parameters<typeof appendAudit>[1], detail = ''): void {
    appendAudit(this.sql, code, detail, REGISTRY_AUDIT);
    this.sql.exec(
      `DELETE FROM ${REGISTRY_AUDIT} WHERE id <= (SELECT MAX(id) FROM ${REGISTRY_AUDIT}) - ?`,
      REGISTRY_AUDIT_ROWS,
    );
  }

  // ---- pairing (agent side) ----------------------------------------------------------------

  async pairStart(installId: string, publicKey: string, ipHash: string): Promise<PairStartOutcome> {
    if (!(await isValidPublicKey(publicKey))) return { ok: false, error: 'invalid-key' };
    this.purge();
    const t = now();
    const existing = this.getInstall(installId);
    if (existing !== null && existing.status === 'active')
      return { ok: false, error: 'already-paired' };
    // A new request from the same install replaces its earlier one.
    this.sql.exec(`DELETE FROM pending WHERE install_id = ?`, installId);
    const live = `state = 'pending' AND expires_ms >= ${t}`;
    const total = this.sql
      .exec<{ c: number }>(`SELECT count(*) AS c FROM pending WHERE ${live}`)
      .one().c;
    if (total >= PAIRING_CAP_TOTAL) return { ok: false, error: 'too-many-pending' };
    const perIp = this.sql
      .exec<{ c: number }>(
        `SELECT count(*) AS c FROM pending WHERE ${live} AND ip_hash = ?`,
        ipHash,
      )
      .one().c;
    if (perIp >= PAIRING_CAP_PER_IP) return { ok: false, error: 'rate-limited' };
    const code = generatePairingCode();
    this.sql.exec(
      `INSERT INTO pending (code_hash, install_id, public_key, ip_hash, created_ms, expires_ms, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      await hashPairingCode(code),
      installId,
      publicKey,
      ipHash,
      t,
      t + PAIRING_TTL_MS,
    );
    this.audit('pair-started', existing === null ? 'new' : 'rekey');
    return {
      ok: true,
      pairingCode: code,
      fingerprint: await fingerprint(publicKey),
      expiresInSec: PAIRING_TTL_MS / 1000,
    };
  }

  async pairStatus(
    installId: string,
    timestampMs: number,
    signature: string,
  ): Promise<PairStatusOutcome> {
    if (Math.abs(now() - timestampMs) > PAIR_STATUS_WINDOW_MS)
      return { ok: false, error: 'stale-timestamp' };
    const row = this.sql
      .exec<PendingRow>(
        `SELECT * FROM pending WHERE install_id = ? ORDER BY created_ms DESC LIMIT 1`,
        installId,
      )
      .toArray()[0];
    if (row === undefined) return { ok: true, status: 'expired' };
    const good = await verifySignature(
      row.public_key,
      pairStatusMessage(installId, timestampMs),
      signature,
    );
    if (!good) return { ok: false, error: 'unauthorized' };
    if (row.state === 'approved') return { ok: true, status: 'approved' };
    if (row.state === 'rejected') return { ok: true, status: 'rejected' };
    return { ok: true, status: row.expires_ms < now() ? 'expired' : 'pending' };
  }

  // ---- pairing (dashboard side) ------------------------------------------------------------

  private findPending(codeHash: string): PendingRow | null {
    const row = this.sql
      .exec<PendingRow>(`SELECT * FROM pending WHERE code_hash = ?`, codeHash)
      .toArray()[0];
    if (row === undefined || row.state !== 'pending' || row.expires_ms < now()) return null;
    return row;
  }

  async lookup(code: string): Promise<{ fingerprint: string; rekey: boolean } | null> {
    const row = this.findPending(await hashPairingCode(code));
    if (row === null) return null;
    return {
      fingerprint: await fingerprint(row.public_key),
      rekey: this.getInstall(row.install_id) !== null,
    };
  }

  /** Approves or rejects a pending pairing. A code works once. Returns false when unknown or expired. */
  async approve(code: string, displayName: string, approve: boolean): Promise<boolean> {
    const hash = await hashPairingCode(code);
    const row = this.findPending(hash);
    if (row === null) return false;
    if (!approve) {
      this.sql.exec(`UPDATE pending SET state = 'rejected' WHERE code_hash = ?`, hash);
      this.audit('pair-rejected');
      return true;
    }
    const existing = this.getInstall(row.install_id);
    if (existing === null) {
      this.sql.exec(
        `INSERT INTO installs (install_id, display_name, public_key, status, locked, created_ms) VALUES (?, ?, ?, 'active', 0, ?)`,
        row.install_id,
        displayName,
        row.public_key,
        now(),
      );
    } else {
      this.sql.exec(
        `UPDATE installs SET public_key = ?, status = 'active', display_name = ? WHERE install_id = ?`,
        row.public_key,
        displayName,
        row.install_id,
      );
    }
    this.sql.exec(`UPDATE pending SET state = 'approved' WHERE code_hash = ?`, hash);
    this.audit('pair-approved', existing === null ? 'new' : 'rekey');
    return true;
  }

  // ---- installs ----------------------------------------------------------------------------

  getInstall(installId: string): InstallRecord | null {
    const row = this.sql
      .exec<InstallRow>(`SELECT * FROM installs WHERE install_id = ?`, installId)
      .toArray()[0];
    return row === undefined ? null : toRecord(row);
  }

  listInstalls(): InstallRecord[] {
    return this.sql
      .exec<InstallRow>(`SELECT * FROM installs ORDER BY created_ms ASC`)
      .toArray()
      .map(toRecord);
  }

  /** Clears the key and waits for the agent to pair again with the same install id. */
  rotate(installId: string): boolean {
    if (this.getInstall(installId) === null) return false;
    this.sql.exec(
      `UPDATE installs SET public_key = '', status = 'rekey' WHERE install_id = ?`,
      installId,
    );
    this.audit('rotated');
    return true;
  }

  setLocked(installId: string, locked: boolean): boolean {
    if (this.getInstall(installId) === null) return false;
    this.sql.exec(`UPDATE installs SET locked = ? WHERE install_id = ?`, locked ? 1 : 0, installId);
    this.audit(locked ? 'revoked' : 'unlocked');
    return true;
  }

  rename(installId: string, displayName: string): boolean {
    if (this.getInstall(installId) === null) return false;
    this.sql.exec(
      `UPDATE installs SET display_name = ? WHERE install_id = ?`,
      displayName,
      installId,
    );
    this.audit('renamed');
    return true;
  }

  remove(installId: string): boolean {
    if (this.getInstall(installId) === null) return false;
    this.sql.exec(`DELETE FROM installs WHERE install_id = ?`, installId);
    this.sql.exec(`DELETE FROM pending WHERE install_id = ?`, installId);
    return true;
  }

  pairingAudit(limit = 200): AuditRow[] {
    return readAudit(this.sql, limit, REGISTRY_AUDIT);
  }
}
