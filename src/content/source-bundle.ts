import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'es-module-lexer';
import { strToU8, zipSync } from 'fflate';
import { atomicWrite, within } from '../project/paths.js';
import type { ContentOptions } from './discover.js';
import { toolPackageImport } from './package-name.js';
import { findLayoutBuilding, readWorldLayout } from './world-layout.js';

const excluded = (name: string) =>
  /^(?:\.git|node_modules|output|blockwright\.local\.json|\.npmrc|\.env(?:\..*)?)$/i.test(name);
const workspaceOutputs = new Set(['artifacts', 'cache', 'dist', 'worlds']);
const moduleFile = /\.(?:[cm]?[jt]s)$/i;

function missingFile(error: NodeJS.ErrnoException) {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
}

export async function packSourceLayout(
  layout: Awaited<ReturnType<typeof readWorldLayout>>,
  options: { root: string; output: string; include: string[]; content: ContentOptions },
) {
  const root = await realpath(options.root);
  const output = resolve(options.output);
  const files: Record<string, Uint8Array> = Object.create(null);
  const scanned = new Set<string>();
  const checkedScopes = new Set<string>();
  const externalImports = new Set<string>();
  const references = new Map<string, string>();
  const buildings = new Set<string>();

  function archiveName(path: string) {
    if (!within(root, path)) throw new Error(`Source is outside the bundle root ${root}: ${path}`);
    const parts = relative(root, path).split(sep);
    if (parts.some((part) => excluded(part) || /[\\:\x00]/.test(part)))
      throw new Error(`Cannot include this path in a source bundle: ${path}`);
    return `source/${parts.join('/')}`;
  }

  async function sourceInfo(path: string) {
    archiveName(path);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !within(root, await realpath(path)))
      throw new Error(`Cannot include a link outside the source tree or archive a symbolic link: ${path}`);
    return info;
  }

  async function addFile(path: string) {
    const name = archiveName(path);
    if (!files[name]) {
      if (path === output || !(await sourceInfo(path)).isFile())
        throw new Error(`Expected a source file: ${path}`);
      files[name] = await readFile(path);
    }
    return files[name];
  }

  async function addTree(path: string) {
    const info = await sourceInfo(path);
    if (!info.isDirectory()) {
      await addFile(path);
      return;
    }
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      if (child === output || excluded(name) || (path === root && workspaceOutputs.has(name))) continue;
      await addTree(child);
    }
  }

  async function addModule(path: string) {
    const source = await addFile(path);
    if (!moduleFile.test(path) || scanned.has(path)) return;
    scanned.add(path);
    const [imports] = parse(Buffer.from(source).toString('utf8'), path);
    for (const item of imports) {
      const { specifier } = item;
      if (!specifier || (item.type === 'dynamic' && item.glob)) continue;
      if (!/^\.{1,2}\//.test(specifier)) {
        if (!isBuiltin(specifier) && !toolPackageImport(specifier)) externalImports.add(specifier);
        continue;
      }
      const target = fileURLToPath(new URL(specifier, pathToFileURL(path)));
      archiveName(target);
      const extension = target.endsWith('.mjs') ? '.mts' : target.endsWith('.js') ? '.ts' : undefined;
      const fallback = extension ? target.slice(0, -extension.length) + extension : target;
      const dependency = (await lstat(target).catch(missingFile)) ? target : fallback;
      try {
        await addModule(dependency);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        throw new Error(`${path} imports missing local source ${specifier}`, { cause: error });
      }
    }
  }

  async function addPackageScope(directory: string): Promise<void> {
    if (checkedScopes.has(directory)) return;
    checkedScopes.add(directory);
    const path = join(directory, 'package.json');
    const name = archiveName(path);
    if (files[name]) return;
    if (await lstat(path).catch(missingFile)) {
      if (!(await sourceInfo(path)).isFile()) throw new Error(`Expected a package file: ${path}`);
      const { type } = JSON.parse(await readFile(path, 'utf8'));
      const scope = type === 'module' || type === 'commonjs' ? { type } : {};
      files[name] = strToU8(JSON.stringify(scope, null, 2) + '\n');
    } else if (directory !== root) {
      await addPackageScope(dirname(directory));
    }
  }

  const placements = [];
  for (const placement of layout.placements) {
    let reference = references.get(placement.building);
    if (!reference) {
      const building = await findLayoutBuilding(layout.path, placement.building, options.content);
      reference = `./${archiveName(building.manifestPath)}`;
      if (!buildings.has(building.manifestPath)) {
        await addTree(building.root);
        await addModule(building.entry);
        buildings.add(building.manifestPath);
      }
      references.set(placement.building, reference);
    }
    placements.push({ ...placement, building: reference });
  }
  for (const entry of options.include) await addTree(resolve(entry));
  for (const path of scanned) await addPackageScope(dirname(path));

  const modules = [...externalImports].sort();
  const packagedLayout = { name: layout.name, spawn: layout.spawn, seed: layout.seed, placements };
  files['layout.json'] = strToU8(JSON.stringify(packagedLayout, null, 2) + '\n');
  files['README.md'] = strToU8([
    `# ${layout.name}`,
    '',
    '编辑 `source/` 中的建筑文件，或在 `layout.json` 中修改坐标、旋转和建筑参数。',
    '安装 BEWright 后，在解压目录预演布局，再去掉 `--dry-run` 生成本地存档。',
    '',
    '```sh',
    'bewright import --layout ./layout.json --local --dry-run',
    '```',
    ...(modules.length ? ['', `源码还引用了这些模块，请在构建前准备好：${modules.join('、')}。`] : []),
    '',
  ].join('\n'));
  const archive = zipSync(files);
  await atomicWrite(output, archive);
  return {
    output,
    name: layout.name,
    placements: placements.length,
    buildings: buildings.size,
    files: Object.keys(files).length,
    bytes: archive.length,
    externalImports: modules,
  };
}
