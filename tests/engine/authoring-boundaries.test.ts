import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function runtimeSpecifiers(source: string): string[] {
  const result: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, bindings, specifier] = match;
    if (!specifier!.startsWith('.')) continue;
    const imports = bindings!.trim();
    if (imports.startsWith('type ')) continue;
    if (
      imports.startsWith('{') &&
      imports
        .slice(1, -1)
        .split(',')
        .every((item) => !item.trim() || item.trim().startsWith('type '))
    )
      continue;
    result.push(specifier!);
  }
  return result;
}

/** Follow runtime imports/re-exports; type-only contracts do not load their owners. */
async function runtimeDependencies(entry: string): Promise<Set<string>> {
  const files = new Set<string>();
  const visit = async (url: URL): Promise<void> => {
    const path = fileURLToPath(url).replaceAll('\\', '/');
    if (files.has(path)) return;
    files.add(path);
    const source = await readFile(url, 'utf8');
    for (const specifier of runtimeSpecifiers(source)) {
      await visit(new URL(specifier.replace(/\.js$/, '.ts'), url));
    }
  };
  await visit(new URL(`../../src/authoring/${entry}`, import.meta.url));
  return files;
}

function excludes(files: Set<string>, forbidden: readonly string[]): void {
  for (const path of files) {
    assert.ok(!forbidden.some((suffix) => path.endsWith(suffix)), `Unexpected runtime dependency: ${path}`);
    assert.ok(!path.includes('/src/content/') && !path.includes('/src/cli/') && !path.includes('/src/mesh/'), path);
  }
}

test('field sampling and terrain recipes do not load model mutation or collision stages', async () => {
  for (const entry of ['terrain/fields.ts', 'terrain/recipe.ts']) {
    excludes(await runtimeDependencies(entry), [
      '/construction.ts',
      '/placement.ts',
      '/placement/operations.ts',
      '/terrain/build.ts',
      '/surface.ts',
      '/traversal.ts',
      '/protection.ts',
    ]);
  }
});

test('authoring internals bypass the compatibility entries when selecting a stage', async () => {
  const root = new URL('../../src/authoring/', import.meta.url);
  // The scene is a composition entry, just like the public index. Low-level
  // stages still select concrete implementations and never load content/CLI.
  const entries = new Set(['fields.ts', 'waters.ts', 'placement.ts', 'index.ts', 'scene.ts']);
  const facades = new Set(['fields.ts', 'waters.ts', 'placement.ts'].map((name) => new URL(name, root).href));
  for (const name of await readdir(root, { recursive: true })) {
    const relative = name.replaceAll('\\', '/');
    if (!relative.endsWith('.ts') || entries.has(relative)) continue;
    const url = new URL(relative, root);
    for (const specifier of runtimeSpecifiers(await readFile(url, 'utf8'))) {
      assert.ok(!facades.has(new URL(specifier.replace(/\.js$/, '.ts'), url).href), `${relative} loads ${specifier}`);
    }
  }
});

test('water planning and final-model checks do not load construction or placement', async () => {
  for (const entry of ['water/plan.ts', 'water/check.ts']) {
    excludes(await runtimeDependencies(entry), [
      '/construction.ts',
      '/placement.ts',
      '/placement/operations.ts',
      '/water/build.ts',
      '/terrain/build.ts',
    ]);
  }
});

test('construction depends on operation policy without loading placement planning', async () => {
  const dependencies = await runtimeDependencies('construction.ts');
  assert.ok([...dependencies].some((path) => path.endsWith('/placement/policy.ts')));
  excludes(dependencies, ['/placement.ts', '/placement/operations.ts', '/surface.ts', '/transform.ts']);
});

test('the scene composition entry has no content, CLI or mesh dependencies', async () => {
  excludes(await runtimeDependencies('scene.ts'), []);
});
