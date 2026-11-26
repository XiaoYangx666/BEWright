import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { checkCommand, EXIT } from '../../src/cli/commands/check.js';

test('CLI reports skipped scene checks as not-run with a nonzero exit code', async () => {
  // Read the actual report file. Intercepting stdout would also intercept
  // Node's binary test-runner protocol during parallel test execution.
  const reportPath = resolve('cache', `authoring-check-${randomUUID()}.json`);
  try {
    const exit = await checkCommand(['./examples/demo-arch', '--no-check', '--report', reportPath, '--outline']);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(exit, EXIT.failed);
    assert.equal(report.status, 'not-run');
    assert.equal(report.outcome, 'not-run');
    assert.equal(report.checkExecuted, false);
    assert.equal(report.stages.buildingCheck, false);
    assert.equal(report.stages.world, false);
  } finally {
    await unlink(reportPath).catch(() => {});
  }
});
