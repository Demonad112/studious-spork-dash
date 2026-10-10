import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setClock } from '../src/clock.ts';
import { RING_SIZE } from '../src/session-do.ts';
import {
  JOB_ID,
  SESSION_A,
  SESSION_B,
  accessKit,
  actionFrame,
  attachBrowser,
  connectAgent,
  enroll,
  event,
  jobStarted,
  openAgentSocket,
  openBrowserSocket,
  progressEvent,
  promptClosed,
  promptOpened,
  registryStub,
  sessionStub,
  snapshot,
  statusEvent,
  testEnv,
  type Json,
} from './helpers.ts';

async function rig() {
  const kit = await accessKit();
  const keys = await enroll();
  const agent = await connectAgent(keys);
  const browser = await attachBrowser(kit, keys.installId);
  await agent.drain();
  await browser.drain();
  return { kit, keys, agent, browser };
}

async function sessionRows(installId: string, sql: string): Promise<Json[]> {
  return runInDurableObject(sessionStub(testEnv, installId), (_i, state) =>
    state.storage.sql.exec(sql).toArray(),
  ) as Promise<Json[]>;
}

describe('events from the agent', () => {
  it('a job-started event is forwarded to the browser and moves the stored state to running', async () => {
    const { keys, agent, browser } = await rig();
    agent.send(jobStarted(1));
    expect(await browser.nextEvent('job-started')).toMatchObject({ seq: 1, jobId: JOB_ID });
    expect((await sessionStub(testEnv, keys.installId).getView()).state).toBe('running');
  });

  it('progress is forwarded without consuming a sequence number', async () => {
    const { agent, browser } = await rig();
    agent.send(jobStarted(1));
    agent.send(progressEvent(1));
    agent.send(progressEvent(1, { percent: 50 }));
    agent.send(promptOpened(2));
    await browser.nextEvent('job-started');
    expect((await browser.nextEvent('progress')).percent).toBe(10);
    expect((await browser.nextEvent('progress')).percent).toBe(50);
    expect(await browser.nextEvent('prompt-opened')).toMatchObject({ seq: 2 });
  });

  it('an illegal transition is dropped, audited and not forwarded', async () => {
    const { keys, agent, browser } = await rig();
    agent.send(promptOpened(1));
    expect(await browser.drain()).toEqual([]);
    const audit = await sessionStub(testEnv, keys.installId).getAudit();
    expect(audit.find((r) => r.code === 'event-dropped')?.detail).toBe('prompt-opened');
  });

  it('a duplicate of an event already applied is ignored', async () => {
    const { agent, browser } = await rig();
    agent.send(jobStarted(1));
    agent.send(jobStarted(1));
    await browser.nextEvent('job-started');
    expect(await browser.drain()).toEqual([]);
  });

  it('an unknown event kind keeps its sequence number but is not forwarded', async () => {
    const { agent, browser } = await rig();
    agent.send(event(1, { kind: 'telemetry-from-the-future', n: 1 }));
    agent.send(jobStarted(2));
    expect(await browser.nextEvent('job-started')).toMatchObject({ seq: 2 });
  });

  it('a skipped sequence number makes the relay ask the agent to resync', async () => {
    const { agent } = await rig();
    agent.send(jobStarted(1));
    agent.send(promptOpened(3));
    expect(await agent.nextType('resync')).toMatchObject({ lastSeq: 1 });
  });

  it('the terminal summary is kept after the agent disconnects', async () => {
    const { kit, keys, agent, browser } = await rig();
    agent.send(jobStarted(1));
    agent.send(
      statusEvent(2, 'completed', {
        summary: {
          filesPlanned: 3,
          bytesPlanned: 30,
          ok: 2,
          okBytes: 20,
          skipped: 0,
          failed: 1,
          failedBytes: 10,
          durationMs: 5,
        },
      }),
    );
    await browser.nextEvent('status');
    agent.ws.close(1000, 'bye');
    await browser.next((f) => f.type === 'event' && f.kind === 'armed-state' && f.armed === false);
    const again = await openBrowserSocket(kit, keys.installId);
    again.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
    await again.nextType('auth-ok');
    again.send({ v: 1, type: 'resync', lastSeq: 0 });
    const snap = await again.nextType('snapshot');
    expect(snap).toMatchObject({ state: 'completed', armed: false });
    expect(snap.terminal.summary.failed).toBe(1);
  });

  it('a hello with a new session id clears the old session', async () => {
    const { keys, agent } = await rig();
    agent.send(jobStarted(1));
    agent.send(statusEvent(2));
    await agent.drain();
    const second = await connectAgent(keys, SESSION_B);
    void second;
    const view = await sessionStub(testEnv, keys.installId).getView();
    expect(view.state).toBe('idle');
    expect((await sessionRows(keys.installId, 'SELECT count(*) AS c FROM ring'))[0]!.c).toBe(0);
  });

  it('a reconnect with the same session id keeps the stored state and asks for a resync from the head', async () => {
    const { keys, agent } = await rig();
    agent.send(jobStarted(1));
    agent.send(promptOpened(2));
    await new Promise((r) => setTimeout(r, 80));
    agent.ws.close(1000, 'bye');
    await agent.waitClosed();
    const again = await connectAgent(keys);
    expect(again.resyncSeen).toMatchObject({ lastSeq: 2 });
    expect((await sessionStub(testEnv, keys.installId).getView()).state).toBe('awaiting-user');
  });
});

describe('browser attach and resync', () => {
  it('a browser attached mid-job is served by the relay alone', async () => {
    const { kit, keys, agent } = await rig();
    agent.send(jobStarted(1));
    agent.send(progressEvent(1, { percent: 42 }));
    agent.send(promptOpened(2));
    await new Promise((r) => setTimeout(r, 100));
    await agent.drain();
    const late = await openBrowserSocket(kit, keys.installId);
    late.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
    await late.nextType('auth-ok');
    late.send({ v: 1, type: 'resync', lastSeq: 0 });
    expect(await late.nextType('resync-result')).toMatchObject({
      fromSeq: 1,
      toSeq: 2,
      gap: false,
    });
    const snap = await late.nextType('snapshot');
    expect(snap).toMatchObject({ state: 'awaiting-user', seq: 2, armed: true });
    expect(snap.progress.percent).toBe(42);
    expect(snap.prompt.promptId).toBe('p1');
    expect((await late.nextEvent('job-started')).seq).toBe(1);
    expect((await late.nextEvent('prompt-opened')).seq).toBe(2);
    expect(await agent.quiet()).toEqual([]);
  });

  it('a browser that is current gets an empty replay', async () => {
    const { kit, keys, agent } = await rig();
    agent.send(jobStarted(1));
    await new Promise((r) => setTimeout(r, 50));
    const late = await attachBrowser(kit, keys.installId, 1);
    expect(await late.quiet()).toEqual([]);
  });

  it('a browser further behind than the ring is told there is a gap', async () => {
    const { kit, keys, agent } = await rig();
    agent.send(jobStarted(1));
    for (let i = 0; i < RING_SIZE + 5; i++) {
      agent.send(promptOpened(2 + i * 2, `p${i}`));
      agent.send(promptClosed(3 + i * 2, `p${i}`));
    }
    await new Promise((r) => setTimeout(r, 300));
    const late = await openBrowserSocket(kit, keys.installId);
    late.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
    await late.nextType('auth-ok');
    late.send({ v: 1, type: 'resync', lastSeq: 1 });
    const r = await late.nextType('resync-result');
    expect(r.gap).toBe(true);
    await late.nextType('snapshot');
    expect(await late.quiet()).toEqual([]);
    const rows = await sessionRows(keys.installId, 'SELECT count(*) AS c FROM ring');
    expect(rows[0]!.c).toBe(RING_SIZE);
  });

  it('a browser from an older session whose sequence number is ahead gets a snapshot to rebuild from', async () => {
    const { kit, keys } = await rig();
    const late = await openBrowserSocket(kit, keys.installId);
    late.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
    await late.nextType('auth-ok');
    late.send({ v: 1, type: 'resync', lastSeq: 900 });
    expect(await late.nextType('resync-result')).toMatchObject({
      gap: false,
      toSeq: 0,
      fromSeq: 1,
    });
    expect((await late.nextType('snapshot')).seq).toBe(0);
  });
});

describe('agent resync after reconnect', () => {
  async function reconnect() {
    const { kit, keys, agent, browser } = await rig();
    agent.send(jobStarted(1));
    agent.send(promptOpened(2, 'p1', 'done'));
    await browser.nextEvent('prompt-opened');
    agent.ws.close(1000, 'drop');
    await agent.waitClosed();
    await browser.next((f) => f.type === 'event' && f.kind === 'armed-state' && f.armed === false);
    const again = await connectAgent(keys, SESSION_A, { settle: false });
    return { kit, keys, browser, again };
  }

  it('replayed events after the old head are forwarded and the snapshot is not applied twice', async () => {
    const { keys, browser, again } = await reconnect();
    expect(again.resyncSeen).toMatchObject({ lastSeq: 2 });
    again.send({ v: 1, type: 'resync-result', fromSeq: 3, toSeq: 4, gap: false });
    again.send(snapshot(4, { state: 'running', jobId: JOB_ID, jobKind: 'simulated' }));
    again.send(promptClosed(3, 'p1', 'answered-local'));
    again.send(event(4, { kind: 'step', step: 'finishing' }));
    expect(await browser.nextEvent('prompt-closed')).toMatchObject({ seq: 3 });
    expect(await browser.nextEvent('step')).toMatchObject({ seq: 4 });
    const view = await sessionStub(testEnv, keys.installId).getView();
    expect(view.state).toBe('running');
    const codes = (await sessionStub(testEnv, keys.installId).getAudit()).map((r) => r.code);
    expect(codes).not.toContain('event-dropped');
    // Live events continue from the new head.
    again.send(statusEvent(5));
    expect(await browser.nextEvent('status')).toMatchObject({ seq: 5 });
  });

  it('a resync that reports a gap replaces the stored state and sends browsers one snapshot', async () => {
    const { keys, browser, again } = await reconnect();
    again.send({ v: 1, type: 'resync-result', fromSeq: 300, toSeq: 400, gap: true });
    again.send(snapshot(400, { state: 'running', jobId: JOB_ID, jobKind: 'simulated' }));
    const snap = await browser.nextType('snapshot');
    expect(snap).toMatchObject({ seq: 400, state: 'running' });
    const rows = await sessionRows(keys.installId, 'SELECT count(*) AS c FROM ring');
    expect(rows[0]!.c).toBe(0);
    again.send(event(401, { kind: 'step', step: 'finishing' }));
    expect(await browser.nextEvent('step')).toMatchObject({ seq: 401 });
  });

  it('a resync with nothing missed sends browsers a fresh snapshot and no events', async () => {
    const { browser, again } = await reconnect();
    again.send({ v: 1, type: 'resync-result', fromSeq: 3, toSeq: 2, gap: false });
    again.send(
      snapshot(2, {
        state: 'awaiting-user',
        jobId: JOB_ID,
        jobKind: 'simulated',
        prompt: { promptId: 'p1', expects: 'done', labelId: 'finish-and-check', blocking: true },
      }),
    );
    expect(await browser.nextType('snapshot')).toMatchObject({ seq: 2, state: 'awaiting-user' });
  });

  it('a snapshot the relay did not ask for is ignored', async () => {
    const { keys, agent, browser } = await rig();
    agent.send(jobStarted(1));
    await browser.nextEvent('job-started');
    agent.send(snapshot(99, { state: 'completed' }));
    expect(await browser.quiet()).toEqual([]);
    expect((await sessionStub(testEnv, keys.installId).getView()).state).toBe('running');
  });
});

describe('browser actions', () => {
  async function awaiting() {
    const r = await rig();
    r.agent.send(jobStarted(1));
    r.agent.send(promptOpened(2, 'p1', 'done'));
    await r.browser.nextEvent('prompt-opened');
    await r.browser.drain();
    await r.agent.drain();
    return r;
  }

  it('an allowed action is forwarded to the agent and its result is broadcast', async () => {
    const { agent, browser } = await awaiting();
    browser.send(actionFrame('act-done-0001', 'done', 'p1'));
    expect(await agent.nextType('action')).toMatchObject({
      actionId: 'act-done-0001',
      action: 'done',
      promptId: 'p1',
    });
    agent.send({
      v: 1,
      type: 'action-result',
      actionId: 'act-done-0001',
      outcome: 'accepted',
      state: 'running',
    });
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-done-0001',
      outcome: 'accepted',
    });
  });

  it('an action the state does not allow is rejected by the relay and never reaches the agent', async () => {
    const { agent, browser } = await awaiting();
    browser.send(actionFrame('act-next-0001', 'next', 'p1'));
    expect(await browser.nextType('action-result')).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid-state',
    });
    expect(await agent.quiet()).toEqual([]);
  });

  it('an action for a prompt that is not open is stale', async () => {
    const { agent, browser } = await awaiting();
    browser.send(actionFrame('act-done-0002', 'done', 'zzz'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'stale-prompt' });
    expect(await agent.quiet()).toEqual([]);
  });

  it('an answer for a prompt that already closed is stale', async () => {
    const { agent, browser } = await awaiting();
    agent.send(promptClosed(3, 'p1', 'answered-local'));
    await browser.nextEvent('prompt-closed');
    browser.send(actionFrame('act-done-0003', 'done', 'p1'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'stale-prompt' });
  });

  it('a duplicate action id returns the stored result and does not run twice', async () => {
    const { agent, browser } = await awaiting();
    browser.send(actionFrame('act-done-0004', 'done', 'p1'));
    await agent.nextType('action');
    agent.send({ v: 1, type: 'action-result', actionId: 'act-done-0004', outcome: 'accepted' });
    await browser.nextType('action-result');
    browser.send(actionFrame('act-done-0004', 'done', 'p1'));
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-done-0004',
      outcome: 'accepted',
    });
    expect(await agent.quiet()).toEqual([]);
  });

  it('a duplicate of an action still in flight is dropped', async () => {
    const { agent, browser } = await awaiting();
    browser.send(actionFrame('act-done-0005', 'done', 'p1'));
    await agent.nextType('action');
    browser.send(actionFrame('act-done-0005', 'done', 'p1'));
    expect(await browser.quiet()).toEqual([]);
    expect(await agent.quiet()).toEqual([]);
  });

  it('a sixth action inside one second is rate limited', async () => {
    const { agent, browser } = await rig();
    for (let i = 0; i < 5; i++) browser.send(actionFrame(`act-stat-000${i}`, 'status'));
    browser.send(actionFrame('act-stat-0009', 'status'));
    const forwarded = [];
    for (let i = 0; i < 5; i++) forwarded.push(await agent.nextType('action'));
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-stat-0009',
      reason: 'rate-limited',
    });
  });

  it('the rate limit bucket refills with time', async () => {
    const { agent, browser } = await rig();
    for (let i = 0; i < 5; i++) browser.send(actionFrame(`act-stat-100${i}`, 'status'));
    for (let i = 0; i < 5; i++) await agent.nextType('action');
    setClock(() => Date.now() + 2000);
    try {
      browser.send(actionFrame('act-stat-1009', 'status'));
      expect(await agent.nextType('action')).toMatchObject({ actionId: 'act-stat-1009' });
    } finally {
      setClock(null);
    }
  });

  it('an action while no agent is connected is rejected as disarmed', async () => {
    const { agent, browser } = await rig();
    agent.ws.close(1000, 'bye');
    await agent.waitClosed();
    await browser.next((f) => f.type === 'event' && f.kind === 'armed-state' && f.armed === false);
    browser.send(actionFrame('act-stat-2000', 'status'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'disarmed' });
  });

  it('an action after the agent said the session expires is rejected as expired', async () => {
    const { agent, browser } = await rig();
    agent.send(event(0, { kind: 'armed-state', armed: true, expiresAtMs: Date.now() + 1000 }));
    await browser.nextEvent('armed-state');
    setClock(() => Date.now() + 5000);
    try {
      browser.send(actionFrame('act-stat-3000', 'status'));
      expect(await browser.nextType('action-result')).toMatchObject({ reason: 'expired' });
    } finally {
      setClock(null);
    }
  });

  it('an action with an unknown kind is answered unknown-action', async () => {
    const { browser } = await rig();
    browser.send({ v: 1, type: 'action', actionId: 'act-bad-0001', action: 'start-job' });
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-bad-0001',
      reason: 'unknown-action',
    });
  });

  it('an action with a path field is answered malformed', async () => {
    const { browser } = await rig();
    browser.send({
      v: 1,
      type: 'action',
      actionId: 'act-bad-0002',
      action: 'status',
      path: 'C:\\x',
    });
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-bad-0002',
      reason: 'malformed',
    });
  });

  it('next without a prompt id is answered malformed', async () => {
    const { browser } = await rig();
    browser.send({ v: 1, type: 'action', actionId: 'act-bad-0003', action: 'next' });
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'malformed' });
  });

  it('a broken frame with no usable action id gets an error and no result', async () => {
    const { browser } = await rig();
    browser.send({ v: 1, type: 'action', actionId: 'x', action: 'status' });
    const err = await browser.nextType('error');
    expect(err).toMatchObject({ code: 'malformed', fatal: false });
  });

  it('in-flight actions are failed as disarmed when the agent disconnects', async () => {
    const { agent, browser } = await awaiting();
    browser.send(actionFrame('act-done-0009', 'done', 'p1'));
    await agent.nextType('action');
    agent.ws.close(1000, 'bye');
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-done-0009',
      reason: 'disarmed',
    });
  });

  it('the dedup set keeps only the newest 128 action ids', async () => {
    const { keys, agent, browser } = await rig();
    for (let batch = 0; batch < 28; batch++) {
      // Move the clock a second per batch so the bucket refills.
      setClock(() => Date.now() + batch * 1000);
      for (let i = 0; i < 5; i++)
        browser.send(actionFrame(`act-many-${String(batch * 5 + i).padStart(4, '0')}`, 'status'));
      for (let i = 0; i < 5; i++) await agent.nextType('action');
    }
    setClock(null);
    const rows = await sessionRows(keys.installId, 'SELECT count(*) AS c FROM dedup');
    expect(rows[0]!.c).toBe(128);
  });
});

describe('connection limits and viewers', () => {
  it('a fourth browser is refused with too-many-connections', async () => {
    const { kit, keys } = await rig();
    await attachBrowser(kit, keys.installId);
    await attachBrowser(kit, keys.installId);
    const fourth = await openBrowserSocket(kit, keys.installId);
    expect(await fourth.nextType('error')).toMatchObject({
      code: 'too-many-connections',
      fatal: true,
    });
  });

  it('the agent is told how many dashboards are watching', async () => {
    const { kit, keys, agent, browser } = await rig();
    const second = await attachBrowser(kit, keys.installId);
    const seen = await agent.next(
      (f) => f.type === 'event' && f.kind === 'armed-state' && f.viewers === 2,
    );
    expect(seen.seq).toBe(0);
    second.ws.close(1000, 'bye');
    await agent.next((f) => f.type === 'event' && f.kind === 'armed-state' && f.viewers === 1);
    void browser;
  });
});

describe('kill switch', () => {
  it('revoking closes the agent socket, keeps it out and is audited', async () => {
    const { kit, keys, agent, browser } = await rig();
    const res = await kit.fetch(`/api/installs/${keys.installId}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await agent.nextType('error')).toMatchObject({ code: 'locked', fatal: true });
    await agent.waitClosed();
    browser.send(actionFrame('act-lock-0001', 'status'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'locked' });
    const again = await openAgentSocket(keys.installId);
    expect(await again.nextType('error')).toMatchObject({ code: 'locked' });
    const codes = (await sessionStub(testEnv, keys.installId).getAudit()).map((r) => r.code);
    expect(codes).toContain('revoked');
  });

  it('unlocking lets the agent connect again', async () => {
    const { kit, keys } = await rig();
    const post = (action: string) =>
      kit.fetch(`/api/installs/${keys.installId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    await post('revoke');
    await post('unlock');
    const back = await connectAgent(keys);
    expect(back.closed).toBeNull();
    expect((await sessionStub(testEnv, keys.installId).getView()).locked).toBe(false);
  });

  it('rotating a key kicks the agent and requires pairing again with the same install id', async () => {
    const { kit, keys, agent } = await rig();
    const res = await kit.fetch(`/api/installs/${keys.installId}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await agent.waitClosed();
    const rec = await registryStub(testEnv).getInstall(keys.installId);
    expect(rec).toMatchObject({ status: 'rekey', publicKey: '' });
    const started = await registryStub(testEnv).pairStart(keys.installId, keys.publicKey, 'ip-rot');
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(await registryStub(testEnv).lookup(started.pairingCode)).toMatchObject({
        rekey: true,
      });
      expect(await registryStub(testEnv).approve(started.pairingCode, 'Renamed', true)).toBe(true);
    }
    expect(await registryStub(testEnv).getInstall(keys.installId)).toMatchObject({
      status: 'active',
      displayName: 'Renamed',
    });
  });
});

describe('hibernation and eviction', () => {
  it('validation is still correct after the Session object is evicted', async () => {
    const { keys, agent, browser } = await rig();
    agent.send(jobStarted(1));
    agent.send(promptOpened(2, 'p9', 'done'));
    agent.send(progressEvent(2, { percent: 77 }));
    await browser.nextEvent('prompt-opened');
    await browser.nextEvent('progress');
    browser.send(actionFrame('act-evic-0001', 'done', 'p9'));
    await agent.next((f) => f.type === 'action');
    await evictDurableObject(sessionStub(testEnv, keys.installId));
    // Duplicate detection survives: the in-flight id is still known, so nothing is forwarded.
    browser.send(actionFrame('act-evic-0001', 'done', 'p9'));
    // A wrong-kind action is still rejected against the stored prompt.
    browser.send(actionFrame('act-evic-0002', 'next', 'p9'));
    expect(await browser.nextType('action-result')).toMatchObject({
      actionId: 'act-evic-0002',
      reason: 'invalid-state',
    });
    // The stale prompt check still works against the stored prompt id.
    browser.send(actionFrame('act-evic-0003', 'done', 'other'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'stale-prompt' });
    expect(await agent.quiet()).toEqual([]);
    // The agent socket survived hibernation and its events still apply in order.
    agent.send(promptClosed(3, 'p9', 'answered-remote'));
    expect(await browser.nextEvent('prompt-closed')).toMatchObject({ seq: 3 });
    browser.send(actionFrame('act-evic-0004', 'done', 'p9'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'stale-prompt' });
  });

  it('the rate limit bucket and the issued prompt ids live in storage, not memory', async () => {
    const { keys, agent, browser } = await rig();
    for (let i = 0; i < 5; i++) browser.send(actionFrame(`act-bkt-000${i}`, 'status'));
    for (let i = 0; i < 5; i++) await agent.nextType('action');
    await evictDurableObject(sessionStub(testEnv, keys.installId));
    browser.send(actionFrame('act-bkt-0009', 'status'));
    expect(await browser.nextType('action-result')).toMatchObject({ reason: 'rate-limited' });
  });

  it('a new browser attaches to an evicted object and is served from storage', async () => {
    const { kit, keys, agent } = await rig();
    agent.send(jobStarted(1));
    agent.send(promptOpened(2));
    await new Promise((r) => setTimeout(r, 100));
    await evictDurableObject(sessionStub(testEnv, keys.installId));
    const late = await openBrowserSocket(kit, keys.installId);
    late.send({ v: 1, type: 'hello', role: 'browser', protocolVersions: [1] });
    await late.nextType('auth-ok');
    late.send({ v: 1, type: 'resync', lastSeq: 0 });
    await late.nextType('resync-result');
    expect(await late.nextType('snapshot')).toMatchObject({ state: 'awaiting-user', seq: 2 });
    expect((await late.nextEvent('prompt-opened')).seq).toBe(2);
  });
});

describe('data minimisation', () => {
  it('an event that carries a path in its text ends the agent socket and reaches no browser', async () => {
    const { agent, browser } = await rig();
    agent.send(jobStarted(1));
    await browser.nextEvent('job-started');
    agent.send(
      event(2, {
        kind: 'prompt-opened',
        promptId: 'p1',
        expects: 'done',
        labelId: 'confirm',
        blocking: true,
        text: 'C:\\Users\\bob\\file.txt',
      }),
    );
    expect(await agent.nextType('error')).toMatchObject({ code: 'malformed', fatal: true });
    expect(await browser.quiet()).toEqual([]);
  });

  it('extra fields on a forwarded event are dropped', async () => {
    const { agent, browser } = await rig();
    agent.send(
      event(1, { kind: 'job-started', jobId: JOB_ID, jobKind: 'simulated', hostname: 'pc-01' }),
    );
    const got = await browser.nextEvent('job-started');
    expect(JSON.stringify(got)).not.toContain('pc-01');
  });

  it('audit rows hold only short codes after a busy session', async () => {
    const { keys, agent, browser } = await rig();
    agent.send(jobStarted(1));
    agent.send(promptOpened(2));
    await browser.nextEvent('prompt-opened');
    browser.send(actionFrame('act-aud-0001', 'done', 'p1'));
    browser.send(actionFrame('act-aud-0002', 'next', 'p1'));
    browser.send({ v: 1, type: 'action', actionId: 'act-aud-0003', action: 'start-job' });
    await agent.nextType('action');
    await browser.nextType('action-result');
    const rows = await sessionStub(testEnv, keys.installId).getAudit(500);
    expect(rows.length).toBeGreaterThan(4);
    for (const r of rows) {
      expect(r.code).toMatch(/^[a-z-]+$/);
      expect(r.detail).toMatch(/^[a-z0-9-]{0,32}$/);
    }
  });
});
