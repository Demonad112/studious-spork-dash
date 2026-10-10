import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLOSE_REASONS,
  FAILURE_CODES,
  JOB_KINDS,
  LABEL_IDS,
  REJECT_REASONS,
  SESSION_STATES,
  STEPS,
  TERMINAL_STATUSES,
} from '@remote-console/protocol';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_TEXT,
  CLOSE_TEXT,
  FAILURE_TEXT,
  JOB_KIND_TEXT,
  LABEL_TEXT,
  REJECT_TEXT,
  STATE_TEXT,
  STATUS_TEXT,
  STEP_TEXT,
} from '../src/lib/labels.ts';

const keys = (o: object): string[] => Object.keys(o).sort();
const sorted = (a: readonly string[]): string[] => [...a].sort();

describe('labels', () => {
  it('every wire enum value has text and no extra text exists', () => {
    expect(keys(STEP_TEXT)).toEqual(sorted(STEPS));
    expect(keys(JOB_KIND_TEXT)).toEqual(sorted(JOB_KINDS));
    expect(keys(STATE_TEXT)).toEqual(sorted(SESSION_STATES));
    expect(keys(STATUS_TEXT)).toEqual(sorted(TERMINAL_STATUSES));
    expect(keys(FAILURE_TEXT)).toEqual(sorted(FAILURE_CODES));
    expect(keys(LABEL_TEXT)).toEqual(sorted(LABEL_IDS));
    expect(keys(CLOSE_TEXT)).toEqual(sorted(CLOSE_REASONS));
    expect(keys(REJECT_TEXT)).toEqual(sorted(REJECT_REASONS));
  });

  it('every audit code the relay writes has text', () => {
    const src = readFileSync(join(process.cwd(), '../relay/src/audit.ts'), 'utf8');
    const block = /export type AuditCode =([^;]+);/.exec(src)?.[1] ?? '';
    const codes = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(10);
    expect(keys(AUDIT_TEXT)).toEqual(sorted(codes));
  });
});
