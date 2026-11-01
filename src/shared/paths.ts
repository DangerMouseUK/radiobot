import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let cachedRoot: string | null = null;

/**
 * Locates the project root (the directory holding package.json, migrations/ and catalog/)
 * whether running from src/ via type stripping or from the compiled dist/ tree.
 */
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'migrations'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = resolve(process.cwd());
  return cachedRoot;
}

export function rootPath(...parts: string[]): string {
  return join(projectRoot(), ...parts);
}
