import {
  ACTION_KINDS,
  CLOSE_REASONS,
  ERROR_CODES,
  EXPECTS,
  FAILURE_CODES,
  JOB_KINDS,
  LABEL_IDS,
  MAX_FRAME_BYTES,
  MAX_TEXT_CHARS,
  REJECT_REASONS,
  ROLES,
  SESSION_STATES,
  STEPS,
  SUPPORTED_VERSIONS,
  TERMINAL_STATUSES,
} from './types.ts';
import type {
  Action,
  ActionResult,
  ArmedStateEvent,
  EventBody,
  Frame,
  Hello,
  ProgressFields,
  PromptObject,
  Summary,
  TerminalInfo,
} from './types.ts';

export type DecodeError = 'frame-too-large' | 'malformed' | 'unsupported-version';
export type DecodeResult =
  { ok: true; frame: Frame } | { ok: false; error: DecodeError; detail: string };

/** Thrown for a shape problem. The detail names a field, never a value. */
class Bad extends Error {}
/** Thrown inside an event when an enum value is unknown to this version. */
class UnknownValue extends Error {}

type Obj = Record<string, unknown>;

const HEX32 = /^[0-9a-f]{32}$/;
const PROMPT_ID = /^[A-Za-z0-9-]{1,32}$/;
const ACTION_ID = /^[A-Za-z0-9-]{8,64}$/;
const APP_ID = /^[a-z0-9-]{1,32}$/;
const AGENT_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;
const B64U_64 = /^[A-Za-z0-9_-]{86}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f/\\]/;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new Bad(`${what}: expected object`);
  return v;
}

function strictKeys(o: Obj, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) throw new Bad(`${what}: unknown field ${k}`);
}

function counter(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER)
    throw new Bad(`${what}: expected non-negative safe integer`);
  return v;
}

function nullableCounter(v: unknown, what: string): number | null {
  return v === null ? null : counter(v, what);
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new Bad(`${what}: expected boolean`);
  return v;
}

function pattern(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw new Bad(`${what}: invalid format`);
  return v;
}

/** Strict enum for strict (inbound) frames. */
function strictEnum<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new Bad(`${what}: invalid value`);
  return v as T;
}

/** Event enum with no `other` member: unknown values make the whole event unknown. */
function eventEnum<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string') throw new Bad(`${what}: expected string`);
  if (!allowed.includes(v as T)) throw new UnknownValue(what);
  return v as T;
}

/** Event enum that has an `other` member: unknown values map to it. */
function enumOrOther<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string') throw new Bad(`${what}: expected string`);
  return (allowed.includes(v as T) ? v : 'other') as T;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || [...v].length > MAX_TEXT_CHARS || CONTROL_OR_SEPARATOR.test(v))
    throw new Bad(`${what}: invalid text`);
  return v;
}

function progressFields(o: Obj, what: string): ProgressFields {
  const percent = o.percent;
  if (
    percent !== null &&
    (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100)
  )
    throw new Bad(`${what}.percent: expected 0-100 or null`);
  return {
    step: enumOrOther(o.step, STEPS, `${what}.step`),
    percent,
    filesDone: counter(o.filesDone, `${what}.filesDone`),
    filesTotal: nullableCounter(o.filesTotal, `${what}.filesTotal`),
    bytesDone: counter(o.bytesDone, `${what}.bytesDone`),
    bytesTotal: nullableCounter(o.bytesTotal, `${what}.bytesTotal`),
    ok: counter(o.ok, `${what}.ok`),
    skipped: counter(o.skipped, `${what}.skipped`),
    failed: counter(o.failed, `${what}.failed`),
  };
}

function summary(v: unknown, what: string): Summary {
  const o = obj(v, what);
  return {
    filesPlanned: counter(o.filesPlanned, `${what}.filesPlanned`),
    bytesPlanned: counter(o.bytesPlanned, `${what}.bytesPlanned`),
    ok: counter(o.ok, `${what}.ok`),
    okBytes: counter(o.okBytes, `${what}.okBytes`),
    skipped: counter(o.skipped, `${what}.skipped`),
    failed: counter(o.failed, `${what}.failed`),
    failedBytes: counter(o.failedBytes, `${what}.failedBytes`),
    durationMs: counter(o.durationMs, `${what}.durationMs`),
  };
}

function terminalInfo(o: Obj, what: string, lenient: boolean): TerminalInfo {
  const status = lenient
    ? eventEnum(o.status, TERMINAL_STATUSES, `${what}.status`)
    : strictEnum(o.status, TERMINAL_STATUSES, `${what}.status`);
  const out: TerminalInfo = { status };
  if (o.failureCode !== undefined)
    out.failureCode = enumOrOther(o.failureCode, FAILURE_CODES, `${what}.failureCode`);
  if (o.summary !== undefined) out.summary = summary(o.summary, `${what}.summary`);
  return out;
}

function promptObject(o: Obj, what: string, lenient: boolean): PromptObject {
  const expects = lenient
    ? eventEnum(o.expects, EXPECTS, `${what}.expects`)
    : strictEnum(o.expects, EXPECTS, `${what}.expects`);
  const out: PromptObject = {
    promptId: pattern(o.promptId, PROMPT_ID, `${what}.promptId`),
    expects,
    labelId: enumOrOther(o.labelId, LABEL_IDS, `${what}.labelId`),
    blocking: bool(o.blocking, `${what}.blocking`),
  };
  if (o.text !== undefined) out.text = text(o.text, `${what}.text`);
  return out;
}

function decodeEvent(o: Obj): Frame {
  const seq = counter(o.seq, 'seq');
  if (typeof o.kind !== 'string') throw new Bad('kind: expected string');
  const kind = o.kind;
  let body: EventBody;
  try {
    switch (kind) {
      case 'job-started':
        body = {
          kind,
          jobId: pattern(o.jobId, HEX32, 'jobId'),
          jobKind: enumOrOther(o.jobKind, JOB_KINDS, 'jobKind'),
        };
        break;
      case 'step':
        body = { kind, step: enumOrOther(o.step, STEPS, 'step') };
        break;
      case 'progress':
        body = { kind, ...progressFields(o, 'progress') };
        break;
      case 'prompt-opened':
        body = { kind, ...promptObject(o, 'prompt', true) };
        break;
      case 'prompt-closed':
        body = {
          kind,
          promptId: pattern(o.promptId, PROMPT_ID, 'promptId'),
          reason: eventEnum(o.reason, CLOSE_REASONS, 'reason'),
        };
        break;
      case 'status':
        body = { kind, ...terminalInfo(o, 'status', true) };
        break;
      case 'armed-state': {
        const armed: ArmedStateEvent = {
          kind,
          armed: bool(o.armed, 'armed'),
          expiresAtMs: nullableCounter(o.expiresAtMs, 'expiresAtMs'),
        };
        if (o.viewers !== undefined) armed.viewers = counter(o.viewers, 'viewers');
        body = armed;
        break;
      }
      default:
        body = { kind: 'unknown' };
    }
  } catch (e) {
    if (e instanceof UnknownValue) body = { kind: 'unknown' };
    else throw e;
  }
  return { v: 1, type: 'event', seq, ...body } as Frame;
}

function decodeSnapshot(o: Obj): Frame {
  const progress =
    o.progress === null ? null : progressFields(obj(o.progress, 'progress'), 'progress');
  const prompt = o.prompt === null ? null : promptObject(obj(o.prompt, 'prompt'), 'prompt', false);
  let terminal = null;
  if (o.terminal !== null) {
    const t = obj(o.terminal, 'terminal');
    terminal = terminalInfo(t, 'terminal', false);
  }
  return {
    v: 1,
    type: 'snapshot',
    seq: counter(o.seq, 'seq'),
    armed: bool(o.armed, 'armed'),
    state: strictEnum(o.state, SESSION_STATES, 'state'),
    jobId: o.jobId === null ? null : pattern(o.jobId, HEX32, 'jobId'),
    jobKind: o.jobKind === null ? null : enumOrOther(o.jobKind, JOB_KINDS, 'jobKind'),
    progress,
    prompt,
    terminal,
  };
}

function decodeBody(o: Obj): Frame {
  const type = o.type;
  switch (type) {
    case 'hello': {
      strictKeys(
        o,
        [
          'v',
          'type',
          'role',
          'protocolVersions',
          'installId',
          'sessionId',
          'appId',
          'agentVersion',
        ],
        'hello',
      );
      const role = strictEnum(o.role, ROLES, 'role');
      const versions = o.protocolVersions;
      if (
        !Array.isArray(versions) ||
        versions.length < 1 ||
        versions.length > 8 ||
        !versions.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535)
      )
        throw new Bad('protocolVersions: invalid');
      const hello: Hello = { v: 1, type: 'hello', role, protocolVersions: versions as number[] };
      if (role === 'agent') {
        hello.installId = pattern(o.installId, HEX32, 'installId');
        hello.sessionId = pattern(o.sessionId, HEX32, 'sessionId');
        hello.appId = pattern(o.appId, APP_ID, 'appId');
        hello.agentVersion = pattern(o.agentVersion, AGENT_VERSION, 'agentVersion');
      } else {
        for (const k of ['installId', 'sessionId', 'appId', 'agentVersion'])
          if (o[k] !== undefined) throw new Bad(`${k}: not allowed for browser`);
      }
      return hello;
    }
    case 'auth-challenge':
      strictKeys(o, ['v', 'type', 'nonce'], 'auth-challenge');
      return { v: 1, type, nonce: pattern(o.nonce, B64U_32, 'nonce') };
    case 'auth-response':
      strictKeys(o, ['v', 'type', 'agentNonce', 'signature'], 'auth-response');
      return {
        v: 1,
        type,
        agentNonce: pattern(o.agentNonce, B64U_32, 'agentNonce'),
        signature: pattern(o.signature, B64U_64, 'signature'),
      };
    case 'auth-ok':
      strictKeys(o, ['v', 'type', 'serverTimeMs'], 'auth-ok');
      return { v: 1, type, serverTimeMs: counter(o.serverTimeMs, 'serverTimeMs') };
    case 'event':
      return decodeEvent(o);
    case 'action': {
      strictKeys(o, ['v', 'type', 'actionId', 'action', 'promptId'], 'action');
      const action = strictEnum(o.action, ACTION_KINDS, 'action');
      const out: Action = {
        v: 1,
        type,
        actionId: pattern(o.actionId, ACTION_ID, 'actionId'),
        action,
      };
      if (o.promptId !== undefined) out.promptId = pattern(o.promptId, PROMPT_ID, 'promptId');
      if ((action === 'next' || action === 'done') && out.promptId === undefined)
        throw new Bad('promptId: required for next and done');
      return out;
    }
    case 'action-result': {
      strictKeys(o, ['v', 'type', 'actionId', 'outcome', 'reason', 'state'], 'action-result');
      const outcome = strictEnum(o.outcome, ['accepted', 'rejected'] as const, 'outcome');
      const out: ActionResult = {
        v: 1,
        type,
        actionId: pattern(o.actionId, ACTION_ID, 'actionId'),
        outcome,
      };
      if (outcome === 'rejected') out.reason = strictEnum(o.reason, REJECT_REASONS, 'reason');
      else if (o.reason !== undefined) throw new Bad('reason: not allowed when accepted');
      if (o.state !== undefined) out.state = strictEnum(o.state, SESSION_STATES, 'state');
      return out;
    }
    case 'resync':
      strictKeys(o, ['v', 'type', 'lastSeq'], 'resync');
      return { v: 1, type, lastSeq: counter(o.lastSeq, 'lastSeq') };
    case 'resync-result':
      strictKeys(o, ['v', 'type', 'fromSeq', 'toSeq', 'gap'], 'resync-result');
      return {
        v: 1,
        type,
        fromSeq: counter(o.fromSeq, 'fromSeq'),
        toSeq: counter(o.toSeq, 'toSeq'),
        gap: bool(o.gap, 'gap'),
      };
    case 'snapshot':
      return decodeSnapshot(o);
    case 'ping':
    case 'pong':
      strictKeys(o, ['v', 'type'], type);
      return { v: 1, type };
    case 'error':
      strictKeys(o, ['v', 'type', 'code', 'fatal'], 'error');
      return {
        v: 1,
        type,
        code: strictEnum(o.code, ERROR_CODES, 'code'),
        fatal: bool(o.fatal, 'fatal'),
      };
    default:
      throw new Bad('type: unknown');
  }
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Decodes and validates one frame. Never throws. */
export function decodeFrame(raw: string): DecodeResult {
  if (utf8Length(raw) > MAX_FRAME_BYTES)
    return { ok: false, error: 'frame-too-large', detail: 'frame exceeds 16 KiB' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed', detail: 'not JSON' };
  }
  if (!isObj(parsed)) return { ok: false, error: 'malformed', detail: 'not an object' };
  if (typeof parsed.v !== 'number' || !Number.isInteger(parsed.v))
    return { ok: false, error: 'malformed', detail: 'v: expected integer' };
  if (!SUPPORTED_VERSIONS.includes(parsed.v))
    return { ok: false, error: 'unsupported-version', detail: 'version not supported' };
  try {
    return { ok: true, frame: decodeBody(parsed) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: 'malformed', detail: e.message };
    throw e;
  }
}

/** Serialises a frame. Throws when the result exceeds the frame cap. */
export function encodeFrame(frame: Frame): string {
  const s = JSON.stringify(frame);
  if (utf8Length(s) > MAX_FRAME_BYTES) throw new Error('frame exceeds 16 KiB');
  return s;
}

/** Keeps at most 80 characters, strips control characters, and drops path-like text. */
export function sanitizeText(input: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\u0000-\u001f\u007f]/g, '');
  const trimmed = [...stripped].slice(0, MAX_TEXT_CHARS).join('');
  if (trimmed.length === 0 || CONTROL_OR_SEPARATOR.test(trimmed) || /^[A-Za-z]:/.test(trimmed))
    return undefined;
  return trimmed;
}
