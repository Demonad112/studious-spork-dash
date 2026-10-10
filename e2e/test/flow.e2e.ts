import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api, start, until } from './harness.ts';
import type { Json } from './harness.ts';

/** Paths, drive letters, user and machine names must never leave the agent. */
const LEAKS = /[A-Za-z]:[\\/]|\\\\|\/home\/|\/tmp\/|\/Users\/|rc-e2e/;

describe('the watch flow through the real relay', () => {
  it('runs progress, then a prompt, then done, then a completed summary', async () => {
    const { browser, agent } = await start('watch-finish');
    const opened = await browser.event('prompt-opened');
    expect(opened.expects).toBe('done');
    expect(opened.blocking).toBe(false);
    const before = browser.events('progress').length;
    await until(
      'more progress while the prompt is open',
      () => browser.events('progress').length > before + 2,
    );

    const id = browser.action('done', opened.promptId);
    expect((await browser.result(id)).outcome).toBe('accepted');
    await browser.event('prompt-closed', (f) => f.promptId === opened.promptId);
    const status = await browser.event('status');
    expect(status.status).toBe('completed');
    expect(status.summary.ok).toBeGreaterThan(0);
    expect(await agent.exited()).toBe(0);
    // The agent said the transport thread was gone within two seconds of disarm.
    expect(agent.output).toMatch(/\[transport\] stopped \d+ ms after disarm/);
  });

  it('shows an indeterminate bar first and known totals after the listing', async () => {
    const { browser, agent } = await start('watch-auto');
    await browser.event('status');
    const progress = browser.events('progress');
    const first = progress.find((p) => p.percent === null);
    expect(first).toBeDefined();
    expect(first?.filesTotal).toBeNull();
    const known = progress.find((p) => p.percent !== null);
    expect(known).toBeDefined();
    expect(known?.filesTotal).toBeGreaterThan(0);
    expect(progress.indexOf(first as Json)).toBeLessThan(progress.indexOf(known as Json));
    await agent.exited();
  });

  it('closes a watch prompt by itself with no action when the app finishes on its own', async () => {
    const { browser, agent } = await start('watch-auto');
    const opened = await browser.event('prompt-opened');
    const closed = await browser.event('prompt-closed', (f) => f.promptId === opened.promptId);
    expect(closed.reason).toBe('auto');
    expect((await browser.event('status')).status).toBe('completed');
    expect(browser.frames.some((f) => f.type === 'action-result')).toBe(false);
    await agent.exited();
  });

  it('answers a remote done as stale when the app was answered locally first', async () => {
    const { browser, agent } = await start('watch-local-finish');
    const opened = await browser.event('prompt-opened');
    const closed = await browser.event('prompt-closed', (f) => f.promptId === opened.promptId);
    expect(closed.reason).toBe('answered-local');
    const id = browser.action('done', opened.promptId);
    const result = await browser.result(id);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('stale-prompt');
    await agent.exited();
  });

  it('accepts a cancel and confirms it with a cancelled status', async () => {
    const { browser, agent } = await start('cancel-midway');
    await browser.event('progress', (f) => f.step === 'copying' && f.percent >= 10);
    const id = browser.action('cancel');
    const result = await browser.result(id);
    expect(result.outcome).toBe('accepted');
    const status = await browser.event('status');
    expect(status.status).toBe('cancelled');
    await agent.exited();
  });

  it('carries a next action for a preflight prompt', async () => {
    const { browser, agent } = await start('preflight-next');
    const opened = await browser.event('prompt-opened');
    expect(opened.expects).toBe('next');
    const id = browser.action('next', opened.promptId);
    expect((await browser.result(id)).outcome).toBe('accepted');
    expect((await browser.event('status')).status).toBe('completed');
    await agent.exited();
  });

  it('reports a failed copy with its failure code', async () => {
    const { browser, agent } = await start('copy-fail');
    const status = await browser.event('status');
    expect(status.status).toBe('failed');
    expect(status.failureCode).toBe('not-enough-space');
    await agent.exited();
  });
});

describe('what leaves the agent', () => {
  it('holds no path, name or secret in any frame, audit row or agent log', async () => {
    const { install, browser, agent } = await start('watch-finish');
    const opened = await browser.event('prompt-opened');
    browser.action('done', opened.promptId);
    await browser.event('status');
    await agent.exited();

    expect(JSON.stringify(browser.frames)).not.toMatch(LEAKS);
    const audit = await api(`/api/installs/${install.installId}/audit`);
    expect(JSON.stringify(audit.body)).not.toMatch(LEAKS);
    for (const name of readdirSync(install.dataDir)) {
      if (!name.endsWith('.jsonl')) continue;
      expect(readFileSync(join(install.dataDir, name), 'utf8')).not.toMatch(LEAKS);
    }
    expect(agent.output).not.toMatch(LEAKS);
  });
});
