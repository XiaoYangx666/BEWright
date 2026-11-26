import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireSidecar, runSidecar } from '../../project/sidecar.js';

export type PreservationInfo = {
  levelDatSha256: string;
  levelDatBytes: number;
  /** Player record keys (`player_<xuid>` / `~local_player`), or null when the sidecar predates `--players`. */
  players: string[] | null;
};

/**
 * Snapshot the parts of a world an import must not touch. level.dat is a plain
 * file next to the LevelDB, while player records live as keys inside it; both are
 * unrelated to the chunk records the writer rewrites.
 */
export async function preservationInfo(world: string): Promise<PreservationInfo> {
  const levelDat = await readFile(join(world, 'level.dat'));
  const sha256 = createHash('sha256').update(levelDat).digest('hex');
  let players: string[] | null = null;
  try {
    const { stdout } = await runSidecar(requireSidecar('blockwright-world-diagnose'), ['--world', world, '--players']);
    const line = stdout.trim().split(/\r?\n/).at(-1);
    const result = line ? (JSON.parse(line) as { players?: unknown }) : undefined;
    if (Array.isArray(result?.players) && result.players.every((id) => typeof id === 'string')) {
      players = (result.players as string[]).sort();
    }
  } catch {
    // Older sidecars only expose chunk diagnostics; preservation still covers level.dat.
  }
  return { levelDatSha256: sha256, levelDatBytes: levelDat.length, players };
}

export type PreservationReport = {
  levelDatUnchanged: boolean;
  levelDat: { before: string; after: string; bytes: number };
  players: { before: string[] | null; after: string[] | null; preserved: boolean | null };
};

export function comparePreservation(before: PreservationInfo, after: PreservationInfo): PreservationReport {
  const samePlayers =
    before.players && after.players
      ? before.players.length === after.players.length &&
        before.players.every((id, index) => id === after.players![index])
      : null;
  return {
    levelDatUnchanged: before.levelDatSha256 === after.levelDatSha256,
    levelDat: { before: before.levelDatSha256, after: after.levelDatSha256, bytes: before.levelDatBytes },
    players: { before: before.players, after: after.players, preserved: samePlayers },
  };
}
