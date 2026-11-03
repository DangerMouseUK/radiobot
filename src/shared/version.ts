import { readFileSync } from 'node:fs';
import { rootPath } from './paths.ts';

let cached: string | null = null;

/** This build's version, from package.json ("1.2.0"). */
export function botVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8')) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

/**
 * Compares two dotted version strings part by part as whole numbers ("1.10.0" > "1.9.2",
 * "2026.11.03.2" > "2026.11.03"). A missing part counts as 0. Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
