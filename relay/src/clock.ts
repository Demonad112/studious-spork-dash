/** The relay's clock. Tests replace it to move time without sleeping. */
let source: () => number = () => Date.now();

export function now(): number {
  return source();
}

export function setClock(fn: (() => number) | null): void {
  source = fn ?? (() => Date.now());
}
