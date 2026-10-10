import { describe, expect, it } from 'vitest';
import { Machine, decideAction, decodeFrame } from '../src/index.ts';
import type { Action, EventBody, SessionState } from '../src/index.ts';
import { loadJson } from './fixtures.ts';

interface StateCase {
  name: string;
  steps: { event: Record<string, unknown>; expect: { ok: boolean; state: SessionState } }[];
}

interface RuleCase {
  name: string;
  state: SessionState;
  prompt: { promptId: string; expects: 'next' | 'done' } | null;
  issued: string[];
  action: { action: Action['action']; promptId?: string };
  expect: string;
}

function body(event: Record<string, unknown>): EventBody {
  const r = decodeFrame(JSON.stringify({ v: 1, type: 'event', seq: 1, ...event }));
  if (!r.ok || r.frame.type !== 'event')
    throw new Error(`bad fixture event ${JSON.stringify(event)}`);
  const { v: _v, type: _t, seq: _s, ...rest } = r.frame;
  return rest as EventBody;
}

describe('shared behaviour tables', () => {
  const states = loadJson<{ cases: StateCase[] }>('fixtures/state-machine.json').cases;
  const rules = loadJson<{ cases: RuleCase[] }>('fixtures/action-rules.json').cases;

  it('the tables are not empty', () => {
    expect(states.length).toBeGreaterThanOrEqual(73);
    expect(rules.length).toBeGreaterThanOrEqual(22);
  });

  for (const c of states) {
    it(`the state machine agrees on: ${c.name}`, () => {
      const m = new Machine();
      c.steps.forEach((step, i) => {
        expect(m.apply(body(step.event)), `step ${i} legality`).toBe(step.expect.ok);
        expect(m.state, `step ${i} state`).toBe(step.expect.state);
      });
    });
  }

  for (const c of rules) {
    it(`the action allowlist agrees on: ${c.name}`, () => {
      const action: Action = { v: 1, type: 'action', actionId: 'act-0001-abcd', ...c.action };
      const got = decideAction(action, c.state, c.prompt, (id) => c.issued.includes(id));
      expect(got ?? 'accepted').toBe(c.expect);
    });
  }

  it('a snapshot taken from a machine restores an equal machine', () => {
    const m = new Machine();
    m.apply(body({ kind: 'job-started', jobId: '0'.repeat(32), jobKind: 'record-watch' }));
    m.apply(
      body({
        kind: 'prompt-opened',
        promptId: 'p-1',
        expects: 'done',
        labelId: 'other',
        blocking: false,
      }),
    );
    const restored = Machine.fromSnapshot(m.snapshot(7, true));
    expect(restored.state).toBe('awaiting-user');
    expect(restored.prompt?.promptId).toBe('p-1');
    expect(restored.apply(body({ kind: 'prompt-closed', promptId: 'p-1', reason: 'auto' }))).toBe(
      true,
    );
  });
});
