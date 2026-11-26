import { minecraftBlock } from '../../src/blocks/registry.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { Structure,block,AIR } from '../../src/core/structure.js';
import { Components } from '../../src/core/components.js';
import { preparePreview } from '../../src/preview/selection.js';
import { materials,material,colorProfile } from '../../src/blocks/materials.js';
import { mesh,ChunkMeshes } from '../../src/mesh/mesher.js';
import { exportMcstructure,TARGET } from '../../src/targets/bedrock/mcstructure.js';

test('every catalogue cube has a pinned Bedrock default state',()=>{
  const d:any=minecraftData('bedrock_'+TARGET.gameVersion);
  const known=new Set(d.blocksArray.map((b:any)=>b.name));
  for(const [name,m] of Object.entries(materials))if(m.geometry==='cube'){
    assert.ok(known.has(name),name);assert.deepEqual(material(name),minecraftBlock(name));
  }
  assert.equal(Object.keys(materials).filter(k=>k.endsWith('_concrete')).length,16);
  assert.throws(()=>material('nonexistent'));assert.throws(()=>material('oak_stairs'));
});
test('preview color changes neither geometry nor exported blocks and cache style is detached',()=>{
  const s=new Structure();s.set(0,0,0,material('orange_concrete'));
  const before=exportMcstructure(s,{min:[0,0,0],max:[1,1,1]});const natural=mesh(s);
  const overrides={orange_concrete:'#123456'};const cache=new ChunkMeshes(s,undefined,overrides);overrides.orange_concrete='#ffffff';cache.update();
  const styled=cache.meshes.get('0,0,0')!;
  assert.deepEqual(styled.positions,natural.positions);assert.notDeepEqual(styled.colors,natural.colors);
  assert.deepEqual(styled.colors,mesh(s,undefined,undefined,{orange_concrete:'#123456'}).colors);
  assert.deepEqual(exportMcstructure(s,{min:[0,0,0],max:[1,1,1]}),before);
  assert.throws(()=>colorProfile({stone:'red'}));assert.equal(colorProfile({glass:'#ffffff'}).glass,'#ffffff');
});
function fixture(){
  const c=new Components(),base=new Structure(),roof=new Structure();
  base.fill({min:[-5,0,0],max:[5,2,5]},block('stone'));
  roof.fill({min:[-2,1,1],max:[3,4,4]},block('gold_block'));roof.set(0,1,1,AIR);
  c.replace('base',base);c.replace('roof',roof);return c;
}
test('component listing, focus, isolation and hiding preserve authoritative layers and air',()=>{
  const c=fixture(),revision=c.world.revision;
  const bytes=exportMcstructure(c.world,{min:[-5,0,0],max:[5,4,5]});
  const info=c.list();info[1].bounds!.min[0]=999;assert.equal(c.list()[1].bounds!.min[0],-2);
  const focus=preparePreview(c,{focus:'roof',padding:0});assert.deepEqual(focus.region,{min:[-2,1,1],max:[3,4,4]});
  const isolated=preparePreview(c,{isolate:['roof']});assert.equal(isolated.world.get(-5,0,0),null);assert.equal(isolated.world.get(0,1,1)?.name,'minecraft:air');
  const hidden=preparePreview(c,{hide:['roof']});assert.equal(hidden.world.get(0,1,1)?.name,'minecraft:stone');
  hidden.world.set(0,1,1,block('red_concrete'));
  assert.equal(c.world.revision,revision);assert.deepEqual(exportMcstructure(c.world,{min:[-5,0,0],max:[5,4,5]}),bytes);
});
test('preview slices use integer half-open limits and errors cannot silently select full scene',()=>{
  const c=fixture();assert.deepEqual(preparePreview(c,{slice:{axis:'y',min:1,max:3}}).region,{min:[-5,1,0],max:[5,3,5]});
  assert.throws(()=>preparePreview(c,{focus:'missing'}));assert.throws(()=>preparePreview(c,{hide:['missing']}));
  assert.throws(()=>preparePreview(c,{focus:'roof',hide:['roof']}));assert.throws(()=>preparePreview(c,{hide:['base','roof']}));
  assert.throws(()=>preparePreview(c,{slice:{axis:'y',max:-1}}));assert.throws(()=>preparePreview(c,{padding:NaN}));
  assert.throws(()=>preparePreview(c,{slice:{axis:'y',max:1.5}}));
});
