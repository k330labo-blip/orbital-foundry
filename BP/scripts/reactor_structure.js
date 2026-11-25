import { NS } from "./config.js";
export const REACTOR_TYPE=NS+":nuclear_reactor";
// 炉構造が完成すると石レンガ→原子炉外殻、ガラス→原子炉観測窓に置き換える (壊れたら元に戻す)
export const REACTOR_CASING=NS+":reactor_casing", REACTOR_WINDOW=NS+":reactor_window";
const SWAP={"minecraft:stone_bricks":REACTOR_CASING,"minecraft:glass":REACTOR_WINDOW};
const BACK={[REACTOR_CASING]:"minecraft:stone_bricks",[REACTOR_WINDOW]:"minecraft:glass"};
export const REACTOR_SHELL=[];
for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
 if(!x&&!y&&!z)continue;
 const glass=Math.abs(x)+Math.abs(y)+Math.abs(z)===1;
 REACTOR_SHELL.push({x,y,z,type:glass?"minecraft:glass":"minecraft:stone_bricks"});
}
// 外殻・観測窓は元の石レンガ・ガラスとして数える
const normalize=t=>t==="minecraft:stonebrick"?"minecraft:stone_bricks":(BACK[t]??t);
export function reactorStructure(world,m){
 let missing=[],unloaded=false;const dim=world.getDimension(m.dim);
 let core;try{core=dim.getBlock(m)?.typeId;if(core===undefined)unloaded=true;}catch{unloaded=true;}
 if(core!==REACTOR_TYPE)missing.push({x:m.x,y:m.y,z:m.z,expected:REACTOR_TYPE,actual:core});
 for(const offset of REACTOR_SHELL){
  const pos={x:m.x+offset.x,y:m.y+offset.y,z:m.z+offset.z};
  let actual;try{actual=dim.getBlock(pos)?.typeId;if(actual===undefined)unloaded=true;}catch{unloaded=true;}
  actual=normalize(actual);
  if(actual!==offset.type)missing.push({...pos,expected:offset.type,actual});
 }
 return {valid:missing.length===0,unloaded,missing,shell:REACTOR_SHELL.map(o=>({x:m.x+o.x,y:m.y+o.y,z:m.z+o.z}))};
}
export function reactorAtShell(world,list,dim,pos){
 let block;try{block=world.getDimension(dim).getBlock(pos);}catch{return;}
 if(!["minecraft:stone_bricks","minecraft:stonebrick","minecraft:glass",REACTOR_CASING,REACTOR_WINDOW].includes(block?.typeId))return;
 for(const m of list){
  if(m.type!==REACTOR_TYPE||m.dim!==dim)continue;
  const dx=Math.abs(m.x-pos.x),dy=Math.abs(m.y-pos.y),dz=Math.abs(m.z-pos.z);
  if(Math.max(dx,dy,dz)!==1)continue;
  if(reactorStructure(world,m).valid)return m;
 }
}
// 温度の段階: 0=冷 / 1=温 (2000度〜) / 2=熱 (10000度〜・発電中) / 3=灼熱 (15000度〜)
export const heatStage=t=>t>=15000?3:t>=10000?2:t>=2000?1:0;
const setHeat=(block,h)=>{try{if(block.permutation.getState("orbital_foundry:heat")!==h)block.setPermutation(block.permutation.withState("orbital_foundry:heat",h));}catch{}};
// 炉構造の見た目を温度と完成状態に合わせる
export function reactorVisual(world,m,temperature,valid){
 let dim;try{dim=world.getDimension(m.dim);}catch{return;}
 const h=valid?heatStage(temperature??20):0;
 try{const core=dim.getBlock(m);if(core?.typeId===REACTOR_TYPE)setHeat(core,h);}catch{}
 for(const o of REACTOR_SHELL){
  let b;try{b=dim.getBlock({x:m.x+o.x,y:m.y+o.y,z:m.z+o.z});}catch{continue;}
  if(!b)continue;
  const t=b.typeId;
  if(valid){
   const want=SWAP[normalize(t)];
   if(!want)continue;
   if(t!==want){try{b.setType(want);}catch{continue;}}
   setHeat(b,h);
  }else if(BACK[t]){try{b.setType(BACK[t]);}catch{}}
 }
}
// 炉心を壊したら、残った外殻・観測窓を石レンガ・ガラスへ戻す
export function installReactorShellCleanup(world){
 world.afterEvents.playerBreakBlock.subscribe(({block,brokenBlockPermutation})=>{
  if(brokenBlockPermutation?.type?.id!==REACTOR_TYPE)return;
  const m={dim:block.dimension.id,x:block.location.x,y:block.location.y,z:block.location.z};
  reactorVisual(world,m,20,false);
 });
}
