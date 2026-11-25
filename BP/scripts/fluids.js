import { noteShort } from "./hud.js";
import { reactorStructure, REACTOR_SHELL, reactorVisual } from "./reactor_structure.js";
import { CONNECTION_DIRECTIONS } from "./connections.js";
import { NS } from "./config.js";
import { SOLAR } from "./solar.js";
import { affordableSpeed, WATER_PUMP, waterPumpOutput } from "./machine-speed.js";
import { GROWER_TIERS } from "./growing_specs.js";
import { ItemStack, EntityDamageCause } from "@minecraft/server";

export const FLUID_NAMES={water:"水",crude_oil:"原油",refined_fuel:"精製燃料"};
export const FLUID_KINDS=Object.keys(FLUID_NAMES);
export const GENERATOR_TYPES=new Set([...Object.keys(SOLAR), ...["coal_generator","thermal_generator","nuclear_reactor","creative_generator","incinerator"].map(name=>NS+":"+name)]);
// クリエイティブ専用のデバッグ設備: 3種類の液体を無限に出す
export const CREATIVE_FLUID_SOURCE=NS+":creative_fluid_source";
export const FLUID_DEVICES=new Set(["water_pump","oil_pump","fluid_pipe","fluid_tank","thermal_generator","nuclear_reactor"].map(name=>NS+":"+name));
const PORTS={
 water_pump:{out:["water"]},oil_pump:{in:["water"],out:["crude_oil"]},
 refinery:{in:["crude_oil"],out:["refined_fuel"]},washer:{in:["water"]},ore_beneficiator:{in:["water"]},
 assembler:{in:["refined_fuel"]},thermal_generator:{in:["crude_oil","refined_fuel"]},
 nuclear_reactor:{in:["water"]},
};
const OFFSETS=CONNECTION_DIRECTIONS.map(d=>[...d.world,d.name]);
export function operatingRates(type,s,speed) {
 const last=s.outputRate??0, draw=s.energyRate??0, actual=s.actualSpeed??0;
 const heading=`上限 ${speed}倍 · 直近の運転 ${actual}倍`;
 if(type==="water_pump")return `${heading}\n最大揚水 ${WATER_PUMP.rate*speed} mB/秒 · 最大消費 ${WATER_PUMP.energy*speed**2} SE/秒\n直近の揚水 ${last} mB · 消費 ${draw} SE`;
 if(type==="oil_pump")return `${heading}\n最大 ${500*speed/4} mB/秒 · 1回 ${4/speed}秒 / ${250*speed} SE\n直近の原油 ${last} mB · 消費 ${draw} SE`;
 if(type==="thermal_generator")return `${heading}\n最大発電 ${2000*speed} SE/秒 · 燃料最大 ${400*speed} mB/秒（精製燃料は ${200*speed} mB/秒）\n直近の発電 ${last} SE · 燃料消費 ${s.fuelRate??0} mB`;
 if(type==="nuclear_reactor")return `${heading}\n最大発電 ${12000*speed} SE/秒 · 最大冷却水 ${500*speed} mB/秒 · 最大昇温電力 ${2000*speed} SE/秒\n直近の発電 ${last} SE · 昇温消費 ${draw} SE · 冷却水 ${s.coolantRate??0} mB`;
 return "";
}
export function installFluids(core) {
 const {world,system,registry,keyOf,expansion,machineContainer,research,generatorRecord,generatorCapacity,speedLimit,saveGeneratorRecord,saveRegistry,removeSlotHost}=core;
 const get=(key,fallback)=>world.getDynamicProperty(key)??fallback;
 const set=(key,value)=>world.setDynamicProperty(key,value);
 const read=(key,fallback)=>{try{return JSON.parse(get(key,JSON.stringify(fallback)));}catch{return fallback;}};
 const kind=m=>m.type.split(":").pop();
 const capacity=m=>kind(m)==="fluid_tank"||m.type===CREATIVE_FLUID_SOURCE?64000:Math.max(8000,(GROWER_TIERS[m.type]?.plants??0)*500);
 const state=m=>({water:0,crude_oil:0,refined_fuel:0,temperature:20,running:true,fuelSeconds:0,...read("of_f:"+m.key,{})});
 const save=(m,s)=>set("of_f:"+m.key,JSON.stringify(s));
 const pipeKind=(block)=>FLUID_KINDS[block.permutation.getState(NS+":fluid_kind")??0];
 function ports(m,block){
  if(kind(m)==="fluid_pipe")return {in:[pipeKind(block)],out:[],pipe:true};
  if(m.type===CREATIVE_FLUID_SOURCE)return {in:[],out:[...FLUID_KINDS],creative:true};
  if(kind(m)==="fluid_tank"){const type=state(m).fluidKind??"water";return {in:[type],out:[type],tank:true};}
  if(GROWER_TIERS[m.type])return {in:["water"]};
  return PORTS[kind(m)];
 }
 function amount(m,fluid){return Math.max(0,Number(state(m)[fluid])||0);}
 function availableRecipe(m,recipe) {
  const s=state(m);
  return (recipe.fluidsIn??[]).every(([type,n])=>(s[type]??0)>=n) &&
    (recipe.fluidsOut??[]).every(([type,n])=>(s[type]??0)+n<=capacity(m));
 }
 function consumeRecipe(m,recipe) {
  if(!availableRecipe(m,recipe))return false;
  const s=state(m);
  for(const [type,n] of recipe.fluidsIn??[])s[type]-=n;
  save(m,s);return true;
 }
 function completeOutputs(m,outputs) {
  const s=state(m);
  if(outputs.some(([type,n])=>(s[type]??0)+n>capacity(m)))return false;
  for(const [type,n] of outputs)s[type]=(s[type]??0)+n;
  save(m,s);return true;
 }
 function describe(m){
  const s=state(m), lines=[];
  if(GENERATOR_TYPES.has(m.type)){const power=generatorRecord(m.key);lines.push("蓄電 "+power.stored+" SE / 累計発電 "+power.generated+" SE");}
  if(kind(m)!=="fluid_pipe"&&kind(m)!=="fluid_tank")lines.push("接続電力 "+expansion.availablePower(m.key)+" SE");
  for(const type of FLUID_KINDS)if((s[type]??0)>0 || PORTS[kind(m)]?.in?.includes(type) || PORTS[kind(m)]?.out?.includes(type) || kind(m)==="fluid_tank"){
   lines.push(FLUID_NAMES[type]+" "+(s[type]??0)+" / "+capacity(m)+" mB");
  }
  if(s.status)lines.push("状態 "+s.status);
  if(kind(m)==="nuclear_reactor")lines.push("炉心 "+Math.round(s.temperature??20)+"度 / 危険温度20000度","起動10000度 · 冷却水500 mB/秒","燃料残り "+(s.fuelSeconds??0)+"秒",reactorStructure(world,m).valid?"炉構造 完成（3×3×3）":"炉構造 未完成 · 不足/誤配置 "+reactorStructure(world,m).missing.length+"か所");
  return lines.join("\n");
 }
 function transfer(nodes,fluid) {
  const byKey=new Map(nodes.map(node=>[node.m.key,node])),seen=new Set();
  for(const start of nodes){
   if(seen.has(start.m.key))continue;
   const component=[],stack=[start];
   while(stack.length){
    const node=stack.pop();
    if(seen.has(node.m.key))continue;
    seen.add(node.m.key);component.push(node);
    for(const [dx,dy,dz] of OFFSETS){
     const next=byKey.get(keyOf(node.m.dim,{x:node.m.x+dx,y:node.m.y+dy,z:node.m.z+dz}));
     if(next&&!seen.has(next.m.key))stack.push(next);
    }
   }
   const sources=component.filter(node=>node.port.out?.includes(fluid)).sort((a,b)=>Number(!!a.port.tank)-Number(!!b.port.tank));
   const targets=component.filter(node=>node.port.in?.includes(fluid)&&!node.port.pipe).sort((a,b)=>Number(!!a.port.tank)-Number(!!b.port.tank));
   for(const source of sources){
    let budget=source.port.tank ? 8000 : 4000*speedLimit(source.m.key);
    for(const target of targets){
     if(source===target || budget<=0)continue;
     const src=state(source.m),dst=state(target.m);
     let quantity=Math.min(budget,src[fluid]??0,capacity(target.m)-(dst[fluid]??0));
     if(source.port.tank&&target.port.tank)quantity=Math.min(quantity,Math.max(0,Math.floor(((src[fluid]??0)-(dst[fluid]??0))/2)));
     if(quantity<=0)continue;
     src[fluid]-=quantity;dst[fluid]=(dst[fluid]??0)+quantity;
     save(source.m,src);save(target.m,dst);budget-=quantity;
    }
   }
  }
 }
 function consumeItem(container,id,n=1) {
  if(!container)return false;
  for(let slot=0;slot<18;slot++){
   const item=container.getItem(slot);
   if(item?.typeId!==id||item.amount<n)continue;
   if(item.amount===n)container.setItem(slot,undefined);
   else{item.amount-=n;container.setItem(slot,item);}
   return true;
  }
  return false;
 }
 function legacyLiquids(m,block){
  const container=machineContainer(block,m.key);if(!container)return;
  for(let slot=0;slot<25;slot++){
   const item=container.getItem(slot);
   const type=item?.typeId===NS+":crude_oil"?"crude_oil":item?.typeId===NS+":refined_fuel"?"refined_fuel":undefined;
   if(!type)continue;
   const s=state(m),n=Math.min(item.amount,Math.floor((capacity(m)-(s[type]??0))/1000));
   if(!n)continue;
   s[type]=(s[type]??0)+n*1000;save(m,s);
   if(n===item.amount)container.setItem(slot,undefined);else{item.amount-=n;container.setItem(slot,item);}
  }
 }
 function generate(m,quantity,max) {
  const record=generatorRecord(m.key);
  const n=Math.min(quantity,Math.max(0,max-record.stored));
  if(!n)return 0;
  record.stored+=n;record.generated+=n;saveGeneratorRecord(m.key,record);return n;
 }
 function zones(){return read("of:radiation",[]);}
 function meltdown(m,block,s,clock){
  if(s.melted)return;
  s.melted=true;s.running=false;s.status="メルトダウン";save(m,s);
  const area={key:m.key+":"+clock,dim:m.dim,x:m.x+.5,y:m.y+.5,z:m.z+.5,expires:clock+1800,radius:50};
  set("of:radiation",JSON.stringify([...zones(),area]));
  const record=generatorRecord(m.key);record.stored=0;saveGeneratorRecord(m.key,record);
  saveRegistry(registry().filter(entry=>entry.key!==m.key));
  removeSlotHost?.(block.dimension,block.location,m.key);
  block.setType("minecraft:air");
  block.dimension.createExplosion({x:area.x,y:area.y,z:area.z},50,{breaksBlocks:true,causesFire:true});
 }
 function tickMachine(m,block,clock){
  const type=kind(m);if(!FLUID_DEVICES.has(m.type)||type==="fluid_pipe"||type==="fluid_tank")return;
  if(research&&!research.allowsMachine(m.type,m))return;
  const s=state(m);
  if(s.melted)return;
  s.actualSpeed=0; s.outputRate=0; s.energyRate=0; s.fuelRate=0; s.coolantRate=0;
  const container=type==="oil_pump"||type==="nuclear_reactor"?machineContainer(block,m.key):undefined;
  const limit=speedLimit(m.key);
  const power=expansion.availablePower(m.key);
  if(type==="water_pump"){
   const water=OFFSETS.some(([dx,dy,dz])=>["minecraft:water","minecraft:flowing_water"].includes(block.dimension.getBlock({x:m.x+dx,y:m.y+dy,z:m.z+dz})?.typeId));
   const room=capacity(m)-s.water;
   const output=waterPumpOutput(limit,power,room);
   s.status=!water?"水源が隣接していません":room<=0?"出力満杯":
     !output.amount||!expansion.spend(m.key,output.energy)?"電力不足":"揚水中";
   if(s.status==="揚水中"){
    s.water+=output.amount;
    s.actualSpeed=output.speed;s.outputRate=output.amount;s.energyRate=output.energy;
   }
  }else if(type==="oil_pump"){
   const room=Math.floor((capacity(m)-(s.crude_oil??0))/500);
   if((s.cycle??0)>clock)s.status="原油を合成中";
   else if((s.water??0)<1000)s.status="水不足";
   else if(!room)s.status="出力満杯";
   else{
    const fuel=Array.from({length:18},(_,slot)=>container?.getItem(slot)).filter(item=>item?.typeId==="minecraft:coal").reduce((sum,item)=>sum+item.amount,0);
    const batches=Math.min(room,fuel,Math.floor(s.water/1000));
    const work=s.oilWork??0;
    const due=speed=>Math.min(batches,Math.floor((work+speed)/4));
    const speed=affordableSpeed(limit,power,speed=>250*speed*Math.max(1,due(speed)));
    if(!fuel)s.status="石炭不足";
    else if(!speed){s.status="電力不足";noteShort(m.key,Math.max(1,250-power));}
    else{
     const count=due(speed);
     const cost=250*speed*count;
     if(!cost||expansion.spend(m.key,cost)){
      for(let i=0;i<count;i++)consumeItem(container,"minecraft:coal");
      s.oilWork=Math.min(3,work+speed-count*4);s.water-=1000*count;s.crude_oil+=500*count;
      s.actualSpeed=speed;s.outputRate=500*count;s.energyRate=cost;s.fuelRate=count;
     }
     s.status="原油を合成中";
    }
   }
  }else if(type==="thermal_generator"){
   s.status="石油不足";
   for(let i=0;i<limit;i++){
    if(generatorRecord(m.key).stored+2000>generatorCapacity(m.key)){s.status="蓄電満杯";break;}
    if((s.refined_fuel??0)>=200){s.refined_fuel-=200;s.fuelRate+=200;s.actualSpeed++;s.outputRate+=generate(m,2000,generatorCapacity(m.key));s.status="精製燃料で発電中";}
    else if((s.crude_oil??0)>=400){s.crude_oil-=400;s.fuelRate+=400;s.actualSpeed++;s.outputRate+=generate(m,2000,generatorCapacity(m.key));s.status="原油で発電中";}
    else break;
   }
  }else if(type==="nuclear_reactor"){
   s.temperature??=20;s.running??=true;s.fuelSeconds??=0;
   if(s.spentPending>0 && container){
    for(let slot=18;slot<25&&s.spentPending>0;slot++){
     const old=container.getItem(slot);
     if(old&&old.typeId!==NS+":depleted_uranium_fuel")continue;
     const n=Math.min(s.spentPending,64-(old?.amount??0));
     if(n>0){container.setItem(slot,new ItemStack(NS+":depleted_uranium_fuel",(old?.amount??0)+n));s.spentPending-=n;}
    }
   }
   const structure=reactorStructure(world,m);
   if(structure.unloaded){s.status="炉構造のチャンク読み込み待ち";save(m,s);core.onState?.(m,block);return;}
   if(s.running&&s.fuelSeconds<=0&&!s.spentPending&&structure.valid){
    if(consumeItem(container,NS+":uranium_fuel")){s.fuelSeconds=1200;s.status="燃料装填";}
    else s.status="ウラン燃料棒不足";
   }
   for(let step=0;step<limit;step++){
     if(s.temperature>=10000 || (!s.running&&s.temperature>200&&s.started)){
      if((s.water??0)>=500&&structure.valid){
       s.water-=500;s.coolantRate+=500;
       if(s.running&&s.fuelSeconds>0){
        if(generatorRecord(m.key).stored>=generatorCapacity(m.key)){
         s.temperature=Math.max(10000,s.temperature-100);
         s.status="蓄電満杯・冷却中";
         break;
        }
        const charge=generatorRecord(m.key).stored/1000000;
        s.temperature=Math.min(15000,Math.max(10000,s.temperature)+10+Math.floor(40*charge));s.fuelSeconds--;s.started=true;if(s.fuelSeconds===0)s.spentPending=(s.spentPending??0)+1;
        s.actualSpeed++;s.fuelRate++;s.outputRate+=generate(m,12000,generatorCapacity(m.key));s.status="原子力発電中";
       }else{s.temperature=Math.max(20,s.temperature-250);s.status="停止・冷却中";if(s.temperature<200)s.started=false;}
      }else{s.temperature+=s.running?1200:200;s.status=structure.valid?"冷却水不足・炉心過熱":"炉構造破損・冷却不能";}
     }else if(s.running&&s.fuelSeconds>0&&structure.valid){
      if((s.water??0)<500)s.status="起動待ち・冷却水不足";
      else if(expansion.spend(m.key,2000)){s.actualSpeed++;s.energyRate+=2000;s.temperature=Math.min(10000,s.temperature+100);s.status="外部電力で炉心を昇温中";}
      else s.status="昇温用電力不足（1段階につき2,000 SE）";
     }else{s.temperature=Math.max(20,s.temperature-5);if(!structure.valid)s.status="炉構造未完成 · 石レンガ20+ガラス6で囲ってください";}
     if(s.temperature>=20000){meltdown(m,block,s,clock);return;}
   }
   // 発電中は観測窓の外に青い光の粒 (チェレンコフ光) を出す
   if(structure.valid&&s.status==="原子力発電中"&&Math.random()<.6){
    try{const dim=world.getDimension(m.dim);
     for(const [dx,dy,dz] of [[1.62,0,0],[-1.62,0,0],[0,0,1.62],[0,0,-1.62],[0,1.62,0]]){
      if(Math.random()<.5)continue;
      dim.spawnParticle("minecraft:blue_flame_particle",{x:m.x+.5+dx+(Math.random()-.5)*.6,y:m.y+.5+dy+(Math.random()-.5)*.6,z:m.z+.5+dz+(Math.random()-.5)*.6});
     }}catch{}
   }
   // 炉構造の見た目: 完成で外殻・観測窓に置き換え、温度で青く光らせる (崩れたら石レンガ・ガラスへ戻す)
   if(structure.valid||s.visualValid){reactorVisual(world,m,s.temperature,structure.valid);s.visualValid=structure.valid;}
  }
  save(m,s);
  if(type==="oil_pump"||type==="nuclear_reactor")core.onState?.(m,block);
 }
 function tickRadiation(clock){
  const active=zones().filter(zone=>zone.expires>clock);
  set("of:radiation",JSON.stringify(active));
  if(clock%2)return;
  const hurt=new Set();
  for(const zone of active){
   try{
    const dim=world.getDimension(zone.dim);
    for(const entity of dim.getEntities({location:zone,maxDistance:50,excludeFamilies:["inanimate","orbital_foundry_slots"]})){
     if(hurt.has(entity.id)||!entity.getComponent("minecraft:health"))continue;
     hurt.add(entity.id);
     entity.applyDamage(2,{cause:EntityDamageCause.magic});
     if(entity.typeId==="minecraft:player")entity.onScreenDisplay?.setActionBar("放射能汚染区域 · 残り"+Math.ceil((zone.expires-clock)/60)+"分");
    }
   }catch{}
  }
 }
 function tick(){
  const clock=Number(get("of:fluid_clock",0))+1;set("of:fluid_clock",clock);
  const live=[];
  for(const m of registry()){
   try{
    const block=world.getDimension(m.dim).getBlock(m);
    if(block?.typeId!==m.type)continue;
    const port=ports(m,block);
    if(port&&(!research||research.allowsMachine(m.type,m))){
     if(port.creative){const s=state(m);for(const fluid of FLUID_KINDS)s[fluid]=capacity(m);save(m,s);}
     live.push({m,block,port});
     if(kind(m)==="nuclear_reactor"&&reactorStructure(world,m).valid){
      for(const offset of REACTOR_SHELL){
       const pos={x:m.x+offset.x,y:m.y+offset.y,z:m.z+offset.z};
       live.push({m:{...m,...pos,key:keyOf(m.dim,pos)},port:{in:["water"],out:[],pipe:true},proxy:true});
      }
     }
    }
   }catch{}
  }
  for(const fluid of FLUID_KINDS)transfer(live.filter(node=>node.port.in?.includes(fluid)||node.port.out?.includes(fluid)),fluid);
  const lookup=new Map(live.map(node=>[node.m.key,node]));
  for(const node of live){
   if(node.proxy)continue;
   if(node.port.pipe){
    let permutation=node.block.permutation,changed=false;
    const type=pipeKind(node.block);
    for(const [dx,dy,dz,name] of OFFSETS){
     const other=lookup.get(keyOf(node.m.dim,{x:node.m.x+dx,y:node.m.y+dy,z:node.m.z+dz}));
     const connected=!!other&&(other.port.in?.includes(type)||other.port.out?.includes(type));
     if(permutation.getState(NS+":"+name)!==connected){permutation=permutation.withState(NS+":"+name,connected);changed=true;}
    }
    if(changed)node.block.setPermutation(permutation);   // 変わったときだけ書き換える (毎秒の無駄な更新を省く)
   }else{
    if(node.port.tank){const value=FLUID_KINDS.indexOf(state(node.m).fluidKind??"water");if(node.block.permutation.getState(NS+":fluid_kind")!==value)node.block.setPermutation(node.block.permutation.withState(NS+":fluid_kind",value));}
    legacyLiquids(node.m,node.block);
    tickMachine(node.m,node.block,clock);
   }
  }
  tickRadiation(clock);
 }
 async function showControl(player,block,key){
  const m={key,dim:block.dimension.id,...block.location,type:block.typeId};
  const s=state(m),type=kind(m);
  const speed=speedLimit(key);
  const report=operatingRates(type,s,speed);
  const form=core.createForm().title(core.nameOf(m.type)+" · 液体・電力")
   .body(describe(m)+(report?"\n\n"+report:"")+
    (type==="water_pump"?"\n隣接する水源から揚水し、配管へ送ります。":"")+
    (type==="oil_pump"?"\n1回につき水1,000 mB・石炭1個を消費します。":"")+
    (type==="thermal_generator"?"\n2,000 SEの発電に原油400 mBまたは精製燃料200 mBを使います。":"")+
    (type==="nuclear_reactor"?"\n3×3×3の外壁は石レンガ20個・各面中央にガラス6個。炉心1万度から発電し、2万度でメルトダウンします。":"")+
    (type==="fluid_pipe"?"\n輸送設定 "+FLUID_NAMES[pipeKind(block)]+"\n同じ種類の配管を6面で接続します。":""));
  const actions=[];
  if(type==="fluid_pipe"||type==="fluid_tank"){
   for(const fluid of FLUID_KINDS){form.button(FLUID_NAMES[fluid]+"に設定");actions.push(fluid);}
  }
  if(type==="nuclear_reactor"){
   form.button("ウラン燃料棒を投入（持ち物から）");actions.push("fuel");
   form.button("使用済み燃料棒を取り出す");actions.push("spent");
   form.button(s.running===false?"炉を起動する":"停止して冷却する");actions.push("toggle");}
  if(["water_pump","oil_pump","thermal_generator","nuclear_reactor"].includes(type)){
   form.button(`速度上限を切り替える（現在 ${speedLimit(key)}倍）`);actions.push("speed");
  }
  form.button("表示を更新");actions.push("refresh");form.button("閉じる");actions.push("close");
  const result=await form.show(player);
  if(result.canceled||block.typeId!==m.type)return;
  const action=actions[result.selection];
  if(FLUID_KINDS.includes(action)){
   if(type==="fluid_pipe")block.setPermutation(block.permutation.withState(NS+":fluid_kind",FLUID_KINDS.indexOf(action)));
   else{
    const current=state(m);
    if(FLUID_KINDS.some(fluid=>(current[fluid]??0)>0&&fluid!==action)){core.toast(player,"中の液体を使い切ってから種類を変更してください");}
    else{current.fluidKind=action;save(m,current);}
   }
  }else if(action==="fuel"){
   const c=machineContainer(block,key),old=c?.getItem(0);
   const n=Math.min(core.countItem(player,NS+":uranium_fuel"),64-(old?.amount??0));
   if(n>0&&(!old||old.typeId===NS+":uranium_fuel")){core.removeItems(player,NS+":uranium_fuel",n);c.setItem(0,new ItemStack(NS+":uranium_fuel",(old?.amount??0)+n));}
  }else if(action==="spent"){
   const c=machineContainer(block,key);for(let slot=18;slot<25;slot++){const item=c?.getItem(slot);if(item?.typeId===NS+":depleted_uranium_fuel"){c.setItem(slot,undefined);core.giveItems(player,item.typeId,item.amount);}}
  }else if(action==="toggle"){const current=state(m);current.running=current.running===false;save(m,current);}
  else if(action==="speed")core.switchSpeed(key);
  else if(action!=="refresh")return;
  return showControl(player,block,key);
 }
 system.runInterval(tick,20);
 return {state,save,amount,capacity,availableRecipe,consumeRecipe,completeOutputs,describe,tick,showControl,ports,forget:m=>set("of_f:"+m.key,undefined)};
}
