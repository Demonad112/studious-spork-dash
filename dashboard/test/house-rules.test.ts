import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const sources = files(join(root, 'src')).filter((f) => /\.(vue|ts)$/.test(f));
const read = (f: string): string => readFileSync(f, 'utf8');

describe('house rules', () => {
  it('no component or script uses a raw colour', () => {
    const raw =
      /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:text|bg|border|ring|fill|stroke)-(?:red|green|blue|gray|grey|slate|zinc|neutral|stone|amber|yellow|orange|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?\b/;
    const bad = sources.filter((f) => raw.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('only the token stylesheet defines colours, and every token has a dark value', () => {
    const css = read(join(root, 'src/style.css'));
    const light = /:root \{([^}]+)\}/.exec(css)?.[1] ?? '';
    const dark = /:root\[data-theme='dark'\] \{([^}]+)\}/.exec(css)?.[1] ?? '';
    const names = (b: string): string[] => [...b.matchAll(/(--app-[a-z-]+):/g)].map((m) => m[1]!);
    expect(names(light).length).toBeGreaterThan(15);
    expect(names(dark).sort()).toEqual(names(light).sort());
  });

  it('the page has no inline script or inline style, which the relay CSP would block', () => {
    const html = read(join(root, 'index.html'));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=/);
    const inlineStyleAttr = sources.filter((f) => f.endsWith('.vue') && /\sstyle="/.test(read(f)));
    expect(inlineStyleAttr).toEqual([]);
  });

  it('no component renders raw HTML', () => {
    expect(sources.filter((f) => /v-html|innerHTML/.test(read(f)))).toEqual([]);
  });

  it('the dashboard only ever sends the four allowed actions', () => {
    const src =
      read(join(root, 'src/lib/socket.ts')) + read(join(root, 'src/views/InstallView.vue'));
    const sent = [...src.matchAll(/sendAction\('([a-z]+)'/g)].map((m) => m[1]);
    for (const k of sent) expect(['status', 'next', 'done', 'cancel']).toContain(k);
  });
});
