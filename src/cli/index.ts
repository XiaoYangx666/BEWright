#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { registerContentResolution } from './resolve-hooks.js';
import { EXIT, UsageError } from './errors.js';

// The compiled dist build runs on plain Node, which strips TypeScript types but
// does not remap `./foo.js` to `foo.ts`. Building content lives outside dist,
// so register the retry hook. Under tsx (source entry) the hook is unnecessary.
if (import.meta.url.endsWith('.js')) registerContentResolution();

type CommandModule = Record<string, unknown>;
type CommandSpec = {
  /** Loaded on demand: the renderer pulls Playwright, which no import needs. */
  load: () => Promise<CommandModule>;
  run: string;
  help: string;
};

const COMMANDS: Record<string, CommandSpec> = {
  init: { load: () => import('./commands/init.js'), run: 'initCommand', help: 'INIT_HELP' },
  list: { load: () => import('./commands/list.js'), run: 'listCommand', help: 'LIST_HELP' },
  check: { load: () => import('./commands/check.js'), run: 'checkCommand', help: 'CHECK_HELP' },
  build: { load: () => import('./commands/build.js'), run: 'buildCommand', help: 'BUILD_HELP' },
  preview: { load: () => import('./commands/preview.js'), run: 'previewCommand', help: 'PREVIEW_HELP' },
  export: { load: () => import('./commands/export.js'), run: 'exportCommand', help: 'EXPORT_HELP' },
  import: { load: () => import('./commands/import.js'), run: 'importCommand', help: 'IMPORT_HELP' },
  target: { load: () => import('./commands/deployment.js'), run: 'targetCommand', help: 'TARGET_HELP' },
  deploy: { load: () => import('./commands/deployment.js'), run: 'deployCommand', help: 'DEPLOY_HELP' },
  diff: { load: () => import('./commands/deployment.js'), run: 'diffCommand', help: 'DIFF_HELP' },
  pack: { load: () => import('./commands/pack.js'), run: 'packCommand', help: 'PACK_HELP' },
  blocks: { load: () => import('./commands/blocks.js'), run: 'blocksCommand', help: 'BLOCKS_HELP' },
  registry: { load: () => import('./commands/registry.js'), run: 'registryCommand', help: 'REGISTRY_HELP' },
  sidecar: { load: () => import('./commands/sidecar.js'), run: 'sidecarCommand', help: 'SIDECAR_HELP' },
  clean: { load: () => import('./commands/clean.js'), run: 'cleanCommand', help: 'CLEAN_HELP' },
};

export const HELP_INTRO = `BEWright — one-stop Minecraft building generation, preview and export

Usage: bewright <command> [options]

  list      list buildings found in every content root
  init      create a starter building in the current workspace
  check     generate and check one building (no meshing, no export, no world)
  build     generate, mesh and check one building (--export for structure files)
  preview   render a headless PNG of a building or component
  export    export to Bedrock .mcstructure or a Java Anvil world
  import    place a building or layout into a Bedrock world (or export Java)
  target    register a reusable Bedrock layout and save
  deploy    apply source changes and preserve unrelated edits in the save
  diff      compare current sources with a registered Bedrock save
  pack      create an editable layout and building source .zip
  blocks    search the pinned Bedrock block registry
  registry  regenerate or verify the generated registry data
  sidecar   build the Rust sidecar binaries
  clean     reclaim cache/artifacts/worlds and old game worlds

Pass a building id, a directory path such as ./my-building, or its manifest.
Add search roots with --content, BLOCKWRIGHT_CONTENT_PATH or blockwright.config.json.`;

/** Full help needs every command's text; `bewright <command> --help` stays lazy. */
export async function helpText() {
  const sections = await Promise.all(
    Object.values(COMMANDS).map(async (spec) => {
      const module = await spec.load();
      return String(module[spec.help] ?? '');
    }),
  );
  return [HELP_INTRO, ...sections].filter(Boolean).join('\n\n');
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    const packageInfo = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    console.log(packageInfo.version);
    return EXIT.ok;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(await helpText());
    return EXIT.ok;
  }
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`Unknown command: ${command}. Run "bewright help" for usage.`);
  const module = await spec.load();
  const handler = module[spec.run] as ((argv: string[]) => Promise<number | void>) | undefined;
  if (!handler) throw new UsageError(`Command "${command}" is missing its handler`);
  const code = await handler(rest);
  if (typeof code === 'number' && code !== EXIT.ok) process.exitCode = code;
  return code ?? EXIT.ok;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (process.env.BLOCKWRIGHT_DEBUG) console.error(error);
  // Usage and configuration errors are distinct from a failed check: exit 2,
  // never 1, so a caller cannot mistake a typo for a regression.
  process.exitCode = error instanceof UsageError ? EXIT.usage : EXIT.failed;
});
