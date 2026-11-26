import test from 'node:test';
import assert from 'node:assert/strict';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { visualGeometry } from '../../src/blocks/shapes.js';

test('garden preview models retain open pots and rotate slender chains',()=>{
  const pot=visualGeometry(minecraftBlock('flower_pot'),()=>null);
  assert.equal(pot.placeholder,undefined);
  assert.ok(!pot.boxes.some(([x,y,z,X,Y,Z])=>x<.5&&X>.5&&y<.3&&Y>.3&&z<.5&&Z>.5),'pot opening stays empty');
  for(const [axis,index] of [['x',0],['y',1],['z',2]] as const){
    const chain=visualGeometry(minecraftBlock('chain',{pillar_axis:axis}),()=>null);
    assert.equal(chain.placeholder,undefined);
    const b=chain.boxes[0];assert.equal(b[index+3]-b[index],1);
    for(const i of [0,1,2])if(i!==index)assert.ok(b[i+3]-b[i]<.25);
  }
  for(const name of ['azalea_leaves','cherry_leaves','flowering_azalea']){
    const g=visualGeometry(minecraftBlock(name),()=>null);
    assert.equal(g.placeholder,undefined);
    assert.ok(g.boxes.every(b=>b.every(v=>v>=0&&v<=1)));
  }
});
