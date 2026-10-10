/** Data-minimisation scanner. Used by contract tests and by the simulator's output tests. */

export interface DenyList {
  keys: string[];
  valuePatterns: { pathSeparator: string; driveLetter: string };
}

export interface DenyFinding {
  where: string;
  why: 'forbidden-key' | 'path-separator' | 'drive-letter';
}

/** Returns every place in `value` that would leak a path, drive letter or forbidden field. */
export function findDenied(value: unknown, deny: DenyList, where = '$'): DenyFinding[] {
  const out: DenyFinding[] = [];
  const sep = new RegExp(deny.valuePatterns.pathSeparator);
  const drive = new RegExp(deny.valuePatterns.driveLetter);
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string') {
      if (sep.test(v)) out.push({ where: at, why: 'path-separator' });
      else if (drive.test(v)) out.push({ where: at, why: 'drive-letter' });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (deny.keys.includes(k)) out.push({ where: `${at}.${k}`, why: 'forbidden-key' });
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(value, where);
  return out;
}
