#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { registerContentResolution } from './resolve-hooks.js';
import { blocksCommand, BLOCKS_HELP } from './commands/blocks.js';
import { buildCommand, BUILD_HELP } from './commands/build.js';
import { checkCommand, CHECK_HELP, EXIT, UsageError } from './commands/check.js';
import { cleanCommand, CLEAN_HELP } from './commands/clean.js';
import { exportCommand, EXPORT_HELP } from './commands/export.js';
import { importCommand, IMPORT_HELP } from './commands/import.js';
import { initCommand, INIT_HELP } from './commands/init.js';
import { listCommand, LIST_HELP } from './commands/list.js';
import { packCommand, PACK_HELP } from './commands/pack.js';
import { previewCommand, PREVIEW_HELP } from './commands/preview.js';
import { registryCommand, REGISTRY_HELP } from './commands/registry.js';
import { sidecarCommand, SIDECAR_HELP } from './commands/sidecar.js';

// The compiled dist build runs on plain Node, which strips TypeScript types but
// does not remap `./foo.js` to `foo.ts`. Building content lives outside dist,
// so register the retry hook. Under tsx (source entry) the hook is unnecessary.
if (import.meta.url.endsWith('.js')) registerContentResolution();

export const HELP = `BEWright — one-stop Minecraft building generation, preview and export

Usage: bewright <command> [options]

  list      list buildings found in every content root
  init      create a starter building in the current workspace
  check     generate and check one building (no meshing, no export, no world)
  build     generate, mesh and check one building (--export for structure files)
  preview   render a headless PNG of a building or component
  export    export to Bedrock .mcstructure or a Java Anvil world
  import    place a building or layout into a Bedrock world (or export Java)
  pack      create an editable layout and building source .zip
  blocks    search the pinned Bedrock block registry
  registry  regenerate or verify the generated registry data
  sidecar   build the Rust sidecar binaries
  clean     reclaim cache/artifacts/worlds and old game worlds

Pass a building id, a directory path such as ./my-building, or its manifest.
Add search roots with --content, BLOCKWRIGHT_CONTENT_PATH or blockwright.config.json.

${INIT_HELP}

${LIST_HELP}

${CHECK_HELP}

${BUILD_HELP}

${PREVIEW_HELP}

${EXPORT_HELP}

${IMPORT_HELP}

${PACK_HELP}

${BLOCKS_HELP}

${REGISTRY_HELP}

${SIDECAR_HELP}

${CLEAN_HELP}`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number | void>> = {
  init: initCommand,
  list: listCommand,
  check: checkCommand,
  build: buildCommand,
  preview: previewCommand,
  export: exportCommand,
  import: importCommand,
  pack: packCommand,
  blocks: blocksCommand,
  registry: registryCommand,
  sidecar: sidecarCommand,
  clean: cleanCommand,
};

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    const packageInfo = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    console.log(packageInfo.version);
    return EXIT.ok;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return EXIT.ok;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`Unknown command: ${command}. Run "bewright help" for usage.`);
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
