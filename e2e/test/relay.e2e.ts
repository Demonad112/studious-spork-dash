import { describe, expect, it } from 'vitest';
import { Browser, Install, api, start, until } from './harness.ts';

describe('browsers attaching and reconnecting', () => {
  it('serves a browser that attaches mid-job from the relay alone', async () => {
    const { install, browser } = await start('watch-finish');
    const opened = await browser.event('prompt-opened');

    const late = new Browser(install.installId);
    await late.connect(0);
    const snapshot = late.frames.find((f) => f.type === 'snapshot')!;
    expect(snapshot.state).toBe('awaiting-user');
    expect(snapshot.prompt.promptId).toBe(opened.promptId);
    expect(snapshot.progress).not.toBeNull();
    const id = late.action('done', opened.promptId);
    expect((await late.result(id)).outcome).toBe('accepted');
    await late.event('status');
    late.close();
  });

  it('replays what a reconnecting browser missed, once', async () => {
    const { install, browser, agent } = await start('watch-auto');
    await browser.event('prompt-opened');
    const seen = browser.lastSeq();
    browser.close();
    await agent.exited();

    const again = new Browser(install.installId);
    await again.connect(seen);
    const resync = again.frames.find((f) => f.type === 'resync-result')!;
    expect(resync.gap).toBe(false);
    expect(resync.fromSeq).toBe(seen + 1);
    const status = await again.event('status');
    expect(status.seq).toBeGreaterThan(seen);
    const replayed = again
      .events()
      .filter((e) => e.kind !== 'progress' && e.kind !== 'armed-state');
    expect(new Set(replayed.map((e) => e.seq)).size).toBe(replayed.length);
    expect(replayed.every((e) => e.seq > seen)).toBe(true);
    again.close();
  });

  it('gives a browser from a newer session a fresh snapshot instead of events', async () => {
    const { install, agent } = await start('watch-auto', { watchFirst: false });
    await agent.exited();
    const odd = new Browser(install.installId);
    await odd.connect(9999);
    const resync = odd.frames.find((f) => f.type === 'resync-result')!;
    expect(resync.gap).toBe(false);
    expect(odd.frames.find((f) => f.type === 'snapshot')!.terminal.status).toBe('completed');
    odd.close();
  });

  it('keeps the terminal summary after the agent has gone', async () => {
    const { install, agent } = await start('watch-auto', { watchFirst: false });
    expect(await agent.exited()).toBe(0);
    const later = new Browser(install.installId);
    await later.connect(0);
    const snapshot = later.frames.find((f) => f.type === 'snapshot')!;
    expect(snapshot.terminal.status).toBe('completed');
    expect(snapshot.terminal.summary.ok).toBeGreaterThan(0);
    expect(snapshot.armed).toBe(false);
    later.close();
  });
});

describe('actions', () => {
  it('runs a duplicate action id once and returns the stored result', async () => {
    const { browser } = await start('watch-finish');
    const opened = await browser.event('prompt-opened');
    const actionId = crypto.randomUUID();
    browser.action('done', opened.promptId, actionId);
    await browser.result(actionId);
    browser.action('done', opened.promptId, actionId);
    await until('the second answer', () =>
      browser.frames.filter((f) => f.type === 'action-result' && f.actionId === actionId).length >=
      2
        ? true
        : undefined,
    );
    const results = browser.frames.filter(
      (f) => f.type === 'action-result' && f.actionId === actionId,
    );
    expect(results.every((r) => r.outcome === results[0]!.outcome)).toBe(true);
    await browser.event('prompt-closed');
    expect(browser.events('prompt-closed')).toHaveLength(1);
  });

  it('rejects an action that does not match the open prompt before the agent sees it', async () => {
    const { browser } = await start('watch-finish');
    const opened = await browser.event('prompt-opened');
    const wrongKind = browser.action('next', opened.promptId);
    expect((await browser.result(wrongKind)).outcome).toBe('rejected');
    const wrongPrompt = browser.action('done', 'old-prompt');
    const stale = await browser.result(wrongPrompt);
    expect(stale.outcome).toBe('rejected');
    expect(stale.reason).toBe('stale-prompt');
    // The prompt is still open and still answerable.
    const ok = browser.action('done', opened.promptId);
    expect((await browser.result(ok)).outcome).toBe('accepted');
  });

  it('rate limits a burst of actions', async () => {
    const { browser } = await start('watch-finish');
    await browser.event('prompt-opened');
    const ids = Array.from({ length: 12 }, () => browser.action('status'));
    for (const id of ids) await browser.result(id);
    const limited = ids.filter(
      (id) =>
        browser.frames.find((f) => f.type === 'action-result' && f.actionId === id)!.reason ===
        'rate-limited',
    );
    expect(limited.length).toBeGreaterThan(0);
  });

  it('rejects an action as disarmed when no agent is connected', async () => {
    const install = await Install.pair();
    const browser = new Browser(install.installId);
    await browser.connect(0);
    const id = browser.action('status');
    const result = await browser.result(id);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('disarmed');
    browser.close();
    install.cleanup();
  });
});

describe('the armed countdown', () => {
  it('shows the session expiry the agent reported and the viewer count', async () => {
    const { browser } = await start('watch-finish');
    const armed = await browser.event(
      'armed-state',
      (f) => f.armed === true && typeof f.expiresAtMs === 'number',
    );
    expect(armed.expiresAtMs).toBeGreaterThan(Date.now());
    expect(armed.viewers).toBeGreaterThanOrEqual(1);
  });
});

describe('revoking', () => {
  it('locks the install, rejects actions and lets a new agent in after unlock', async () => {
    const { install, browser, agent } = await start('watch-finish');
    const opened = await browser.event('prompt-opened');

    expect((await api(`/api/installs/${install.installId}/revoke`, {})).status).toBe(200);
    await until('the agent to be dropped', () =>
      agent.output.includes('disconnected') ? true : undefined,
    );
    const id = browser.action('done', opened.promptId);
    const result = await browser.result(id);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('locked');
    agent.kill();

    const locked = install.run('watch-auto');
    await until('the locked agent to be refused', () =>
      locked.output.includes('disconnected') ? true : undefined,
    );
    expect(locked.output).not.toContain('authenticated');
    locked.kill();

    expect((await api(`/api/installs/${install.installId}/unlock`, {})).status).toBe(200);
    const fresh = install.run('watch-auto');
    await until(
      'the unlocked agent to authenticate',
      () => (fresh.output.includes('authenticated') ? true : undefined),
      30_000,
    );
    fresh.kill();

    const rows = (await api(`/api/installs/${install.installId}/audit`)).body.rows as {
      code: string;
    }[];
    const codes = rows.map((r) => r.code);
    expect(codes).toContain('revoked');
    expect(codes).toContain('unlocked');
  });
});
