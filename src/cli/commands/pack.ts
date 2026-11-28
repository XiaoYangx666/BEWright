import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { packSourceLayout } from '../../content/source-bundle.js';
import { readWorldLayout } from '../../content/world-layout.js';
import { ARTIFACT_ROOT, PROJECT_ROOT } from '../../project/paths.js';
import { loadBlockwrightConfig } from '../../project/config.js';
import { CONTENT_OPTION, contentOptions } from '../args.js';
import { UsageError } from './check.js';

export const PACK_HELP = `bewright pack --layout FILE [options]

  --output FILE    output .zip (default artifacts/ or packages/ under outputRoot)
  --root DIR       root for source paths in the archive (default current directory)
  --include PATH   extra file or directory, repeatable
  --content DIR    extra building discovery root, repeatable
  --json           print the archive summary as JSON`;

export async function packCommand(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      layout: { type: 'string' },
      output: { type: 'string' },
      root: { type: 'string' },
      include: { type: 'string', multiple: true },
      content: CONTENT_OPTION,
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(PACK_HELP);
    return;
  }
  if (!values.layout?.trim()) throw new UsageError('Usage: bewright pack --layout FILE [--output FILE.zip]');
  const layout = await readWorldLayout(values.layout);
  const stem = basename(layout.path, extname(layout.path));
  const name = stem === 'layout' ? basename(dirname(layout.path)) || stem : stem;
  const { outputRoot } = await loadBlockwrightConfig(undefined, { absolutePaths: true });
  const output = values.output ?? join(outputRoot ? join(outputRoot, 'packages') : ARTIFACT_ROOT, `${name}-source.zip`);
  if (extname(output).toLowerCase() !== '.zip') throw new UsageError('--output must be a .zip file');
  const report = await packSourceLayout(layout, {
    root: values.root ?? PROJECT_ROOT,
    output,
    include: values.include ?? [],
    content: contentOptions(values),
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : report.output);
}
