import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cargoExecutable, sidecarDir } from '../../project/sidecar.js';
import { TOOL_ROOT } from '../../project/context.js';
import { CACHE_ROOT, PROJECT_ROOT } from '../../project/paths.js';

export const SIDECAR_HELP = `bewright sidecar build [--debug]

Builds the bundled Rust sidecar and installs the binaries in cache/sidecar/.

  --debug   build the debug profile instead of release`;

const BINARIES = [
  'blockwright-world',
  'blockwright-world-export',
  'blockwright-world-diagnose',
  'blockwright-world-init',
  'blockwright-java-export',
];

export async function sidecarCommand(argv: string[]) {
  const action = argv[0];
  if (action !== 'build' || argv.slice(1).some((arg) => arg !== '--debug'))
    throw new Error('Usage: bewright sidecar build [--debug]');
  const debug = argv.includes('--debug');
  const profile = debug ? 'debug' : 'release';
  const cargo = cargoExecutable();
  const source = join(TOOL_ROOT, 'tools', 'blockwright-world');
  const target = join(CACHE_ROOT, 'cargo');
  const args = ['build', '--locked', '--manifest-path', join(source, 'Cargo.toml'), '--target-dir', target];
  if (!debug) args.push('--release');
  const child = spawn(cargo, args, { stdio: 'inherit', windowsHide: true, cwd: PROJECT_ROOT });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.on('error', (error) => reject(new Error(`Could not launch Cargo (${error.message}). Install the Rust toolchain and its native build prerequisites.`)));
    child.on('close', resolveCode);
  });
  if (code !== 0) process.exit(code ?? 1);

  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binDir = sidecarDir();
  await mkdir(binDir, { recursive: true });
  for (const name of BINARIES) {
    const file = name + suffix;
    await copyFile(join(target, profile, file), join(binDir, file));
    console.log(`Installed ${join(binDir, file)}`);
  }
}
