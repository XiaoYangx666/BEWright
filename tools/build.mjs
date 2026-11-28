#!/usr/bin/env node
// Compiles src/ to dist/ with the TypeScript compiler and copies the generated
// registry JSON. tsc is a plain Node program (no esbuild service worker), so
// this works inside a workspace-write sandbox where `tsx` fails with EPERM.
// After building, run: node dist/cli/index.js <command>
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) throw new Error(`TypeScript not found at ${tsc}; run npm ci first`);

await rm(join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tools/tsconfig.build.json'], { stdio: 'inherit', cwd: root });

const registryFrom = join(root, 'src', 'blocks', 'generated', 'bedrock-registry.json');
const registryTo = join(root, 'dist', 'blocks', 'generated', 'bedrock-registry.json');
await mkdir(dirname(registryTo), { recursive: true });
await cp(registryFrom, registryTo);

// npm links the CLI straight to this file, so keep it executable after a rebuild.
if (process.platform !== 'win32') await chmod(join(root, 'dist', 'cli', 'index.js'), 0o755);

console.log('Built dist/. Run: node dist/cli/index.js <command>');
