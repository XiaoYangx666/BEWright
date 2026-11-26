import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { CACHE_ROOT, PROJECT_ROOT, within } from '../../src/project/paths.js';

test('cache cleanup boundary accepts only descendants',()=>{
  assert.equal(within(PROJECT_ROOT,CACHE_ROOT),true);
  assert.equal(within(CACHE_ROOT,resolve(CACHE_ROOT,'meshes','pavilion')),true);
  assert.equal(within(CACHE_ROOT,PROJECT_ROOT),false);
  assert.equal(within(CACHE_ROOT,resolve(PROJECT_ROOT,'artifacts')),false);
});
