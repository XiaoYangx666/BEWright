import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, AIR, type Box } from '../../src/core/structure.js';
import { Components } from '../../src/core/components.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';
import { applyBedrockWallConnections } from '../../src/blocks/connections.js';
import { buildModel, modelSession, prepareModel } from '../../src/content/model.js';
import { generateModel } from '../../src/content/check.js';
import { encodeJavaWorld } from '../../src/targets/java/world.js';

const bounds: Box = { min: [-2, 0, -2], max: [4, 4, 4] };
function fixture() {
  const s = new Structure();
  for (let x = 0; x < 3; x++) s.set(x, 0, 0, b('cobblestone_wall', { wall_post_bit: true }));
  s.set(-1, 0, 0, AIR);
  return s;
}

test('prepared checks preserve every cell and state of the previous generation sequence', () => {
  const expected = fixture();
  applyBedrockWallConnections(expected, bounds);
  const generated = generateModel({ id: 'model-test', name: 'Model', bounds, build: fixture });
  assert.deepEqual(generated.world.snapshot(), expected.snapshot());
  assert.equal(generated.world.getId(-2, 0, 0), 0);
  assert.deepEqual(generated.world.get(-1, 0, 0), AIR);
});

test('camera-only jobs reuse generation and preparation; distinct sources stay distinct', () => {
  let mainCalls = 0,
    viewCalls = 0;
  const main = () => {
    mainCalls++;
    return fixture();
  };
  const view = () => {
    viewCalls++;
    return fixture();
  };
  const session = modelSession({ id: 'model-test', name: 'Model', bounds, build: main }, {});
  const source = session.generate();
  assert.equal(session.generate().world, source.world);
  assert.equal(session.generate(main).world, source.world);
  assert.equal(session.preview(source.world, bounds), session.preview(source.world, structuredClone(bounds)));
  assert.notEqual(session.generate(view).world, source.world);
  session.generate(view);
  assert.equal(mainCalls, 1);
  assert.equal(viewCalls, 1);
});

test('cropped wall preparation is independent of view order and never edits source layers', () => {
  const model = new Components();
  model.replace('walls', fixture());
  const session = modelSession({ id: 'model-test', name: 'Model', bounds, build: () => model }, {});
  const source = session.generate();
  const before = source.world.snapshot();
  const layerBefore = model.compose().snapshot();
  const crop: Box = { min: [0, 0, 0], max: [1, 2, 1] };
  session.preview(source.world, bounds);
  const cropped = session.preview(source.world, crop);
  const expected = fixture();
  applyBedrockWallConnections(expected, crop);
  for (let x = -1; x < 3; x++) assert.deepEqual(cropped.get(x, 0, 0), expected.get(x, 0, 0));
  assert.deepEqual(source.world.snapshot(), before);
  assert.deepEqual(model.compose().snapshot(), layerBefore);
  assert.equal(model.compose().get(1, 0, 0)?.states.wall_post_bit, true);
});

test('Java preparation retains source states and its encoder still derives connections', () => {
  const definition = { id: 'model-test', name: 'Model', bounds, build: fixture };
  const { world } = buildModel(definition, {});
  const before = world.snapshot();
  const prepared = prepareModel(world, bounds, { connections: 'preserve' });
  assert.deepEqual(prepared.snapshot(), before);
  assert.deepEqual(
    encodeJavaWorld(prepared, bounds, { name: 'Test' }),
    encodeJavaWorld(fixture(), bounds, { name: 'Test' }),
  );
});
