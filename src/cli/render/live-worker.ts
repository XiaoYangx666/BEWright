import { registerContentResolution } from '../resolve-hooks.js';
import { prepareSnapshot, type SnapshotRequest } from './prepare.js';

// The worker is forked from the compiled dist build on plain Node; content
// modules keep `./foo.js` specifiers that point at `foo.ts`, so the same
// resolve retry as the CLI entry must be registered on this thread too.
if (import.meta.url.endsWith('.js')) registerContentResolution();

process.once('message', async (request: SnapshotRequest) => {
  try {
    const snapshot = await prepareSnapshot(request);
    process.send!({ snapshot }, (error) => {
      if (error) process.exitCode = 1;
      process.disconnect!();
    });
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.message : String(error) }, () => process.disconnect!());
  }
});
