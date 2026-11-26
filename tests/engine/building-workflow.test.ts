import test from 'node:test';
import assert from 'node:assert/strict';
import { OrthographicCamera, Vector3 } from 'three';
import { Structure, AIR, type Box } from '../../src/core/structure.js';
import { minecraftBlock as b, registryBlock } from '../../src/blocks/registry.js';
import { familyGeometry, materials } from '../../src/blocks/materials.js';
import { visualGeometry } from '../../src/blocks/shapes.js';
import { planPreviewCamera } from '../../src/preview/camera.js';

test('conditional road paint preserves fluid and air; failed selection does not partially paint',()=>{
 const s=new Structure(),box:Box={min:[0,0,0],max:[4,1,1]};
 s.set(0,0,0,b('grass_block'));s.set(1,0,0,b('water'));s.set(2,0,0,AIR);
 const count=s.fillWhere(box,b('stone_bricks'),old=>old?.name==='minecraft:grass_block');
 assert.equal(count,1);assert.equal(s.get(1,0,0)?.name,'minecraft:water');assert.deepEqual(s.get(2,0,0),AIR);assert.equal(s.get(3,0,0),null);
 const revision=s.revision;
 assert.throws(()=>s.fillWhere(box,b('gold_block'),(_,p)=>{if(p[0]===2)throw Error('predicate');return true;}));
 assert.equal(s.revision,revision);assert.equal(s.get(0,0,0)?.name,'minecraft:stone_bricks');
});
test('conditional fill observes the same original region for neighbor predicates',()=>{
 const s=new Structure();s.set(0,0,0,b('stone'));
 s.fillWhere({min:[1,0,0],max:[4,1,1]},b('stone'),(_,p)=>s.get(p[0]-1,0,0)?.name==='minecraft:stone');
 assert.equal(s.get(1,0,0)?.name,'minecraft:stone');assert.equal(s.get(2,0,0),null);
});
test('standard shape families render new materials but reject extra state schemas and special blocks',()=>{
 for(const name of ['birch_stairs','quartz_stairs','birch_slab','cherry_fence']){
  assert.notEqual(materials[name].geometry,'placeholder');assert.equal(visualGeometry(b(name),()=>null).placeholder,undefined);
 }
 const stairs=registryBlock('birch_stairs');
 assert.equal(familyGeometry({...stairs,defaultStates:{...stairs.defaultStates,new_mode:true}}),undefined);
 assert.equal(familyGeometry(registryBlock('fence_gate')),undefined);
 assert.equal(materials.piston.geometry,'placeholder');
 const shape=visualGeometry(b('birch_slab',{'minecraft:vertical_half':'top'}),()=>null);
 assert.deepEqual(shape.boxes,[[0,.5,0,1,1,1]]);
});
test('orthographic auto-fit contains every corner even when the requested eye is inside the model',()=>{
 const bounds:Box={min:[-8,-4,-10],max:[80,32,192]};
 for(const direction of [[1,1,1],[0,1,0],[0,-1,0],[0,0,1]] as [number,number,number][]){
  const p=planPreviewCamera(bounds,{direction,aspect:1.6});
  const camera=new OrthographicCamera(-p.span*.8,p.span*.8,p.span/2,-p.span/2,p.near,p.far);
  camera.position.set(...p.eye);camera.up.set(...p.up);camera.lookAt(...p.target);camera.updateMatrixWorld(true);
  for(const x of [bounds.min[0],bounds.max[0]])for(const y of [bounds.min[1],bounds.max[1]])for(const z of [bounds.min[2],bounds.max[2]]){
   const q=new Vector3(x,y,z).project(camera);assert.ok([q.x,q.y,q.z].every(v=>v>=-1&&v<=1),JSON.stringify(q));
  }
 }
 const p=planPreviewCamera(bounds,{eye:[40,17,95],target:[40,16,96],span:25});
 assert.equal(p.span,25);assert.ok(new Vector3(...p.eye).distanceTo(new Vector3(...p.target))>50);
});
test('perspective eyes are preserved; invalid camera inputs fail early',()=>{
 const bounds:Box={min:[0,0,0],max:[80,32,192]},eye:[number,number,number]=[40,11,49];
 const p=planPreviewCamera(bounds,{eye,target:[40,10,111],perspective:true});
 p.eye.forEach((v,i)=>assert.ok(Math.abs(v-eye[i])<1e-10));
 assert.throws(()=>planPreviewCamera(bounds,{direction:[0,0,0]}));
 assert.throws(()=>planPreviewCamera(bounds,{span:-1}));
});
