import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ProgressPanel from '../src/components/ProgressPanel.vue';
import PromptCard from '../src/components/PromptCard.vue';
import SummaryCard from '../src/components/SummaryCard.vue';
import { LiveSession } from '../src/lib/live.ts';
import { AUTH_OK, JOB, PROMPT, ev, progress, snap } from './helpers.ts';

function running(): LiveSession {
  const s = new LiveSession();
  s.apply(AUTH_OK, 0);
  s.apply(snap({ seq: 0 }), 0);
  s.apply(ev(1, { kind: 'job-started', jobId: JOB, jobKind: 'record-copy' }), 0);
  return s;
}

describe('progress panel', () => {
  it('shows an indeterminate bar and a found count while totals are unknown', () => {
    const s = running();
    s.apply(
      ev(1, {
        kind: 'progress',
        ...progress({
          step: 'listing-source',
          percent: null,
          filesTotal: null,
          bytesTotal: null,
          filesDone: 4210,
        }),
      }),
      0,
    );
    const w = mount(ProgressPanel, { props: { live: s.current } });
    expect(w.find('[data-testid=bar-indeterminate]').exists()).toBe(true);
    expect(w.get('[data-testid=files]').text()).toBe('4,210 found');
    expect(w.text()).toContain('Listing the source…');
  });

  it('shows a determinate bar and x of y once totals are known', () => {
    const s = running();
    s.apply(
      ev(1, { kind: 'progress', ...progress({ percent: 40, filesDone: 4, filesTotal: 10 }) }),
      0,
    );
    const w = mount(ProgressPanel, { props: { live: s.current } });
    expect(w.find('[data-testid=bar-indeterminate]').exists()).toBe(false);
    expect(w.get('[data-testid=bar-determinate]').attributes('style')).toContain('width: 40%');
    expect(w.get('[data-testid=files]').text()).toBe('4 of 10');
  });

  it('shows the not copied count in the danger colour only above zero', () => {
    const s = running();
    s.apply(ev(1, { kind: 'progress', ...progress({ failed: 0 }) }), 0);
    expect(
      mount(ProgressPanel, { props: { live: s.current } })
        .get('[data-testid=not-copied]')
        .classes(),
    ).not.toContain('text-danger');
    s.apply(ev(1, { kind: 'progress', ...progress({ failed: 2 }) }), 0);
    expect(
      mount(ProgressPanel, { props: { live: s.current } })
        .get('[data-testid=not-copied]')
        .classes(),
    ).toContain('text-danger');
  });
});

describe('prompt card', () => {
  it('enables Finish only for a prompt that expects done', () => {
    const s = running();
    s.apply(
      ev(2, {
        kind: 'prompt-opened',
        promptId: PROMPT,
        expects: 'done',
        labelId: 'finish-and-check',
        blocking: false,
        text: 'Press when the copy looks right',
      }),
      0,
    );
    const w = mount(PromptCard, { props: { live: s.current, locked: false } });
    expect(w.get('[data-testid=finish]').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-testid=finish]').text()).toContain('Finish and check');
    expect(w.find('[data-testid=next]').exists()).toBe(false);
    expect(w.get('[data-testid=prompt-text]').text()).toBe('Press when the copy looks right');
  });

  it('disables Finish and Next while no prompt is open', () => {
    const w = mount(PromptCard, { props: { live: running().current, locked: false } });
    expect(w.get('[data-testid=finish]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid=next]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid=cancel]').attributes('disabled')).toBeUndefined();
  });

  it('emits press only for the kind the prompt expects', async () => {
    const s = running();
    s.apply(
      ev(2, {
        kind: 'prompt-opened',
        promptId: PROMPT,
        expects: 'next',
        labelId: 'continue',
        blocking: true,
      }),
      0,
    );
    const w = mount(PromptCard, { props: { live: s.current, locked: false } });
    await w.get('[data-testid=next]').trigger('click');
    expect(w.emitted('press')).toEqual([['next']]);
  });

  it('cancel needs a second tap', async () => {
    const w = mount(PromptCard, { props: { live: running().current, locked: false } });
    await w.get('[data-testid=cancel]').trigger('click');
    expect(w.emitted('cancel')).toBeUndefined();
    await w.get('[data-testid=cancel]').trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
  });

  it('shows Cancelling… and locks the buttons after a cancel was requested', () => {
    const s = running();
    s.startPending('act-00000001', 'cancel');
    s.apply({ v: 1, type: 'action-result', actionId: 'act-00000001', outcome: 'accepted' }, 0);
    const w = mount(PromptCard, { props: { live: s.current, locked: false } });
    expect(w.get('[data-testid=pending]').text()).toBe('Cancelling…');
    expect(w.get('[data-testid=cancel]').attributes('disabled')).toBeDefined();
  });

  it('says why a press was rejected', () => {
    const s = running();
    s.startPending('act-00000002', 'cancel');
    s.apply(
      {
        v: 1,
        type: 'action-result',
        actionId: 'act-00000002',
        outcome: 'rejected',
        reason: 'rate-limited',
      },
      0,
    );
    const w = mount(PromptCard, { props: { live: s.current, locked: false } });
    expect(w.get('[data-testid=rejected]').text()).toContain('Too many requests');
  });
});

describe('summary card', () => {
  const summary = {
    filesPlanned: 5,
    bytesPlanned: 500,
    ok: 3,
    okBytes: 300,
    skipped: 1,
    failed: 1,
    failedBytes: 100,
    durationMs: 65_000,
  };

  it('names the items not copied in the danger colour', () => {
    const w = mount(SummaryCard, { props: { terminal: { status: 'completed', summary } } });
    expect(w.get('[data-testid=headline]').text()).toBe('1 item not copied');
    expect(w.get('[data-testid=summary] p').classes()).toContain('text-danger');
  });

  it('says all copied in the success colour when nothing failed', () => {
    const w = mount(SummaryCard, {
      props: {
        terminal: { status: 'completed', summary: { ...summary, failed: 0, failedBytes: 0 } },
      },
    });
    expect(w.get('[data-testid=headline]').text()).toBe('All copied');
    expect(w.get('[data-testid=summary] p').classes()).toContain('text-success');
  });

  it('shows the failure reason for a failed job', () => {
    const w = mount(SummaryCard, {
      props: { terminal: { status: 'failed', failureCode: 'not-enough-space' } },
    });
    expect(w.text()).toContain('not enough space');
  });
});
