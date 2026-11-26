import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Explicit output scope for library callers; CLI retains its current-directory default. */
export type ProjectContext = Readonly<{
  root: string;
  artifacts: string;
  cache: string;
  worlds: string;
}>;

export function createProjectContext(root = process.cwd()): ProjectContext {
  const absolute = resolve(root);
  return Object.freeze({
    root: absolute,
    artifacts: join(absolute, 'artifacts'),
    cache: join(absolute, 'cache'),
    worlds: join(absolute, 'worlds'),
  });
}

export const DEFAULT_PROJECT = createProjectContext();
