import { parseArgs } from 'node:util';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ARTIFACT_ROOT, CACHE_ROOT, PROJECT_ROOT, WORLD_ROOT, within } from '../../project/paths.js';
import { SIDECAR_CACHE_NAME } from '../../project/sidecar.js';
import { defaultMinecraftWorldsDir, minecraftRunning } from '../../targets/bedrock/create.js';

export const CLEAN_HELP = `bewright clean [options]

Dry-run by default. Scans rebuildable caches and temporary files under artifacts/.
Installed Rust binaries are kept unless --sidecar is supplied.
Worlds are listed only when --worlds or --game is selected.

  --apply        actually delete
  --artifacts    include artifacts/
  --worlds       include worlds/
  --sidecar     include installed Rust binaries under cache/sidecar/
  --game         clean explicitly marked Minecraft worlds instead of project output
  --keep N       keep the newest N BEWright worlds (default 1)
  --no-cache     skip cache/
  --no-tmp       skip stray temp files
  --force        proceed while Minecraft is running`;

export async function cleanCommand(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean' },
      artifacts: { type: 'boolean' },
      worlds: { type: 'boolean' },
      sidecar: { type: 'boolean' },
      game: { type: 'boolean' },
      keep: { type: 'string' },
      force: { type: 'boolean' },
      'no-cache': { type: 'boolean' },
      'no-tmp': { type: 'boolean' },
    },
    strict: true,
  });

  const mode = values.apply ? 'apply' : 'dry-run';
  const targets: { name: string; path: string; files: number; bytes: number; action: string }[] = [];
  let totalBytes = 0;

  async function measure(root: string): Promise<{ files: number; bytes: number }> {
    let files = 0,
      bytes = 0;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        const sub = await measure(path);
        files += sub.files;
        bytes += sub.bytes;
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await lstat(path).catch(() => undefined))?.size ?? 0;
      }
    }
    return { files, bytes };
  }

  async function consider(name: string, path: string) {
    const resolved = resolve(path);
    if (!within(PROJECT_ROOT, resolved) || resolved === PROJECT_ROOT)
      throw new Error(`Refusing unsafe target: ${resolved}`);
    const info = await lstat(resolved).catch(() => undefined);
    if (!info) return;
    if (info.isSymbolicLink() || !within(await realpath(PROJECT_ROOT), await realpath(resolved)))
      throw new Error(`Refusing a cleanup target outside the workspace: ${resolved}`);
    const usage = info.isDirectory() ? await measure(resolved) : { files: 1, bytes: info.size };
    targets.push({ name, path: resolved, ...usage, action: values.apply ? 'deleted' : 'delete' });
    totalBytes += usage.bytes;
    if (values.apply) await rm(resolved, { recursive: true, force: true });
  }

  async function findTempJunk(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await findTempJunk(path)));
      else if (entry.isFile() && /\.tmp-\d+(?:-(?:\d+|[0-9a-f-]{36})|\.png)$/.test(entry.name)) {
        // Other commands may be publishing files concurrently.
        const info = await lstat(path).catch(() => undefined);
        if (info?.isFile() && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) found.push(path);
      }
    }
    return found;
  }

  type GameWorld = {
    path: string;
    name: string;
    folder: string;
    marked: boolean;
    mtimeMs: number;
    bytes: number;
    action: string;
  };
  const gameWorlds: GameWorld[] = [];
  let gameWorldsDir: string | undefined;
  async function markedWorld(path: string) {
    if ((await realpath(path).catch(() => undefined)) !== path) return false;
    const marker = join(path, 'blockwright-world.json');
    if (!(await lstat(marker).catch(() => undefined))?.isFile()) return false;
    return readFile(marker, 'utf8')
      .then((raw) => JSON.parse(raw)?.createdBy === 'blockwright')
      .catch(() => false);
  }
  if (values.game) {
    if (values.artifacts || values.worlds || values.sidecar)
      throw new Error('--game cannot be combined with --artifacts, --worlds, or --sidecar');
    const keep = Number(values.keep ?? '1');
    if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('--keep must be a nonnegative integer');
    gameWorldsDir = await realpath(await defaultMinecraftWorldsDir());
    for (const entry of await readdir(gameWorldsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(gameWorldsDir, entry.name);
      if (!(await markedWorld(path))) continue;
      const levelName = (await readFile(join(path, 'levelname.txt'), 'utf8').catch(() => undefined))?.trim();
      gameWorlds.push({
        path,
        folder: entry.name,
        name: levelName ?? entry.name,
        marked: true,
        mtimeMs: (await lstat(path)).mtimeMs,
        bytes: (await measure(path)).bytes,
        action: 'keep',
      });
    }
    gameWorlds.sort((a, b) => b.mtimeMs - a.mtimeMs);
    gameWorlds.forEach((item, index) => {
      item.action = index < keep ? 'keep' : 'delete';
    });
  }

  const kept = gameWorlds.filter((item) => item.action === 'keep').length;
  const removed = gameWorlds.filter((item) => item.action === 'delete');
  if (values.game) {
    if (values.apply && removed.length) {
      const running = values.force ? undefined : await minecraftRunning();
      if (running) throw new Error(`${running} is running; exit Minecraft first or pass --force`);
      for (const item of removed) {
        if (!(await markedWorld(item.path)))
          throw new Error(`World directory changed during cleanup: ${item.path}`);
        await rm(item.path, { recursive: true, force: true });
        item.action = 'deleted';
      }
    }
  } else {
    if ((!values['no-cache'] || values.sidecar) && (await lstat(CACHE_ROOT).catch(() => undefined))?.isSymbolicLink())
      throw new Error(`Refusing to scan a linked cache directory: ${CACHE_ROOT}`);
    if (!values['no-cache']) {
      const entries = await readdir(CACHE_ROOT).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const name of entries.sort())
        if (name.toLowerCase() !== SIDECAR_CACHE_NAME) await consider(`cache/${name}`, join(CACHE_ROOT, name));
    }
    if (values.sidecar) await consider('cache/sidecar (Rust 写入器)', join(CACHE_ROOT, SIDECAR_CACHE_NAME));
    if (values.artifacts) await consider('artifacts (工作区产物)', ARTIFACT_ROOT);
    if (values.worlds) await consider('worlds (工作区世界与备份)', WORLD_ROOT);
    if (!values['no-tmp'] && !values.artifacts && (await lstat(ARTIFACT_ROOT).catch(() => undefined))?.isDirectory())
      for (const file of await findTempJunk(ARTIFACT_ROOT)) await consider('临时文件残留', file);
  }
  console.log(
    JSON.stringify(
      {
        mode,
        ...(values.game ? {} : { targets, totalBytes }),
        gameWorlds: gameWorlds.map(({ path, name, folder, marked, bytes, action }) => ({
          path,
          name,
          folder,
          marked,
          bytes,
          action,
        })),
      },
      null,
      2,
    ),
  );
  if (values.game) {
    console.error(
      mode === 'apply'
        ? `已删除 ${removed.length} 个 BEWright 世界（保留最新 ${kept} 个，加 --keep N 改变数量）`
        : `dry-run：将删除 ${removed.length} 个 BEWright 世界，保留最新 ${kept} 个；执行用 --apply`,
    );
  } else {
    console.error(
      mode === 'apply'
        ? `已清理 ${targets.length} 个目标，释放 ${(totalBytes / 1024 / 1024).toFixed(1)}MB`
        : `dry-run：将清理 ${targets.length} 个目标，可释放 ${(totalBytes / 1024 / 1024).toFixed(1)}MB；加 --apply 执行`,
    );
  }
  if (gameWorlds.length) {
    console.error(`Minecraft 目录里的 BEWright 世界（${gameWorldsDir}）：`);
    for (const item of gameWorlds)
      console.error(
        `  [${item.action}] ${item.folder} "${item.name}" ${(item.bytes / 1024 / 1024).toFixed(1)}MB`,
      );
  }
}
