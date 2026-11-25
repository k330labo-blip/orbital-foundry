import { FOUNDRY_COMPONENTS } from "./foundry-spec.js";
import { SCIENCE_PACKS, BELT_RESEARCH, ORE_PROCESSING } from "./config.js";

export const TECHNOLOGIES = [
  {id:"metallurgy",name:"金属加工",requires:[],count:20,packs:[0],unlocks:"合金炉・プレス機 / 鋼・鋼板 / 鋼の防具（作業台） / 未処理石炭の粉砕（石炭2倍）",icon:"steel_ingot"},
  {id:"electrification",name:"電子工学",requires:["metallurgy"],count:20,packs:[0],unlocks:"電気炉・製線機・揚水ポンプ・液体パイプ・タンク / 銅線・シリコン",icon:"copper_wire"},
  {id:"automation",name:"自動組立",requires:["electrification"],count:40,packs:[0],unlocks:"組立機・全自動栽培槽 Mk I・ベルト分配機 Mk I / 回路・モーター・緑パック",icon:"motor"},
  {id:"advanced_materials",name:"高度素材",requires:["automation"],count:50,packs:[0,1],unlocks:"洗浄機・蓄電池 Mk I・太陽光発電機 / ニッケル・アルミ・耐熱合金",icon:"heat_alloy"},
  {id:"chemistry",name:"化学工業",requires:["advanced_materials"],count:80,packs:[0,1],unlocks:"原油ポンプ・精製機 / 精製燃料・青パック",icon:"refined_fuel"},
  {id:"advanced_manufacturing",name:"精密生産",requires:["chemistry"],count:100,packs:[0,1,2],unlocks:"高度制御ユニット・紫パック",icon:"processing_unit"},
  {id:"ore_beneficiation",name:"高度選鉱",requires:["thermal_power","advanced_manufacturing"],count:80,packs:[0,1,2],unlocks:"高度選鉱機 / 原鉱から最大5倍の収量",icon:"crushed_copper"},
  {id:"rocketry",name:"ロケット工学",requires:["advanced_manufacturing"],count:100,packs:[0,1,2,3],unlocks:"発射台・着陸台 / ロケット機体・誘導装置・打ち上げ",icon:"rocket_body_section"},
  {id:"orbital_industry",name:"軌道産業",requires:["rocketry"],count:140,packs:[1,2,3],unlocks:"軌道ターミナル・軌道工廠部品・ボス起動核",icon:"orbital_crystal"},
  {id:"belt_capacity",name:"ベルト積載量",requires:["automation"],count:BELT_RESEARCH.packs,packs:[0],unlocks:"ベルト1便の積載上限 4 > 8個",icon:"gear"},
  {id:"thermal_power",name:"石油火力",requires:["chemistry"],count:80,packs:[0,1],unlocks:"石油火力発電機・蓄電池 Mk II・集光型太陽光発電機・全自動栽培槽 Mk II / 駆動部品（組立機） / 2000 SE毎秒",icon:"refined_fuel"},
  {id:"factory_defense",name:"工場防衛",requires:["advanced_materials"],count:40,packs:[0,1],
    unlocks:"防衛端末・機関砲塔 Mk I・レールガン砲塔・ショットガン砲塔 / 専用弾・補修キット（組立機）。3ウェーブを守り切ると軍用制御核2個",icon:"industrial_ammo"},
  {id:"industrial_storage",name:"工業保管",requires:["advanced_materials"],count:30,packs:[0,1],unlocks:"工業コンテナ Mk I / 1品目を4,096個まで保管",icon:"of_tech_storage"},
  {id:"large_scale_mining",name:"大規模掘削",requires:["advanced_manufacturing","thermal_power","industrial_storage"],count:50,packs:[0,1,2],unlocks:"チャンクデストロイヤー Mk I・工業コンテナ Mk II・ベルト Mk II・分配機 Mk II / 隣のチャンクを岩盤まで掘る",icon:"of_tech_quarry"},
  {id:"orbital_mining",name:"軌道掘削",requires:["large_scale_mining","orbital_industry","nuclear_power"],count:80,packs:[1,2,3],
    gate:{key:"of:rocket_stage",min:4,label:"自分の軌道便の貨物を着陸台で1回回収する"},
    unlocks:"チャンクデストロイヤー Mk II・軌道コンテナ Mk III・軌道迎撃砲 / 2倍速・予約4件・262,144個",icon:"of_tech_orbital_mining"},
  {id:"singularity_tech",name:"特異点技術",requires:["orbital_mining"],count:120,packs:[2,3],
    gate:{key:"of:boss_rank",min:1,label:"オーバーシアを1回討伐する"},
    unlocks:"チャンクデストロイヤー Mk III・特異点コンテナ・ベルト Mk III・分配機 Mk III / 4倍速・予約16件・容量無限",icon:"of_tech_singularity"},
  {id:"nuclear_power",name:"原子力",requires:["advanced_manufacturing","thermal_power"],count:150,packs:[0,1,2],unlocks:"原子炉・蓄電池 Mk III・全自動栽培槽 Mk III・ウラン精錬・燃料棒 / 12000 SE毎秒",icon:"uranium_fuel"},
];
export const EQUIPMENT_TECH = {solar_generator:"advanced_materials",solar_concentrator:"thermal_power",grower_mk1:"automation",grower_mk2:"thermal_power",grower_mk3:"nuclear_power",water_pump:"electrification",fluid_pipe:"electrification",fluid_tank:"electrification",thermal_generator:"thermal_power",nuclear_reactor:"nuclear_power",
  alloy_furnace:"metallurgy",press:"metallurgy",electric_furnace:"electrification",wire_mill:"electrification",
  assembler:"automation",auto_crafter:"automation",washer:"advanced_materials",ore_beneficiator:"ore_beneficiation",battery:"advanced_materials",battery_mk2:"thermal_power",battery_mk3:"nuclear_power",
  oil_pump:"chemistry",refinery:"chemistry",launch_pad:"rocketry",landing_pad:"rocketry",
  orbital_terminal:"orbital_industry",
  industrial_container_mk1:"industrial_storage",industrial_container_mk2:"large_scale_mining",chunk_destroyer_mk1:"large_scale_mining",
  defense_terminal:"factory_defense",turret_mk1:"factory_defense",turret_railgun:"factory_defense",turret_shotgun:"factory_defense",
  chunk_destroyer_mk2:"orbital_mining",conveyor_2:"large_scale_mining",conveyor_3:"singularity_tech",splitter_1:"automation",incinerator:"metallurgy",mob_crusher:"factory_defense",mob_spawner:"thermal_power",splitter2_1:"automation",splitter2_2:"large_scale_mining",splitter2_3:"singularity_tech",splitter_2:"large_scale_mining",splitter_3:"singularity_tech",orbital_cannon:"orbital_mining",orbital_container_mk3:"orbital_mining",chunk_destroyer_mk3:"singularity_tech",singularity_container:"singularity_tech",
};
export const RECIPE_TECH = {
  ...Object.fromEntries(FOUNDRY_COMPONENTS.map(c=>[c.id,"orbital_industry"])),
  ...Object.fromEntries(ORE_PROCESSING.recipes.filter(recipe=>recipe.technology).map(recipe=>[recipe.id,recipe.technology])),
  uranium_ingot:"nuclear_power",uranium_fuel:"nuclear_power",
  steel_ingot:"metallurgy",steel_plate:"metallurgy",copper_wire:"electrification",silicon:"electrification",
  gear:"automation",bearing:"automation",motor:"automation",basic_circuit:"automation",control_board:"automation",
  science_automation:"automation",nickel_ingot:"advanced_materials",aluminum_plate:"advanced_materials",
  heat_alloy:"advanced_materials",wash_iron:"advanced_materials",solar_cell:"advanced_materials",
  refine_oil:"chemistry",rocket_fuel:"chemistry",rocket_fuel_refined:"chemistry",science_chemical:"chemistry",
  processing_unit:"advanced_manufacturing",science_aerospace:"advanced_manufacturing",
  industrial_ammo:"factory_defense",railgun_round:"factory_defense",shotgun_shell:"factory_defense",repair_kit:"factory_defense",drive_component:"thermal_power",storage_cell:"advanced_materials",rocket_body_section:"rocketry",guidance_device:"rocketry",activation_core:"orbital_industry",
};
// 研究はワールド全体で共有する (誰が研究しても全員に反映)。
// who (プレイヤー / 機械の登録 / プレイヤーID) は受け取るが、研究の記録には使わない。
// 進行条件 (防衛戦の勝利などのフラグ) だけは、これまでどおり選ぶプレイヤー本人の記録で判定する。
export function ownerIdOf(who) {
  if (!who) return undefined;
  if (typeof who === "string") return who;
  if (who.typeId === "minecraft:player") return who.id;
  return who.owner;
}
export function createResearch(get,set,listIds=()=>[]) {
  const technology=id=>TECHNOLOGIES.find(tech=>tech.id===id);
  const SHARED="of:research:";
  // プレイヤーごとに記録していた版からの引き継ぎ: 全員の記録のうち一番進んでいる値をワールド共有の記録へまとめる (1回だけ)
  let merged=false;
  function mergeOnce(){
    if(merged)return; merged=true;
    try{
      if(get("of:research_shared_v2",false))return;
      const ids=listIds().filter(k=>k.startsWith(SHARED));
      for(const t of TECHNOLOGIES){
        let best=Number(get(SHARED+t.id,0))||0;
        for(const k of ids){ if(k.endsWith(":"+t.id)&&k!==SHARED+t.id){ const v=Number(get(k,0))||0; if(v>best)best=v; } }
        if(best)set(SHARED+t.id,Math.min(best,t.count));
      }
      // 研究中だった項目も、共有の記録が空なら誰かのものを引き継ぐ
      if(!get(SHARED+"selected","")){
        const k=ids.find(k=>k.endsWith(":selected")&&k!==SHARED+"selected"&&get(k,""));
        if(k){ set(SHARED+"selected",get(k,"")); const g=k.replace(/:selected$/,":gate_selected"); set(SHARED+"gate_selected",get(g,"")); }
      }
      set("of:research_shared_v2",true);
    }catch(e){ console.warn("[Orbital Foundry] 研究の共有化: "+e); }
  }
  function key(_owner,name){ mergeOnce(); return SHARED+name; }
  const own=who=>ownerIdOf(who);
  const progress=(id,who)=>Math.max(0,Number(get(key(own(who),id),0))||0);
  const isUnlocked=(id,who)=>!id || !!technology(id)&&progress(id,who)>=technology(id).count;
  // 進行条件 (貨物回収・討伐など)。研究パックとは別に満たす必要がある
  const gateOpen=(id,player)=>{
    const gate=technology(id)?.gate;
    return !gate||Number(player?.getDynamicProperty?.(gate.key)??0)>=gate.min;
  };
  const hasPrerequisites=(tech,who)=>!!tech&&tech.requires.every(r=>isUnlocked(r,who))&&!isUnlocked(tech.id,who);
  const canStart=(id,player)=>hasPrerequisites(technology(id),player)&&gateOpen(id,player);
  const selected=who=>technology(get(key(own(who),"selected"),""));
  // 持ち主の記録がない機械 (旧版で置いた・別経路で置いた) は、置けた時点で研究済みとみなす
  const ownerless=who=>!!who&&typeof who==="object"&&who.typeId!=="minecraft:player"&&!who.owner;
  const allowsMachine=(type,who)=>ownerless(who)||isUnlocked(EQUIPMENT_TECH[type.split(":").pop()],who);
  const allowsRecipe=(recipe,who)=>allowsMachine("orbital_foundry:"+recipe.machine,who)&&(ownerless(who)||isUnlocked(RECIPE_TECH[recipe.id],who));
  function select(id,player) {
    if(!canStart(id,player))return false;
    set(key(own(player),"gate_selected"),technology(id).gate?id:"");
    set(key(own(player),"selected"),id);return true;
  }
  const needsAuthorization=(id,who)=>!!technology(id)?.gate&&get(key(own(who),"gate_selected"),"")!==id;
  function pause(id,player) {
    if(selected(player)?.id!==id || (!gateOpen(id,player)&&get(key(own(player),"gate_selected"),"")===id))return;
    set(key(own(player),"selected"),"");
    set(key(own(player),"gate_selected"),"");
  }
  function contribute(container,spend,who) {
    const tech=selected(who);
    if(!hasPrerequisites(tech,who))return {reason:tech&&isUnlocked(tech.id,who)?"研究完了":"研究を選んでください"};
    if(needsAuthorization(tech.id,who))return {reason:"条件を満たしたプレイヤーが研究を選んでください"};
    const inputs=tech.packs.map(index=>SCIENCE_PACKS[index]);
    const slots=[];
    for(const id of inputs) {
      let found=-1;
      for(let slot=0;slot<18;slot++)if(container.getItem(slot)?.typeId===id){found=slot;break;}
      if(found<0)return {reason:"研究パック不足",missing:id};
      slots.push(found);
    }
    if(!spend(15))return {reason:"電力不足"};
    for(const slot of slots) {
      const item=container.getItem(slot);
      if(item.amount===1)container.setItem(slot,undefined);
      else {item.amount--;container.setItem(slot,item);}
    }
    const next=progress(tech.id,who)+1;
    set(key(own(who),tech.id),next);
    return {reason:next>=tech.count?"研究完了":"研究中",worked:true,tech:tech.id};
  }
  return {technology,progress,isUnlocked,canStart,gateOpen,selected,select,pause,needsAuthorization,allowsMachine,allowsRecipe,contribute,ownerIdOf};
}
