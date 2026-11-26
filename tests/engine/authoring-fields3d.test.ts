import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simplex2D,
  simplex3D,
  latticeSafe,
  latticeSafe3,
  fbmNoise,
  fbmNoise3D,
  weightedPick,
  pair,
  type WeightedChoice,
} from '../../src/authoring/index.js';

/**
 * 三维杂色与色板选择：框架只提供机制。
 *
 * 这两件工具的存在理由是**竖直面不能被二维场刷成条纹**，以及**使用者不该
 * 手写阈值链**。测试同时钉住"框架不预设任何方块/材料"这条边界。
 */

test('3D simplex IS degenerate on the integer lattice, unlike 2D', () => {
  // 2D simplex 只在原点为 0，整数格点上基本都有值（实测约 5% 为 0）。
  // 框架文档曾声称"2D 在整数格点恒为 0"，那是错的；这条测试钉住实测行为。
  const flat2d = simplex2D(941);
  assert.equal(flat2d.at(0, 0), 0, 'the 2D origin is the lattice zero');
  assert.notEqual(flat2d.at(12, 34), 0, '2D is NOT flat across the integer lattice');
  const grid2d = [];
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) grid2d.push(flat2d.at(x, z));
  const zeros2d = grid2d.filter((value) => value === 0).length;
  assert.ok(zeros2d < grid2d.length * 0.15, `2D should rarely be zero on integers, got ${zeros2d}/${grid2d.length}`);

  // 3D 才是真正退化的那个：整数格点上有很大一部分**恰好为 0**
  // （实测约 48%，对应 3D simplex 的偏移四面体格点）。
  const raw3d = simplex3D(941);
  assert.equal(raw3d.at(0, 0, 0), 0);
  assert.equal(raw3d.at(12, 34, 56), 0, '3D simplex vanishes on lattice points');
  const cube = [];
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) cube.push(raw3d.at(x, y, z));
  const zeros3d = cube.filter((value) => value === 0).length;
  assert.ok(zeros3d > cube.length * 0.4, `3D should be zero on a large share of integer points, got ${zeros3d}/${cube.length}`);

  // 所以按方块采样 3D 噪声**必须**先偏移，latticeSafe3 是正确性前提，不是可选装饰。
  const [ox, oy, oz] = latticeSafe3(941);
  assert.ok(ox !== 0 || oy !== 0 || oz !== 0, '3D lattice offset must not be all zero');
  assert.notEqual(raw3d.at(12 + ox, 34 + oy, 56 + oz), 0);
});

test('latticeSafe3 draws three independent offsets', () => {
  const [x, y, z] = latticeSafe3(7);
  assert.ok(x >= 0 && x < 1 && y >= 0 && y < 1 && z >= 0 && z < 1);
  assert.notEqual(x, y);
  assert.notEqual(y, z);
  // 与 2D 版本互不相关，且同种子可复现。
  assert.deepEqual(latticeSafe3(7), [x, y, z]);
  const two = latticeSafe(7);
  assert.ok(x !== two[0] || y !== two[1]);
});

test('fbmNoise3D varies along Y, while the 2D field is constant there', () => {
  const volume = fbmNoise3D({ seed: 941, scale: 7, octaves: 3 });
  const planar = fbmNoise({ seed: 941, scale: 7 });

  const along = [];
  for (let y = 10; y < 60; y++) along.push(volume.at(112, y, 76));
  const span3 = Math.max(...along) - Math.min(...along);
  // 这是整个改动的意义：竖直面必须有变化，否则崖壁出竖条纹。
  assert.ok(span3 > 0.05, `3D field should vary along Y, span was ${span3}`);

  const flat = [];
  for (let y = 10; y < 60; y++) flat.push(planar.at(112, 76));
  assert.equal(Math.max(...flat) - Math.min(...flat), 0);

  for (const value of along) assert.ok(value >= 0 && value < 1, 'fbmNoise3D stays in [0,1)');
});

test('fbmNoise3D is reproducible for one seed and distinct across seeds', () => {
  const a = fbmNoise3D({ seed: 12, scale: 9, octaves: 2 });
  const b = fbmNoise3D({ seed: 12, scale: 9, octaves: 2 });
  const c = fbmNoise3D({ seed: 13, scale: 9, octaves: 2 });
  let same = 0,
    differ = 0;
  for (let i = 0; i < 400; i++) {
    const x = i % 23,
      y = i % 11,
      z = (i * 5) % 31;
    if (a.at(x, y, z) === b.at(x, y, z)) same++;
    if (a.at(x, y, z) !== c.at(x, y, z)) differ++;
  }
  assert.equal(same, 400, 'same seed must be bit-identical');
  assert.ok(differ > 380, 'a different seed must change the field');
});

test('fbmNoise3D rejects invalid parameters', () => {
  assert.throws(() => fbmNoise3D({ seed: 1, scale: 0 }), /scale must be positive/);
  assert.throws(() => fbmNoise3D({ seed: 1, scale: 8, persistence: 0 }), /persistence must be positive/);
  assert.throws(() => fbmNoise3D({ seed: 1, scale: 8, lacunarity: -1 }), /lacunarity must be positive/);
});

test('fbmNoise3D domain warp bends the field without breaking determinism', () => {
  const plain = fbmNoise3D({ seed: 5, scale: 12, octaves: 2 });
  const warped = fbmNoise3D({ seed: 5, scale: 12, octaves: 2, warp: { strength: 6 } });
  const again = fbmNoise3D({ seed: 5, scale: 12, octaves: 2, warp: { strength: 6 } });

  let changed = 0;
  for (let i = 0; i < 300; i++) {
    const x = i % 19,
      y = i % 13,
      z = (i * 7) % 23;
    if (plain.at(x, y, z) !== warped.at(x, y, z)) changed++;
    assert.equal(warped.at(x, y, z), again.at(x, y, z), 'a warped field must still be reproducible');
  }
  assert.ok(changed > 250, `warp should change the field, only ${changed}/300 samples moved`);

  // 非零强度但 warp 关闭时，结果与不传 warp 完全一致。
  const zero = fbmNoise3D({ seed: 5, scale: 12, octaves: 2, warp: { strength: 0 } });
  for (let i = 0; i < 50; i++) assert.equal(zero.at(i, i, i), plain.at(i, i, i));
});

test('weightedPick follows relative weights', () => {
  const palette = [pair('a', 5), pair('b', 3), pair('c', 2)];
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  const samples = 10000;
  for (let i = 0; i < samples; i++) counts[weightedPick(palette, (i + 0.5) / samples)]++;
  assert.equal(counts.a, 5000);
  assert.equal(counts.b, 3000);
  assert.equal(counts.c, 2000);
});

test('weightedPick scales weights, so ratios and probabilities agree', () => {
  const scaled = [pair('a', 0.5), pair('b', 0.3), pair('c', 0.2)];
  for (const sample of [0, 0.1, 0.49, 0.5, 0.79, 0.8, 0.99]) {
    assert.equal(weightedPick(scaled, sample), weightedPick([pair('a', 5), pair('b', 3), pair('c', 2)], sample));
  }
});

test('weightedPick clamps the sample and always returns a value', () => {
  const palette = [pair('a', 1), pair('b', 1)];
  assert.equal(weightedPick(palette, 0), 'a');
  assert.equal(weightedPick(palette, 1), 'b');
  assert.equal(weightedPick(palette, -5), 'a', 'below range clamps to the first');
  assert.equal(weightedPick(palette, 5), 'b', 'above range clamps to the last');
});

test('weightedPick skips non-positive weights and degrades predictably', () => {
  const conditional = [pair('disabled', -1), pair('enabled', 1)];
  assert.equal(weightedPick(conditional, 0.5), 'enabled');

  // 全零权重时返回最后一项：调用方不必为字面色板不可能出现的情况加空值检查。
  assert.equal(weightedPick([pair('a', 0), pair('b', 0)], 0.5), 'b');

  assert.throws(() => weightedPick([], 0.5), /at least one choice/);
});

test('weightedPick is generic over any value type', () => {
  const numbers: readonly WeightedChoice<number>[] = [pair(1, 1), pair(2, 3)];
  assert.equal(weightedPick(numbers, 0.1), 1);
  assert.equal(weightedPick(numbers, 0.9), 2);

  const objects = [pair({ id: 'x' }, 1), pair({ id: 'y' }, 1)];
  assert.deepEqual(weightedPick(objects, 0.9), { id: 'y' });
});

test('the framework ships no material palettes of its own', async () => {
  // 边界：这两个工具是机制，不含任何方块名或默认材料。
  // 一旦有人往 fields.ts 里塞内置色板，这条会失败。
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/authoring/fields.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function weightedPick'));
  const palette = body.slice(0, body.indexOf('/** Slope of a height field'));
  for (const block of ['stone', 'dirt', 'grass_block', 'andesite', 'tuff', 'deepslate', 'sand'])
    assert.ok(!palette.includes(`'${block}'`), `weightedPick must not hard-code ${block}`);
});
