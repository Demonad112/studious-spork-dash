import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const protocolDir = join(here, '..', '..');

export interface Fixture {
  name: string;
  text: string;
  json: unknown;
}

export function loadFixtures(dir: string): Fixture[] {
  const full = join(protocolDir, 'fixtures', dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const text = readFileSync(join(full, f), 'utf8');
      return { name: f.replace(/\.json$/, ''), text, json: JSON.parse(text) as unknown };
    });
}

export function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(protocolDir, rel), 'utf8')) as T;
}
