import { installHud, noteShort, checkShort } from "./hud.js";
import { installFactoryLoader } from "./factory_loader.js";
import { LOD, nearMachine } from "./lod.js";
import { installPetWither } from "./pet_wither.js";
import { installAstraea } from "./orbital_strike.js";
// ============================================================
// 軌道工廠 v0.8.98 - Phase1: 掘削 - 加工 - 搬送(回収)
// UI方針: 全操作はフォーム (スマホ/コントローラ対応、チャット命令なし)
//   ・機械とガイドには工廠専用のグレーの枠を適用する
//   ・ボタンには必ずアイコンと「できる / 素材不足」を付け、不足分を数字で出す
//   ・結果はその場でフォームに戻り、閉じ直す手間を作らない
// 永続化: world dynamic property (電力 / 機械登録 / 機械状態 / チーム進行)
// 処理: 毎tick全走査せず、登録機械をローテーションで分割処理する
// ============================================================
import { world, system, ItemStack, GameMode, ItemLockMode, BlockPermutation, BlockTypes } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { ENERGY, PROCESS_RECIPES, STAGES, QUESTS, EXPANSION as ORBIT, ROCKET1, ROCKET_COST, NS, MECHANICAL_SCIENCE, BELT_RESEARCH, SCIENCE_PACKS, LOG_VARIANTS, ORE_PROCESSING } from "./config.js";

import { orderedRecipes, orderedTechnologies } from "./progression.js";
import { reactorAtShell, installReactorShellCleanup } from "./reactor_structure.js";
import { MACHINE_LAYOUTS, machineLayout, consolidateMachineSlots } from "./machine_ui.js";
import { installFluids, GENERATOR_TYPES, FLUID_DEVICES, FLUID_NAMES, operatingRates } from "./fluids.js";
import { installSolar, SOLAR } from "./solar.js";
import { BATTERIES, installBatteries } from "./battery.js";
import { affordableSpeed, nextSpeed, processingCost, SPEEDS, visualStepTicks, scheduledStart, SCHED } from "./machine-speed.js";
import { installResearchDebug } from "./research_debug.js";
import { createResearch, TECHNOLOGIES, EQUIPMENT_TECH, RECIPE_TECH } from "./research.js";
import { EQUIPMENT_CATALOG } from "./equipment_catalog.js";
import { ITEM_TEXTURES } from "./item_icons.js";
import { installMachineVisuals } from "./machine_visuals.js";
import { installExpansion } from "./expansion.js";
import { createGameClock, migrateTimer } from "./game_clock.js";
import { createBulkStorage, BULK_TYPES, BULK_TIERS } from "./bulk_storage.js";
import { installBulk } from "./bulk_machine.js";
import { installBulkPack } from "./bulk_pack.js";
import { installQuarry } from "./quarry.js";
import { installDefense, DEF, DEFENSE, TURRET_TYPES } from "./defense.js";
const isPlayerGun=()=>false;   // 銃はゲリラアドオンを使うので削除
import { QUARRY_TYPES, QUARRY_TIERS } from "./quarry_rules.js";
import { installGrowing } from "./growing.js";
import { installRocketScene } from "./rocket_scene.js";
import { GROWER_TIERS } from "./growing_specs.js";
import { installStarforge } from "./starforge.js";
import { installStarWither } from "./star_wither.js";
import { installArmorGuard } from "./armor_guard.js";
import { installMobWorks, MOBWORKS_TYPES, MOBWORKS } from "./mob_works.js";
import { installOrbitalFoundry } from "./orbital-foundry.js";
import { CONSTRUCTION_PLAN, FOUNDRY_CARGO, FOUNDRY_COMPONENTS } from "./foundry-spec.js";
import { installMachineLabels } from "./machine-labels.js";
import { installMachineProductDisplay, PRODUCT_DISPLAY_TYPES, PRODUCT_DISPLAY_LIFT } from "./machine_product_display.js";

// ロケット・軌道便はワールド内時間で進む (ワールド停止中は進まない)
const gameClock = createGameClock({ world, system });

const MACHINES = {
  "orbital_foundry:turret_railgun":{ name:"レールガン砲塔", icon:"textures/blocks/turret_railgun" },
  "orbital_foundry:turret_shotgun":{ name:"ショットガン砲塔", icon:"textures/blocks/turret_shotgun" },
  "orbital_foundry:turret_mk1":{ name:"機関砲塔 Mk I", icon:"textures/blocks/turret_mk1" },
  ...Object.fromEntries(Object.entries(SOLAR).map(([id,spec])=>[id,{name:spec.name,icon:`textures/blocks/${id.split(":")[1]}`}])),
  ...Object.fromEntries(Object.entries(GROWER_TIERS).map(([id,tier])=>[id,{name:tier.name,icon:`textures/blocks/${id.split(":")[1]}`}])),
 "orbital_foundry:water_pump":{name:"揚水ポンプ",icon:"textures/blocks/water_pump"},
 "orbital_foundry:fluid_pipe":{name:"液体パイプ",icon:"textures/blocks/fluid_pipe"},
 "orbital_foundry:fluid_tank":{name:"液体タンク",icon:"textures/blocks/fluid_tank"},
 "orbital_foundry:thermal_generator":{name:"石油火力発電機",icon:"textures/blocks/thermal_generator"},
 "orbital_foundry:nuclear_reactor":{name:"原子炉",icon:"textures/blocks/nuclear_reactor"},
  "orbital_foundry:power_cable": {name:"送電ケーブル"},
  "orbital_foundry:oil_pump": {name:"原油ポンプ"},
  "orbital_foundry:refinery": {name:"精製機"},
  "orbital_foundry:orbital_terminal": {name:"軌道ターミナル"},
  "orbital_foundry:coal_generator":   { name:"石炭発電機",   icon:"textures/blocks/coal_generator" },
  "orbital_foundry:fixed_drill":      { name:"固定ドリル",   icon:"textures/blocks/fixed_drill" },
  "orbital_foundry:crusher":          { name:"粉砕機",       icon:"textures/blocks/crusher" },
  "orbital_foundry:ore_beneficiator": { name:"高度選鉱機",   icon:"textures/blocks/ore_beneficiator" },
  "orbital_foundry:washer":           { name:"洗浄機",       icon:"textures/blocks/washer" },
  "orbital_foundry:electric_furnace": { name:"電気炉",       icon:"textures/blocks/electric_furnace" },
  "orbital_foundry:alloy_furnace":    { name:"合金炉",       icon:"textures/blocks/alloy_furnace" },
  "orbital_foundry:press":            { name:"プレス機",     icon:"textures/blocks/press" },
  "orbital_foundry:wire_mill":        { name:"製線機",       icon:"textures/blocks/wire_mill" },
  "orbital_foundry:assembler":        { name:"組立機",       icon:"textures/blocks/assembler" },
  "orbital_foundry:auto_crafter":     { name:"組立機（旧型）", icon:"textures/blocks/auto_crafter" },
  "orbital_foundry:research_lab":{ name:"研究所", icon:"textures/blocks/research_lab" },
  "orbital_foundry:research_terminal":{ name:"研究端末",     icon:"textures/blocks/research_terminal" },
  ...Object.fromEntries(Object.entries(BATTERIES).map(([id,spec])=>[id,{name:spec.name,icon:`textures/blocks/${id.split(":")[1]}`}])),
  "orbital_foundry:conveyor_1":       { name:"ベルト Mk1",   icon:"textures/blocks/conveyor_1" },
  "orbital_foundry:conveyor_2":       { name:"ベルト Mk II", icon:"textures/blocks/conveyor_2" },
  "orbital_foundry:conveyor_3":       { name:"ベルト Mk III", icon:"textures/blocks/conveyor_3" },
  "orbital_foundry:splitter_1":       { name:"ベルト分配機 Mk I", icon:"textures/blocks/splitter_1_top" },
  "orbital_foundry:splitter_2":       { name:"ベルト分配機 Mk II", icon:"textures/blocks/splitter_2_top" },
  "orbital_foundry:splitter_3":       { name:"ベルト分配機 Mk III", icon:"textures/blocks/splitter_3_top" },
  "orbital_foundry:incinerator":      { name:"廃棄物焼却炉", icon:"textures/blocks/of_inc_door_lit" },
  "orbital_foundry:mob_spawner":      { name:"全自動モブスポナー", icon:"textures/blocks/of_sp_circle_lit" },
  "orbital_foundry:mob_crusher":      { name:"全自動モブクラッシャー", icon:"textures/blocks/of_cr_emblem" },
  "orbital_foundry:splitter2_1":      { name:"二又ベルト分配機 Mk I", icon:"textures/blocks/splitter2_1_top" },
  "orbital_foundry:splitter2_2":      { name:"二又ベルト分配機 Mk II", icon:"textures/blocks/splitter2_2_top" },
  "orbital_foundry:splitter2_3":      { name:"二又ベルト分配機 Mk III", icon:"textures/blocks/splitter2_3_top" },
  "orbital_foundry:launch_pad":       { name:"発射台",       icon:"textures/blocks/launch_pad" },
  "orbital_foundry:landing_pad":      { name:"着陸台",       icon:"textures/blocks/landing_pad" },
  "orbital_foundry:defense_terminal":{ name:"防衛端末", icon:"textures/blocks/defense_terminal" },
  "orbital_foundry:orbital_cannon":{ name:"軌道迎撃砲", icon:"textures/blocks/orbital_cannon_top" },
  "orbital_foundry:creative_generator":{ name:"無限発電機（クリエイティブ）", icon:"textures/blocks/creative_generator" },
  "orbital_foundry:creative_fluid_source":{ name:"無限液体源（クリエイティブ）", icon:"textures/blocks/creative_fluid_source" },
  ...Object.fromEntries([...Object.entries(BULK_TIERS),...Object.entries(QUARRY_TIERS)].map(([type,tier])=>[type,{name:tier.name,icon:"textures/blocks/"+type.split(":").pop()}])),
};
const ASSEMBLER = `${NS}:assembler`;
const LEGACY_CRAFTER = `${NS}:auto_crafter`;
const PROCESSOR_IDS = new Set(orderedRecipes(PROCESS_RECIPES).map(r => `${NS}:${r.machine}`));
const OVERDRIVE_TYPES = new Set([...PROCESSOR_IDS,...QUARRY_TYPES,...TURRET_TYPES,
  ...["incinerator","mob_spawner","mob_crusher","coal_generator","fixed_drill","research_lab","water_pump","oil_pump","thermal_generator","nuclear_reactor","orbital_cannon","launch_pad"].map(name=>`${NS}:${name}`)]);
installMachineLabels({world,system,machines:{...MACHINES},
  // 製品表示を出す機械は、名前ラベルを表示枠の上に逃がす
  labelHeight:type=>PRODUCT_DISPLAY_TYPES.has(type)?1.85+(PRODUCT_DISPLAY_LIFT[type]??0):undefined});
const ORE_NAMES=Object.fromEntries(Object.entries(ORE_PROCESSING.ores).flatMap(([kind,ore])=>[
  ...(ore.raw.startsWith(NS+":unprocessed_")?[[ore.raw,"未処理"+ore.name]]:[]),
  ...(ore.product.startsWith(NS+":crushed_")?[[ore.product,kind==="bauxite"?"粉砕ボーキサイト":kind==="ancient_debris"?"粉砕古代残骸":"粉砕"+ore.name+"鉱"]]:[]),
]));
const ITEM_ICON_OVERRIDE = {}; // 必要時に追加

// ---------- 小物 ----------
const keyOf = (dimId, loc) => `${dimId}:${loc.x},${loc.y},${loc.z}`;
const dpGet = (k, fb) => { try { const v = world.getDynamicProperty(k); return v === undefined ? fb : v; } catch { return fb; } };
const dpSet = (k, v) => { try { world.setDynamicProperty(k, v); } catch {} };
const research=createResearch(dpGet,dpSet,()=>world.getDynamicPropertyIds());
installResearchDebug({system,world});
// Legacy shared energy remains spendable; new production is stored at its source.
const legacyEnergy = () => Math.max(0,Number(dpGet("of:energy",0)));
function generatorRecord(key) {
  try {return JSON.parse(dpGet("of_g:"+key,'{"stored":0,"generated":0}')); }
  catch {return {stored:0,generated:0};}
}
const lastGeneratorJson = new Map();
function saveGeneratorRecord(key,record) {
  const json = JSON.stringify(record);
  if (lastGeneratorJson.get(key) === json) return;   // 自分が最後に書いた内容と同一ならDPへ書き直さない
  lastGeneratorJson.set(key, json);
  dpSet("of_g:"+key,json);
}
function energy() {
  return registry().filter(m=>GENERATOR_TYPES.has(m.type)||BATTERIES[m.type])
    .reduce((total,m)=>total+generatorRecord(m.key).stored,legacyEnergy());
}
function drawEnergy(amount,sources,useLegacy=true) {
  const legacy=useLegacy?legacyEnergy():0;
  const used=Math.min(amount,legacy);
  if (used) dpSet("of:energy",legacy-used);
  let remaining=amount-used;
  for (const key of sources) {
    if (!remaining) break;
    const record=generatorRecord(key);
    const drawn=Math.min(remaining,record.stored);
    if (!drawn) continue;
    record.stored-=drawn;
    remaining-=drawn;
    saveGeneratorRecord(key,record);
  }
}
function generatorCapacity(key) {
  return generatorBaseCapacity(registryEntry(key)?.type);
}
const speedLimit = key => {
  const value = dpGet("of_speed:"+key,1);
  return SPEEDS.includes(value)?value:1;
};
function switchSpeed(key) {
  const next=nextSpeed(speedLimit(key));
  dpSet("of_speed:"+key,next===1?undefined:next);
  return next;
}
// 機械の登録簿。1つの動的プロパティは約32KBまでなので、100件ずつ複数のキーに分けて保存する
// (以前は400件で打ち切っており、大きな工場ではパイプ・ベルト・ケーブルが登録されず動かなかった)
const REG_PAGE = 100, REG_MAX = 100000;   // 1件 約150バイト × 100件 = 約15KB/ページ (上限32KB)
let regCache, regIndex = new Map();
function rebuildRegIndex() { regIndex = new Map((regCache ?? []).map(m => [m.key, m])); }
function loadRegistry() {
  let list = [];
  try { list = JSON.parse(dpGet("of:machines", "[]")); } catch {}
  for (let i = 1; ; i++) { const page = dpGet("of:machines:" + i, undefined); if (page === undefined) break; try { list.push(...JSON.parse(page)); } catch {} }
  regCache = list.filter(m => m.type !== `${NS}:robot_station`);   // 廃止した機械
  rebuildRegIndex();
}
function registry() {
  // 登録簿の書き換えは saveRegistry 経由だけ (全数確認済み) なので、初回ロード後はメモリを正とし、
  // tickが変わるたびの全ページ読み直し＋JSONパースをしない。戻り値は従来どおり配列の複製
  if (!regCache) loadRegistry();
  return regCache.slice();
}
function registryEntry(key) {
  if (!regCache) loadRegistry();
  return regIndex.get(key);
}
function saveRegistry(list) {
  list = list.slice(0, REG_MAX);
  const pages = Math.max(1, Math.ceil(list.length / REG_PAGE));
  const put = (k, part) => { try { world.setDynamicProperty(k, JSON.stringify(part)); } catch (e) { console.warn(`[Orbital Foundry] 登録簿の保存に失敗 ${k}: ${e}`); } };
  put("of:machines", list.slice(0, REG_PAGE));
  for (let i = 1; i < pages; i++) put("of:machines:" + i, list.slice(i * REG_PAGE, (i + 1) * REG_PAGE));
  for (let i = pages; dpGet("of:machines:" + i, undefined) !== undefined; i++) dpSet("of:machines:" + i, undefined);
  // 保存後の registry() が返す内容 (廃止した機械を除いた一覧) とメモリを一致させる
  regCache = list.filter(m => m.type !== `${NS}:robot_station`);
  rebuildRegIndex();
}
function machineState(key) { try { return JSON.parse(dpGet("of_m:" + key, "{}")); } catch { return {}; } }
const lastMachineStateJson = new Map();
function saveMachineState(key, st) {
  const json = JSON.stringify(st);
  if (lastMachineStateJson.get(key) === json) return;   // 内容が同じならDPへ書き直さない (保存データは同一)
  // ただし、このキーについて一度も書いていない場合は、既存DPと同内容でも従来どおり書く
  // (lastMachineStateJson は「自分が最後に書いた/読んだ内容」の記録として machineState 側では更新しないため、
  //  ここでの省略は「前回自分が書いた内容と同一」の場合に限られる)
  lastMachineStateJson.set(key, json);
  dpSet("of_m:" + key, json);
}
function setBlockActive(block, typeId, key, on) {
  if (!block || block.typeId !== typeId) return;
  const perm = block.permutation;
  const state = `${NS}:active`;
  const current = perm.getState(state);
  if (current !== undefined && current !== on) block.setPermutation(perm.withState(state, on));
}
const activeFireSounds = new Map();
function playForgeFire(entry) {
  entry.nextTick=system.currentTick+40;
  try {entry.dimension.playSound("orbital_foundry.forge_fire",entry.location,{volume:.75,pitch:1});} catch {}
}
system.runInterval(()=>{
  for (const [key,entry] of activeFireSounds) {
    if (Date.now()>=entry.until) {activeFireSounds.delete(key);continue;}
    if (system.currentTick>=entry.nextTick) playForgeFire(entry);
    if (entry.blockPosition) {
      if (system.currentTick>=entry.nextPose) animateGenerator(entry);
      if (system.currentTick>=entry.nextSteam) emitGeneratorSteam(entry);
    }
  }
},1);
function animateGenerator(entry) {
  entry.nextPose=system.currentTick+visualStepTicks(entry.speed);
  try {
    const block=entry.dimension.getBlock(entry.blockPosition);
    if (block?.typeId!==`${NS}:coal_generator`) return;
    const permutation=block.permutation;
    const key=`${NS}:gear_phase`;
    const phase=permutation.getState(key);
    if (phase!==undefined) block.setPermutation(permutation.withState(key,(phase+1)%4));
  } catch {}
}
const STEAM_VENT_OFFSETS = {
  north:[.83,.79], west:[.79,.17], south:[.17,.21], east:[.21,.83],
};
function emitGeneratorSteam(entry) {
  entry.nextSteam=system.currentTick+4;
  const {x,y,z}=entry.blockPosition;
  const [dx,dz]=STEAM_VENT_OFFSETS[entry.facing] ?? STEAM_VENT_OFFSETS.north;
  try { entry.dimension.spawnParticle(`${NS}:steam`,{x:x+dx,y:y+1.55,z:z+dz}); } catch {}
}
function updateGeneratorVisual(block, active, burnUntil = Date.now()+2000) {
  const perm = block.permutation;
  const stationKey=keyOf(block.dimension.id,block.location);
  const charge = Math.min(10,Math.max(0,Math.round(10*generatorRecord(stationKey).stored/generatorCapacity(stationKey))));
  const key = `${NS}:charge_level`;
  if (perm.getState(key) !== charge) block.setPermutation(perm.withState(key,charge));
  const soundKey=keyOf(block.dimension.id,block.location);
  if (!active) {
    activeFireSounds.delete(soundKey);
    const phaseKey=`${NS}:gear_phase`;
    const current=block.permutation;
    if (current.getState(phaseKey)>0) block.setPermutation(current.withState(phaseKey,0));
    return;
  }
  const {x,y,z}=block.location;
  let sound=activeFireSounds.get(soundKey);
  if (!sound) {
    sound={dimension:block.dimension,location:{x:x+.5,y:y+.5,z:z+.5},
      blockPosition:{x,y,z},facing:perm.getState("minecraft:cardinal_direction"),until:burnUntil,nextPose:system.currentTick+3};
    emitGeneratorSteam(sound);
    activeFireSounds.set(soundKey,sound);
    playForgeFire(sound);
  } else sound.until=burnUntil;
  const burn=machineState(stationKey).burn;
  sound.speed=burn?.speed ?? (burn?.duration ? burn.val*100/burn.duration : speedLimit(stationKey));
}
function desiredActive(m, st) {
  const now = Date.now();
  if(!research.allowsMachine(m.type,m))return false;
  if(FLUID_DEVICES.has(m.type))return (fluidSystem.state(m).actualSpeed??0)>0;
  if (m.type === `${NS}:coal_generator`) return !!st.burn && now < st.burn.until;
  if (m.type === `${NS}:launch_pad`) { return rocketFlights().some(f=>f.key===m.key && gameClock.now()<f.readyAt); }
  if (m.type === `${NS}:research_lab`) return (labActiveUntil.get(m.key) ?? 0) > system.currentTick;
  if (m.type === `${NS}:landing_pad`) { return rocketFlights().some(f=>f.landing===m.key && gameClock.now()>=f.readyAt); }
  if (m.type===`${NS}:oil_pump`) return (st.nextPump??0)>now;
  if (BATTERIES[m.type]) return generatorRecord(m.key).stored>0;
  if (m.type===`${NS}:research_terminal`) return !!research.selected(m) && !research.isUnlocked(research.selected(m).id,m);
  if (m.type===`${NS}:orbital_terminal`) {
    return orbitalFoundry.workingAt(m.key)||rocketFlights().some(f=>f.orbital&&gameClock.now()<f.readyAt);
  }
  return PROCESSOR_IDS.has(m.type) && !!st.job && now < st.job.readyAt;
}
function generatorBaseCapacity(type) {
  return BATTERIES[type]?.capacity ?? SOLAR[type]?.capacity ?? (type===`${NS}:incinerator`?MOBWORKS.incinerator.capacity:type===`${NS}:nuclear_reactor`?1000000:type===`${NS}:thermal_generator`?100000:ENERGY.baseCapacity);
}
function capacity() {
  return registry().filter(m=>GENERATOR_TYPES.has(m.type)||BATTERIES[m.type])
    .reduce((sum,m)=>sum+generatorBaseCapacity(m.type),0);
}
function bar(cur, max) { return `${Math.max(0, Math.min(100, Math.floor(100 * cur / (max || 1))))}%`; }
function energyLine() { return `蓄電  ${energy().toLocaleString("en-US")} / ${capacity().toLocaleString("en-US")} SE`; }
const inv = (p) => p.getComponent("minecraft:inventory")?.container;
function countItem(p, id) { const c = inv(p); if (!c) return 0; let n = 0; for (let i = 0; i < c.size; i++) { const it = c.getItem(i); if (it?.typeId === id) n += it.amount; } return n; }
function removeItems(p, id, amount) { const c = inv(p); if (!c || countItem(p, id) < amount) return false; let left = amount;
  for (let i = 0; i < c.size && left > 0; i++) { const it = c.getItem(i); if (it?.typeId !== id) continue; const take = Math.min(left, it.amount); const remaining = it.amount - take; left -= take; if (remaining > 0) { it.amount = remaining; c.setItem(i, it); } else c.setItem(i, undefined); } return left === 0; }
function giveItems(p, id, amount) {
  const c = inv(p);
  const max = new ItemStack(id).maxAmount;
  for (let left = amount; left > 0;) {
    const n = Math.min(max, left);
    const stack = new ItemStack(id, n);
    const rest = c ? c.addItem(stack) : stack;
    if (rest) p.dimension.spawnItem(rest, p.location);
    left -= n;
  }
}
const foundryNames={...Object.fromEntries(FOUNDRY_COMPONENTS.map(c=>[c.id,c.name])),starforge_chip:"星炉認証チップ"};
const nameOf = (id) => { const short = id.replace(`${NS}:`, "").replace("minecraft:", "");
  const names = {"raw_uranium":"ウラン原鉱","uranium_ingot":"ウランインゴット","uranium_fuel":"ウラン燃料棒","depleted_uranium_fuel":"使用済み燃料棒","science_automation":"緑パック","science_chemical":"青パック","science_aerospace":"紫パック","processing_unit":"高度制御ユニット","science_mechanical":"機械サイエンスパック","research_lab":"研究所","silicon": "シリコン", "sulfur": "硫黄", "crude_oil": "原油", "refined_fuel": "精製燃料", "factory_rifle":"工廠ライフル","factory_shotgun":"工廠ショットガン","orbital_railgun":"軌道レールガン", "crushed_iron": "粉砕鉄鉱", "raw_nickel": "粗ニッケル", "nickel_ingot": "ニッケルインゴット", "raw_bauxite": "ボーキサイト", "aluminum_plate": "アルミ板", "heat_alloy": "耐熱合金", "steel_ingot": "鋼インゴット", "steel_plate": "鋼板", "gear": "歯車", "bearing": "軸受", "motor": "モーター", "copper_wire": "銅線", "basic_circuit": "基礎回路", "control_board": "制御基板", "resin": "樹脂", "lubricant": "潤滑油", "rocket_fuel": "ロケット燃料", "drive_component": "駆動部品", "dense_alloy": "高密度合金", "precision_drive": "精密駆動部品", "extension_tube": "拡張チューブ", "storage_cell": "蓄電セル", "military_control_core": "軍用制御核", "orbital_coordinate_data": "軌道座標データ", "meteor_iron": "隕鉄", "orbital_crystal": "軌道結晶", "iridium": "イリジウム", "vacuum_ice": "真空氷", "phase_stone": "位相石", "singularity_core": "特異炉心", "enhancement_core": "強化コア", "solar_cell": "太陽電池", "quarry_marker": "掘削マーカー", "rocket_body_section": "ロケット機体区画", "guidance_device": "誘導装置", "activation_core": "起動核", "guide_book": "工廠ガイド", "wrench": "整備レンチ", "coal_generator": "石炭発電機", "fixed_drill": "固定ドリル", "crusher": "粉砕機", "washer": "洗浄機", "electric_furnace": "電気炉", "alloy_furnace": "合金炉", "press": "プレス機", "wire_mill": "製線機", "assembler": "組立機", "research_terminal": "研究端末", "battery": "蓄電池 Mk I", "battery_mk2": "蓄電池 Mk II", "battery_mk3": "蓄電池 Mk III", "conveyor_1": "ベルト Mk1", "launch_pad": "発射台", "landing_pad": "着陸台", "sulfur_ore": "硫黄鉱石", "nickel_ore": "ニッケル鉱石", "bauxite_ore": "ボーキサイト鉱石"};
  const vanilla = { cobblestone:"丸石",stick:"棒",stone_pickaxe:"石のツルハシ",oak_planks:"オークの板材", iron_ingot:"鉄インゴット", coal:"石炭", charcoal:"木炭", coal_block:"石炭ブロック", blaze_rod:"ブレイズロッド", copper_ingot:"銅インゴット", sand:"砂", redstone:"レッドストーン", raw_iron:"鉄の原石", raw_copper:"銅の原石", raw_gold:"金の原石", lapis_lazuli:"ラピスラズリ", diamond:"ダイヤモンド", emerald:"エメラルド", gold_ingot:"金インゴット", netherite_scrap:"ネザライトの欠片", quartz:"ネザークォーツ", gold_nugget:"金塊", ancient_debris:"古代の残骸", glass:"ガラス", stone:"石", piston:"ピストン", furnace:"かまど", blast_furnace:"溶鉱炉", bucket:"バケツ", paper:"紙", book:"本", compass:"コンパス", diamond_pickaxe:"ダイヤのツルハシ", oak_log:"オークの原木", ...Object.fromEntries(LOG_VARIANTS), chest:"チェスト", railgun_round:"レールガン弾", shotgun_shell:"ショットガン弾", industrial_ammo:"工業弾薬", repair_kit:"補修キット", military_control_core:"軍用制御核", yellow_dye:"黄色の染料", quarry_marker:"掘削マーカー", clay_ball:"粘土玉", dirt:"土", gravel:"砂利", red_sand:"赤い砂", granite:"花崗岩", diorite:"閃緑岩", andesite:"安山岩", tuff:"凝灰岩", calcite:"方解石", dripstone_block:"鍾乳石ブロック", cobbled_deepslate:"深層岩の丸石", coarse_dirt:"粗い土", dirt_with_roots:"根付いた土", mud:"泥", moss_block:"苔ブロック", sandstone:"砂岩", red_sandstone:"赤い砂岩", slime_ball:"スライムボール" };
  return MACHINES[id]?.name ?? foundryNames[short] ?? ORE_NAMES[id] ?? names[short] ?? vanilla[short] ?? short; };
const iconOf = (id) => ITEM_ICON_OVERRIDE[id] ?? (id.startsWith(NS) ? `textures/items/${id.split(":")[1]}` : undefined);
function toast(p, msg) { try { p.onScreenDisplay.setActionBar(msg); } catch {} try { p.playSound("random.orb", { volume: 0.4, pitch: 1.2 }); } catch {} }

// ---------- UI 共通 ----------
function header(_title, sub) { return sub; }
const FORM_MARKER = "§r§r§r";
// grid=true でアイテム格子の画面 (RP server_form の of_grid_panel) を使う
function createForm(grid) {
  const form = new ActionFormData();
  return {
    title(t) { form.title(FORM_MARKER + (grid === true ? "§s§t" : "") + cleanText(t)); return this; },
    body(t) { form.body(cleanText(t)); return this; },
    button(t, icon) { form.button(cleanText(t), icon ?? ""); return this; },
    button1(t) { return this.button(t); },
    button2(t) { return this.button(t); },
    show(p) { return form.show(p); },
  };
}
function cleanText(t) { return t.replace(/§[0-9a-z]/gi, ""); }
function sameMachine(block, type) {
  try { return block.typeId === type; } catch { return false; }
}



// ---------- 実績クエスト (実績風UI: 次にやることを示し、達成で次の助けになる報酬) ----------
// 状態はプレイヤーごとに保存 (チーム共有の進行とは別に、各人が報酬を1回ずつ受け取れる)
const pGet = (p, k, fb) => { try { const v = p.getDynamicProperty(k); return v === undefined ? fb : v; } catch { return fb; } };
const pSet = (p, k, v) => { try { p.setDynamicProperty(k, v); } catch {} };
const claimedOf = (p) => { try { return JSON.parse(pGet(p, "of:quests", "[]")); } catch { return []; } };
const counterOf = (p, key) => Number(pGet(p, "of:q_" + key, 0));
function bumpCounter(p, key, by) { pSet(p, "of:q_" + key, counterOf(p, key) + by); }
function questProgress(p, q) {
  const c = q.cond;
  if (c.kind === "have") { const cur = countItem(p, c.item); return { cur, target: c.n, done: cur >= c.n }; }
  if (c.kind === "place") { const done = registry().some(m => m.type === c.block); return { cur: done ? 1 : 0, target: 1, done }; }
  if (c.kind === "energy") { const cur = energy(); return { cur, target: c.n, done: cur >= c.n }; }
  if (c.kind === "counter") { const cur = c.key === "processed" ? Number(dpGet("of:total_processed", 0)) : counterOf(p, c.key); return { cur, target: c.n, done: cur >= c.n }; }
  return { cur: 0, target: 1, done: false };
}
const questIcon = (q) => q.icon === "coal_generator" || q.icon === "fixed_drill" || q.icon === "research_terminal" || q.icon === "battery" || q.icon === "assembler" ? `textures/blocks/${q.icon}` : `textures/items/${q.icon}`;
const rewardText = (q) => q.reward.map(([i, n]) => `${nameOf(i)} ×${n}`).join(" / ");
function currentQuest(p) { const claimed = claimedOf(p); return QUESTS.find(q => !claimed.includes(q.id)); }

const QUEST_PATHS = [
  ["蒸気・電力", "battery", ["guide", "generator", "steam100", "battery"]],
  ["製鉄・採掘", "fixed_drill", ["steel", "plate", "drill", "drill_first", "process10"]],
  ["回路・組立", "assembler", ["wire", "circuit", "board", "motor", "terminal"]],
  ["打ち上げ準備", "launch_pad", ["rocket_prep", "guidance"]],
];
async function showQuests(p) {
  const claimed = claimedOf(p);
  const cur = currentQuest(p);
  const form = createForm().title("実績クエスト").body(
    `受取済み ${claimed.length} / ${QUESTS.length}${cur ? "\n次の目標  " + cur.title : ""}`);
  for (const [name, icon, ids] of QUEST_PATHS) {
    form.button(`${name}    ${ids.filter(id => claimed.includes(id)).length} / ${ids.length}`, `textures/blocks/${icon}`);
  }
  const r = await form.show(p);
  if (!r.canceled && QUEST_PATHS[r.selection]) return showQuestPath(p, r.selection);
}
async function showQuestPath(p, index) {
  const [name, , ids] = QUEST_PATHS[index];
  const claimed = claimedOf(p);
  const quests = ids.map(id => QUESTS.find(q => q.id === id));
  const form = createForm().title(name).body(quests.map(q => q.title).join(" > "));
  for (const q of quests) {
    const pr = questProgress(p, q);
    const state = claimed.includes(q.id) ? "受取済み" : pr.done ? "報酬あり" : `${Math.min(pr.cur, pr.target)} / ${pr.target}`;
    form.button(`${q.title}    ${state}`, questIcon(q));
  }
  form.button("実績一覧へ");
  const r = await form.show(p);
  if (r.canceled) return;
  if (r.selection === quests.length) return showQuests(p);
  if (quests[r.selection]) return showQuestDetail(p, quests[r.selection]);
}
async function showQuestDetail(p, q) {
  const claimed = claimedOf(p); const isClaimed = claimed.includes(q.id); const pr = questProgress(p, q);
  const form = createForm().title(`§6§l${q.title}§r`)
    .body(header(q.title,
      `§e目標§r  §f${q.desc}§r\n§e進み具合§r  ${bar(Math.min(pr.cur, pr.target), pr.target)}  §f${Math.min(pr.cur, pr.target)} / ${pr.target}§r\n\n§eやり方§r\n§f${q.hint}§r\n\n§e報酬§r  §f${rewardText(q)}§r  ${isClaimed ? "§a(受取済み)§r" : pr.done ? "§a(今すぐ受け取れます)§r" : "§7(達成で受取可能)§r"}`));
  if (!isClaimed && pr.done) form.button("§a報酬を受け取る§r", questIcon(q));
  form.button("§eクエスト一覧へ§r", "textures/items/guide_book"); form.button("§7閉じる§r");
  const r = await form.show(p); if (r.canceled) return;
  let idx = r.selection;
  if (!isClaimed && pr.done) {
    if (idx === 0) {
      // 二重受取防止: 受取直前に再判定してから確定する
      if (claimedOf(p).includes(q.id)) { toast(p, "§7この報酬は受取済みです"); return showQuests(p); }
      if (!questProgress(p, q).done) return showQuestDetail(p, q);
      for (const [id, n] of q.reward) giveItems(p, id, n);
      pSet(p, "of:quests", JSON.stringify([...claimedOf(p), q.id]));
      try { p.playSound("random.levelup", { volume: 0.6 }); } catch {}
      toast(p, `§a報酬を受け取りました: ${rewardText(q)}`);
      const next = currentQuest(p);
      if (next) { const npr = questProgress(p, next); toast(p, `§e> 次のクエスト: ${next.title} - ${next.desc}`); }
      return showQuests(p);
    }
    idx--;
  }
  if (idx === 0) return showQuests(p);
}

// 研究端末 / ガイド: 進行をバーと次の目標で見せる
async function showProgress(p) {
  let cur = playerStage(p);
  // 序盤の目標は所持品を目安に表示し、初号機以降は本人の実績で進める。
  while (cur < 2 && countItem(p, STAGES[cur].keyItem) > 0) cur++;
  const s = STAGES[Math.min(cur, STAGES.length - 1)];
  const form = createForm()
    .title("工場管理")
    .body(header("軌道工廠 - 進行状況",
      `§e現在の段階§r  §f${s.id} ${s.name}§r\n§7(${Math.min(cur + 1, STAGES.length)}/${STAGES.length})\n\n§e次の目標§r\n§f${s.goal}§r\n\n§e鍵になる素材§r  §f${s.keyLabel}§r  所持 §a${countItem(p, s.keyItem)}§r 個\n\n${energyLine()}`))
    .button("§6§l実績クエスト§r\n§7次にやることと報酬", "textures/items/guide_book")
    .button("§aガイドを開く§r\n§7進め方・機械・レシピ", "textures/items/basic_circuit")
    .button("§e機械レシピ一覧§r\n§7全加工レシピと必要素材", "textures/items/gear")
    .button("§7閉じる§r");
  form.button("地上作戦とオーバーシア","textures/items/activation_core");
  const flight=playerFlight(p)??legacyRocketFlights()[0];
  if (flight) form.button("ロケット運航状況", "textures/blocks/landing_pad");
  const drillButton=flight?6:5;
  form.button("遠隔採掘状況","textures/blocks/fixed_drill");
  form.button("研究の始め方","textures/blocks/research_lab");
  form.button("技術ツリーを開く","textures/items/science_mechanical");
  const r = await form.show(p); if (r.canceled) return;
  if (r.selection === 0) return showQuests(p);
  if (r.selection === 1) return showGuide(p, 0);
  if (r.selection === 2) return showRecipeBook(p);
  if (r.selection === 4) return expansion.operations(p);
  if (r.selection === drillButton) return showRemoteDrills(p);
  if (r.selection === drillButton+1) return showResearchGuide(p);
  if (r.selection === drillButton+2) return showResearchTree(p);
  if (r.selection === 5 && drillButton===6) return showRocket(p);
}
async function showRemoteDrills(p) {
  const drills=expansion.remoteDrills().filter(row=>row.snapshot);
  const page=drills.slice(0,20);
  const lines=page.map(({m,snapshot,remaining,reason,power})=>{
    const rate=reason==="採掘中"?15:0;
    const possible=Math.floor(power/ENERGY.drillPerBlock);
    const prediction=!rate?"待機中のため未計算":possible<remaining
      ? `現在の蓄電で残り約${remaining-possible}個`
      : `枯渇まで稼働約${Math.ceil(remaining/15)}分`;
    return `${nameOf(snapshot.item)}｜${remaining?remaining+"個":"枯渇済み"}\n${m.dim} ${m.x}, ${m.y}, ${m.z}｜${reason}｜毎分${rate}個\n${prediction}`;
  });
  const form=createForm().title("遠隔採掘状況").body(lines.join("\n\n")||"鉱床の上で固定ドリルを稼働させると表示されます。")
    .button("表示を更新").button("戻る");
  const response=await form.show(p);
  if(response.canceled)return;
  if(response.selection===0)return showRemoteDrills(p);
  if(response.selection===1)return showProgress(p);
}

async function showGuide(p, page) {
  const pages = [
    ["はじめに", "木材と丸石で石炭発電機、固定ドリル、送電ケーブルを作ろう。\n\n発電機に石炭を入れると §e蒸気エネルギー (SE)§r が貯まる。機械はこの電力で動く。\n電力が足りないときは、機械の画面に §c理由§r がそのまま表示される。"],
    ["機械の使い方", "機械を §eタップ / 右クリック§r すると画面が開く。\n\n§a緑のボタン§r = 今すぐ作れる\n§c赤い表示§r = 素材か電力が不足 (不足数が数字で出る)\n\n加工が終わると §e「受け取る」§r が一番上に出る。受け取るまで次の加工は始まらない。"],
    ["掘削 - 加工 - 搬送", "§e固定ドリル§r は真下の鉱脈を自動で掘る (4秒に1個、電力10 SE/個)。\n掘った素材はドリルの中に貯まるので、画面から受け取る。\n\n§e粉砕機§r - 粉砕した原石は製錬で2倍になる下処理に対応。\n§e合金炉§r で鋼、§eプレス§r で板、§e組立機§r で回路と部品を作る。"],
    ["進行 T0 - T5", STAGES.map(s => `§e${s.id} ${s.name}§r\n§7${s.goal}`).join("\n")],
    ["鉱石の増産","原鉱を一度だけ加工して収量を増やせます。粉砕機は2倍、洗浄機は3倍、高度選鉱機は5倍です。\n高度選鉱機は石油火力と精密生産の後、高度選鉱を研究して製作できます。\n石炭や宝石などの未処理鉱は鉱床から採掘し、作業台で等倍の素材にもできます。\n未処理石炭の粉砕（石炭2倍）は金属加工の研究で解禁されます。"],
    ["液体と石油", "揚水ポンプを水源に隣接させて給電。1000 mB/秒で水を汲み出します。\n液体パイプは右クリックで水・原油・精製燃料を選び、同じ種類を接続します。上下6面に対応。\n原油ポンプに水と石炭を投入すると原油が生産され、精製機で精製燃料と樹脂になります。水バケツは不要です。\nタンクは64000 mB。入れ物と配管の液種を合わせてください。"],
    ["倍速と太陽光", `機械の速度は、機械をしゃがみ＋右クリックしたメニューの「速度上限を切り替える」で変えます。整備レンチはベルトの向きを変えるときだけ使います。加工機は電力が足りなければ上限より低い速度で動きます。\n全自動栽培槽は Mk I が1株、Mk II が16株、Mk III が64株。同じ種・苗を複数セットできます。\n太陽光発電機は高度素材の設備一覧から製作します。集光型は石油火力の設備一覧から、攻城制御核を使って製作します。どちらも空の下で昼間に発電します。通常型は${SOLAR[NS + ":solar_generator"].rate} SE/秒、集光型は${SOLAR[NS + ":solar_concentrator"].rate} SE/秒です。`],
    ["石油火力と原子力", "化学工業の次に石油火力を研究。原油400 mB/秒または精製燃料200 mB/秒で2000 SE/秒。\n原子力を研究するとウラン原鉱を電気炉で精錬し、組立機で燃料棒を作れます。\n原子炉を3×3×3の石レンガ20個・各面中央のガラス6個で囲み、外壁へ配管・電線を接続。10000度まで約200000 SEで昇温後、燃料棒1本20分・12000 SE/秒。冷却水500 mB/秒が必要です。\n冷却水が切れ20000度になると半径50の爆発。汚染はワールド稼働時間で30分続きます。停止後も冷却水を切らさないでください。"],
    ["軌道便", `初号機の貨物は着陸台で荷下ろしします。荷下ろし後、機体は発射台へ戻ります。軌道産業を研究し、軌道ターミナルで行き先を指定。発射台を右クリックして行き先を確認し、発射します。帰還したら着陸台で荷下ろししてください。1便にロケット燃料12個（足りなければ真空氷4個）と発射台の電力${ROCKET1.launchEnergy} SE。飛行時間はワールドが動いている間だけ進みます。\n\n§e隕石帯§r 隕鉄・軌道結晶\n§e氷小惑星§r 真空氷・イリジウム\n§e深宇宙§r 相転移石・軌道結晶\n\n真空氷は軌道便の推進剤に、イリジウムは軌道レールガンなどの設備製作に使います。`],
    ["軌道工廠の完成","軌道ターミナルで建設計画を開き、組立機で作った部品とオーバーシアの特異炉心を投入します。\n建設便を発射して着陸台で搬入完了を確認。次に、送電ケーブルをつないだ軌道ターミナルで500,000 SEを使い工廠を起動します。\n完成後は軌道ターミナルから定期便を選び、着陸台で荷物を受け取れます。"],
    ["星炉外骨格と四連自律砲","本編クリア後に着陸台で星炉認証チップを5枚受け取れます。作業台のレシピブックから、外骨格の各部位と自律砲を製作できます。\n一式を着た状態でジャンプを2回押すと飛行を切り替えます。ジャンプで上昇、しゃがみで下降します。\n自律砲モジュールを使うと展開・格納。展開中は左クリックでHUDに表示されている敵や頭部をロックします。照準を合わせる必要はありません。ロックした部位が壊れたら、HUDに出る次の部位を左クリックで固定できます。しゃがんで使うと防護フィールド、長押しでチャージ砲撃です。チャージ砲は射程110ブロックで、照準から30度以内の敵に命中します。"],
    ["倉庫と大規模掘削", "§e工業保管§rを研究すると工業コンテナ Mk I（1品目を4,096個）、§e大規模掘削§rでチャンクデストロイヤー Mk I と工業コンテナ Mk II（32,768個）を設備製作で作れます。\n\nコンテナは複数の品目をまとめて保管し（容量は合計個数）、6面どこからでもベルト・機械と出し入れできます。上に浮かぶ看板に、多い順に4品目のアイコンが出ます。中身があるうちは回収できません。\n\nチャンクデストロイヤーを置くと、掘削エリアが青緑と黒の線で常に表示されます（Mk I 1×1・Mk II 2×2・Mk III 4×4チャンク、本体の正面の奥）。§e掘削マーカー§rを置いて本体の画面で登録すると、そのチャンクを本体側の角にしてエリアが奥へ広がります（マーカーが効く距離は Mk I 4・Mk II 8・Mk III 16チャンク以内。自分で置いたマーカーを自分の掘削機にだけ登録可）。画面の「エリアを掘削開始」でエリア全体を順番に掘り、全部終わると登録したマーカーを自動で回収してバッファに入れます。1チャンクずつ選ぶ「範囲を測量」も使えます。開始すると境界上にガントリーが組まれ、ドリル頭が層ごとに走査して岩盤まで掘り下げます。1,200 SE/秒・基準深度128で約15分。\n\n§e廃棄フィルター§rで石系・深層岩系・土系・砂系をゴミ箱へ送ると、鉱石と鉱床の資源だけが搬出されます。バッファ512個が満杯・電力不足・未読込のときは、その場で止まって同じ位置から再開します。\n\n§e軌道掘削§r（着陸台で軌道便の貨物を1回回収すると研究可能）で Mk II（2倍速・予約4件）と軌道コンテナ Mk III（262,144個）。§e特異点技術§r（オーバーシア討伐後）で Mk III（4倍速・予約16件）と特異点コンテナ（容量無限）。予約したチャンクは、今のチャンクが終わると自動で掘り始めます。ネザー・エンドでも使えます。"],
    ["工場防衛", "§e工場防衛§r（高度素材の後・赤緑各30）で防衛端末と機関砲塔 Mk I を設備製作、工業弾薬（鉄2・銅1・石炭1>16発）と補修キット（鋼板2・銅線2・樹脂1>2個）を組立機で作れます。\n\nレールガン砲塔とショットガン砲塔も設備製作で作れます。専用弾は組立機で製造。端末の24ブロック以内に砲塔を置くと自動で登録。ベルトやコンテナから弾薬を搬入できます。\n\n端末で作戦を開始すると30秒後に第1波。突撃機スクラッパーは端末を叩き、妨害機ジャマーは紫に光って砲塔を止めます（予告中に倒せば阻止）。補修キットで端末の耐久+25。3波を全滅させると軍用制御核2個。手持ちの武器はゲリラアドオンの銃・重火器を使ってください。"],
    ["持ち運べる蓄電池","送電ケーブル経由で発電機から充電し、機械に給電します。壊して回収しても残量を引き継ぎます。右クリックで自動・充電のみ・給電のみを切り替えられます。\n高度素材で Mk I（20,000 SE）、石油火力で Mk II（100,000 SE）、原子力で Mk III（500,000 SE）を製作できます。"],
    ["困ったとき","§c電力不足§r - 発電機に石炭を足す / 蓄電池を増やす\n§c素材不足§r - ボタンの数字が不足分。そのままドリルや前段の機械へ\n§c機械が開かない§r - 設置し直すと登録が作り直される\n§cガイドを失くした§r - 作業台で本+紙から再作成できる"],
  ];
  const [t, body] = pages[page];
  const form = createForm().title("§6§l工廠ガイド§r").body(header(`ガイド - ${t}`, `§f${body}§r\n\n§8${page + 1} / ${pages.length} ページ§r`));
  if (page > 0) form.button("§7前のページ§r");
  if (page < pages.length - 1) form.button("§a次のページ >§r");
  form.button("§e進行状況へ§r", "textures/blocks/research_terminal"); form.button("§7閉じる§r");
  const r = await form.show(p); if (r.canceled) return;
  let idx = r.selection;
  if (page > 0) { if (idx === 0) return showGuide(p, page - 1); idx--; }
  if (page < pages.length - 1) { if (idx === 0) return showGuide(p, page + 1); idx--; }
  if (idx === 0) return showProgress(p);
}
async function showRecipeBook(player) {
  return showRecipeTree(player,orderedRecipes(PROCESS_RECIPES.filter(recipe=>!recipe.variantOf)),"加工レシピ");
}
async function showRecipeTree(player,recipes,title,block,key){
  const form=new ActionFormData().title(title).body("作りたい品目を選んで作り方を確認できます。");
  for(const recipe of recipes)form.button(recipe.label+"\n"+(recipe.id==="science_mechanical"?"作業台 / 組立機":nameOf(`${NS}:${recipe.machine}`)),`textures/items/${recipe.icon}`);
  form.button("設備一覧へ").button("研究ツリーへ").button("閉じる");
  const result=await form.show(player);if(result.canceled)return;
  if(result.selection===recipes.length)return showEquipmentCatalog(player,block,key);
  if(result.selection===recipes.length+1)return showResearchTree(player,block,key);
  const recipe=recipes[result.selection];if(!recipe)return;
  const required=[...new Set([EQUIPMENT_TECH[recipe.machine],RECIPE_TECH[recipe.id]].filter(Boolean))];
  const ingredients=recipe.in.map(([id,n])=>nameOf(id)+" ×"+n).concat((recipe.fluidsIn??[]).map(([id,n])=>FLUID_NAMES[id]+" "+n+" mB"));
  const products=recipe.out.map(([id,n])=>nameOf(id)+" ×"+n).concat((recipe.fluidsOut??[]).map(([id,n])=>FLUID_NAMES[id]+" "+n+" mB"));
  const detail=new ActionFormData().title(recipe.label+"の作り方").body("設備 "+(recipe.id==="science_mechanical"?"作業台（序盤） / 組立機（自動化後）":nameOf(`${NS}:${recipe.machine}`))+"\n"+(required.length?"必要研究 "+required.map(id=>research.technology(id).name).join("・"):"最初から作成可能")+"\n\n材料\n"+ingredients.join("\n")+"\n\n完成品\n"+products.join("\n")+`\n\n${recipe.sec}秒 · ${recipe.energy} SE / 回`+(recipe.note?"\n\n"+recipe.note:""))
    .button("レシピ一覧へ戻る").button("設備一覧へ").button("研究ツリーへ");
  const selected=await detail.show(player);if(selected.canceled)return;
  if(selected.selection===1)return showEquipmentCatalog(player,block,key);
  if(selected.selection===2)return showResearchTree(player,block,key);
  return showRecipeTree(player,recipes,title,block,key);
}

// ---------- 機械フォーム ----------
const MACHINE_PURPOSES = {
  crusher:"原鉱の収量を2倍にし、原木から樹脂も取り出します。",
  washer:"水と電力を使って原鉱の収量を3倍にします。",
  ore_beneficiator:"水と電力を使って原鉱の収量を5倍にします。",
  alloy_furnace:"金属と副材料を合わせて、鋼や耐熱合金を作ります。",
  press:"金属を板材に加工します。",
  wire_mill:"銅インゴットを銅線に加工します。",
  electric_furnace:"砂からシリコンを作り、ニッケルやウランを精錬します。",
  assembler:"素材を組み合わせて、部品・研究パック・弾薬・宇宙用の資材を作ります。",
  refinery:"原油を精製燃料と樹脂に加工します。液体は配管で出し入れします。",
};
const ASSEMBLY_CATEGORIES = [
  ["部品・中間素材", ["gear","bearing","motor","basic_circuit","control_board","drive_component","storage_cell","processing_unit","solar_cell"]],
  ["サイエンスパック", ["science_mechanical","science_automation","science_chemical","science_aerospace"]],
  ["防衛・弾薬", ["industrial_ammo","repair_kit","railgun_round","shotgun_shell"]],
  ["発電・ロケット・宇宙", ["uranium_fuel","rocket_body_section","guidance_device","rocket_fuel","rocket_fuel_refined","activation_core",...FOUNDRY_COMPONENTS.map(c=>c.id)]],
];
const recipeOutput = recipe => [
  ...recipe.out.map(([id,n])=>`${nameOf(id)} ×${n}`),
  ...(recipe.fluidsOut??[]).map(([id,n])=>`${FLUID_NAMES[id]} ${n.toLocaleString()} mB`),
].join(" + ");
function operatingSpeedInfo(block,key,limit) {
  const type=block.typeId, short=type.split(":")[1];
  if(FLUID_DEVICES.has(type))return operatingRates(short,fluidSystem.state({key,type}),limit);
  if(short==="fixed_drill")return `最大 ${limit/4}個/秒 · ${ENERGY.drillPerBlock*limit} SE/個`;
  if(short==="research_lab")return `研究1回 ${4/limit}秒 · ${15*limit} SE/回`;
  if(short==="coal_generator")return `最大発電 ${10*limit} SE/秒（燃料の消費ペースも${limit}倍）`;
  if(short==="launch_pad")return `飛行時間 1/${limit} · 発射電力 ${ROCKET1.launchEnergy*limit} SE`;
  if(PROCESSOR_IDS.has(type))return "上限に達すると加工時間は1/"+limit+"、1回の消費SEは"+limit+"倍です。稼働中の加工には次の回から適用されます。";
  return "";
}
function visualSpeed(machine,state) {
  if(FLUID_DEVICES.has(machine.type))return fluidSystem.state(machine).actualSpeed||1;
  if(machine.type===`${NS}:research_lab`)return labActiveSpeed.get(machine.key)??1;
  if(machine.type===`${NS}:launch_pad`||machine.type===`${NS}:landing_pad`)return rocketFlights().find(f=>(machine.type===launchPadType?f.key:f.landing)===machine.key)?.speed??1;
  return state.job?.speed??1;
}
// しゃがみ＋右クリックで開く機械のメニュー
async function showMachineHub(player,block,key) {
  const type=block.typeId, limit=speedLimit(key), hasStock=SLOT_MACHINES.has(type);
  const form=new ActionFormData().title(MACHINES[type].name)
    .body([`速度上限 ${limit}倍`,operatingSpeedInfo(block,key,limit)].filter(Boolean).join("\n"))
    .button("詳細画面を開く").button(`速度上限を切り替える（現在 ${limit}倍）\n§7押すたびに 1倍・2倍・4倍・8倍`);
  if(hasStock)form.button("機械の在庫・取り出し");
  form.button("閉じる");
  const r=await form.show(player);
  if(r.canceled||!sameMachine(block,type))return;
  if(r.selection===0)return system.run(()=>tryOpenMachine(player,block,true,true));
  if(r.selection===1){switchSpeed(key);return showMachineHub(player,block,key);}
  if(hasStock&&r.selection===2)return showMachineStock(player,block,key,showMachineHub);
}
async function showOperatingSpeed(player,block,key) {
  const type=block.typeId, limit=speedLimit(key);
  const form=new ActionFormData().title(MACHINES[type].name+"の倍速設定")
    .body([`速度上限 ${limit}倍`,operatingSpeedInfo(block,key,limit),"1倍、2倍、4倍、8倍を順に切り替えます。"].filter(Boolean).join("\n"))
    .button(`速度上限を切り替える（現在 ${limit}倍）`);
  const hasStock=SLOT_MACHINES.has(type);
  if(hasStock)form.button("機械の在庫・取り出し");
  form.button("閉じる");
  const result=await form.show(player);
  if(result.canceled||!sameMachine(block,type))return;
  if(result.selection===0){switchSpeed(key);return showOperatingSpeed(player,block,key);}
  if(hasStock&&result.selection===1)return showMachineStock(player,block,key,showOperatingSpeed);
}

const recipeChoice = recipe => recipe.id === "rocket_fuel_refined" ? "ロケット燃料 ×8（精製燃料）"
  : recipe.id === "rocket_fuel" ? "ロケット燃料 ×4（石炭）" : recipeOutput(recipe);

function machineIdleStatus(m,recipe,storage) {
  if(!recipe || !storage) return "待機中 · 材料と電力がそろうと開始";
  if(!research.allowsRecipe(recipe,m)) return "待機中 · このレシピは未研究";
  const variants=PROCESS_RECIPES.filter(r=>r.variantOf===recipe.id);
  if(![recipe,...variants].some(r=>r.in.every(([id,n])=>countSlots(storage,id)>=n)))
    return "材料待ち · レシピ詳細で必要数を確認";
  const tanks=fluidSystem.state(m);
  const missing=recipe.fluidsIn?.find(([id,n])=>(tanks[id]??0)<n);
  if(missing) return `液体待ち · ${FLUID_NAMES[missing[0]]}を配管で供給`;
  if(!fluidSystem.availableRecipe(m,recipe)) return "搬出待ち · 配管とタンクの空きを確認";
  const missingPower=recipe.energy-expansion.availablePower(m.key);
  return missingPower>0 ? `電力待ち · あと ${missingPower.toLocaleString()} SE` : "生産準備完了";
}
async function showMachineControl(player,block,key) {
  const type=block.typeId, state=machineState(key);
  const storage=machineContainer(block,key);
  const recipe=PROCESS_RECIPES.find(r=>r.id===state.selectedRecipe && `${NS}:${r.machine}`===type);
  const job=state.job, now=Date.now();
  const m={key,type,...block.location,dim:block.dimension.id};
  const status=job ? (job.readyAt>now ? `加工中 · ${job.label} · 残り${Math.ceil((job.readyAt-now)/1000)}秒` : `搬出待ち · ${job.label}`)
    : machineIdleStatus(m,recipe,storage);
  const details=fluidSystem.describe(m);
  const form=new ActionFormData().title(MACHINES[type].name+"の生産設定")
    .body([MACHINE_PURPOSES[type.split(":").pop()], "", state.selectedRecipe && recipe ? "設定中 · "+recipeChoice(recipe) : "設定中 · 材料で自動選択",
      status, `速度上限 ${speedLimit(key)}倍${job?.speed ? " / 加工中 "+job.speed+"倍" : ""}`, details, "", "材料の投入・完成品の回収は「機械の在庫」から行えます。"].filter(line=>line!==undefined).join("\n"))
    .button("作れるもの・レシピ","textures/items/gear")
    .button("機械の在庫・取り出し")
    .button(`速度上限を切り替える（現在 ${speedLimit(key)}倍）`)
    .button("表示を更新").button("閉じる");
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,type) || !storage) return;
  if(result.selection===0) return showMachineRecipes(player,block,key);
  if(result.selection===1) return showMachineStock(player,block,key,showMachineControl);
  if(result.selection===2) switchSpeed(key);
  if(result.selection===2 || result.selection===3) return showMachineControl(player,block,key);
}

async function showMachineRecipes(player,block,key,category) {
  const type=block.typeId;
  const recipes=orderedRecipes(PROCESS_RECIPES.filter(recipe=>`${NS}:${recipe.machine}`===type && !recipe.variantOf));
  const state=machineState(key);
  const form=new ActionFormData().title(MACHINES[type].name+"のレシピ")
    .body("完成品を選ぶと材料・加工時間・消費電力が見られます。");
  const actions=[];
  if (type===ASSEMBLER && category===undefined) {
    const known=new Set(ASSEMBLY_CATEGORIES.flatMap(([,ids])=>ids));
    const groups=[...ASSEMBLY_CATEGORIES,["その他",recipes.filter(recipe=>!known.has(recipe.id)).map(recipe=>recipe.id)]];
    for(const [label,ids] of groups) {
      const group=recipes.filter(recipe=>ids.includes(recipe.id));
      if (!group.length) continue;
      form.button(label,`textures/items/${group[0].icon}`);
      actions.push(()=>showMachineRecipes(player,block,key,ids));
    }
  } else {
    for(const recipe of recipes.filter(recipe=>!category||category.includes(recipe.id))) {
      const status=!research.allowsRecipe(recipe,player)?"未研究":state.selectedRecipe===recipe.id?"設定中":"材料を見る";
      const title=status==="材料を見る"?recipeChoice(recipe):`${recipeChoice(recipe)}\n${status}`;
      form.button(title,`textures/items/${recipe.icon}`);
      actions.push(()=>showMachineRecipeDetail(player,block,key,recipe,category));
    }
  }
  if (category===undefined && state.selectedRecipe && recipes.length>1) {
    form.button("材料で自動選択に戻す");
    actions.push(()=>{
      const current=machineState(key);
      delete current.selectedRecipe;
      saveMachineState(key,current);
      ensureSlotHost(block,key);
      return showMachineControl(player,block,key);
    });
  }
  form.button("戻る");
  actions.push(()=>category===undefined?showMachineControl(player,block,key):showMachineRecipes(player,block,key));
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,type))return;
  return actions[result.selection]?.();
}

async function showMachineRecipeDetail(player,block,key,recipe,category) {
  const type=block.typeId;
  const m={key,type,...block.location,dim:block.dimension.id};
  const storage=machineContainer(block,key);
  if(!storage)return;
  const cost=processingCost(recipe,speedLimit(key));
  const variants=PROCESS_RECIPES.filter(r=>r.variantOf===recipe.id);
  const materials=recipe.in.map(([id,n])=>{
    if(variants.length) return `対応する原木（同じ種類） ×${n}`;
    return `${nameOf(id)}　機械内 ${countSlots(storage,id)} / 必要 ${n}`;
  });
  for(const [id,n] of recipe.fluidsIn??[]) materials.push(`${FLUID_NAMES[id]}　機械内 ${fluidSystem.state(m)[id]??0} / 必要 ${n} mB`);
  const unlocked=research.allowsRecipe(recipe,player);
  const tech=research.technology(RECIPE_TECH[recipe.id]);
  const text=[
    "完成品　"+recipeOutput(recipe), "",
    "材料", ...materials, "",
    `1倍速　${recipe.sec}秒 · ${recipe.energy} SE / 回`,
    `上限 ${cost.speed}倍　${cost.sec}秒 · ${cost.energy.toLocaleString()} SE / 回（足りなければ減速）`,
    `接続電力 ${expansion.availablePower(key).toLocaleString()} SE`,
    tech?`研究　${tech.name}（${unlocked?"解禁済み":"未解禁"}）`:undefined,
    variants.length?`対応原木　${[recipe,...variants].map(r=>nameOf(r.in[0][0])).join("・")}`:undefined,
    unlocked && machineState(key).job ? "加工中の品は完成し、その後新しいレシピが使われます。" : undefined,
  ].filter(line=>line!==undefined);
  const form=new ActionFormData().title("レシピ詳細").body(text.join("\n"));
  if(unlocked)form.button("このレシピで生産する",`textures/items/${recipe.icon}`);
  form.button("レシピ一覧へ戻る");
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,type))return;
  if(result.selection!==0 || !unlocked || !research.allowsRecipe(recipe,player))
    return showMachineRecipes(player,block,key,category);
  const current=machineState(key);
  current.selectedRecipe=recipe.id;
  saveMachineState(key,current);
  ensureSlotHost(block,key);
  return showMachineControl(player,block,key);
}
async function showMachineDeposit(player,block,key,back) {
  const type=block.typeId;
  const inventory=inv(player);
  const target=expansion.manualMachineInput(block,key);
  if(!inventory || !target)return showMachineStock(player,block,key,back);
  const entries=[];
  for(let slot=0;slot<inventory.size;slot++){
    const item=inventory.getItem(slot);
    if(item && !isGauge(item) && expansion.roomFor(target,item)>0) entries.push({slot,item});
  }
  const form=createForm().title(MACHINES[type].name+" · 材料を入れる")
    .body(entries.length?"持ち物の枠を選ぶと、入る分だけ移します。":"入れられる材料がないか、機械の空きがありません。");
  for(const {item} of entries) form.button(nameOf(item.typeId)+" ×"+item.amount,iconOf(item.typeId));
  form.button("在庫へ戻る");
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,type))return;
  const entry=entries[result.selection];
  if(entry){
    const current=inventory.getItem(entry.slot);
    const destination=expansion.manualMachineInput(block,key);
    if(destination && current?.typeId===entry.item.typeId){
      expansion.insertCargo(destination,current,left=>{
        const remainder=left ? current.clone() : undefined;
        if(remainder)remainder.amount=left;
        inventory.setItem(entry.slot,remainder);
      });
    }
    return showMachineDeposit(player,block,key,back);
  }
  return showMachineStock(player,block,key,back);
}
async function showMachineStock(player,block,key,back) {
  const type=block.typeId, storage=machineContainer(block,key);
  const entries=[];
  if(storage)for(let slot=0;slot<storage.size;slot++) {
    const item=storage.getItem(slot);
    if(item && !isGauge(item))entries.push({slot,item});
  }
  const water=[`${NS}:washer`,`${NS}:ore_beneficiator`].includes(type)
    ?"\n水　"+fluidSystem.amount({key,type},"water")+" mB":"";
  const form=createForm().title(MACHINES[type].name+" · 在庫")
    .body("接続電力　"+expansion.availablePower(key)+" SE"+water+"\n在庫の品目を選ぶと取り出せます。");
  for(const {slot,item} of entries) form.button(`${slot<18?"材料":"完成品"}　${nameOf(item.typeId)} ×${item.amount}`,iconOf(item.typeId));
  const acceptsInput=!!expansion.manualMachineInput(block,key);
  if(acceptsInput)form.button("材料・燃料を入れる");
  form.button(back?"戻る":"設定を開く").button("閉じる");
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,type))return;
  const entry=entries[result.selection];
  if(!entry){
    if(acceptsInput && result.selection===entries.length)return showMachineDeposit(player,block,key,back);
    if(result.selection===entries.length+Number(acceptsInput)){
      if(back)return back(player,block,key);
      return tryOpenMachine(player,block,true);
    }
    return;
  }
  const current=storage.getItem(entry.slot);
  if(current?.typeId===entry.item.typeId){
    storage.setItem(entry.slot,undefined);
    const inventory=inv(player);
    const remainder=inventory?inventory.addItem(current):current;
    if(remainder)player.dimension.spawnItem(remainder,player.location);
  }
  return showMachineStock(player,block,key,back);
}
async function showCoalGenerator(player,block,key) {
  const type=block.typeId;
  const record=generatorRecord(key);
  const burn=machineState(key).burn;
  const left=burn?Math.max(0,Math.ceil((burn.until-Date.now())/1000)):0;
  const form=createForm().title("石炭発電機 · 稼働状況")
    .body(`つないだ機械に電力を送ります。機械を通常どおり使って燃料を入れてください。

蓄電 ${record.stored} / ${generatorCapacity(key)} SE
`+
      (left?`燃焼中 · 残り ${left}秒`:burn?"蓄電の空き待ち":"燃料待ち") + "\n\n燃料1個あたり\n" +
      FUELS.map(([id,n])=>`${nameOf(id)}　+${n} SE`).join("\n"))
    .button("機械の在庫・取り出し").button(`速度上限を切り替える（現在 ${speedLimit(key)}倍）`).button("表示を更新").button("閉じる");
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,type))return;
  if(result.selection===0)return showMachineStock(player,block,key,showCoalGenerator);
  if(result.selection===1)switchSpeed(key);
  if(result.selection===1||result.selection===2)return showCoalGenerator(player,block,key);
}
const FUELS = [
  ["minecraft:coal", ENERGY.coal, "石炭", "coal"],
  ["minecraft:charcoal", ENERGY.charcoal, "木炭", "charcoal"],
  ["minecraft:coal_block", ENERGY.coalBlock, "石炭ブロック", "coal_block"],
  ["minecraft:blaze_rod", ENERGY.blazeRod, "ブレイズロッド", "blaze_rod"],
];
function settleGenerator(key, st) {
  const record=generatorRecord(key);
  if (st.burn && Date.now() >= st.burn.until && generatorCapacity(key) - record.stored >= st.burn.val) {
    record.stored+=st.burn.val;
    record.generated+=st.burn.val;
    saveGeneratorRecord(key,record);
    delete st.burn;
    saveMachineState(key, st);
  }
}
async function showDrill(p,block,st,key) {
  const running=st.running!==false;
  const {deposit,buffered,power,reason,speed}=expansion.drillStatus(block,key,st);
  const item=deposit?nameOf(deposit.item):"-";
  const legacy=Object.values(st.buffer??{}).reduce((sum,n)=>sum+n,0);
  const form=createForm().title("固定ドリル")
    .body(`状態：${reason}\n採掘品：${item}\n鉱床の残り：${deposit?deposit.remaining+"個":"-"}\n出力バッファ：${buffered} / 16個${legacy?"（旧版の貯蔵 "+legacy+"個）":""}\n接続中の発電機：${power} SE\n稼働速度 ${reason==="採掘中"?speed:0}倍\n上限 ${speedLimit(key)}倍で1個 / ${4/speedLimit(key)}秒・${10*speedLimit(key)} SE`)
    .button(running?"停止する":"稼働を開始する")
    .button("採掘品を回収する","textures/blocks/landing_pad")
    .button(`速度上限を切り替える（現在 ${speedLimit(key)}倍）`)
    .button("表示を更新")
    .button("閉じる");
  const response=await form.show(p);
  if (response.canceled || !sameMachine(block,`${NS}:fixed_drill`)) return;
  const current=machineState(key);
  if (response.selection===0) {
    if ((current.running!==false)===running) {
      current.running=!running;
      saveMachineState(key,current);
    }
  } else if (response.selection===1) {
    const container=machineContainer(block,key);
    let collected=0;
    if (container) for (let slot=18;slot<25;slot++) {
      const stack=container.getItem(slot);
      if (!stack) continue;
      container.setItem(slot,undefined);
      giveItems(p,stack.typeId,stack.amount);
      collected+=stack.amount;
    }
    for (const [type,count] of Object.entries(current.buffer??{})) {
      giveItems(p,type,count);collected+=count;
    }
    delete current.buffer;
    saveMachineState(key,current);
    if (collected) bumpCounter(p,"drill",collected);
  } else if(response.selection===2) switchSpeed(key);
  else if (response.selection!==3) return;
  return showDrill(p,block,machineState(key),key);
}
async function showSimple(player,block) {
  const key=keyOf(block.dimension.id,block.location);
  const stored=expansion.availablePower(key);
  const form=createForm().title(MACHINES[block.typeId].name+" · 状態")
    .body(`利用可能電力　${stored} SE\n\nケーブル・ベルトは上下を含む6面に接続できます。`)
    .button("表示を更新").button("工場の進行状況").button("閉じる");
  const result=await form.show(player);
  if(result.canceled || !sameMachine(block,block.typeId))return;
  if(result.selection===0)return showSimple(player,block);
  if(result.selection===1)return showProgress(player);
}

// ---------- 登録とイベント ----------
// Change the block in place. The slot host and processing job both use the position as their key.
function upgradeLegacyCrafter(block, key) {
  const state = machineState(key);
  const direction = block.permutation.getState("minecraft:cardinal_direction");
  block.setPermutation(BlockPermutation.resolve(ASSEMBLER, {"minecraft:cardinal_direction": direction}));
  state.selectedRecipe = "gear";
  saveMachineState(key, state);
  const list = registry();
  const existing = list.find(entry => entry.key === key);
  if (existing) existing.type = ASSEMBLER;
  else list.push({ key, type: ASSEMBLER, dim: block.dimension.id, ...block.location });
  saveRegistry(list);
}
const CREATIVE_DEBUG = new Set([`${NS}:creative_generator`, `${NS}:creative_fluid_source`]);
world.afterEvents.playerPlaceBlock.subscribe((ev) => { let t = ev.block.typeId; if (!MACHINES[t]) return;
  if(CREATIVE_DEBUG.has(t) && ev.player.getGameMode?.()!==GameMode.Creative) {
    ev.block.setType("minecraft:air");
    toast(ev.player,"デバッグ用設備はクリエイティブ専用です");
    return;
  }
  if(!research.allowsMachine(t,ev.player)) {
    ev.block.setType("minecraft:air");
    if(!(BULK_TYPES.has(t)&&bulkPack.refund(ev)) && ev.player.getGameMode?.()!==GameMode.Creative)giveItems(ev.player,t,1);
    toast(ev.player,"未解禁 · 研究ツリーで "+research.technology(EQUIPMENT_TECH[t.split(":").pop()]).name+" を研究してください");
    return;
  }
  const key = keyOf(ev.dimension.id, ev.block.location);
  if (t === LEGACY_CRAFTER) {
    upgradeLegacyCrafter(ev.block, key);
    t = ASSEMBLER;
  }
  if (expansion.isSplitter(t)) expansion.orientSplitter(ev.block, ev.player);
  try { expansion.orientBelt(ev.block, ev.player, key); } catch {}
  const list = registry();
  if (BATTERIES[t]) batteries.onPlace(ev,key);
  if (BULK_TYPES.has(t)) bulkPack.onPlace(ev,key);
  fluidSystem.forget({key});
  if (!list.some(m => m.key === key)) { list.push({ key, type: t, dim: ev.dimension.id, x: ev.block.location.x, y: ev.block.location.y, z: ev.block.location.z, owner: ev.player?.id }); saveRegistry(list); }
  try { ensureSlotHost(ev.block,key); } catch (err) { console.warn(String(err)); }
  system.run(() => { try { expansion.updateNetwork(registry()); } catch {} try { factoryLoader.refresh(); } catch {} });
});
world.afterEvents.playerBreakBlock.subscribe((ev) => { const t = ev.brokenBlockPermutation.type.id; if (!MACHINES[t]) return;
  const key = keyOf(ev.dimension.id, ev.block.location); activeFireSounds.delete(key); labActiveUntil.delete(key); labActiveSpeed.delete(key);
  if (BATTERIES[t]) {
    if(ev.player.getGameMode()!==GameMode.Creative || generatorRecord(key).stored>0){
      ev.dimension.spawnItem(batteries.recoveryItem(t,key),anchorOf(ev.block.location));
    }
    dpSet("of_g:"+key,undefined); lastGeneratorJson.delete(key);
  } else if (GENERATOR_TYPES.has(t)) {
    dpSet("of:energy",legacyEnergy()+generatorRecord(key).stored);
    dpSet("of_g:"+key,undefined); lastGeneratorJson.delete(key);
  }
  saveRegistry(registry().filter(m => m.key !== key));
  dpSet("of_speed:"+key,undefined);
  processorPoll.delete(key);
  system.run(()=>{try{factoryLoader.refresh();}catch{}});
  if(dpGet("of_mod:"+key,false)){
    dpSet("of_mod:"+key,undefined);
    try { ev.dimension.spawnItem(new ItemStack(`${NS}:siege_control_core`,1),anchorOf(ev.block.location)); } catch {}
  }
  try { removeSlotHost(ev.dimension,ev.block.location,key); } catch (err) { console.warn(String(err)); }
  if (QUARRY_TYPES.has(t)) quarry.forget(key,ev.dimension);
  if (GROWER_TIERS[t]) growing.forget(key);
  if (t===`${NS}:launch_pad` || t===`${NS}:landing_pad`) rocketScene.forget(key);
  if (t===DEF.terminal || TURRET_TYPES.has(t)) defense.forget(t,key,ev.dimension,ev.block.location);
  if (BULK_TYPES.has(t)) {
    // シュルカーボックスのように中身ごと落とす (空なら普通のコンテナ。クリエイティブで空のときは何も落とさない)
    try {
      const item=bulkPack.packItem(t,key);
      if(item && (ev.player?.getGameMode()!==GameMode.Creative || item.typeId!==t)) ev.dimension.spawnItem(item,anchorOf(ev.block.location));
    } catch (err) { console.warn("[Orbital Foundry] コンテナ回収: "+err); }
    bulkMachine.forget(key,ev.dimension,ev.block.location);
  }
  if (t===`${NS}:fixed_drill`) {
    const st=machineState(key);
    if (st.remotePending>0 && st.drillSnapshot?.item) {
      ev.dimension.spawnItem(new ItemStack(st.drillSnapshot.item,st.remotePending),anchorOf(ev.block.location));
    }
  }
  system.run(() => { try { expansion.updateNetwork(registry()); } catch {} });
  fluidSystem.forget({key});
  dpSet("of_m:" + key, undefined); lastMachineStateJson.delete(key); });
// 機械を開く処理は3経路 (前イベント/後イベント/レンチ使用) から同じ関数へ集約し、
// 800ms以内の重複発火は1回にまとめる (片方の経路が環境で発火しなくても開けるように)
const lastOpen = new Map();
const openMachineScreens = new Set();
const silentPlacementUntil=new Map();
function silentPlacement(p) {
 if(!p)return false;
 if(p.isSneaking&&[`${NS}:fluid_pipe`,`${NS}:conveyor_1`,`${NS}:conveyor_2`,`${NS}:conveyor_3`,`${NS}:power_cable`].includes(heldItemId(p))){silentPlacementUntil.set(p.id,system.currentTick+4);return true;}
 return (silentPlacementUntil.get(p.id)??-1)>=system.currentTick;
}
function tryOpenMachine(p, block, fromStock=false, detail=false) {
  if(silentPlacement(p))return;
  const shell=block&&reactorAtShell(world,registry(),block.dimension.id,block.location);
  if(shell)block=block.dimension.getBlock(shell);
  let t = block?.typeId; if (!t || !MACHINES[t] || !p) return;
  if(!research.allowsMachine(t,p)) {
    const tech=research.technology(EQUIPMENT_TECH[t.split(":").pop()]);
    toast(p,"未解禁 · "+tech.name+"を研究してください");
    showResearchDetail(p,tech.id).catch(console.warn);return;
  }
  const key = keyOf(block.dimension.id, block.location);
  const lk = p.id + ":" + key; const now = Date.now();
  if (!fromStock && now - (lastOpen.get(lk) ?? 0) < 800) return; lastOpen.set(lk, now);
  if (!fromStock && openMachineScreens.has(p.id)) return;
  if (t === LEGACY_CRAFTER) {
    upgradeLegacyCrafter(block, key);
    t = ASSEMBLER;
    expansion.updateNetwork(registry());
  }
  const list = registry();
  if (!list.some(m => m.key === key)) {
    const { x, y, z } = block.location;
    saveRegistry([...list, { key, type: t, dim: block.dimension.id, x, y, z, owner: p.id }]);
  }
  // しゃがみ＋右クリック: 詳細画面・倍速設定・在庫を選ぶ画面 (レンチは不要。レンチはベルトの向き変え専用)
  if (OVERDRIVE_TYPES.has(t) && p.isSneaking && !detail && !fromStock) {
    openMachineScreens.add(p.id);
    showMachineHub(p,block,key).catch(console.warn).finally(()=>openMachineScreens.delete(p.id));
    return;
  }
  if(shell){
    // 外殻を素手で右クリック: かまど風の画面は外殻の外に張り出した受け皿から開く。しゃがみ右クリックで詳細画面
    if(!p.isSneaking){ try{p.onScreenDisplay.setActionBar("§e原子炉の外殻の前で右クリックすると画面を開きます§r · しゃがみ＋右クリックで詳細画面");}catch{} return; }
    openMachineScreens.add(p.id);
    fluidSystem.showControl(p,block,key).catch(console.warn).finally(()=>openMachineScreens.delete(p.id));
    return;
  }
  openMachineScreens.add(p.id);
  if ([`${NS}:conveyor_1`,`${NS}:conveyor_2`,`${NS}:conveyor_3`].includes(t) && heldItemId(p)===`${NS}:wrench`) {
    openMachineScreens.delete(p.id);
    expansion.rotateBelt(p,block,key);
    return;
  }
  const st = machineState(key);
  let pending;
  if (expansion.isSplitter(t)) {
    expansion.splitterUi(p, block, key).catch(e => console.warn(`[Orbital Foundry] splitter UI: ${e}`)).finally(() => openMachineScreens.delete(p.id));
    return;
  }
  if (t === `${NS}:orbital_cannon`) {
    expansion.cannonUi(p, block, key).catch(e => console.warn(`[Orbital Foundry] cannon UI: ${e}`)).finally(() => openMachineScreens.delete(p.id));
    return;
  }
  if (BULK_TYPES.has(t) || QUARRY_TYPES.has(t) || t===DEF.terminal || TURRET_TYPES.has(t)) {
    (t===DEF.terminal ? defense.showTerminal(p,block,key) : TURRET_TYPES.has(t) ? defense.showTurret(p,block,key) : BULK_TYPES.has(t) ? bulkMachine.show(p,block,key) : quarry.show(p,block,key))
      .catch(e => console.warn(`[Orbital Foundry] machine UI: ${e}`)).finally(() => openMachineScreens.delete(p.id));
    return;
  }
  if(!fromStock && SLOT_MACHINES.has(t) && !p.isSneaking &&
      !(t===launchPadType && (rocketStage(p)>=3 || playerFlight(p)))) {
    // 既定はかまど風の在庫画面 (機械の中の受け皿エンティティ)。ブロックに当たってしまったときは受け皿の当たり判定を張り直す
    openMachineScreens.delete(p.id);
    try{ ensureSlotHost(block,key); const host=slotHost(block.dimension,block.location,key); if(host){hostHitState.delete(host.id);hostMineUntil.delete(host.id);setHostHit(host,"extend");} }catch{}
    try{ p.onScreenDisplay.setActionBar("§eもう一度右クリックで機械の画面を開きます§r · しゃがみ＋右クリックで詳細画面"); }catch{}
    return;
  }
  else if(GROWER_TIERS[t]) pending=growing.show(p,block,key);
  else if(MOBWORKS_TYPES.includes(t)) pending=mobWorks.show(p,block,key);
  else if(SOLAR[t]) pending=solar.show(p,block,key);
  else if(BATTERIES[t]) pending=batteries.show(p,block,key);
  else if(["water_pump","fluid_pipe","fluid_tank","thermal_generator","nuclear_reactor","oil_pump","creative_generator","creative_fluid_source"].some(name=>t===`${NS}:${name}`)) pending=fluidSystem.showControl(p,block,key);
  else if (t === `${NS}:research_lab`) pending = showResearchTree(p,block,key);
  else if (t === `${NS}:research_terminal`) pending = showResearchTree(p);
  else if (t === launchPadType || t === landingPadType) pending = showRocket(p, block, key);
  else if (t === terminalType) pending = showOrbitalTerminal(p, block);
  else if (t === `${NS}:fixed_drill`) pending = showDrill(p, block, st, key);
  else if (["conveyor_1","conveyor_2","conveyor_3","power_cable","oil_pump"].some(n=>t===`${NS}:${n}`)) pending=expansion.device(p,block,key);
  else if (PROCESSOR_IDS.has(t)) pending = showMachineControl(p,block,key);
  else if (t === `${NS}:coal_generator`) pending = showCoalGenerator(p,block,key);
  else pending = showSimple(p, block);
  return pending.catch(e => console.warn(`[Orbital Foundry] machine UI: ${e}`))
    .finally(() => openMachineScreens.delete(p.id));
}
world.beforeEvents.playerInteractWithBlock.subscribe((ev) => { if (!ev.player || isPlayerGun(ev.itemStack?.typeId) || BATTERIES[ev.itemStack?.typeId] || DEBUG_SPAWN_EGGS.has(ev.itemStack?.typeId)) return;
  const p = ev.player, block = ev.block;
  if(silentPlacement(p))return;
  if (MACHINES[block?.typeId]||reactorAtShell(world,registry(),block.dimension.id,block.location)) { system.run(() => tryOpenMachine(p, block)); return; }
  const held = heldItemId(p); if (held === `${NS}:guide_book`) system.run(() => openItemUI(p, held)); });
world.afterEvents.playerInteractWithBlock?.subscribe((ev) => { if (!ev.player || BATTERIES[ev.beforeItemStack?.typeId] || isPlayerGun(ev.beforeItemStack?.typeId ?? heldItemId(ev.player))) return;
  if(silentPlacement(ev.player))return;
  if (MACHINES[ev.block?.typeId]||reactorAtShell(world,registry(),ev.block.dimension.id,ev.block.location)) { tryOpenMachine(ev.player, ev.block); return; }
  const held = heldItemId(ev.player); if (held === `${NS}:guide_book`) openItemUI(ev.player, held); });
// ---- デバッグ用スポーンエッグ: このアドオンの敵・ボス7種。クリエイティブ専用 ----
// エッグで出した個体には of:debug を付け、作戦/ボス記録と無関係でも片付けない (行動AIの一部は作戦中のみ)
const DEBUG_SPAWN_EGGS = new Map([
  "scrapper", "jammer", "mender", "gnawer", "siege_engine", "overseer"
].map(name => [`${NS}:${name}_spawn_egg`, `${NS}:${name}`]));
const DEFENSE_MOBS = new Set(["scrapper", "jammer", "mender", "gnawer", "siege_engine"].map(name => `${NS}:${name}`));
const EGG_FACE_OFFSET = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1],
  south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};
world.beforeEvents.playerInteractWithBlock.subscribe(ev => {
  const type = DEBUG_SPAWN_EGGS.get(ev.itemStack?.typeId);
  if (!type) return;
  ev.cancel = true;
  if (!ev.isFirstEvent) return;
  const player = ev.player;
  if (player.getGameMode() !== GameMode.Creative) {
    system.run(() => toast(player, "§cデバッグ用スポーンエッグはクリエイティブ専用です"));
    return;
  }
  const { dimension, location } = ev.block;
  const [dx, dy, dz] = EGG_FACE_OFFSET[ev.blockFace.toLowerCase()];
  const spawnAt = { x: location.x + dx + .5, y: location.y + dy, z: location.z + dz + .5 };
  system.run(() => {
    if (!player.isValid || player.getGameMode() !== GameMode.Creative) return;
    // 本物と同じ中身にする: 防衛の敵は進行中の作戦へ波の敵と同じ形で登録、オーバーシアは召喚と同じボス記録を作る
    if (DEFENSE_MOBS.has(type) && !defense.enlist({ location: spawnAt, dimension }, 128, true)) {
      toast(player, "§c防衛作戦中の端末の近く (128マス以内) でだけ出せます§r\n§7本物の敵のAIは作戦の中でしか動かないため");
      return;
    }
    let mob;
    try { mob = dimension.spawnEntity(type, spawnAt); } catch { toast(player, "§cここにはスポーンできません"); return; }
    try {
      if (DEFENSE_MOBS.has(type)) {
        const r = defense.enlist(mob, 128);
        if (r === "siege_busy") toast(player, "§cこの作戦にはすでに攻城機がいます");
        else if (!r) mob.remove();
      } else if (type === `${NS}:overseer`) expansion.adoptOverseer(mob, player);
    } catch (e) { console.warn(`[Orbital Foundry] spawn egg: ${e}`); try { mob.remove(); } catch {} }
  });
});
world.afterEvents.entitySpawn?.subscribe(ev => {
  const e = ev.entity;
  if (!e?.isValid || !DEFENSE_MOBS.has(e.typeId)) return;
  system.runTimeout(() => {
    try { if (e.isValid && !e.getDynamicProperty("of:terminal") && !e.getDynamicProperty("of:debug")) e.remove(); } catch {}
  }, 2);
});
world.beforeEvents.itemUseOn?.subscribe((ev) => { const p = ev.source; if (!p || p.typeId !== "minecraft:player") return;
  const id = ev.itemStack?.typeId;
  if (id === `${NS}:wrench`) { if (![`${NS}:conveyor_1`,`${NS}:conveyor_2`,`${NS}:conveyor_3`].includes(ev.block?.typeId)) return; const block = ev.block; system.run(() => tryOpenMachine(p, block)); }
  else if (id === `${NS}:guide_book`) system.run(() => openItemUI(p, id)); });
// アイテム系UIは「空中での使用 (itemUse)」「ブロックへ向けての使用 (itemUseOn)」「ブロック対話時に手に持っている場合」の
// 全経路から同じ関数を開く (ブロックを見て右クリックすると itemUse が発火しない環境があるため)
function openGuideHub(p) {
  system.run(async () => {
    const cur = currentQuest(p); const pr = cur ? questProgress(p, cur) : null;
    const form = createForm().title("§6§l工廠ガイド§r")
      .body(header("工廠ハブ", cur ? `§e> 今のクエスト§r  §f${cur.title}§r\n§7${cur.desc} (${Math.min(pr.cur, pr.target)}/${pr.target})・報酬: ${rewardText(cur)}` : "§aPhase1 クエスト全達成§r"))
      .button("§6§l実績クエスト§r\n§7次にやること・ヒント・報酬", "textures/items/guide_book")
      .button("§aガイドを読む§r\n§7進め方・機械の使い方", "textures/items/basic_circuit")
      .button("§e進行状況§r\n§7T0-T5 の現在地", "textures/blocks/research_terminal")
      .button((hud.isOpen(p)?"§c電力パネルを閉じる§r":"§b電力パネルを開く§r")+"\n§7しゃがみ2回でも開閉できます", "textures/blocks/battery")
      .button("§b電力の内訳を全部見る§r\n§7発電機・機械ごとの発電量と消費量", "textures/blocks/battery_mk2")
      .button("§7閉じる§r");
    const r = await form.show(p); if (r.canceled) return;
    if (r.selection === 0) return showQuests(p);
    if (r.selection === 1) return showGuide(p, 0);
    if (r.selection === 2) return showProgress(p);
    if (r.selection === 3) return hud.toggle(p);
    if (r.selection === 4) return hud.showAll(p);
  });
}
const heldItemId = (p) => { try { return inv(p)?.getItem(p.selectedSlotIndex)?.typeId; } catch { return undefined; } };
function openItemUI(p, id) {
  if (id === `${NS}:guide_book`) openGuideHub(p);
  else if (id === `${NS}:research_terminal`) system.run(() => showResearchTree(p));
}
world.afterEvents.itemUse.subscribe((ev) => { const p = ev.source; if (!p) return; openItemUI(p, ev.itemStack?.typeId); });
// 本命経路: アイテム自体に「使う」部品を登録する (抜刀剣 v2.4.29 と同じ仕組み)。
// これがあると、空を見ても地面を見ても右クリックが「使用」として確実に届く。
try { system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
  try { itemComponentRegistry.registerCustomComponent(`${NS}:open_ui`, {
    onUse: (ev) => { if (ev.source?.typeId === "minecraft:player") openItemUI(ev.source, ev.itemStack?.typeId); },
    onUseOn: (ev) => { if (ev.source?.typeId === "minecraft:player") openItemUI(ev.source, ev.itemStack?.typeId); },
  }); } catch {}
}); } catch {}

// 初回参加: ガイドを配ってクエストの存在を知らせる (1人1回)
world.afterEvents.playerSpawn.subscribe((ev) => { const p = ev.player; if (!p) return;
  if (pGet(p, "of:welcomed", 0)) return;
  system.run(() => { if (countItem(p, `${NS}:guide_book`) === 0) giveItems(p, `${NS}:guide_book`, 1);
    if (countItem(p, `${NS}:guide_book`) > 0) { pSet(p, "of:welcomed", 1);
      toast(p, "§6§l軌道工廠§r §fガイドを渡しました。手に持って右クリックすると「次にやること」が分かります"); } });
});
// 達成通知: 未受取で達成済みになったクエストを1回だけタイトルで知らせる (実績トースト風)
system.runInterval(() => { for (const p of world.getPlayers()) {
  const inventory = inv(p);
  if (inventory) for (let i = 0; i < inventory.size; i++) {
    if (isGauge(inventory.getItem(i))) inventory.setItem(i, undefined);
  }
  const claimed = claimedOf(p); let notified = []; try { notified = JSON.parse(pGet(p, "of:q_notified", "[]")); } catch {}
  for (const q of QUESTS) { if (claimed.includes(q.id) || notified.includes(q.id)) continue;
    if (questProgress(p, q).done) { notified.push(q.id);
      try { p.onScreenDisplay.setActionBar(`§6実績達成: ${q.title}§r §7/ 報酬: ${rewardText(q)} §7(ガイドの「実績クエスト」から受取)`); p.playSound("random.levelup", { volume: 0.5 }); } catch {}
      break; } }
  pSet(p, "of:q_notified", JSON.stringify(notified));
} }, 100);

const SLOT_MACHINES = new Set([...PROCESSOR_IDS, `${NS}:coal_generator`, `${NS}:fixed_drill`, `${NS}:launch_pad`, `${NS}:oil_pump`, `${NS}:research_lab`, `${NS}:nuclear_reactor`]);
const anchorOf = ({x,y,z}) => ({x:x+.5,y:y+.96,z:z+.5});
const slotHostCache = new Map();   // key -> 在庫エンティティ (機械1台に1体で固定)
function slotHost(dim, loc, key) {
  const cached = slotHostCache.get(key);
  if (cached) {
    try { if (cached.isValid) return cached; } catch {}
    slotHostCache.delete(key);
  }
  const found = dim.getEntities({location:{x:loc.x+.5,y:loc.y-.3,z:loc.z+.5},maxDistance:2.2,families:["orbital_foundry_slots"]})
    .find(e=>e.getDynamicProperty("of:machine_key")===key);
  if (found) slotHostCache.set(key, found);
  return found;
}
// ---- 機械の在庫エンティティの当たり判定 ----
// 普段は機械と同じ大きさに広げ、右クリックでかまど風の在庫画面 (RP chest_screen) を開く。
// しゃがんでいる人の近く (シフト+右クリックで詳細設定・ブロック設置) と、殴られた直後 (採掘) は縮めてブロックへ通す。
const hostHitState=new Map(); // entity.id -> "extend" | "retract"
const hostMineUntil=new Map(); // entity.id -> tick
const SLOT_FAMILY="orbital_foundry_slots";
const hostHitAt=new Map();
function setHostHit(host,state) {
  // 記録が古くなって実体と食い違わないよう、2秒ごとに張り直す
  if(hostHitState.get(host.id)===state && system.currentTick-(hostHitAt.get(host.id)??0)<40)return;
  hostHitAt.set(host.id,system.currentTick);
  try{host.triggerEvent(`${NS}:${state}`);hostHitState.set(host.id,state);}catch{}
}
system.runInterval(()=>{
  const want=new Map();
  for(const p of world.getPlayers()){
    let hosts=[];
    try{hosts=p.dimension.getEntities({location:p.location,maxDistance:10,families:[SLOT_FAMILY]});}catch{continue;}
    // しゃがみ中、またはツルハシ・斧・シャベルを持っている間はブロック側へ通す (設定画面・設置・採掘)
    // ブロックを持っている間も引っ込める (機械の隣にブロックを置けるように。素手やブロック以外なら画面を開ける)
    const held=heldItemId(p)??"";
    let holdsBlock=false; if(held&&held!==`${NS}:wrench`){ try{holdsBlock=!!BlockTypes.get(held);}catch{} }
    const sneaking=p.isSneaking||holdsBlock||/pickaxe|_axe$|shovel|_hoe$|sword|shears/.test(held);
    for(const host of hosts){
      const retract=sneaking||(hostMineUntil.get(host.id)??0)>system.currentTick;
      const prev=want.get(host.id);
      const d=Math.hypot(host.location.x-p.location.x,host.location.z-p.location.z);
      const lean=(!prev?.lean||d<prev.dist)?{x:p.location.x,y:p.location.y+1.6,z:p.location.z}:prev.lean;
      want.set(host.id,{host,retract:retract||!!prev?.retract,lean,dist:Math.min(d,prev?.dist??1e9)});
    }
  }
  for(const {host,retract,lean} of want.values()){
    setHostHit(host,retract?"retract":"extend");
    // 受け皿をいちばん近いプレイヤーの側へ少し張り出させ、ブロックより先に右クリックが当たるようにする
    try{
      const pos=JSON.parse(host.getDynamicProperty("of:block_position")??"null"); if(!pos)continue;
      const c={x:pos.x+.5,y:pos.y+.02,z:pos.z+.5};
      let t=c;
      if(retract)t={x:c.x,y:pos.y-1.5,z:c.z};   // 掘る・しゃがむ間は受け皿を床下へ沈め、ブロックに当たるようにする
      else if(lean&&host.typeId===`${NS}:nuclear_reactor_slots`){
        // 原子炉は3×3×3の外殻に囲まれるので、受け皿を外殻の外へ、プレイヤーに一番近い面から張り出させる
        const dx=lean.x-c.x,dy=lean.y-(pos.y+.5),dz=lean.z-c.z,ax=Math.abs(dx),ay=Math.abs(dy),az=Math.abs(dz);
        let shelled=false; try{const dim=host.dimension;shelled=!dim.getBlock({x:pos.x+1,y:pos.y,z:pos.z})?.isAir&&!dim.getBlock({x:pos.x,y:pos.y+1,z:pos.z})?.isAir;}catch{}
        const reach=shelled?1.72:.3;
        if(dy>0&&ay>ax&&ay>az&&shelled)t={x:c.x,y:pos.y+1.8,z:c.z};
        else if(ax>=az)t={x:c.x+Math.sign(dx||1)*reach,y:c.y,z:c.z};
        else t={x:c.x,y:c.y,z:c.z+Math.sign(dz||1)*reach};
      }
      else if(lean){const dx=lean.x-c.x,dz=lean.z-c.z,d=Math.hypot(dx,dz)||1;t={x:c.x+dx/d*.3,y:c.y,z:c.z+dz/d*.3};}
      const l=host.location; if(Math.abs(l.x-t.x)>.03||Math.abs(l.z-t.z)>.03||Math.abs(l.y-t.y)>.03)host.teleport(t);
    }catch{}
  }
  for(const [id,until] of hostMineUntil)if(until<=system.currentTick)hostMineUntil.delete(id);
},2);
// 機械を叩いたら (壊そうとしたら) 3秒間はブロックへ通す
world.afterEvents.entityHitEntity?.subscribe(({damagingEntity,hitEntity})=>{
  try{
    if(damagingEntity?.typeId!=="minecraft:player"||!hitEntity?.matches?.({families:[SLOT_FAMILY]}))return;
    hostMineUntil.set(hitEntity.id,system.currentTick+60);
    hostHitState.delete(hitEntity.id);
    setHostHit(hitEntity,"retract");
    try{const pos=JSON.parse(hitEntity.getDynamicProperty("of:block_position")??"null");if(pos)system.run(()=>{try{hitEntity.teleport({x:pos.x+.5,y:pos.y-1.5,z:pos.z+.5});}catch{}});}catch{}
    try{damagingEntity.onScreenDisplay.setActionBar("§7そのまま叩き続けると機械を壊せます");}catch{}
  }catch{}
});
// 在庫画面の代わりに別の画面を出すべき場合 (未研究・レンチ・軌道便のある発射台) は、開く前に止めて従来の画面へ
world.beforeEvents.playerInteractWithEntity?.subscribe(ev=>{
  const p=ev.player, host=ev.target;
  try{
    if(!p||!host?.typeId?.endsWith("_slots")||!host.typeId.startsWith(NS+":"))return;
    const type=host.getDynamicProperty("of:machine_type");
    const pos=JSON.parse(host.getDynamicProperty("of:block_position")??"null");
    if(!type||!pos)return;
    const held=ev.itemStack?.typeId;
    const redirect=p.isSneaking||!research.allowsMachine(type,p)||
      (type===launchPadType&&(rocketStage(p)>=3||playerFlight(p)));
    if(!redirect)return;
    ev.cancel=true;
    const dim=host.dimension;
    system.run(()=>{try{const block=dim.getBlock(pos);if(block?.typeId===type)tryOpenMachine(p,block);}catch{}});
  }catch{}
});
function parkSlotHost(host, position) {
  hostHitState.delete(host.id);
  // 床面に置き、当たり判定 (collision_box 0.98) がブロック全体を覆うようにする
  const anchor={x:position.x+.5,y:position.y+.02,z:position.z+.5};
  if (Math.abs(host.location.y-anchor.y)>.001) host.teleport(anchor);
  if (host.getDynamicProperty("of:mining_clearance")!==undefined) {
    host.setDynamicProperty("of:mining_clearance",undefined);
  }
  host.nameTag="";
  host.triggerEvent(`${NS}:retract`);
}
function ensureSlotHost(block, key) {
  if (!SLOT_MACHINES.has(block.typeId)) return;
  const pos=block.location;
  let host=slotHost(block.dimension,pos,key);
  if (!host) {
    host=block.dimension.spawnEntity(`${block.typeId}_slots`,{x:pos.x+.5,y:pos.y+.02,z:pos.z+.5});
    slotHostCache.set(key, host);
    host.setDynamicProperty("of:machine_key",key);
    host.setDynamicProperty("of:machine_type",block.typeId);
    const {x,y,z}=block.location;
    host.setDynamicProperty("of:block_position",JSON.stringify({x,y,z}));
    if (block.typeId === `${NS}:coal_generator`) {
      const inventory=host.getComponent("minecraft:inventory")?.container;
      if (inventory) updateGauges(inventory,{type:block.typeId,key},machineState(key));
    }
  }
  if (host.getDynamicProperty("of:slot_host_parked")!==true || (Math.abs(host.location.y-(pos.y+.02))>.001 && Math.abs(host.location.y-(pos.y-1.5))>.001 && Math.abs(host.location.y-(pos.y+1.8))>.001)) {
    parkSlotHost(host,pos);
    host.setDynamicProperty("of:slot_host_parked",true);
  }
  if (block.typeId === ASSEMBLER && host.getDynamicProperty("of:machine_type") === LEGACY_CRAFTER) {
    const inventory = host.getComponent("minecraft:inventory")?.container;
    if (inventory && isGauge(inventory.getItem(0))) inventory.setItem(0, undefined);
  }
  if (host.getDynamicProperty("of:machine_type")!==block.typeId) host.setDynamicProperty("of:machine_type",block.typeId);
  const blockPosJson=JSON.stringify(block.location);
  if (host.getDynamicProperty("of:block_position")!==blockPosJson) host.setDynamicProperty("of:block_position",blockPosJson);
  if (block.typeId === `${NS}:crusher`) {
    const inventory=host.getComponent("minecraft:inventory")?.container;
    if (inventory) updateGauges(inventory,{type:block.typeId,key},machineState(key));
  }
  if (MACHINE_LAYOUTS.some(layout=>layout.type===block.typeId)) {
    const inventory=host?.getComponent("minecraft:inventory")?.container;
    if(inventory) {
      const state=machineState(key);
      const layout=machineLayout(block.typeId,state,inventory);
      consolidateMachineSlots(inventory,layout);
      const index=layout.marker-31400;
      if(inventory.getItem(26)?.typeId!==`${NS}:of_machine_${index}`) crusherMeter(inventory,26,`${NS}:of_machine_${index}`,0,"電力を確認中");
    }
  }
  if(block.typeId===`${NS}:coal_generator`) {
    const inventory=host?.getComponent("minecraft:inventory")?.container;
    if(inventory)furnaceMeter(inventory,26,"energy",generatorRecord(key).stored/generatorCapacity(key),`蓄電 ${generatorRecord(key).stored} / ${generatorCapacity(key)} SE`);
  }
  return host;
}
world.afterEvents.entityLoad?.subscribe(({entity})=>{
  try {
    if (!entity.typeId.startsWith(NS+":") || !entity.typeId.endsWith("_slots")) return;
    const position=JSON.parse(entity.getDynamicProperty("of:block_position")??"null");
    if (!position) return;
    parkSlotHost(entity,position);
    entity.setDynamicProperty("of:slot_host_parked",true);
  } catch {}
});
function machineContainer(block,key) {
  return ensureSlotHost(block,key)?.getComponent("minecraft:inventory")?.container;
}

// ---- 粉砕機の歯車アニメーション (発電機と同じ gear_phase + bone_visibility 方式) ----
const activeCrushers = new Map();
// 煙突 (モデル座標 x4.6, z5.4) の蒸気位置を、設置向きごとにブロック内座標へ換算したもの
const CRUSHER_VENT = {north:[.7875,.8375], east:[.1625,.7875], south:[.2125,.1625], west:[.8375,.2125]};
function pokeCrusherAnim(block, speed, until) {
  const cadence=visualStepTicks(speed);
  const key = keyOf(block.dimension.id, block.location);
  let e = activeCrushers.get(key);
  if (!e) {
    e = {dimension: block.dimension, blockPosition: {x: block.location.x, y: block.location.y, z: block.location.z}, nextPose: system.currentTick + cadence, cadence};
    activeCrushers.set(key, e);
  }
  e.until = until;
  e.cadence = cadence;
}
system.runInterval(() => {
  for (const [key, entry] of activeCrushers) {
    if (Date.now() >= entry.until) { activeCrushers.delete(key); continue; }
    if (system.currentTick < entry.nextPose) continue;
    entry.nextPose = system.currentTick + entry.cadence;
    try {
      const block = entry.dimension.getBlock(entry.blockPosition);
      if (block?.typeId !== `${NS}:crusher`) { activeCrushers.delete(key); continue; }
      const perm = block.permutation;
      const phase = perm.getState(`${NS}:gear_phase`);
      if (phase !== undefined) block.setPermutation(perm.withState(`${NS}:gear_phase`, (phase + 1) % 6));
    } catch { activeCrushers.delete(key); }
  }
}, 1);
function debrisKind(itemId) {
  const s = itemId ?? "";
  if (s.includes("raw_iron") || s.includes("iron_ore")) return "iron";
  if (s.includes("raw_copper") || s.includes("copper_ore")) return "copper";
  if (s.includes("raw_gold") || s.includes("gold_ore")) return "gold";
  if (s.includes("redstone")) return "redstone";
  if (s.includes("coal")) return "coal";
  if (s.includes("_log") || s.includes("_wood") || s.includes("stem")) return "wood";
  if (s.includes("nickel")) return "nickel";
  if (s.includes("bauxite")) return "bauxite";
  if (s.includes("sulfur")) return "sulfur";
  if (s.includes("diamond")) return "diamond";
  return "stone";
}
function removeSlotHost(dim,loc,key) {
  const host=slotHost(dim,loc,key);
  slotHostCache.delete(key);
  if (!host) return;
  const cont=host.getComponent("minecraft:inventory")?.container;
  if (cont) for (let i=0;i<cont.size;i++) {
    const item=cont.getItem(i);
    if (!item) continue;
    if (!isGauge(item)) dim.spawnItem(item,anchorOf(loc));
    cont.setItem(i,undefined);
  }
  host.remove();
}
function countSlots(container, id) {
  let n=0;
  for (let i=0;i<Math.min(18,container.size);i++) { const item=container.getItem(i); if (item?.typeId===id) n+=item.amount; }
  return n;
}
function takeSlots(container, id, n) {
  for (let i=0;i<Math.min(18,container.size) && n>0;i++) {
    const item=container.getItem(i);
    if (item?.typeId!==id) continue;
    const count=Math.min(n,item.amount);
    n-=count;
    if (count===item.amount) container.setItem(i,undefined);
    else { item.amount-=count; container.setItem(i,item); }
  }
}
// First two rows are ingredients. The bottom row receives products.
function putSlots(container,id,n) {
  const output = new ItemStack(id);
  for (let i=18;i<Math.min(25,container.size) && n>0;i++) {
    const current=container.getItem(i);
    if (current && !current.isStackableWith(output)) continue;
    const existing=current?.amount??0;
    const added=Math.min(n,output.maxAmount-existing);
    if (!added) continue;
    container.setItem(i,new ItemStack(id,existing+added));
    n-=added;
  }
  return n;
}
const isGauge = item => !!item && /^orbital_foundry:of_(energy|progress|fire|crusher|crafter|machine|fluid|heat)_([0-9]+)$/.test(item.typeId);
// ItemStack.nameTag is limited to 255 bytes, including Japanese text and formatting.
function meterLabel(label) {
  let bytes = 0;
  let end = 0;
  let ellipsisAt = 0;
  for (const char of label) {
    const point = char.codePointAt(0);
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 255) return label.slice(0, ellipsisAt).replace(/§$/, "") + "...";
    end += char.length;
    if (bytes <= 252) ellipsisAt = end;
  }
  return label;
}
function showGauge(container, slot, kind, fraction, label) {
  label = meterLabel(label);
  if (slot >= container.size) return;
  const current = container.getItem(slot);
  if (current && !isGauge(current)) return;
  const level = Math.min(10, Math.max(0, Math.round(fraction * 10)));
  const id = `${NS}:of_${kind}_${level}`;
  if (current?.lockMode===ItemLockMode.slot && current?.typeId === id && current.nameTag === label) return;
  const display = new ItemStack(id);
  display.nameTag = label;
  display.lockMode=ItemLockMode.slot;
  container.setItem(slot, display);
}
function furnaceMeter(container, slot, kind, fraction, label) {
  label = meterLabel(label);
  const current = container.getItem(slot);
  if (current && !isGauge(current)) return;
  const id = `${NS}:of_${kind}_0`;
  const level = kind === "fire" ? Math.ceil(fraction * 10) : Math.round(fraction * 10);
  const damage = 11 - Math.min(10, Math.max(0, level));
  if (current?.lockMode===ItemLockMode.slot && current?.typeId === id && current.nameTag === label &&
      current.getComponent("minecraft:durability")?.damage === damage) return;
  const item = new ItemStack(id);
  const durability = item.getComponent("minecraft:durability");
  if (!durability) return;
  durability.damage = damage;
  item.nameTag = label;
  item.lockMode=ItemLockMode.slot;
  container.setItem(slot, item);
}
function crusherMeter(container, slot, itemId, fraction, label) {
  label = meterLabel(label);
  const current = container.getItem(slot);
  if (current && current.typeId !== itemId && !isGauge(current)) return;
  const level = Math.min(10, Math.max(0, Math.round(fraction * 10)));
  const damage = 10 - level;
  if (current?.lockMode===ItemLockMode.slot && current?.typeId === itemId && current.nameTag === label &&
      current.getComponent("minecraft:durability")?.damage === damage) return;
  const item = new ItemStack(itemId);
  const durability = item.getComponent("minecraft:durability");
  if (!durability) return;
  durability.damage = damage;
  item.nameTag = label;
  item.lockMode=ItemLockMode.slot;
  container.setItem(slot, item);
}
const FURNACE_ROUTE_SLOT = 0;
const FURNACE_FUEL_SLOT = 1;
function consolidateGeneratorSlots(container) {
  for (let source=0;source<container.size;source++) {
    const item=container.getItem(source);
    if (!item) continue;
    const target=FUELS.some(([id])=>id===item.typeId) ? FURNACE_FUEL_SLOT : undefined;
    if (target===undefined || source===target) continue;
    const old=container.getItem(target);
    if (old && !old.isStackableWith(item)) continue;
    const count=Math.min(item.amount,item.maxAmount-(old?.amount??0));
    if (!count) continue;
    const stack=(old??item).clone();
    stack.amount=(old?.amount??0)+count;
    container.setItem(target,stack);
    if (count===item.amount) container.setItem(source,undefined);
    else {item.amount-=count;container.setItem(source,item);}
  }
}
// 入れられないアイテムは消さずに機械の上へ吐き出す
function ejectForeign(container, m, allowed, from=0, to=18) {
  let n=0;
  for(let i=from;i<to;i++){
    const it=container.getItem(i);
    if(!it||isGauge(it)||allowed(it))continue;
    container.setItem(i,undefined);
    try{const dim=world.getDimension(m.dim);dim.spawnItem(it,{x:m.x+.5,y:m.y+1.2,z:m.z+.5});n++;}catch{}
  }
  if(n)try{world.getDimension(m.dim).playSound("random.pop",{x:m.x+.5,y:m.y+1,z:m.z+.5},{volume:.6,pitch:.8});}catch{}
}
function updateGauges(container, m, st) {
  const now = Date.now();
  const local=GENERATOR_TYPES.has(m.type);
  const record=local?generatorRecord(m.key):undefined;
  const launch=m.type===`${NS}:launch_pad`;
  const stored=record?.stored??expansion.availablePower(m.key,!launch);
  const max=launch?ROCKET1.launchEnergy:local?generatorCapacity(m.key):expansion.powerCapacity(m.key);
  const charge=stored/Math.max(1,max);
  const chargeLabel = local ? `蓄電 ${stored} / ${max} SE\n累計発電 ${record.generated} SE` : `蓄電 ${stored} / ${max} SE`;
  const fluidState=fluidSystem.state(m);
  const registered=registryEntry(m.key);
  const fluidPorts=registered?fluidSystem.ports(registered,world.getDimension(registered.dim).getBlock(registered)):undefined;
  for(const [index,type] of Object.keys(FLUID_NAMES).entries()) {
    if(fluidPorts?.in?.includes(type)||fluidPorts?.out?.includes(type))
      crusherMeter(container,15+index,`${NS}:of_fluid_${index}`,(fluidState[type]??0)/fluidSystem.capacity(m),FLUID_NAMES[type]+" "+(fluidState[type]??0)+" mB");
  }
  if(m.type===`${NS}:nuclear_reactor` && isGauge(container.getItem(14))) container.setItem(14,undefined);
  const layout=machineLayout(m.type,st,container);
  if(layout) {
    consolidateMachineSlots(container,layout);
    { const ok=new Set(PROCESS_RECIPES.filter(r=>`${NS}:${r.machine}`===m.type).flatMap(r=>r.in.map(([id])=>id))); for(const [id] of layout.inputs)ok.add(id); ejectForeign(container,m,it=>ok.has(it.typeId)); }
    const index=layout.marker-31400;
    const job=st.job;
    const fraction=job ? 1-Math.max(0,job.readyAt-now)/Math.max(1,job.readyAt-(job.startedAt??now)) : 0;
    const missing=layout.inputs.filter(([id,n])=>countSlots(container,id)<n);
    const cost=PROCESS_RECIPES.find(recipe=>recipe.id===layout.id)?.energy??0;
    const requirement=EQUIPMENT_TECH[m.type.split(":").pop()]??RECIPE_TECH[layout.id];
    const locked=!research.allowsMachine(m.type,m)||!research.allowsRecipe({id:layout.id,machine:m.type.split(":").pop()},m);
    const status=locked ? "未解禁 · "+(research.technology(requirement)?.name??"対応技術")+"を研究してください" : job ? now>=job.readyAt ? "完成品の搬出待ち" : `加工中 ${Math.floor(fraction*100)}%`+(job.speed>1?` · ${job.speed}倍`:"") :
      missing.length ? "材料不足 "+missing.map(([id,n])=>`${nameOf(id)} あと${n-countSlots(container,id)}個`).join(" / ") :
      stored<cost ? "電力不足 · ケーブルと発電機を確認してください" : "材料が揃うと自動で稼働します";
    crusherMeter(container,26,`${NS}:of_machine_${index}`,charge,chargeLabel);
    // 原子炉は炉の状態と燃料棒の残り時間を出す (蓄電満杯の間は燃料を消費しないので、燃え尽きず使用済み燃料棒も出てこない)
    const reactorStatus=m.type===`${NS}:nuclear_reactor` ? `${fluidState.status??"待機中"} · ${Math.round(fluidState.temperature??20)}度`+
      ((fluidState.fuelSeconds??0)>0?` · 燃料棒 残り${Math.ceil(fluidState.fuelSeconds/60)}分`:"")+((fluidState.spentPending??0)>0?" · 使用済み燃料棒の置き場が満杯":"") : undefined;
    crusherMeter(container,25,`${NS}:of_crusher_1`,m.type===`${NS}:nuclear_reactor`?(fluidState.temperature??20)/20000:fraction,reactorStatus??status);
    return;
  }
  if (m.type === `${NS}:coal_generator`) {
    ejectForeign(container,m,it=>FUELS.some(([id])=>id===it.typeId),0,25);
    const remaining = Math.max(0, (st.burn?.until ?? now) - now);
    const fire = remaining / (st.burn?.duration ?? (st.burn?.val ?? 1) * 100);
    const label = remaining ? `燃焼残り ${Math.ceil(remaining / 1000)} 秒` : st.burn ? "蓄電の空き待ち" : "燃焼停止";
    // Expose the original grid if old saves or shift-clicks contain items outside the visible controls.
    const hasOverflow = Array.from({length:25}, (_,i)=>i).some(i=>i!==FURNACE_FUEL_SLOT&&container.getItem(i)&&!isGauge(container.getItem(i))) ||
      [25,26].some(i=>container.getItem(i)&&!isGauge(container.getItem(i)));
    if (hasOverflow) {
      // The normal icon has no durability routing marker.
      const route=container.getItem(FURNACE_ROUTE_SLOT);
      if (route?.typeId === `${NS}:of_energy_0`) container.setItem(FURNACE_ROUTE_SLOT,undefined);
      showGauge(container,25,"fire",fire,label);
      furnaceMeter(container,26,"energy",charge,chargeLabel);
    } else {
      furnaceMeter(container,FURNACE_ROUTE_SLOT,"energy",charge,chargeLabel);
      furnaceMeter(container,26,"energy",charge,chargeLabel);
      furnaceMeter(container,25,"fire",fire,label);
    }
    return;
  }
  if (m.type === `${NS}:crusher`) {
    const job = st.job;
    const elapsed = job ? 1 - Math.max(0, job.readyAt - now) / Math.max(1, job.readyAt - (job.startedAt ?? now)) : 0;
    const progressLabel = !job ? "加工待機" : now >= job.readyAt ? "完成 / 回収待ち" : `加工進捗 ${Math.floor(elapsed * 100)}%` + (job.speed>1 ? ` · ${job.speed}倍` : "");
    const energyMeter = `${NS}:of_crusher_0`;
    crusherMeter(container, 0, energyMeter, charge, chargeLabel);
    crusherMeter(container, 25, `${NS}:of_crusher_1`, elapsed, progressLabel);
    crusherMeter(container, 26, energyMeter, charge, chargeLabel);
    return;
  }
  showGauge(container, 26, "energy", charge, chargeLabel);
  if (PROCESSOR_IDS.has(m.type)) {
    const job = st.job;
    const elapsed = job ? 1 - Math.max(0, job.readyAt - now) / Math.max(1, job.readyAt - (job.startedAt ?? now)) : 0;
    const label = !job ? "加工待機" : now >= job.readyAt ? "完成 / 回収待ち" : `加工進捗 ${Math.floor(elapsed * 100)}%`;
    showGauge(container, 25, "progress", elapsed, label);
  }
}
function consolidateCrusherSlots(container) {
  const first = container.getItem(0);
  if (first && !isGauge(first)) {
    for (let j = 1; j < 18; j++) {
      const old = container.getItem(j);
      if (old && !old.isStackableWith(first)) continue;
      const count = Math.min(first.amount, first.maxAmount - (old?.amount ?? 0));
      if (!count) continue;
      const stack = (old ?? first).clone(); stack.amount = (old?.amount ?? 0) + count;
      container.setItem(j, stack);
      if (count === first.amount) { container.setItem(0, undefined); break; }
      first.amount -= count; container.setItem(0, first);
    }
  }
  for (let source = 2; source < 18; source++) {
    const item = container.getItem(source);
    if (!item || isGauge(item)) continue;
    for (let j = 1; j < source; j++) {
      const old = container.getItem(j);
      if (old && !old.isStackableWith(item)) continue;
      const count = Math.min(item.amount, item.maxAmount - (old?.amount ?? 0));
      if (!count) continue;
      const stack = (old ?? item).clone(); stack.amount = (old?.amount ?? 0) + count;
      container.setItem(j, stack);
      if (count === item.amount) { container.setItem(source, undefined); break; }
      item.amount -= count; container.setItem(source, item);
    }
  }
}
const labActiveUntil = new Map();
const labActiveSpeed = new Map();
const selectedResearch = who => !!research.selected(who);
const researchPacksUsed = who => research.selected(who)?research.progress(research.selected(who).id,who):0;
function tickResearchLab(key,container,far=false) {
  // far: 間引いて呼ばれるので、前の作業の終了時刻から続けて、その間に終わったはずの分も進める
  const owner=registryEntry(key);
  for(let k=0;k<(far?LOD.catchUp:1);k++){
    const until=labActiveUntil.get(key)??0;
    if(until>system.currentTick)return;
    labActiveUntil.delete(key);labActiveSpeed.delete(key);
    const labPower=expansion.availablePower(key);
    const speed=affordableSpeed(speedLimit(key),labPower,value=>15*value);
    if(!speed){checkShort(key,15,labPower);return;}
    const result=research.contribute(container,n=>expansion.spend(key,n*speed),owner);
    if(!result.worked)return;
    const start=far&&until>0&&system.currentTick-until<=LOD.farTicks+40?until:system.currentTick;
    labActiveUntil.set(key,start+80/speed);labActiveSpeed.set(key,speed);
  }
}

async function showResearchGuide(player) {
  const form=createForm().title("研究の進め方")
    .body("最初は鉄4個で歯車を作り、歯車1個+銅1個から赤パックを2個作ります。\n"+
      "研究所に給電し、赤パックを入れて「金属加工」を研究してください。\n\n"+
      "解禁設備は研究画面の「設備製作」で作れます。\n"+
      "赤 > 金属加工 > 電子工学 > 自動組立 > 緑 > 高度素材 > 化学工業 > 青 > 精密生産 > 紫 > ロケット工学。\n化学工業から石油火力、精密生産+石油火力から原子力へ分岐します。")
    .button("技術ツリーを開く").button("戻る");
  const result=await form.show(player);
  if(!result.canceled&&result.selection===0)return showResearchTree(player);
  if(!result.canceled)return showProgress(player);
}
async function showResearchTree(player,block,key) {
  const technologies=orderedTechnologies(TECHNOLOGIES);
  const current=research.selected(player);
  const progress=current?research.progress(current.id,player)+"/"+current.count:"";
  const form=createForm().title("研究所 · 技術ツリー")
    .body(current?`現在の研究　${current.name}　${progress}\n技術を選ぶと必要パックと解禁内容を確認できます。`:"技術を選んで、必要なパックと電力を研究所へ供給してください。");
  for(const tech of technologies){
    const state=research.isUnlocked(tech.id,player)?"習得済み":current?.id===tech.id?"研究中":research.canStart(tech.id,player)?"研究可能":
      tech.requires.every(r=>research.isUnlocked(r,player))&&!research.gateOpen(tech.id,player)?"条件: "+tech.gate.label:"前提待ち";
    form.button(tech.name+"\n"+state,`textures/items/${tech.icon}`);
  }
  form.button("設備製作").button("パックの作り方").button("表示を更新").button("閉じる");
  const result=await form.show(player);
  if(result.canceled || (block&&!sameMachine(block,`${NS}:research_lab`)) || result.selection===TECHNOLOGIES.length+3)return;
  if(technologies[result.selection])return showResearchDetail(player,technologies[result.selection].id,block,key);
  if(result.selection===TECHNOLOGIES.length)return showEquipmentCatalog(player,block,key);
  if(result.selection===TECHNOLOGIES.length+1)return showScienceRecipes(player,block,key);
  return showResearchTree(player,block,key);
}
async function showResearchDetail(player,id,block,key) {
  const tech=research.technology(id);if(!tech)return;
  const container=block?machineContainer(block,key):undefined;
  const needs=tech.packs.map(index=>{
    const item=SCIENCE_PACKS[index];
    return nameOf(item)+" "+research.progress(id,player)+"/"+tech.count+"個"+(container?" · 所内 "+countSlots(container,item)+"個":"");
  }).join("\n");
  const done=research.isUnlocked(id,player), available=research.canStart(id,player);
  const current=research.selected(player)?.id===id;
  const needsAuthorization=current&&research.needsAuthorization(id,player);
  const form=createForm().title(tech.name+" · 研究内容")
    .body((done?"習得済み":available?"研究可能":tech.requires.every(r=>research.isUnlocked(r,player))&&!research.gateOpen(id,player)?"進行条件が未達成: "+tech.gate.label:"前提技術が未完了")+"\n\n"+
      "前提　"+(tech.requires.map(id=>research.technology(id).name+(research.isUnlocked(id,player)?"［済］":"［未］")).join(" / ")||"なし")+"\n"+
      (tech.gate?"条件　"+tech.gate.label+(research.gateOpen(id,player)?"［済］":"［未］")+"\n":"")+"\n"+
      needs+"\n1セットにつき15 SE・研究所1台で最短4秒\n\n解禁内容\n"+tech.unlocks)
    .button(done?"習得済み":current&&!needsAuthorization?"研究を一時停止する":available?"この研究を開始する":"前提技術を確認する")
    .button("設備製作").button("ツリーへ戻る");
  const result=await form.show(player);
  if(result.canceled || (block&&!sameMachine(block,`${NS}:research_lab`)))return;
  if(result.selection===0){
    if(current && research.selected(player)?.id===id) {
      if (available && research.needsAuthorization(id,player)) research.select(id,player);
      else research.pause(id,player);
    } else if(available)research.select(id,player);
    else if(!done&&tech.requires.some(id=>!research.isUnlocked(id,player)))return showResearchDetail(player,tech.requires.find(id=>!research.isUnlocked(id,player)),block,key);
    return showResearchDetail(player,id,block,key);
  }
  if(result.selection===1)return showEquipmentCatalog(player,block,key);
  return showResearchTree(player,block,key);
}
async function showEquipmentCatalog(player,block,key) {
  const form=new ActionFormData().title("設備製作").body("研究を選ぶと、その研究で作れる設備が表示されます。");
  const groups=[{name:"序盤の設備（研究不要）",tech:null,icon:"textures/blocks/coal_generator"}];
  for(const tech of orderedTechnologies(TECHNOLOGIES)) {
    if(!EQUIPMENT_CATALOG.some(entry=>entry.tech===tech.id))continue;
    groups.push({name:tech.name,tech:tech.id,icon:`textures/items/${tech.icon}`});
  }
  for(const group of groups)form.button(group.name,group.icon);
  form.button("研究ツリーへ戻る");
  const result=await form.show(player);
  if(result.canceled||(block&&!sameMachine(block,`${NS}:research_lab`)))return;
  if(result.selection===groups.length)return showResearchTree(player,block,key);
  const group=groups[result.selection];
  if(group)return showEquipmentGroup(player,block,key,group);
}
async function showEquipmentGroup(player,block,key,group) {
  const entries=EQUIPMENT_CATALOG.filter(entry=>entry.tech===group.tech);
  const form=new ActionFormData().title(group.name).body(
    research.isUnlocked(group.tech,player)?"設備を選ぶと必要な材料を確認できます。":"未研究。設備を選ぶと必要な研究と材料を確認できます。");
  for(const entry of entries){
    const missing=entry.in.some(([id,n])=>!id.startsWith("tag:")&&countItem(player,id)<n);
    const state=!research.isUnlocked(entry.tech,player)?"未研究":entry.manual?"作業台で製作":missing?"素材不足":"製作可能";
    const icon=MACHINES[entry.item]?.icon??ITEM_TEXTURES[entry.item]??iconOf(entry.item);
    form.button(nameOf(entry.item)+" ×"+entry.count+"\n"+state,icon);
  }
  form.button("設備製作へ戻る");
  const result=await form.show(player);
  if(result.canceled||(block&&!sameMachine(block,`${NS}:research_lab`)))return;
  if(result.selection===entries.length)return showEquipmentCatalog(player,block,key);
  const entry=entries[result.selection];
  if(entry)return showEquipmentDetail(player,entry,block,key,group);
}
async function showEquipmentDetail(player,entry,block,key,group){
  const locked=!research.isUnlocked(entry.tech,player);
  const ingredientName=id=>id==="tag:minecraft:planks"?"板材（種類自由）":nameOf(id);
  const needs=entry.in.map(([id,n])=>ingredientName(id)+" ×"+n+(id.startsWith("tag:")?"":" / 所持 "+countItem(player,id))).join("\n");
  const form=new ActionFormData().title(nameOf(entry.item)+"の製作")
    .body("完成数 "+entry.count+"個\n"+(entry.tech?"必要研究 "+research.technology(entry.tech).name:"最初から使用可能・研究不要")+"\n\n"+needs+
      (entry.detail?"\n\n"+entry.detail:"")+
      (entry.manual?"\n\n作業台のレシピブックから製作してください。":"\n\n製作を押すと持ち物から材料を消費します。"));
  if(locked)form.button("必要な研究を開く");
  else if(entry.manual)form.button("研究の進め方");
  else form.button(entry.in.every(([id,n])=>countItem(player,id)>=n)?"製作する":"素材不足 · 材料を確認");
  form.button("この研究の設備一覧へ").button("研究ツリーへ");
  const result=await form.show(player);
  if(result.canceled||(block&&!sameMachine(block,`${NS}:research_lab`)))return;
  if(result.selection===2)return showResearchTree(player,block,key);
  if(result.selection===0){
    if(locked)return showResearchDetail(player,entry.tech,block,key);
    if(entry.manual)return showResearchGuide(player);
    if(!entry.manual&&research.isUnlocked(entry.tech,player)&&entry.in.every(([id,n])=>countItem(player,id)>=n)){
      for(const [id,n] of entry.in)removeItems(player,id,n);
      giveItems(player,entry.item,entry.count);toast(player,nameOf(entry.item)+"を製作しました");
    }
  }
  return showEquipmentGroup(player,block,key,group);
}
async function showScienceRecipes(player,block,key) {
  const recipes=orderedRecipes(PROCESS_RECIPES.filter(recipe=>SCIENCE_PACKS.some(id=>recipe.out.some(([out])=>out===id))));
  return showRecipeTree(player,recipes,"研究パックの作り方",block,key);
}

function tickPort(m, block, st, previousBurnDue) {
  const container=machineContainer(block,m.key);
  if (!container) return;
  if (!research.allowsMachine(m.type,m)) { updateGauges(container,m,st); return; }
  if (m.type===`${NS}:research_lab`) { updateGauges(container,m,st); return; }
  if (m.type===`${NS}:coal_generator`) consolidateGeneratorSlots(container);
  if (m.type===`${NS}:crusher`) consolidateCrusherSlots(container);
  updateGauges(container, m, st);
  if (m.type===`${NS}:crusher`) {
    if (st.job) {
      if(Date.now()<st.job.readyAt)pokeCrusherAnim(block,st.job.speed,st.job.readyAt);
      if (Date.now()<st.job.readyAt) {
        try { block.dimension.spawnParticle(`${NS}:debris_${debrisKind(st.job.input)}`, {x:m.x+.5, y:m.y+1.15, z:m.z+.5}); } catch {}
        try {
          const [vx, vz] = CRUSHER_VENT[block.permutation.getState("minecraft:cardinal_direction")] ?? CRUSHER_VENT.north;
          block.dimension.spawnParticle(`${NS}:steam`, {x:m.x+vx, y:m.y+1.88, z:m.z+vz});
        } catch {}
      }
    } else {
      activeCrushers.delete(m.key);
      try { const perm = block.permutation; if (perm.getState(`${NS}:gear_phase`)) block.setPermutation(perm.withState(`${NS}:gear_phase`, 0)); } catch {}
    }
  }
  if (m.type===`${NS}:coal_generator`) {
    if (st.burn) return;
    const f=FUELS.find(([id,n])=>generatorCapacity(m.key)-generatorRecord(m.key).stored>=n && countSlots(container,id)>0);
    if (!f) return;
    takeSlots(container,f[0],1);
    const speed=speedLimit(m.key), duration=f[1]*100/speed;
    st.burn={val:f[1],duration,speed,until:scheduledStart(previousBurnDue,Date.now())+duration};
  } else if (m.type===`${NS}:fixed_drill`) {
    if (!st.buffer || !Object.keys(st.buffer).length) return;
    for (const [id,n] of Object.entries(st.buffer)) {
      const rest=putSlots(container,id,n);
      if (rest) st.buffer[id]=rest; else delete st.buffer[id];
    }
  } else return;
  saveMachineState(m.key,st);
}

const RECIPES_BY_MACHINE = new Map();
for (const r of PROCESS_RECIPES) {
  const k = `${NS}:${r.machine}`;
  if (!RECIPES_BY_MACHINE.has(k)) RECIPES_BY_MACHINE.set(k, []);
  RECIPES_BY_MACHINE.get(k).push(r);
}
const processorPoll = new Map();
function processAt(m,block,st,now) {
  if(m.type===ASSEMBLER && st.job?.out?.some(([id])=>id===`${NS}:orbital_blade`)){
    delete st.job;
    saveMachineState(m.key,st);
  }
  if(st.job && st.job.readyAt>now)return st.job.readyAt;
  const previousDue=st.job?.readyAt;
  const container=machineContainer(block,m.key);
  if(!container)return now+500;
  if(st.job) {
    if(st.job.fluidsOut?.length){
      if(!fluidSystem.completeOutputs(m,st.job.fluidsOut))return now+500;
      st.job.fluidsOut=[];
      saveMachineState(m.key,st);
    }
    st.job.out=st.job.out.map(([id,n])=>[id,putSlots(container,id,n)]).filter(([,n])=>n>0);
    if(st.job.out.length){saveMachineState(m.key,st);return now+500;}
    delete st.job;
    saveMachineState(m.key,st);
    dpSet("of:total_processed",Number(dpGet("of:total_processed",0))+1);
    try { block.dimension.playSound("dig.stone",{x:block.location.x+.5,y:block.location.y+.5,z:block.location.z+.5},{volume:.9,pitch:.95}); } catch {}
  }
  if(st.selectedRecipe==="orbital_blade")delete st.selectedRecipe;
  const power=expansion.availablePower(m.key);
  // この呼び出しの中ではコンテナは変わらないので、材料スロット (0..17) を1回だけ読んで数える
  // (従来はレシピ候補ごとに countSlots が最大18スロットを読み直していた)
  const slotSnapshot=[];
  for (let i=0;i<Math.min(18,container.size);i++) { const it=container.getItem(i); if (it) slotSnapshot.push([it.typeId,it.amount]); }
  const countInSnapshot=id=>{ let n=0; for (const [t,a] of slotSnapshot) if (t===id) n+=a; return n; };
  const candidates=RECIPES_BY_MACHINE.get(m.type)??[];
  const recipe=candidates.find(r=>
    (!st.selectedRecipe||r.id===st.selectedRecipe||r.variantOf===st.selectedRecipe) && r.energy<=power &&
    research.allowsRecipe(r,m) && r.in.every(([id,n])=>countInSnapshot(id)>=n) && fluidSystem.availableRecipe(m,r));
  if(!recipe){
    // 材料はそろっているのに電力だけ足りない場合は、電力パネルの「不足」に計上する
    const want=candidates.find(r=>(!st.selectedRecipe||r.id===st.selectedRecipe||r.variantOf===st.selectedRecipe)&&r.energy>power&&
      research.allowsRecipe(r,m)&&r.in.every(([id,n])=>countInSnapshot(id)>=n));
    if(want)noteShort(m.key,want.energy-power);
    return now+500;
  }
  const speed=affordableSpeed(speedLimit(m.key),power,value=>processingCost(recipe,value).energy);
  if(!speed){checkShort(m.key,processingCost(recipe,1).energy,power);return now+500;}
  const cost=processingCost(recipe,speed);
  if(!fluidSystem.consumeRecipe(m,recipe)||!expansion.spend(m.key,cost.energy))return now+500;
  for(const [id,n] of recipe.in)takeSlots(container,id,n);
  const start=scheduledStart(previousDue,now);
  st.job={recipeId:recipe.id,label:recipe.label,out:recipe.out,fluidsOut:recipe.fluidsOut??[],
    input:recipe.in[0]?.[0],startedAt:start,readyAt:start+cost.sec*1000,port:true,speed};
  saveMachineState(m.key,st);
  if(m.type===`${NS}:crusher`)pokeCrusherAnim(block,speed,st.job.readyAt);
  return st.job.readyAt;
}

// The flight and reusable hull are world state, independent of the blocks and their inventories.
const launchPadType=`${NS}:launch_pad`;
const landingPadType=`${NS}:landing_pad`;
const terminalType=`${NS}:orbital_terminal`;
const missions=[
  {name:"隕石帯",cargo:ROCKET1.firstCargo},
  {name:"氷小惑星",cargo:[[`${NS}:vacuum_ice`,8],[`${NS}:iridium`,8]]},
  {name:"深宇宙",cargo:[[`${NS}:phase_stone`,10],[`${NS}:orbital_crystal`,8]]},
];
const rocketStage=p=>Number(pGet(p,"of:rocket_stage",0));
const playerStage=p=>orbitalFoundry.hasCompleted(p)?6:rocketStage(p)>=4 && pGet(p,"of:boss_rank",0)>0?5:rocketStage(p);
function rocketRecord(key) {
  try { return JSON.parse(dpGet(key,"null")); } catch { return null; }
}
const personalFlights=()=>rocketRecord("of:rocket_flights")??[];
const playerFlight=p=>personalFlights().find(f=>f.owner===p.id);
function legacyRocketFlights() {
  const flights=[];
  const current=rocketRecord("of:rocket");
  if (current) {
    if (migrateTimer(current,"readyAt",gameClock)) dpSet("of:rocket",JSON.stringify(current));
    flights.push({...current,legacyKey:"of:rocket"});
  }
  const legacy=rocketRecord("of:orbit");
  if (legacy) {
    if (migrateTimer(legacy,"ready",gameClock)) dpSet("of:orbit",JSON.stringify(legacy));
    flights.push({legacyKey:"of:orbit",orbital:true,readyAt:legacy.ready,
      cargo:legacy.cargo.map(([id,n])=>[`${NS}:${id}`,n])});
  }
  return flights;
}
const rocketFlights=()=>[...personalFlights(),...legacyRocketFlights()];
const rocketHome=p=>pGet(p,"of:rocket_home","");
function setRocketHome(p,key) {
  pSet(p,"of:rocket_home",key);
  saveMachineState(key,{...machineState(key),rocketParked:true});
}
const rocketPlan=p=>pGet(p,"of:rocket_plan",-1);
const rocketDestination=flight=>flight.foundryConstruction?"軌道工廠の建設便":missions[flight.mission]?.name??(flight.orbital?"軌道便":"初号機");
const cargoText=cargo=>cargo.map(([id,n])=>`${nameOf(id)} ×${n}`);
function registeredPad(key,type) {
  const pad=registry().find(m=>m.key===key&&m.type===type);
  if (!pad) return;
  try {
    const block=world.getDimension(pad.dim).getBlock(pad);
    if (block && block.typeId!==type) return;
  } catch {} // A registered pad in an unloaded chunk is still the assigned pad.
  return pad;
}
function orbitPropellant(p) {
  const fuel=`${NS}:rocket_fuel`, ice=`${NS}:vacuum_ice`;
  if (countItem(p,fuel)>=ORBIT.orbitFuel) return [fuel,ORBIT.orbitFuel];
  if (countItem(p,ice)>=ORBIT.orbitIceFuel) return [ice,ORBIT.orbitIceFuel];
}
const orbitFuelText=()=>`ロケット燃料×${ORBIT.orbitFuel} または真空氷×${ORBIT.orbitIceFuel}`;

function launchRocket(p,block,key,shownStage,shownPlan) {
  if (playerFlight(p)) return "あなたの前の便が飛行中か、貨物が未回収です";
  if (rocketFlights().some(f=>f.key===key)) return "この発射台は別の便が使っています";
  const orbital=rocketStage(p)>=3;
  if (orbital!==(shownStage>=3)) return "運航状況が変わりました。発射画面を確認してください";
  const plan=rocketPlan(p);
  const construction=orbital && plan===CONSTRUCTION_PLAN;
  const mission=missions[plan];
  if (orbital && ((!mission&&!construction) || plan!==shownPlan || !research.isUnlocked("orbital_industry",p)))
    return "軌道ターミナルで行き先を指定し、発射画面で確認してください";
  if(construction){
    const issue=orbitalFoundry.cargoIssue(p);
    if(issue)return issue;
  }
  const home=registeredPad(rocketHome(p),launchPadType);
  if (orbital && home && home.key!==key) return "機体が待機している発射台を使ってください";
  const site=rocketScene.inspect(block,true);
  if (site.reason) return site.reason;
  const landing=rocketScene.landingPad(block.dimension);
  if (!landing) return "同じディメンションに空いている着陸台が必要です。使用状況と区画・上空を確認してください";
  const propellant=orbital?orbitPropellant(p):undefined;
  const source=orbital?undefined:machineContainer(block,key);
  if (orbital && !propellant) return `持ち物に ${orbitFuelText()} が必要です`;
  if (!orbital && (!source || !ROCKET_COST.every(([id,n])=>countSlots(source,id)>=n)))
    return "ロケットの材料が不足しています";
  const speed=speedLimit(key);
  const energy=ROCKET1.launchEnergy*speed;
  expansion.updateNetwork(registry());
  if (!expansion.spend(key,energy,false)) return `電力不足 · 発射台につないだ発電網に ${energy} SE が必要です`;
  if (orbital) removeItems(p,...propellant);
  else for (const [id,n] of ROCKET_COST) takeSlots(source,id,n);
  const seconds=(orbital?ORBIT.orbitSeconds:ROCKET1.firstFlightSec)/speed;
  const flight={owner:p.id,key,landing:landing.key,readyAt:gameClock.now()+seconds*1000,clock:"game",
    cargo:construction?[]:orbital?mission.cargo:ROCKET1.firstCargo,orbital,foundryConstruction:construction||undefined,mission:orbital&&!construction?plan:undefined,
    speed,startedAt:rocketScene.now(),launchSite:{...site.center,dim:block.dimension.id}};
  dpSet("of:rocket_flights",JSON.stringify([...personalFlights(),flight]));
  pSet(p,"of:rocket_plan",undefined);
  rocketScene.launchAudio(flight);
  setBlockActive(block,block.typeId,key,true);
}

function canUnload(flight,block,key) {
  if (flight.landing===key) return true;
  if (flight.launchSite?.dim && flight.launchSite.dim!==block.dimension.id) return false;
  return !registeredPad(flight.landing,landingPadType)
    && !rocketFlights().some(other=>other.landing===key);
}
function visibleFlight(p,block,key) {
  return playerFlight(p)??legacyRocketFlights().find(f=>
    !block || (block.typeId===landingPadType&&canUnload(f,block,key)) || f.key===key);
}

async function showRocket(p,block,key) {
  const type=block?.typeId;
  const launch=type===launchPadType, land=type===landingPadType;
  const flight=visibleFlight(p,block,key), stage=rocketStage(p), plan=rocketPlan(p);
  const form=createForm().title(launch?"発射台":land?"着陸台":"ロケット運航状況");
  const actions=[];
  const button=(action,label,icon)=>{ form.button(label,icon); actions.push(action); };
  if (flight) {
    const ready=gameClock.now()>=flight.readyAt;
    const landing=registeredPad(flight.landing,landingPadType);
    const landingText=landing?`着陸台 ${landing.x}, ${landing.y}, ${landing.z}`:"設置済みの着陸台";
    form.body(`${rocketDestination(flight)}\n${ready?"帰還済み · 荷下ろし待ち":`飛行中 · 残り ${Math.ceil((flight.readyAt-gameClock.now())/1000)}秒`}\n${landingText}\n\n${flight.foundryConstruction?"貨物：軌道工廠の建設資材":cargoText(flight.cargo).join("\n")}`);
    if (ready && land && canUnload(flight,block,key)) button("claim",flight.foundryConstruction?"建設資材の搬入完了を確認":"荷下ろし・貨物を回収","textures/items/orbital_crystal");
  } else if (block && rocketFlights().some(f=>launch?f.key===key:f.landing===key)) {
    form.body("この設備は別のプレイヤーの便が使っています");
  } else if (launch) {
    const plot=rocketScene.inspect(block);
    const orbital=stage>=3;
    const energy=ROCKET1.launchEnergy*speedLimit(key);
    const power=expansion.availablePower(key,false);
    const landing=rocketScene.landingPad(block.dimension);
    const status=`奥側の3×3区画 · ${plot.reason??"使用可能"}\n飛行速度 ${speedLimit(key)}倍\n発射電力 ${power} / ${energy} SE\n着陸台 · ${landing?"確認済み":"未設置・使用中・区画に障害物"}`;
    if (orbital) {
      const home=registeredPad(rocketHome(p),launchPadType);
      const construction=plan===CONSTRUCTION_PLAN;
      const mission=construction?{name:"軌道工廠の建設便",cargo:FOUNDRY_CARGO}:missions[plan];
      const propellant=orbitPropellant(p);
      const fuelStatus=propellant?`使用する推進剤 · ${nameOf(propellant[0])}×${propellant[1]}`:`推進剤不足 · ${orbitFuelText()}`;
      if (home && home.key!==key) form.body(`機体は別の発射台で待機中です。\n座標 ${home.x}, ${home.y}, ${home.z}`);
      else {
        form.body(`${mission?`行き先 · ${mission.name}\n貨物 · ${cargoText(mission.cargo).join(" / ")}\n${fuelStatus}`:"軌道ターミナルで次の行き先を指定してください。"}\n\n${status}`);
        if(construction && orbitalFoundry.cargoIssue(p))button("refresh","建設条件を確認してください");
        else if (mission) button("launch",`${mission.name}へ発射`,"textures/blocks/launch_pad");
      }
    } else {
      const port=machineContainer(block,key);
      const materials=ROCKET_COST.map(([id,n])=>`${nameOf(id)}  ${port?countSlots(port,id):0} / ${n}`).join("\n");
      form.body(`行き先 · 初号機の試験飛行\n${status}\n\n${materials}\n\n資材を投入すると機体が段階的に組み上がります。`);
      button("launch","初号機を打ち上げる","textures/blocks/launch_pad");
      button("port","機械の在庫・資材を入れる");
    }
  } else if (land) {
    const plot=rocketScene.inspect(block);
    form.body(`待機中 · 奥側の3×3区画\n${plot.reason??"着陸可能"}`);
  } else form.body("飛行中のロケットはありません");
  for(const offer of orbitalFoundry.rewardList(p,block)) {
    button("foundry:"+offer.kind,offer.label+"\n"+cargoText(offer.cargo).join(" / "),
      "textures/items/"+offer.cargo[0][0].split(":")[1]);
  }
  button("refresh","状態を更新");
  button("close","閉じる");
  const result=await form.show(p);
  if (result.canceled || (block && !sameMachine(block,type))) return;
  const action=actions[result.selection];
  if(action?.startsWith("foundry:")){
    if(orbitalFoundry.claimReward(p,block,action.slice("foundry:".length)))toast(p,"軌道工廠の貨物を回収しました");
    return showRocket(p,block,key);
  }
  if (action==="port") return showMachineStock(p,block,key,showRocket);
  if (action==="launch") {
    if (!research.isUnlocked("rocketry",p)) return showResearchDetail(p,"rocketry");
    const reason=launchRocket(p,block,key,stage,plan);
    if (reason) toast(p,reason);
  }
  if (action==="claim") {
    const current=visibleFlight(p,block,key);
    if (!current || JSON.stringify(current)!==JSON.stringify(flight) ||
        gameClock.now()<current.readyAt || !canUnload(current,block,key)) return;
    if(current.foundryConstruction){
      if(!orbitalFoundry.acceptConstruction(p,current))return;
    }else for (const [id,n] of current.cargo) giveItems(p,id,n);
    const personalLevel=current.orbital?(current.legacyKey&&rocketStage(p)<3?0:4):3;
    pSet(p,"of:rocket_stage",Math.max(rocketStage(p),personalLevel));
    const home=registeredPad(current.key??rocketHome(p),launchPadType)??rocketScene.launchPad(block.dimension);
    const returnsHome=home && rocketStage(p)>=3;
    if (returnsHome) setRocketHome(p,home.key);
    if (current.legacyKey) dpSet(current.legacyKey,undefined);
    else dpSet("of:rocket_flights",JSON.stringify(personalFlights().filter(f=>f.owner!==p.id)));
    rocketScene.forget(current.landing??key);
    toast(p,current.foundryConstruction?"軌道への搬入完了。軌道ターミナルから工廠を起動できます":returnsHome?"貨物を回収しました。ロケットは発射台へ戻ります":"貨物を回収しました");
  }
  if (["launch","claim","refresh"].includes(action)) return showRocket(p,block,key);
}

async function showOrbitalTerminal(p,block) {
  const form=createForm().title("軌道ターミナル");
  const flight=playerFlight(p), plan=rocketPlan(p), stage=rocketStage(p);
  const normalChoices=stage>=3&&!flight?missions.length:0;
  if (stage<3) form.body("自分の初号機の帰還貨物を着陸台で荷下ろしすると解放されます");
  else if (flight) form.body(`${rocketDestination(flight)} · ${gameClock.now()>=flight.readyAt?"着陸台で荷下ろしできます":"飛行中"}`);
  else {
    const home=registeredPad(rocketHome(p),launchPadType);
    const current=plan===CONSTRUCTION_PLAN?{name:"軌道工廠の建設便"}:missions[plan];
    const homeText=home?`発射台 ${home.x}, ${home.y}, ${home.z}\n`:"";
    form.body(`${homeText}${current?`選択中 · ${current.name}\n`:""}行き先を指定し、発射台を右クリックして発射してください。\n発射時に ${orbitFuelText()} と ${ROCKET1.launchEnergy} SE を使います。`);
    for (const {name,cargo} of missions) form.button(`${name}\n${cargoText(cargo).join(" / ")}`,`textures/items/${cargo[0][0].split(":")[1]}`);
  }
  form.button("軌道工廠の建設・運用","textures/items/foundry_frame");
  form.button("閉じる");
  const result=await form.show(p);
  if (result.canceled || !sameMachine(block,terminalType))return;
  if(result.selection===normalChoices)return orbitalFoundry.show(p,block,showOrbitalTerminal);
  if (stage<3 || flight || !missions[result.selection] || playerFlight(p) || !research.isUnlocked("orbital_industry",p)) return;
  selectRocketPlan(p,result.selection,block);
  toast(p,`行き先を「${missions[result.selection].name}」に設定しました。発射台で確認してください`);
}
function selectRocketPlan(p,plan,block) {
  pSet(p,"of:rocket_plan",plan);
  if(plan!==-1 && !registeredPad(rocketHome(p),launchPadType)){
    const home=rocketScene.launchPad(block.dimension);
    if(home)setRocketHome(p,home.key);
  }
}

const rocketScene=installRocketScene({world,system,registry,gameClock,rocketFlights,isParked:key=>!!machineState(key).rocketParked,machineContainer,countSlots,rocketCost:ROCKET_COST});

const expansion = installExpansion({
  world, system, registry, machineState, saveMachineState, legacyEnergy, generatorRecord, generatorCapacity, drawEnergy,
  keyOf, machineContainer, createForm, countItem, removeItems, giveItems, dpGet, dpSet,
  toast, sameMachine, setBlockActive, nameOf, research, rocketStage, pGet, pSet, speedLimit,
});
// 無限発電機: ケーブルでつないだ機械へ、常に満タンの電力を供給する (クリエイティブ専用のデバッグ設備)
system.runInterval(()=>{
  for(const m of registry()){
    if(m.type!==`${NS}:creative_generator`)continue;
    try{
      if(world.getDimension(m.dim).getBlock(m)?.typeId!==m.type)continue;
      const record=generatorRecord(m.key);
      if(record.stored<1e9)saveGeneratorRecord(m.key,{...record,stored:1e9,generated:(record.generated??0)+(1e9-record.stored)});
    }catch{}
  }
},10);
// 大容量コンテナとチャンクデストロイヤー (実インベントリを持たず、数値在庫を物流へ見せる)
const bulk = createBulkStorage({ dpGet, dpSet });
const bulkPack = installBulkPack({ world, system, keyOf, bulk, nameOf });
const bulkMachine = installBulk({ world, system, registry, keyOf, createGridForm: () => createForm(), toast, nameOf, expansion, bulk, dpSet });
const quarry = installQuarry({ world, system, registry, keyOf, dpGet, dpSet, createForm, toast, giveItems, nameOf, research, expansion, speedLimit, switchSpeed });
const orbitalFoundry=installOrbitalFoundry({world,system,gameClock,playerFlight,rocketStage,rocketPlan,
  selectPlan:selectRocketPlan,research,keyOf,expansion,registry,countItem,removeItems,giveItems,nameOf,createForm,sameMachine,toast});
const defense = installDefense({ world, system, registry, keyOf, dpGet, dpSet, createForm, toast, nameOf, expansion, gameClock, countItem, removeItems, speedLimit });
const ofHostile=entity=>Object.hasOwn(DEFENSE.enemy,entity.typeId)||[`${NS}:overseer`,`${NS}:star_wither`].includes(entity.typeId);
const ofDamage=(entity,player,amount,origin)=>{
    if(Object.hasOwn(DEFENSE.enemy,entity.typeId))return defense.hurtEnemy(entity,amount,{cause:"projectile",damagingEntity:player,ofPierce:1},true,origin);
    if(entity.typeId===`${NS}:overseer`)return expansion.hurtOverseer(entity,player,amount,"pierce");
    return pierceHp(entity,player,amount);
  };
// 装甲・耐性・ダメージ軽減を無視して体力を直接削る (ゲリラアドオン等の敵にもそのまま通す)。
// 体力が尽きる一撃だけは、討伐者がプレイヤーになるよう override ダメージでとどめを刺す
function pierceHp(entity,player,amount){
  try{
    const h=entity.getComponent("minecraft:health");if(!h)return entity.applyDamage(amount,{cause:"override",damagingEntity:player});
    const left=h.currentValue-amount;
    if(left>0){h.setCurrentValue(left);try{entity.applyDamage(0.001,{cause:"override",damagingEntity:player});}catch{}return true;}
    try{entity.applyDamage(h.currentValue+100000,{cause:"override",damagingEntity:player});}catch{}
    if(entity.isValid&&h.currentValue>0)try{entity.kill();}catch{}
    return true;
  }catch{try{return entity.kill();}catch{return false;}}
}
installArmorGuard({world,system});
installReactorShellCleanup(world);
const starWither=installStarWither({world,system,toast,hasCompleted:orbitalFoundry.hasCompleted,hasBombard:orbitalFoundry.hasBombard,hostileAddon:ofHostile,damageTarget:ofDamage});
const damageStarforge=(entity,player,amount,origin,attack,lockedPart)=>{
  if(starWither.isBoss(entity))return starWither.hurtBoss(entity,player,amount,origin,attack,lockedPart);
  ofDamage(entity,player,amount,origin);
  return false;
};
const factoryLoader=installFactoryLoader({world,system,registry,dpGet});
// 登録の掃除: 爆発・コマンド・他アドオンなど、プレイヤーが壊した以外の理由で消えた機械を見つけて登録から外す
// (常時読み込みの枠や掘削の予約もこれで解放される)。1秒ごとに最大300件を順番に確認する
let sweepCursor=0;
system.runInterval(()=>{
  const list=registry(); if(!list.length)return;
  const gone=[];
  for(let i=0;i<Math.min(300,list.length);i++){
    const m=list[(sweepCursor+i)%list.length];
    try{
      const b=world.getDimension(m.dim).getBlock({x:m.x,y:m.y,z:m.z});
      if(!b)continue;   // 未読込は判定しない
      if(b.typeId===m.type||(m.type===ASSEMBLER&&b.typeId===LEGACY_CRAFTER))continue;
      gone.push({m,b});
    }catch{}
  }
  sweepCursor=(sweepCursor+300)%Math.max(1,list.length);
  if(!gone.length)return;
  for(const {m,b} of gone){
    const key=m.key;
    try{removeSlotHost(b.dimension,b.location,key);}catch{}
    try{if(GROWER_TIERS[m.type])growing.forget(key);}catch{}
    try{fluidSystem.forget({key});}catch{}
    try{if(QUARRY_TYPES.has(m.type))quarry.forget(key,b.dimension);}catch{}
    if(BATTERIES[m.type])dpSet("of_g:"+key,undefined); lastGeneratorJson.delete(key);
    if(GENERATOR_TYPES.has(m.type)){dpSet("of:energy",legacyEnergy()+generatorRecord(key).stored);dpSet("of_g:"+key,undefined); lastGeneratorJson.delete(key);}
    dpSet("of_speed:"+key,undefined); processorPoll.delete(key);
  }
  const keys=new Set(gone.map(g=>g.m.key));
  saveRegistry(registry().filter(m=>!keys.has(m.key)));
  try{factoryLoader.refresh();}catch{}
},20);
system.afterEvents.scriptEventReceive.subscribe(ev=>{
  if(ev.id!==`${NS}:factory_status`)return;
  const p=ev.sourceEntity; const i=factoryLoader.stats();
  const names=Object.fromEntries(world.getAllPlayers().map(q=>[q.id,q.name]));
  const lines=[`工場の区画 ${i.total}か所 · 常時読み込み ${i.loaded}枠${i.rotating?" (60秒ごとに交代中)":""}`,...Object.entries(i.byOwner).map(([o,n])=>`  ${names[o]??o}: ${n}区画`)];
  try{p?.sendMessage(lines.join("\n"));}catch{}
});
const hud=installHud({world,system,registry,machineName:t=>MACHINES[t]?.name,generatorRecord,generatorCapacity:(key,m)=>generatorBaseCapacity(m?.type),GENERATOR_TYPES,BATTERIES});
// 所有者のない古い機械は、最初に触ったプレイヤーのものにする (電力パネルはプレイヤーごとの集計のため)
world.afterEvents.playerInteractWithBlock?.subscribe(ev=>{
  try{
    const b=ev.block,key=keyOf(b.dimension.id,b.location);
    const list=registry(),m=list.find(x=>x.key===key);
    if(m&&!m.owner&&ev.player){m.owner=ev.player.id;saveRegistry(list);}
  }catch{}
});
installPetWither({world,system,toast,damageTarget:ofDamage,hurtBoss:(e,p,a,o)=>starWither.hurtBoss(e,p,a,o),isBoss:e=>starWither.isBoss(e),hostileAddon:ofHostile});
installAstraea({damageTarget:ofDamage,hurtBoss:(e,p,a,o)=>starWither.hurtBoss(e,p,a,o),isBoss:e=>starWither.isBoss(e)});
installStarforge({world,system,unlocked:orbitalFoundry.hasCompleted,toast,hostileAddon:ofHostile,damageTarget:ofDamage,damageStarforge});
expansion.attachDefense(defense);   // オーバーシア戦の地上部隊

world.beforeEvents.playerBreakBlock?.subscribe(ev=>{
  const type=ev.block?.typeId;
  if(!BULK_TYPES.has(type)&&!QUARRY_TYPES.has(type)&&type!==DEF.terminal&&!GROWER_TIERS[type])return;
  const key=keyOf(ev.block.dimension.id,ev.block.location);
  const reason=GROWER_TIERS[type]?growing.canBreak(key):type===DEF.terminal?defense.canBreak(type,key):BULK_TYPES.has(type)?bulkPack.canBreak(type,key):quarry.canBreak(key);
  if(!reason)return;
  ev.cancel=true;
  const player=ev.player;
  system.run(()=>toast(player,reason));
});
const batteries=installBatteries({world,system,registry,keyOf,research,generatorRecord,saveGeneratorRecord,generatorCapacity,expansion,createForm,sameMachine,toast});
const solar=installSolar({world,system,registry,research,generatorRecord,generatorCapacity,saveGeneratorRecord,setBlockActive,createForm,sameMachine});
const fluidSystem=installFluids({world,system,registry,keyOf,expansion,machineContainer,research,generatorRecord,generatorCapacity,speedLimit,switchSpeed,saveGeneratorRecord,saveRegistry,removeSlotHost,createForm,nameOf,toast,countItem,removeItems,giveItems,onState:(m,b)=>{const c=machineContainer(b,m.key);if(c)updateGauges(c,m,machineState(m.key));}});
const growing = installGrowing({world,registry,keyOf,dpGet,dpSet,createForm,toast,giveItems,countItem,removeItems,research,expansion,fluidSystem,sameMachine});
const mobWorks=installMobWorks({world,system,registry,expansion,speedLimit,research,generatorRecord,saveGeneratorRecord,generatorCapacity,setBlockActive,createForm,sameMachine,toast,nameOf,dpGet,dpSet});
expansion.setVirtualStorage((block,key,output)=>{
  if (GROWER_TIERS[block.typeId]) return growing.view(block,key,output);
  if (MOBWORKS_TYPES.includes(block.typeId)) return mobWorks.view(block,key,output);
  return bulk.view(block,key,output)??quarry.view(block,key,output)??defense.view(block,key,output);
},[...BULK_TYPES,...QUARRY_TYPES,...TURRET_TYPES,...Object.keys(GROWER_TIERS),...MOBWORKS_TYPES]);
installMachineVisuals({world, system, registry, machineState, desiredActive, visualSpeed, chargeFraction:key=>generatorRecord(key).stored/generatorCapacity(key)});
installMachineProductDisplay({world, system, registry, machineState, desiredActive});
// ---------- 分割処理ループ (毎tick全走査しない) ----------
let cursor = 0;
let fastMachines=[];
system.runInterval(()=>{
  const now=Date.now();
  for(const m of fastMachines){
    if((processorPoll.get(m.key)??0)>now)continue;
    processorPoll.set(m.key,now+500);
    // 軽量モード: 近くにプレイヤーがいない機械は最短5秒おきに処理し、その間に終わったはずの作業をまとめて進める
    const far=!nearMachine(m);
    if(far)SCHED.tolerance=LOD.farMs+2000;
    try{
      if(!research.allowsMachine(m.type,m))continue;
      const block=world.getDimension(m.dim).getBlock(m);
      if(block?.typeId!==m.type)continue;
      if(PROCESSOR_IDS.has(m.type)){
        let due=processAt(m,block,machineState(m.key),now);
        for(let k=0;far&&due<=now&&k<LOD.catchUp;k++)due=processAt(m,block,machineState(m.key),now);
        processorPoll.set(m.key,far?Math.max(due,now+LOD.farMs):due);
      }
      else if(m.type===`${NS}:research_lab`){
        const container=machineContainer(block,m.key);
        if(container)tickResearchLab(m.key,container,far);
        processorPoll.set(m.key,now+(far?LOD.farMs:50));
      }else{
        const st=machineState(m.key);
        if(m.type===`${NS}:coal_generator`){
          const previousBurnDue=st.burn?.until;
          settleGenerator(m.key,st);
          tickPort(m,block,st,previousBurnDue);
          const active=!!st.burn && st.burn.until>now;
          if(!far){setBlockActive(block,m.type,m.key,active);updateGeneratorVisual(block,active,st.burn?.until);}
          processorPoll.set(m.key,st.burn ? Math.max(now+(far?1000:50),st.burn.until) : now+(far?LOD.farMs:500));
        }else {
          expansion.tickFast(m,block,st);
          if(far&&m.type===`${NS}:fixed_drill`)for(let k=0;k<LOD.catchUp&&(machineState(m.key).nextMine??Infinity)<=now;k++){const before=machineState(m.key).nextMine;expansion.tickFast(m,block,machineState(m.key));if(machineState(m.key).nextMine===before)break;}
          const due=m.type===`${NS}:fixed_drill`?machineState(m.key).nextMine:undefined;
          processorPoll.set(m.key,Math.max(now+(far?LOD.farMs:50),due??0));
        }
      }
    }catch(error){console.warn("[Orbital Foundry] machine cycle: "+error);}
    finally{SCHED.tolerance=100;}
  }
},1);
system.runInterval(() => {
  const list = registry();
  fastMachines=list.filter(m=>PROCESSOR_IDS.has(m.type)||["research_lab","coal_generator","fixed_drill"].some(name=>m.type===`${NS}:${name}`));
  const liveKeys=new Set(fastMachines.map(m=>m.key));
  for(const key of processorPoll.keys())if(!liveKeys.has(key))processorPoll.delete(key);
  if (!list.length) return;
  expansion.updateNetwork(list);
  batteries.tick(list);
  const batch = 6; // 1秒あたり最大でも登録の一部だけを見る
  for (let i = 0; i < Math.min(batch, list.length); i++) {
    const m = list[(cursor + i) % list.length]; const key = m.key; const st = machineState(key);
    try { const b = world.getDimension(m.dim).getBlock({ x: m.x, y: m.y, z: m.z });
      if (!b) continue;
      if (b.typeId === LEGACY_CRAFTER) {
        upgradeLegacyCrafter(b, key);
        continue; // The next network update reads the new block type.
      }
      if (b.typeId !== m.type) {
        if (GROWER_TIERS[m.type]) { growing.forget(key); fluidSystem.forget({key}); }
        removeSlotHost(b.dimension,b.location,key);
        if (BATTERIES[m.type]) dpSet("of_g:"+key,undefined); lastGeneratorJson.delete(key);
        if (GENERATOR_TYPES.has(m.type)) {
          dpSet("of:energy",legacyEnergy()+generatorRecord(key).stored);
          dpSet("of_g:"+key,undefined); lastGeneratorJson.delete(key);
        }
        dpSet("of_speed:"+key,undefined);
        dpSet("of_mod:"+key,undefined);
        saveRegistry(registry().filter(entry=>entry.key!==key));
        continue;
      }
      tickPort(m, b, st);
      if (![`${NS}:conveyor_1`,`${NS}:conveyor_2`,`${NS}:conveyor_3`].includes(m.type) && m.type !== `${NS}:fixed_drill` && !GROWER_TIERS[m.type] && !SOLAR[m.type]) {
        const active=desiredActive(m,st);
        setBlockActive(b,m.type,key,active);
        if (m.type === `${NS}:coal_generator`) updateGeneratorVisual(b,active,st.burn?.until);
      }
      expansion.tick(m,b,st);
    } catch { continue; }
  }
  expansion.tickRemoteDrills(list);
  growing.tick(registry());
  cursor = (cursor + Math.min(batch, list.length)) % Math.max(1, list.length);
}, 20);

// Remove virtual meters leaked by old versions from player inventories.
system.runInterval(()=>{
 for(const player of world.getAllPlayers()){
  const container=inv(player);if(!container)continue;
  for(let i=0;i<container.size;i++)if(isGauge(container.getItem(i)))container.setItem(i,undefined);
 }
},20);
