import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configs = ['wrangler.relay.jsonc', 'wrangler.dashboard.jsonc'];

function load(name: string): Record<string, unknown> {
  // Wrangler accepts JSONC and Prettier adds trailing commas, so drop comments and trailing commas.
  const text = readFileSync(join(root, name), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('tracked configuration', () => {
  for (const name of configs) {
    it(`${name} never mentions the development bypass`, () => {
      expect(readFileSync(join(root, name), 'utf8')).not.toContain('ALLOW_DEV_AUTH');
    });

    it(`${name} sets no variable to a value that enables the bypass anywhere`, () => {
      const text = JSON.stringify(load(name));
      expect(text).not.toMatch(/ALLOW_DEV_AUTH/i);
    });
  }

  it('the untracked dev vars file is ignored by git', () => {
    const ignore = readFileSync(join(root, '..', '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.dev.vars');
  });

  it('the dashboard config ships empty Access settings so it fails closed until set', () => {
    const vars = (load('wrangler.dashboard.jsonc').vars ?? {}) as Record<string, string>;
    expect(vars.ACCESS_TEAM_DOMAIN).toBe('');
    expect(vars.ACCESS_AUD).toBe('');
    expect(vars.ALLOWED_EMAILS).toBe('');
  });

  it('the relay Worker config carries no Access settings', () => {
    const vars = (load('wrangler.relay.jsonc').vars ?? {}) as Record<string, string>;
    expect(Object.keys(vars)).toEqual([]);
  });

  it('the dashboard Worker binds the same Durable Object classes from the relay Worker', () => {
    const relay = load('wrangler.relay.jsonc') as { name: string };
    const dash = load('wrangler.dashboard.jsonc') as {
      durable_objects: { bindings: { class_name: string; script_name: string }[] };
    };
    expect(dash.durable_objects.bindings.map((b) => b.class_name).sort()).toEqual([
      'RegistryDO',
      'SessionDO',
    ]);
    for (const b of dash.durable_objects.bindings) expect(b.script_name).toBe(relay.name);
  });

  it('the example dev vars file is the only place the bypass is spelled out', () => {
    expect(readFileSync(join(root, '.dev.vars.example'), 'utf8')).toContain('ALLOW_DEV_AUTH=true');
  });
});
