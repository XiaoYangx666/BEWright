import { meshChunkDecoderSource } from '../../mesh/cache.js';

/** Kept as a browser module so the CLI needs no frontend bundler. */
export function livePage(storageKey: string, background = '#181a20', agent = false) {
  const safe = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>BEWright live preview</title>
<style>body{margin:0;background:#181a20;color:#eee;font:14px system-ui}canvas{display:block}#panel{position:fixed;top:12px;left:12px;padding:12px;background:#15171ddd;border-radius:8px;max-width:70vw}button{margin-right:12px}#status{white-space:pre-wrap;margin-top:8px}</style>
<div id="panel"${agent ? ' style="display:none"' : ''}><button id="reset">重置机位</button><span>拖动旋转 · 右键平移 · 滚轮缩放</span>
<div style="margin-top:8px"><select id="views" aria-label="观察机位"></select> <button id="tour">开始巡览</button>
<input id="bookmark-name" aria-label="机位名称" placeholder="机位名称" size="10"><button id="bookmark">保存机位</button><button id="remove-bookmark">删除自存机位</button><button id="capture">保存截图</button></div>
<div style="margin-top:8px">WASD 前后左右 · Q/E 升降 · Shift 加速 · Esc 停止巡览 <label>速度 <input id="speed" type="range" min="1" max="80" value="12"></label></div>
<div style="margin-top:8px">环境亮度 <input id="ambient" type="range" min="0" max="0.9" step="0.01"> 曝光 <input id="exposure" type="range" min="0.4" max="2.5" step="0.05"> 衰减 <input id="curve" type="range" min="0.6" max="3" step="0.05"> 白天 <input id="day" type="range" min="0" max="1" step="0.01"></div>
<div id="status">正在连接…</div><details id="support"><summary>方块支持情况</summary><p>各环节独立判断；Java“可转换”不代表客户端验收通过。点击定位可观察示例方块。</p><div id="support-table" style="max-height:260px;overflow:auto"></div></details></div>
<script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from '/three/OrbitControls.js';
const storageKey = ${safe(storageKey)};
// Agent mode hides the human panel and slaves the camera to the server pose.
const AGENT_MODE = ${agent ? 'true' : 'false'};
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight); document.body.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(${safe(background)});
const camera = new THREE.PerspectiveCamera(65,innerWidth/innerHeight,0.05,100000);
const controls = new OrbitControls(camera,renderer.domElement);
// Per-vertex block and sky light, shaded in the fragment shader so the sliders
// below act on uniforms instantly instead of triggering a rebuild. The vertex
// colors are baked in linear space, so the fragment output must encode to
// sRGB exactly like the MeshBasicMaterial output path it replaced.
const SRGB=\`vec3 toSRGB(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,vec3(greaterThanEqual(c,vec3(0.0031308))));}\`;
const LIGHT_FRAG=\`precision highp float;uniform float uAmbient;uniform float uExposure;uniform float uCurve;uniform float uDay;varying vec3 vColor;varying float vLight;varying float vSky;
\${SRGB}
void main(){float l=max(vLight,vSky*uDay);float b=(uAmbient+(1.0-uAmbient)*pow(l,uCurve))*uExposure;gl_FragColor=vec4(toSRGB(vColor*b),1.0);}\`;
const LIGHT_FRAG_RGBA=\`precision highp float;uniform float uAmbient;uniform float uExposure;uniform float uCurve;uniform float uDay;varying vec4 vColor;varying float vLight;varying float vSky;
\${SRGB}
void main(){float l=max(vLight,vSky*uDay);float b=(uAmbient+(1.0-uAmbient)*pow(l,uCurve))*uExposure;gl_FragColor=vec4(toSRGB(vColor.rgb*b),vColor.a);}\`;
const LIGHT_VERT=(rgba)=>\`precision highp float;attribute vec3 position;attribute \${rgba?'vec4':'vec3'} color;attribute float light;attribute float sky;
uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;varying \${rgba?'vec4':'vec3'} vColor;varying float vLight;varying float vSky;
void main(){vColor=color;vLight=light;vSky=sky;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}\`;
function lightMaterial(rgba){return new THREE.RawShaderMaterial({uniforms:{uAmbient:{value:.18},uExposure:{value:1},uCurve:{value:1.45},uDay:{value:1}},vertexShader:LIGHT_VERT(rgba),fragmentShader:rgba?LIGHT_FRAG_RGBA:LIGHT_FRAG,transparent:!!rgba,depthWrite:!rgba,side:rgba?THREE.DoubleSide:THREE.FrontSide});}
const opaque=lightMaterial(false),transparentMat=lightMaterial(true);
const chunks = new Map(); let revision=0, latest, initialized=false, loading=false, pending=false;
const status = document.querySelector('#status');
const LIGHT_DEFAULTS={ambient:.18,exposure:1,curve:1.45,day:1};
let lightState={...LIGHT_DEFAULTS};try{Object.assign(lightState,JSON.parse(localStorage.getItem(storageKey+':light'))??{});}catch{}
// URL parameters (?ambient=&exposure=&curve=&day=) seed a session; the server
// keeps the shared value so agents and sliders stay in sync.
const query=new URLSearchParams(location.search),urlLight={};
for(const key of ['ambient','exposure','curve','day'])if(query.has(key)){const value=Number(query.get(key));if(Number.isFinite(value)){lightState[key]=value;urlLight[key]=value;}}
function pushLight(){fetch('/lighting',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(lightState)}).catch(()=>{});}
function applyLight(){const uniformNames={ambient:'uAmbient',exposure:'uExposure',curve:'uCurve',day:'uDay'};for(const key of ['ambient','exposure','curve','day']){for(const m of [opaque,transparentMat])m.uniforms[uniformNames[key]].value=lightState[key];const input=document.querySelector('#'+key);if(input)input.value=lightState[key];}draw();if(AGENT_MODE)return;try{localStorage.setItem(storageKey+':light',JSON.stringify(lightState));}catch{}}
for(const key of ['ambient','exposure','curve','day']){const input=document.querySelector('#'+key);if(input)input.oninput=()=>{lightState[key]=Number(input.value);applyLight();pushLight();};}
applyLight();
if(Object.keys(urlLight).length)pushLight();
const viewSelect=document.querySelector('#views'), tourButton=document.querySelector('#tour');
let bookmarks=[];try{bookmarks=JSON.parse(localStorage.getItem(storageKey+':bookmarks'))??[];}catch{}
const validPose=p=>p&&typeof p.name==='string'&&p.camera?.eye?.length===3&&p.camera?.target?.length===3&&[...p.camera.eye,...p.camera.target].every(Number.isFinite);
bookmarks=Array.isArray(bookmarks)?bookmarks.filter(validPose).slice(0,50):[];
let choices=[], tourFrame=0, tourStarted=0, tourFrom, tourTo, tourIndex=0;
const keys=new Set();let movementFrame=0, movementLast=0;
function stopTour(){cancelAnimationFrame(tourFrame);tourFrame=0;tourButton.textContent='开始巡览';save();}
function cameraPose(view){
  const min=new THREE.Vector3(...latest.bounds.min),max=new THREE.Vector3(...latest.bounds.max);
  const target=new THREE.Vector3(...(view.target??min.clone().add(max).multiplyScalar(.5).toArray()));
  const directions={iso:[1,.85,1],top:[0,1,.001],front:[0,0,1],side:[1,0,0]};
  const eye=view.eye?new THREE.Vector3(...view.eye):target.clone().addScaledVector(new THREE.Vector3(...(view.direction??directions[view.camera]??directions.iso)).normalize(),Math.max(max.clone().sub(min).length(),4)/Math.sin(camera.fov*Math.PI/360));
  return {eye,target};
}
function applyPose(pose){camera.position.copy(pose.eye);controls.target.copy(pose.target);controls.update();draw();}
function rebuildChoices(){
 const previous=viewSelect.value;
 choices=[...(latest.views??[]).map(v=>({...v,id:'view:'+v.name})),...['iso','top','front','side'].map(name=>({name:'全景 '+name,id:'auto:'+name,camera:{camera:name},available:true})),...bookmarks.map((v,i)=>({...v,id:'saved:'+i,available:true}))];
 viewSelect.replaceChildren();for(const choice of choices){const option=document.createElement('option');option.value=choice.id;option.textContent=(choice.title??choice.name)+(choice.available?'':'（需单独加载此模型/区域）');option.disabled=!choice.available;viewSelect.append(option);}
 if(choices.some(v=>v.id===previous&&v.available))viewSelect.value=previous;
 else viewSelect.value=choices.find(v=>v.available)?.id??'';
}
viewSelect.onchange=()=>{stopTour();const choice=choices.find(v=>v.id===viewSelect.value);if(choice?.available)applyPose(cameraPose(choice.camera));};
tourButton.onclick=()=>{
 if(tourFrame){stopTour();return;}if(!latest)return;
 const route=choices.filter(v=>v.available);if(route.length<2)return;
 tourIndex=Math.max(0,route.findIndex(v=>v.id===viewSelect.value));tourStarted=performance.now();
 tourFrom={eye:camera.position.clone(),target:controls.target.clone()};tourTo=cameraPose(route[tourIndex].camera);tourButton.textContent='停止巡览';
 function tick(now){const t=Math.min((now-tourStarted)/1500,1),ease=t*t*(3-2*t);applyPose({eye:tourFrom.eye.clone().lerp(tourTo.eye,ease),target:tourFrom.target.clone().lerp(tourTo.target,ease)});
 if(now-tourStarted>4500){tourIndex=(tourIndex+1)%route.length;viewSelect.value=route[tourIndex].id;tourFrom=tourTo;tourTo=cameraPose(route[tourIndex].camera);tourStarted=now;}
 tourFrame=requestAnimationFrame(tick);}
 tourFrame=requestAnimationFrame(tick);
};
function storeBookmarks(){try{localStorage.setItem(storageKey+':bookmarks',JSON.stringify(bookmarks));}catch{status.textContent='浏览器未允许保存机位';}rebuildChoices();}
document.querySelector('#bookmark').onclick=()=>{if(!latest)return;stopTour();if(bookmarks.length>=50){status.textContent='最多保存 50 个机位，请先删除不需要的机位';return;}const name=document.querySelector('#bookmark-name').value.trim()||'机位 '+(bookmarks.length+1);bookmarks.push({name,camera:{eye:camera.position.toArray(),target:controls.target.toArray(),camera:'iso'}});storeBookmarks();viewSelect.value='saved:'+(bookmarks.length-1);};
document.querySelector('#remove-bookmark').onclick=()=>{if(!viewSelect.value.startsWith('saved:'))return;stopTour();bookmarks.splice(Number(viewSelect.value.slice(6)),1);storeBookmarks();};
document.querySelector('#capture').onclick=()=>{draw();const link=document.createElement('a');link.download='bewright-view.png';link.href=renderer.domElement.toDataURL('image/png');link.click();};
renderer.domElement.addEventListener('pointerdown',stopTour);
function move(now){const dt=Math.min((now-movementLast)/1000,.05);movementLast=now;
 const speed=Number(document.querySelector('#speed').value)*(keys.has('ShiftLeft')||keys.has('ShiftRight')?4:1)*dt;
 const forward=camera.getWorldDirection(new THREE.Vector3()),right=forward.clone().cross(camera.up).normalize(),delta=new THREE.Vector3();
 delta.addScaledVector(forward,Number(keys.has('KeyW'))-Number(keys.has('KeyS')));delta.addScaledVector(right,Number(keys.has('KeyD'))-Number(keys.has('KeyA')));delta.y+=Number(keys.has('KeyE'))-Number(keys.has('KeyQ'));
 if(delta.lengthSq()){delta.normalize().multiplyScalar(speed);camera.position.add(delta);controls.target.add(delta);controls.update();draw();}
 movementFrame=keys.size?requestAnimationFrame(move):0;
}
addEventListener('keydown',event=>{if(event.code==='Escape'){stopTour();keys.clear();return;}if(/INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName))return;if(!['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight'].includes(event.code)||!latest)return;event.preventDefault();stopTour();keys.add(event.code);if(!movementFrame){movementLast=performance.now();movementFrame=requestAnimationFrame(move);}});
addEventListener('keyup',event=>{keys.delete(event.code);save();});
addEventListener('blur',()=>{keys.clear();stopTour();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();stopTour();}});
function showSupport(){
 const container=document.querySelector('#support-table');container.replaceChildren();
 const labels={supported:'支持',unsupported:'不支持',unknown:'未确认',mapped:'可转换'};
 const table=document.createElement('table');table.style.borderSpacing='10px 4px';const head=table.insertRow();
 for(const title of ['方块 / 状态','数量','注册表','简便选材','预览','碰撞','基岩编码','Java 转换','位置']){const th=document.createElement('th');th.textContent=title;head.append(th);}
 for(const item of latest.support??[]){const row=table.insertRow();const name=row.insertCell();name.textContent=item.name.replace('minecraft:','');name.title=JSON.stringify(item.states);row.insertCell().textContent=item.count;
 for(const gate of ['registry','materialHelper','preview','collision','bedrock','javaMapping']){const cell=row.insertCell();cell.textContent=labels[item[gate].status];cell.title=item[gate].detail;cell.style.color=item[gate].status==='unsupported'?'#ff958b':item[gate].status==='unknown'?'#ffd782':'#afe0b8';}
 const button=document.createElement('button');button.textContent='定位 '+item.sample.join(',');button.onclick=()=>{stopTour();const target=new THREE.Vector3(...item.sample).addScalar(.5),direction=camera.getWorldDirection(new THREE.Vector3());applyPose({target,eye:target.clone().addScaledVector(direction,-8)});};row.insertCell().append(button);}
 container.append(table);
 document.querySelector('#support summary').textContent='方块支持情况（'+(latest.support?.length??0)+' 种实际状态；悬停查看原因）';
}
function draw(){renderer.render(scene,camera);}
function save(){if(initialized&&!AGENT_MODE)try{localStorage.setItem(storageKey,JSON.stringify({eye:camera.position.toArray(),target:controls.target.toArray()}));}catch{}}
controls.addEventListener('change',()=>{draw();if(!tourFrame&&!movementFrame)save();});
addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();draw();});
function fit(state){
  const min=new THREE.Vector3(...state.bounds.min),max=new THREE.Vector3(...state.bounds.max);
  const center=min.clone().add(max).multiplyScalar(.5), size=max.clone().sub(min).length();
  const view=state.camera;
  controls.target.fromArray(view.target ?? center.toArray());
  if(view.eye) camera.position.fromArray(view.eye);
  else {
    const directions={iso:[1,.85,1],top:[0,1,.001],front:[0,0,1],side:[1,0,0]};
    const direction=new THREE.Vector3(...(view.direction ?? directions[view.camera] ?? directions.iso)).normalize();
    camera.position.copy(controls.target).addScaledVector(direction,Math.max(size,4)/Math.sin(camera.fov*Math.PI/360));
  }
  controls.update();draw();save();
}
document.querySelector('#reset').onclick=()=>{stopTour();if(latest?.bounds)fit(latest);};
${meshChunkDecoderSource()}
function geometry(bytes,origin){
  const chunk=decodeMeshChunk(bytes,origin);if(!chunk)return new THREE.Group();
  const group=new THREE.Group();
  function add(positions,colors,lights,skies,alphas,material){
    if(!positions.length)return;
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(positions,3));
    if(alphas){const rgba=new Float32Array(alphas.length*4);for(let i=0;i<alphas.length;i++){rgba.set(colors.subarray(i*3,i*3+3),i*4);rgba[i*4+3]=alphas[i];}g.setAttribute('color',new THREE.BufferAttribute(rgba,4));}
    else g.setAttribute('color',new THREE.BufferAttribute(colors,3));
    g.setAttribute('light',new THREE.BufferAttribute(lights,1));
    g.setAttribute('sky',new THREE.BufferAttribute(skies,1));
    group.add(new THREE.Mesh(g,material));
  }
  add(chunk.positions,chunk.colors,chunk.lights,chunk.skies,null,opaque);
  add(chunk.translucentPositions,chunk.translucentColors,chunk.translucentLights,chunk.translucentSkies,chunk.translucentAlphas,transparentMat);
  return group;
}
function dispose(group){group.traverse(object=>object.geometry?.dispose());}
let appliedPose='';
async function refresh(){
  if(loading){pending=true;return;} loading=true;
  const staged=new Map();
  try{
    const state=await fetch('/state').then(r=>r.json());
    status.textContent=state.status==='error'?'构建失败，保留上次画面：'+state.error:state.status==='building'?'正在构建，保留当前机位…':'已更新 · '+state.metrics?.rebuilt+' 个区块 · 网格 '+state.metrics?.meshMs+' ms';
    if(AGENT_MODE&&state.pose){const key=JSON.stringify(state.pose);if(key!==appliedPose){appliedPose=key;applyPose({eye:new THREE.Vector3(...state.pose.eye),target:new THREE.Vector3(...state.pose.target)});}}
    if(!state.revision || state.revision===revision)return;
    const queue=Object.entries(state.chunks).filter(([key,version])=>chunks.get(key)?.version!==version);
    let cursor=0, failure;
    await Promise.all(Array.from({length:Math.min(8,queue.length)},async()=>{
      while(cursor<queue.length && !failure){
        const [key,version]=queue[cursor++];
        try{
          const response=await fetch('/chunk?key='+encodeURIComponent(key)+'&version='+version);
          if(!response.ok)throw Error('Preview changed while loading');
          staged.set(key,{version,group:geometry(new Uint8Array(await response.arrayBuffer()),chunkOriginFor(key))});
        }catch(error){failure=error;}
      }
    }));
    if(failure)throw failure;
    for(const [key,entry]of chunks){if(!(key in state.chunks)||staged.has(key)){scene.remove(entry.group);dispose(entry.group);chunks.delete(key);}}
    for(const [key,entry]of staged){scene.add(entry.group);chunks.set(key,entry);}staged.clear();
    latest=state;revision=state.revision;
    if(state.lighting){let serverChanged=false;for(const key of ['ambient','exposure','curve','day'])if(Number.isFinite(state.lighting[key])&&lightState[key]!==state.lighting[key]){lightState[key]=state.lighting[key];serverChanged=true;}if(serverChanged)applyLight();}
    rebuildChoices();showSupport();
    if(!initialized){
      if(AGENT_MODE&&!state.pose)fit(state);
      else if(!AGENT_MODE){fit(state);try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved?.eye?.length===3&&saved?.target?.length===3&&[...saved.eye,...saved.target].every(Number.isFinite)){camera.position.fromArray(saved.eye);controls.target.fromArray(saved.target);controls.update();}}catch{}}
      initialized=true;
    }
    draw();
  }catch(error){status.textContent='更新尚未完成，保留上次画面：'+error.message;setTimeout(()=>void refresh(),1000);}
  finally{staged.forEach(entry=>dispose(entry.group));loading=false;if(pending){pending=false;void refresh();}}
}
const events=new EventSource('/events');events.onmessage=()=>void refresh();events.onerror=()=>{status.textContent='连接中断，正在重连；当前画面已保留。';};
// Read-only inspection handle for browser regression tests and performance diagnostics.
// snapshot() renders one PNG at an optional pose/lighting/size override and
// restores everything, so scripted captures never disturb the live view.
window.blockwrightPreview={camera,controls,chunks,renderer,get revision(){return revision;},async snapshot(options){
  options=options||{};
  const oldSize=new THREE.Vector2(),oldPixelRatio=renderer.getPixelRatio();renderer.getSize(oldSize);
  const oldEye=camera.position.toArray(),oldTarget=controls.target.toArray();
  const savedLight={ambient:lightState.ambient,exposure:lightState.exposure,curve:lightState.curve,day:lightState.day};
  try{
    if(options.width||options.height){renderer.setPixelRatio(1);renderer.setSize(options.width||oldSize.x,options.height||oldSize.y,false);camera.aspect=(options.width||oldSize.x)/(options.height||oldSize.y);camera.updateProjectionMatrix();}
    if(options.eye)camera.position.fromArray(options.eye);
    if(options.target)controls.target.fromArray(options.target);
    if(options.eye||options.target)controls.update();
    let overrides=false;for(const key of ['ambient','exposure','curve','day'])if(options[key]!==undefined){lightState[key]=options[key];overrides=true;}
    if(overrides)applyLight();
    draw();
    const data=renderer.domElement.toDataURL('image/png');
    if(overrides){Object.assign(lightState,savedLight);applyLight();}
    return data;
  }finally{
    if(options.width||options.height){renderer.setPixelRatio(oldPixelRatio);renderer.setSize(oldSize.x,oldSize.y,false);camera.aspect=oldSize.x/oldSize.y;camera.updateProjectionMatrix();}
    camera.position.fromArray(oldEye);controls.target.fromArray(oldTarget);controls.update();
    draw();
  }
}};
draw();
</script></html>`;
}
