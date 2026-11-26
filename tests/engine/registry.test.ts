import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from 'nbtify';
import minecraftData from 'minecraft-data';
import { Structure,block } from '../../src/core/structure.js';
import { registryBlocks,registryBlock,minecraftBlock,validateBlockState,registrySource } from '../../src/blocks/registry.js';
import { materials } from '../../src/blocks/materials.js';
import { visualGeometry,fullCube } from '../../src/blocks/shapes.js';
import { mesh,ChunkMeshes,meshDiagnostics } from '../../src/mesh/mesher.js';
import { exportMcstructure,TARGET } from '../../src/targets/bedrock/mcstructure.js';

test('generated registry covers every source state exactly with typed default and partial override support',()=>{
  const d:any=minecraftData('bedrock_'+TARGET.gameVersion);assert.equal(registryBlocks.length,d.blocksArray.length);assert.equal(registrySource.stateCount,d.blockStates.length);
  let count=0;
  for(const b of d.blockStates){
    const states=Object.fromEntries(Object.entries(b.states).map(([k,v]:any)=>[k,v.type==='byte'?Boolean(v.value):v.value]));
    validateBlockState(block(b.name,states));count++;
  }
  assert.equal(count,15168);
  const log=minecraftBlock('oak_log',{pillar_axis:'x'});assert.equal(log.states.pillar_axis,'x');assert.equal(minecraftBlock('oak_log').states.pillar_axis,'y');
  assert.throws(()=>minecraftBlock('oak_log',{pillar_axis:'north'}));assert.throws(()=>validateBlockState(block('oak_log')));
  assert.throws(()=>minecraftBlock('oak_stairs',{upside_down_bit:0}));assert.throws(()=>minecraftBlock('stone',{extra:true}));
  assert.throws(()=>minecraftBlock('custom:stone'));assert.throws(()=>minecraftBlock('no_such_block'));
});

test('ordinary cube selection is corroborated; special and dynamic blocks never become plain cubes',()=>{
  assert.ok(Object.values(materials).filter(m=>m.geometry==='cube').length>300);
  for(const name of ['dirt','oak_log','iron_block','basalt','sea_lantern','copper_block'])assert.ok(fullCube(minecraftBlock(name)),name);
  for(const name of ['glass','yellow_stained_glass','oak_leaves','water','spruce_stairs']){
    const state=minecraftBlock(name);assert.equal(fullCube(state),false,name);
    assert.equal(visualGeometry(state,()=>null).placeholder,undefined,name);
  }
  for(const name of ['chest','piston','redstone_wire']){
    const state=minecraftBlock(name);assert.equal(fullCube(state),false,name);
    assert.ok(visualGeometry(state,()=>null).placeholder,name);
  }
  assert.equal(registryBlock('sea_lantern').emitLight,15); // metadata only; no simulated lighting
});

test('placeholder keeps true block data, does not cull neighboring cube, and reports exact position',()=>{
  const s=new Structure();s.set(15,0,0,minecraftBlock('stone'));s.set(16,0,0,minecraftBlock('chest'));
  const stone=mesh(s,undefined,'0,0,0');assert.equal(stone.quads,6);
  const all=mesh(s);assert.equal(all.diagnostics[0].name,'minecraft:chest');assert.deepEqual(all.diagnostics[0].samples,[[16,0,0]]);
  assert.equal(s.get(16,0,0)?.name,'minecraft:chest');
});

test('glass and water use translucent geometry while leaves remain porous supported foliage',()=>{
  const s=new Structure();s.set(0,0,0,minecraftBlock('glass'));s.set(1,0,0,minecraftBlock('water'));s.set(2,0,0,minecraftBlock('oak_leaves',{persistent_bit:true}));
  const result=mesh(s);assert.equal(result.diagnostics.length,0);assert.ok(result.translucentPositions.length>0);assert.ok(result.translucentAlphas.every(a=>a>0&&a<1));
  assert.ok(result.positions.length>0);assert.ok(visualGeometry(minecraftBlock('oak_leaves',{persistent_bit:true}),()=>null).boxes.length>1);
});

test('tower furniture preview retains recognizable bed, bookshelf and barrel geometry',()=>{
  const shelf=visualGeometry(minecraftBlock('bookshelf'),()=>null),barrel=visualGeometry(minecraftBlock('barrel'),()=>null),bed=visualGeometry(minecraftBlock('bed',{direction:0,head_piece_bit:true,occupied_bit:false}),()=>null);
  assert.ok(shelf.boxes.length>=7);assert.ok(new Set(shelf.boxColors).size>=3);
  assert.ok(barrel.boxes.length>=3);assert.ok(new Set(barrel.boxColors).size>=2);
  assert.ok(bed.boxes.length>=2);assert.ok(new Set(bed.boxColors).size>=2);
});

test('placeholder diagnostics refresh on boundary edits while retaining warnings in untouched chunks',()=>{
  const s=new Structure();s.set(15,1,1,minecraftBlock('chest'));s.set(16,1,1,minecraftBlock('chest'));s.set(48,1,1,minecraftBlock('chest'));
  const cache=new ChunkMeshes(s);cache.update();assert.equal(meshDiagnostics(cache.meshes.values()).reduce((n,d)=>n+d.count,0),3);
  const distant=cache.meshes.get('3,0,0');s.set(16,1,1,minecraftBlock('stone'));assert.equal(cache.update().length,2);
  const reports=meshDiagnostics(cache.meshes.values());assert.equal(reports.length,1);assert.equal(reports[0].name,'minecraft:chest');assert.equal(cache.meshes.get('3,0,0'),distant);
});

test('all registered defaults independently round-trip names and states, including placeholders',async()=>{
  const s=new Structure();registryBlocks.forEach((b,i)=>s.set(i%50,0,Math.floor(i/50),minecraftBlock(b.name)));
  const bytes=exportMcstructure(s,{min:[0,0,0],max:[50,1,26]});
  const r:any=(await read(bytes,{endian:'little',compression:null,bedrockLevel:false,strict:true})).data;
  const palette=r.structure.palette.default.block_palette,indices=r.structure.block_indices[0];
  for(let i=0;i<registryBlocks.length;i++){
    const expected=minecraftBlock(registryBlocks[i].name),actual=palette[Number(indices[(i%50)*26+Math.floor(i/50)])];
    assert.equal(actual.name,expected.name);
    assert.deepEqual(Object.fromEntries(Object.entries(actual.states).map(([k,v])=>[k,typeof v==='string'?v:Number(v)])),Object.fromEntries(Object.entries(expected.states).map(([k,v])=>[k,typeof v==='boolean'?Number(v):v])));
  }
});

test('export validates active region states and drops unused stale palette entries',async()=>{
  const s=new Structure();s.set(0,0,0,block('not_a_real_block'));s.set(0,0,0,minecraftBlock('dirt'));s.set(20,0,0,block('oak_log'));
  const bytes=exportMcstructure(s,{min:[0,0,0],max:[1,1,1]});
  const r:any=(await read(bytes,{endian:'little',compression:null,bedrockLevel:false,strict:true})).data;
  assert.equal(r.structure.palette.default.block_palette.length,1);
  assert.throws(()=>exportMcstructure(s,{min:[20,0,0],max:[21,1,1]}),/Invalid Bedrock/);
});
