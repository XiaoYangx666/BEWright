import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Writable } from 'node:stream';
import { TOOL_ROOT } from './context.js';

/**
 * Single place for invoking the Rust sidecar binaries.
 * Every sidecar follows the same contract: optional binary stdin payload,
 * UTF-8 stdout/stderr, and a non-zero exit code on failure.
 *
 * A payload may be an iterable of chunks rather than one buffer. Large payloads
 * (a 14M-block direct world write is 220 MB) are then produced and handed to the
 * pipe chunk by chunk: the producer is suspended while the pipe is full, so the
 * whole payload never has to exist in memory at once.
 */
export type SidecarResult = { stdout: string; stderr: string };
export type SidecarInput = Buffer | Iterable<Buffer> | AsyncIterable<Buffer>;

const EXECUTABLE_SUFFIX = process.platform === 'win32' ? '.exe' : '';
export const SIDECAR_CACHE_NAME = 'sidecar';
const sidecarCache = join('cache', SIDECAR_CACHE_NAME);

export function sidecarDir() {
  return resolve(process.env.BLOCKWRIGHT_BIN_DIR ?? sidecarCache);
}

export function sidecarBinary(name: string) {
  const filename = name + EXECUTABLE_SUFFIX;
  const local = join(sidecarDir(), filename);
  if (process.env.BLOCKWRIGHT_BIN_DIR || existsSync(local)) return local;
  const tool = join(TOOL_ROOT, sidecarCache, filename);
  return existsSync(tool) ? tool : local;
}

/** Resolve a sidecar binary or fail with the command that rebuilds it. */
export function requireSidecar(name: string, buildCommand = 'bewright sidecar build') {
  const binary = sidecarBinary(name);
  if (!existsSync(binary)) throw new Error(`Sidecar ${name} not found: ${binary}. Run ${buildCommand} first.`);
  return binary;
}

export function runSidecar(binary: string, args: string[], input?: SidecarInput): Promise<SidecarResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '',
      stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    // A producer that throws mid-payload (an encoder bug) truncates the stream, so
    // the sidecar fails too. Keep both facts in the message instead of reporting
    // only the exit code the truncation caused.
    let feedFailure: unknown;
    child.on('close', (code) => {
      if (feedFailure && code === 0)
        reject(feedFailure instanceof Error ? feedFailure : new Error(String(feedFailure)));
      else if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const note = feedFailure
          ? `; payload producer failed: ${feedFailure instanceof Error ? feedFailure.message : String(feedFailure)}`
          : '';
        reject(new Error(`${binary.split(/[\\/]/).at(-1)} exited ${code}: ${stderr.trim() || stdout.trim()}${note}`));
      }
    });
    if (input && child.stdin) {
      const stdin = child.stdin;
      void feed(stdin, input).catch((error) => {
        feedFailure = error;
        stdin.destroy();
      });
    }
  });
}

/**
 * Bounded producer -> pipe handoff. `write()` returning false means the child has
 * not drained the previous chunk yet, so the producer waits for `drain` instead
 * of queueing the rest of the payload in Node's stream buffers.
 */
async function feed(stdin: Writable, input: SidecarInput) {
  const chunks: Iterable<Buffer> | AsyncIterable<Buffer> = Buffer.isBuffer(input) ? [input] : input;
  for await (const chunk of chunks) {
    // A sidecar that already failed (bad world, bad arguments) closes stdin; stop
    // pushing and let `close` report the exit code.
    if (stdin.destroyed || !stdin.writable) return;
    if (!stdin.write(chunk)) await once(stdin, 'drain');
  }
  stdin.end();
}

/** Sidecars print one JSON result line last; surface protocol errors instead of guessing. */
export async function runSidecarJson<T extends { ok: boolean }>(
  binary: string,
  args: string[],
  label: string,
  input?: SidecarInput,
): Promise<T> {
  const { stdout } = await runSidecar(binary, args, input);
  const line = stdout.trim().split(/\r?\n/).at(-1);
  const result = line ? (JSON.parse(line) as T) : undefined;
  if (!result?.ok) throw new Error(`${label} returned an invalid result: ${stdout}`);
  return result;
}

export function cargoExecutable() {
  const name = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const userCargo = join(homedir(), '.cargo', 'bin', name);
  return existsSync(userCargo) ? userCargo : name;
}
