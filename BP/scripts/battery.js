import { GameMode, ItemStack } from "@minecraft/server";
import { NS } from "./config.js";

export const BATTERIES = {
  [`${NS}:battery`]: {name:"蓄電池 Mk I", capacity:20000, rate:400},
  [`${NS}:battery_mk2`]: {name:"蓄電池 Mk II", capacity:100000, rate:2000},
  [`${NS}:battery_mk3`]: {name:"蓄電池 Mk III", capacity:500000, rate:10000},
};
const CHARGE = "of:battery_charge";
const MODES = ["auto","charge","discharge"];
const MODE_NAMES = {auto:"自動",charge:"充電のみ",discharge:"給電のみ"};
const DIRECTIONS = {down:[0,-1,0],up:[0,1,0],north:[0,0,-1],south:[0,0,1],west:[-1,0,0],east:[1,0,0]};
const label = n => n.toLocaleString("en-US");
const heldCharge = (item, spec) => {
  const n = item?.getDynamicProperty(CHARGE);
  return typeof n==="number" && Number.isFinite(n) ? Math.max(0,Math.min(spec.capacity,Math.floor(n))) : 0;
};

export function installBatteries({world,system,registry,keyOf,research,generatorRecord,saveGeneratorRecord,
    generatorCapacity,expansion,createForm,sameMachine,toast}) {
  const placements = new Map();
  world.beforeEvents.playerInteractWithBlock.subscribe(ev=>{
    const {player,itemStack,block}=ev;
    const spec=BATTERIES[itemStack?.typeId];
    if(!spec) return;
    placements.delete(player.id);
    if(!research.allowsMachine(itemStack.typeId,player) || registry().length>=100000){
      ev.cancel=true;
      if(ev.isFirstEvent) system.run(()=>toast(player,research.allowsMachine(itemStack.typeId,player)
        ?"設備登録が上限です。設備を回収してから設置してください"
        :"研究ツリーでこの蓄電池に必要な研究を完了してください"));
      return;
    }
    const stored=heldCharge(itemStack,spec);
    if(!stored) return;
    const {x,y,z}=block.location;
    const [dx,dy,dz]=DIRECTIONS[ev.blockFace.toLowerCase()];
    const dim=block.dimension.id;
    placements.set(player.id,{
      type:itemStack.typeId, stored, slot:player.selectedSlotIndex, tick:system.currentTick,
      positions:[keyOf(dim,{x,y,z}),keyOf(dim,{x:x+dx,y:y+dy,z:z+dz})],
    });
  });

  function onPlace(ev,key){
    const type=ev.block.typeId;
    const pending=placements.get(ev.player.id);
    placements.delete(ev.player.id);
    let stored=0;
    if(pending?.type===type && system.currentTick-pending.tick<=1 && pending.positions.includes(key)){
      if(ev.player.getGameMode()===GameMode.Creative){
        const inv=ev.player.getComponent("minecraft:inventory")?.container;
        const item=inv?.getItem(pending.slot);
        if(item?.typeId===type && heldCharge(item,BATTERIES[type])===pending.stored){
          inv.setItem(pending.slot,undefined);
          stored=pending.stored;
        }
      }else{
        stored=pending.stored;
      }
    }
    saveGeneratorRecord(key,{stored,generated:0,mode:"auto"});
  }

  function recoveryItem(type,key){
    const item=new ItemStack(type);
    const stored=generatorRecord(key).stored;
    if(stored>0){
      item.setDynamicProperty(CHARGE,stored);
      item.setLore([`蓄電 ${label(stored)} / ${label(BATTERIES[type].capacity)} SE`]);
    }
    return item;
  }

  function tick(list) {
    for(const m of list){
      const spec=BATTERIES[m.type];
      if(!spec || !research.allowsMachine(m.type,m)) continue;
      try{
        const block=world.getDimension(m.dim).getBlock(m);
        if(block?.typeId!==m.type) continue;
        const record=generatorRecord(m.key);
        const mode=record.mode??"auto";
        if(mode==="discharge" || record.stored>=spec.capacity) continue;
        let remaining=Math.min(spec.rate,spec.capacity-record.stored);
        for(const source of expansion.chargingSources(m.key)){
          const supply=generatorRecord(source);
          const reserve=mode==="auto" ? Math.floor(generatorCapacity(source)/5) : 0;
          const amount=Math.min(remaining,Math.max(0,supply.stored-reserve));
          if(!amount) continue;
          supply.stored-=amount;
          record.stored+=amount;
          remaining-=amount;
          saveGeneratorRecord(source,supply);
          saveGeneratorRecord(m.key,record);
          if(!remaining) break;
        }
      }catch(error){console.warn("[Orbital Foundry] battery charge: "+error);}
    }
    for(const [id,placement] of placements) if(system.currentTick-placement.tick>1) placements.delete(id);
  }

  async function show(player,block,key){
    const type=block.typeId;
    const spec=BATTERIES[type], record=generatorRecord(key);
    const mode=record.mode??"auto";
    const body=[
      `蓄電　${label(record.stored)} / ${label(spec.capacity)} SE`,
      `最大充電速度　${label(spec.rate)} SE/秒`,
      `運転モード　${MODE_NAMES[mode]}`,
      "",
      "発電機や機械につないだ送電ケーブルに接続してください。",
      "壊して回収しても、貯めた電力はアイテムに残ります。",
      "自動では発電機に容量の20%を残して充電し、必要なときに給電します。",
    ].join("\n");
    const result=await createForm().title(spec.name).body(body)
      .button("運転モードを切り替える").button("表示を更新").button("閉じる").show(player);
    if(result.canceled || !sameMachine(block,type)) return;
    if(result.selection===0){
      const current=generatorRecord(key);
      current.mode=MODES[(MODES.indexOf(current.mode??"auto")+1)%MODES.length];
      saveGeneratorRecord(key,current);
    }
    if(result.selection===0 || result.selection===1) return show(player,block,key);
  }
  return {onPlace,recoveryItem,tick,show};
}
