import { GameMode, ItemStack } from "@minecraft/server";
import { NS } from "./config.js";
import { STARFORGE, STARFORGE_STATS as S } from "./starforge-spec.js";
import { SW_INFO } from "./star_wither.js";

const id=name=>NS+":"+name;
const MODULE=id("starforge_array"), MODULES=new Set([MODULE]), VIEWS=new Set(["armed","firing","cooling","charging","beam"].map(k=>id("starforge_view_"+k))), ARMOR=STARFORGE.filter(piece=>piece.slot);
const HB_DURATION=20000000;
const EFFECTS=[["health_boost",S.boost],["resistance",S.resistance]];
// 部位ごとの常時効果: 頭=暗視・水中呼吸 / 胴=採掘速度 / 脚=水中移動 / 足=火炎耐性(+落下・炎ダメージ無効)
const PIECE_EFFECTS={Head:[["night_vision",0,400,240],["water_breathing",0]],Chest:[["haste",1]],Legs:[["conduit_power",0]],Feet:[["fire_resistance",0]]};
const FIRE=new Set(["fire","fireTick","lava","campfire","magma"]);
const fx=(viewer,effect,at)=>{try{viewer.spawnParticle(id("starforge_"+effect),at);}catch{}};
const sound=(p,key,at,volume=.5,pitch=1)=>{try{p.dimension.playSound(key,at,{volume,pitch});}catch{}};
const plus=(a,b,k=1)=>({x:a.x+b.x*k,y:a.y+b.y*k,z:a.z+b.z*k});
const offset=(x,y,z)=>({x,y,z});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const clamp=(n,max)=>Math.max(-max,Math.min(max,n));
const normalize=v=>{const d=Math.hypot(v.x,v.y,v.z)||1;return offset(v.x/d,v.y/d,v.z/d);};
const cross=(a,b)=>offset(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);

function equipped(player) {
  const slots=player.getComponent("minecraft:equippable");
  return Object.fromEntries(ARMOR.map(piece=>{const t=slots?.getEquipment(piece.slot)?.typeId;return [piece.slot,t===id(piece.id)||(piece.slot==="Chest"&&CHEST_STATES.has(t))];}));
}
const CHEST_STATES=new Set(["armed","firing","cooling"].map(k=>id("starforge_chest_"+k)));
const fullSet=armor=>ARMOR.every(piece=>armor[piece.slot]);

export function dronePositions(eye,direction) {
  const forward=normalize(direction);
  const reference=Math.abs(forward.y)>.97?offset(0,0,-1):offset(0,1,0);
  const right=normalize(cross(forward,reference)),up=normalize(cross(right,forward));
  const center=plus(eye,forward,1.55);
  return [[-1,1],[1,1],[-1,-1],[1,-1]].map(([x,y])=>plus(plus(center,right,.90*x),up,.49*y));
}
// 飛行中の目標速度 (ブロック/tick)。プレイヤーには applyImpulse が効かないので、applyKnockback でこの速度に置き換える
// 前進は「見ている方向」へ (上を見て前進すると上昇、下を見ると降下)。横移動は水平、ジャンプ/しゃがみで上下も足せる
export function flightVelocity(view,motion,up,down,sprint,look) {
  const yaw=view.y*Math.PI/180, pace=sprint?2.76:1.44;
  const pitch=view.x*Math.PI/180;
  const f=look??offset(-Math.sin(yaw)*Math.cos(pitch),-Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch));
  const x=pace*(Math.cos(yaw)*motion.x+f.x*motion.y);
  const z=pace*(Math.sin(yaw)*motion.x+f.z*motion.y);
  const y=pace*f.y*motion.y+(up?.9:down?-.9:0);
  return offset(x,Math.max(-2.6,Math.min(2.6,y)),z);
}

// 4基の配置 (block単位, 右=+x側を左右対称で): [横, 高さ, 前]。一人称でも視界の端に入る位置
const FORMATION=[[-0.85,2.05,0.8],[0.85,2.05,0.8],[-1.15,1.2,0.7],[1.15,1.2,0.7]];
export function formationPositions(loc,yaw,tick) {
  const r=yaw*Math.PI/180, fw=offset(-Math.sin(r),0,Math.cos(r)), rt=offset(-Math.cos(r),0,-Math.sin(r));
  return FORMATION.map(([x,y,z],i)=>plus(plus(offset(loc.x,loc.y+y+.04*Math.sin(tick*.15+i*1.7),loc.z),rt,x),fw,z));
}
const DRONE=id("starforge_drone");
const GUN_PX=[[-12,31,-9],[12,31,-9],[-16,17,-8],[16,17,-8]];
export function gunMuzzles(head,dir){
  const f=normalize(dir), ref=Math.abs(f.y)>.97?offset(0,0,-1):offset(0,1,0);
  const rt=normalize(cross(f,ref)), up=normalize(cross(rt,f));
  return GUN_PX.map(([x,y,z])=>plus(plus(plus(head,rt,x/16),up,(y-27)/16),f,(-z+17)/16));
}
export function installStarforge(core) {
  const {world,system,unlocked,toast,damageTarget,damageStarforge,hostileAddon}=core;
  const live=new Map();
  // 一式を着ていれば誰でも動く (入手の制限は製作側でかける)。以前は「軌道工廠を完成させた本人」だけに効いていた
  const allowed=p=>!!p;
  const fresh=()=>({hurtTick:system.currentTick,flight:false,armed:false,nextShot:0,lastJump:-100,until:0,shield:0});
  function stateOf(p) {
    if(!live.has(p.id))live.set(p.id,fresh());
    return live.get(p.id);
  }
  const carryingModule=p=>{
    const c=p.getComponent("minecraft:inventory")?.container;
    if(!c)return false;
    for(let i=0;i<c.size;i++)if(MODULES.has(c.getItem(i)?.typeId))return true;
    return false;
  };
  function lineOfSight(p,start,target,desired=plus(target.getHeadLocation(),offset(0,-.2,0))) {
    const length=distance(start,desired);
    if(length<.25)return true;
    const hit=p.dimension.getBlockFromRay(start,normalize(plus(desired,start,-1)),
      {maxDistance:Math.max(.1,length-.22),includeLiquidBlocks:false,includePassableBlocks:false});
    return !hit;
  }
  // 他アドオン (ゲリラアドオン等) の敵: 独自の名前空間で、敵らしい種族や名前を持つもの
  const HOSTILE_FAMILIES=["monster","enemy","hostile","guerrilla","soldier","illager","raider","terrorist","zombie","undead"];
  const foreignHostile=e=>{try{const t=e.typeId;if(t.startsWith("minecraft:")||t.startsWith("orbital_foundry:"))return false;
    return HOSTILE_FAMILIES.some(f=>e.matches({families:[f]}))||/enemy|hostile|guerr|soldier|zombie|terror|bandit|insurg/i.test(t);}catch{return false;}};
  const targetOK=(e,p)=>e?.isValid && e.dimension?.id===p.dimension.id && e.typeId!=="minecraft:player" &&
    (hostileAddon(e)||e.matches({families:["monster"]})||foreignHostile(e)) && !e.getComponent("minecraft:tameable")?.isTamed && !!e.getComponent("minecraft:health");
  // 効果は長めに付けて早めに掛け直す (切れ目で最大体力が一瞬下がらないように)
  function chargeEffect(p,effect,amp,dur=240,low=120) {
    try{
    const current=p.getEffect(effect);
    if(!current || current.amplifier<amp || (current.amplifier===amp && current.duration<low))p.addEffect(effect,dur,{amplifier:amp,showParticles:false});
    }catch{}   // 1つの効果の失敗で残りの処理まで止めない
  }
  function clearPieces(p,armor) {
    for(const [slot,list] of Object.entries(PIECE_EFFECTS)){
      if(armor?.[slot])continue;
      for(const [effect,amp,dur=240] of list){
        const current=p.getEffect(effect);
        if(current?.amplifier===amp && current.duration<=dur)p.removeEffect(effect);
      }
    }
  }
  function toggleArray(p,s,tick){
    if(!s.armed&&!freeOffhand(p))return toast(p,"§c持ち物がいっぱいです · 左手の物をしまう空きスロットを1つ作ってください");
    s.armed=!s.armed;s.pressTick=undefined;
    if(s.armed)deployFx(p);else{s.modState=undefined;}s.focus=undefined;s.focusPart=undefined;s.hudTarget=undefined;s.hudPart=undefined;s.target=undefined;s.spin=0;s.deploy=tick;s.nextShot=tick+8;
    fx(p.dimension,"surge",p.location);
    sound(p,s.armed?"beacon.activate":"beacon.deactivate",p.location,.65,s.armed?1.35:1);
    toast(p,s.armed?"四連ガトリング展開 · 長押しでチャージ砲撃 / 左クリックでHUDの対象をロック":"自律砲を格納");
  }
  function chargeContact(p,e,origin,direction){
    const points=[];
    if(e.typeId===id("star_wither")){
      for(const part of ["star","tracker","heavy"]){
        const at=SW_INFO.partLocation(e,part);
        if(at)points.push({at,part});
      }
    }
    points.push({at:plus(e.location,offset(0,.9,0))});
    const minDot=Math.cos(S.chargeAngle*Math.PI/180);
    let contact, closest=minDot-1e-9;
    for(const point of points){
      const delta=plus(point.at,origin,-1);
      const length=Math.hypot(delta.x,delta.y,delta.z);
      if(length>S.chargeRange+1e-9)continue;
      const cosine=length>0?(delta.x*direction.x+delta.y*direction.y+delta.z*direction.z)/length:1;
      if(cosine>=closest&&lineOfSight(p,origin,e,point.at)){
        contact=point;
        closest=cosine+1e-9;
      }
    }
    return contact;
  }
  // チャージ砲撃: 4門の砲口を一点に収束させた貫通ビーム。撃つと強制冷却
  function fireCharge(p,s,tick){
    if((s.coolUntil??0)>tick)return toast(p,"§6冷却中はチャージ砲撃できません");
    const eye=p.getHeadLocation(),dir=normalize(p.getViewDirection());
    let len=S.chargeRange;
    try{const hit=p.getBlockFromViewDirection({maxDistance:S.chargeRange,includeLiquidBlocks:false});if(hit){const b=hit.block.location;len=Math.min(len,distance(eye,offset(b.x+.5,b.y+.5,b.z+.5)));}}catch{}
    const end=plus(eye,dir,len);
    const dim=p.dimension;
    // 候補検索には頭部と座標のずれを見込み、各命中点を円すいで絞る。
    const beamQuery={location:eye,maxDistance:S.chargeRange+10,excludeTypes:["minecraft:player"]};
    const hitSet=new Set();
    function hitChargeTargets(){
      let brokeRegen=false;
      for(const e of dim.getEntities(beamQuery)){
        if(hitSet.has(e.id)||!targetOK(e,p))continue;
        const contact=chargeContact(p,e,eye,dir);
        if(!contact)continue;
        hitSet.add(e.id);
        if(damageStarforge(e,p,S.chargeDamage,eye,"charge",contact.part))brokeRegen=true;
        fx(dim,"impact",contact.at);
      }
      return brokeRegen;
    }
    const fullCooldown=Math.round(S.gatlingCool*S.chargeCoolMul);
    const followupCooldown=20;
    let brokeRegen=false;
    try{brokeRegen=hitChargeTargets();}catch{}
    try{for(const e of dim.getEntities({location:end,maxDistance:S.chargeBlast,excludeTypes:["minecraft:player"]}))if(targetOK(e,p)&&!hitSet.has(e.id)&&distance(eye,e.location)<=S.chargeRange)damageTarget(e,p,S.chargeBlastDamage,end);}catch{}
    // ビームは一定時間照射し続ける (撃った瞬間の向きのまま)。照射中に線上へ入った敵にも1回ずつ当たる
    s.beamUntil=tick+S.chargeBeamTicks;
    const ref=Math.abs(dir.y)>.97?offset(0,0,-1):offset(0,1,0),brt=normalize(cross(dir,ref)),bup=normalize(cross(brt,dir));
    const ringAt=(c,r,n,name)=>{for(let q=0;q<n;q++){const a=q*2*Math.PI/n;fx(dim,name,plus(plus(c,brt,Math.cos(a)*r),bup,Math.sin(a)*r));}};
    vanilla(p,"minecraft:sonic_explosion",plus(eye,dir,3));vanilla(p,"minecraft:huge_explosion_emitter",end);
    for(let q=0;q<4;q++)system.runTimeout(()=>{try{ringAt(plus(eye,dir,3.4+q*1.2),1+q*1.1,14+q*4,"surge");}catch{}},q*2);
    for(let f=0;f<S.chargeBeamTicks;f+=2)system.runTimeout(()=>{try{
      if(!p.isValid||p.dimension.id!==dim.id)return;
      const head=plus(p.location,offset(0,1.5,0)),fresh=f===0;
      const focus=plus(eye,dir,Math.min(4,len));
      for(const m of gunMuzzles(head,dir)){for(let k=1;k<6;k++)fx(dim,"tracer",plus(m,plus(focus,m,-1),k/6));if(fresh||f%6===0)fx(dim,"muzzle",m);}
      const n=Math.min(110,Math.round(len*1.8)),fade=1-f/S.chargeBeamTicks;
      for(let k=0;k<=n;k++){
        const at=plus(focus,plus(end,focus,-1),k/n);fx(dim,"tracer",at);
        if(k%3===(f/2)%3){const sp=S.chargeWidth*.55*fade,a=(k*.9+f*.7);
          fx(dim,"surge",plus(at,offset(Math.cos(a)*sp,Math.sin(a)*sp,Math.sin(a*1.3)*sp)));}
      }
      if(f%4===0){fx(dim,"impact",end);fx(dim,"surge",end);vanilla(p,"orbital_foundry:overseer_sparks",end);}
      // 進んでいく衝撃波リング
      {const d=((f*5)%Math.max(8,len));ringAt(plus(focus,dir,d),S.chargeWidth*.8*fade+.4,16,"tracer");}
      if(f%6===0){ringAt(end,1.5+f*.12,20,"surge");vanilla(p,"minecraft:large_explosion",plus(end,offset(Math.random()*4-2,Math.random()*3-1,Math.random()*4-2)));}
      if(f%10===0)shake(p,.08*fade+.02,.3);
      if(f>0&&hitChargeTargets()&&s.coolUntil===tick+fullCooldown){
        s.coolDuration=Math.min(s.coolUntil-system.currentTick,followupCooldown);
        s.coolUntil=system.currentTick+s.coolDuration;
      }
      if(f%8===0)sound(p,"beacon.ambient",p.location,.8,2);
    }catch{}},f);
    for(let k=0;k<6;k++)system.runTimeout(()=>{try{fx(p.dimension,"impact",plus(end,offset(Math.random()*3-1.5,Math.random()*3-1.5,Math.random()*3-1.5)));fx(p.dimension,"surge",end);}catch{}},k*2);
    sound(p,"mob.warden.sonic_boom",p.location,1,.8);sound(p,"random.explode",end,1.2,.6);sound(p,"ambient.weather.thunder",p.location,.6,1.6);
    shake(p,.3,.7);
    try{p.applyKnockback({x:-dir.x*.9,z:-dir.z*.9},.15);}catch{}
    // 回復を止めた時は4秒の猶予内に四連砲で追撃できる。
    s.coolDuration=brokeRegen?followupCooldown:fullCooldown;
    s.heat=S.gatlingHeatMax;s.coolUntil=tick+s.coolDuration;s.spin=0;
    toast(p,`§bチャージ砲撃 · ${hitSet.size}体に命中 · ${brokeRegen?"星炉の回復停止":"強制冷却"}`);
  }
  function shutdown(p,s) {
    if(s.powered){
      for(const [effect,amp] of EFFECTS){
        const current=p.getEffect(effect);
        if(current?.amplifier===amp && (effect==="health_boost"||current.duration<=240))p.removeEffect(effect);
      }
    }
    clearPieces(p,{});
    if(s.gunState){swapChest(p,null);cockpit(p,s,null);}
    live.delete(p.id);
  }

  try {
    system.beforeEvents.startup.subscribe(({itemComponentRegistry})=>{
      const onUse=({source:p,itemStack})=>{
        if(p?.typeId!=="minecraft:player" || !MODULES.has(itemStack?.typeId))return;
        if(!allowed(p)||!fullSet(equipped(p)))return toast(p,"星炉外骨格を4部位すべて装備すると使えます");
        const s=stateOf(p), tick=system.currentTick;
        if(s.lastUse!==undefined && tick-s.lastUse<6)return;
        s.lastUse=tick;
        if(p.isSneaking && s.armed){
          if(s.until<=tick){
            s.shield=tick+40;s.until=tick+500;
            fx(p.dimension,"surge",p.getHeadLocation());
            sound(p,"beacon.activate",p.location,.7,1.5);
            toast(p,"防護フィールド展開 · 2秒");
          }
        }else if(!s.armed)toggleArray(p,s,tick);
        else s.pressTick=tick;   // 展開中: 短押し=格納 / 長押し=チャージ砲撃 (離した時に判定)
      };
      itemComponentRegistry.registerCustomComponent(id("starforge_control"),{onUse,onUseOn:onUse});
      world.afterEvents.itemStopUse.subscribe(({source:p,itemStack})=>{try{
        if(p?.typeId!=="minecraft:player")return;
        const s=live.get(p.id);if(!s?.pressTick)return;
        const tick=system.currentTick,held=tick-s.pressTick;s.pressTick=undefined;
        if(!s.armed)return;
        if(held<S.tapTicks)return toggleArray(p,s,tick);
        if(held>=S.chargeTicks)return fireCharge(p,s,tick);
        sound(p,"beacon.deactivate",p.location,.5,1.8);toast(p,"§7チャージ不足 · "+(S.chargeTicks/20)+"秒溜めてから離す");
      }catch{}});
    });
  } catch {}

  function lockTarget(p){
    const s=live.get(p.id);
    if(!s?.armed||!fullSet(equipped(p)))return;
    const target=s.hudTarget;
    if(!targetOK(target,p))return;
    const part=s.hudPart;
    if(part&&!SW_INFO.partLocation(target,part))return;
    if(s.focus?.id===target.id&&s.focusPart===part)return;
    s.focus=target;
    s.focusPart=part;
    const status=SW_INFO.lock(p,target,part);
    toast(p,status?`§bロックオン · ${status}`:"§b集中射撃 · ロックオン");
  }

  world.afterEvents.playerSwingStart?.subscribe(({player,swingSource})=>{try{
    if(swingSource==="Attack"||swingSource==="Mine"||swingSource==="None")lockTarget(player);
  }catch{}});
  world.afterEvents.entityHitEntity?.subscribe(({damagingEntity})=>{try{
    if(damagingEntity.typeId==="minecraft:player")lockTarget(damagingEntity);
  }catch{}});
  world.afterEvents.entityHitBlock?.subscribe(({damagingEntity})=>{try{
    if(damagingEntity.typeId==="minecraft:player")lockTarget(damagingEntity);
  }catch{}});

  world.afterEvents.playerButtonInput?.subscribe(ev=>{
    const p=ev.player;
    if(ev.button!=="Jump" || ev.newButtonState!=="Pressed")return;
    const s=live.get(p.id);
    if(!s?.powered || p.getGameMode()===GameMode.Creative)return;
    const tick=system.currentTick;
    if(s.pendingOff && tick<=s.pendingOff){
      s.pendingOff=0;s.lastJump=-100;
      if(tick<s.boostReady){toast(p,"§7加速噴射 冷却中 · "+Math.ceil((s.boostReady-tick)/20)+"秒");return;}
      s.boostUntil=tick+S.boostTicks;s.boostReady=tick+S.boostCool;
      fx(p.dimension,"surge",p.location);
      sound(p,"mob.enderdragon.flap",p.location,.9,1.4);
      sound(p,"beacon.power",p.location,.7,1.8);
      toast(p,"§6星炉加速噴射 · "+(S.boostTicks/20)+"秒");
      return;
    }
    if(tick-s.lastJump<=7 && tick-s.lastJump>=1){
      if(s.flight){s.pendingOff=tick+7;s.lastJump=-100;return;}
      s.flight=!s.flight;s.lastJump=-100;
      fx(p.dimension,"surge",p.location);
      sound(p,s.flight?"beacon.activate":"beacon.deactivate",p.location,.6,s.flight?1.55:.8);
      toast(p,s.flight?"星炉飛行 · ジャンプで上昇、しゃがみで下降":"星炉飛行を停止");
    }else s.lastJump=tick;
  });

  let supportsDamageFilter=false;
  try {
  const beforeHurt=world.beforeEvents.entityHurt;
  beforeHurt?.subscribe(ev=>{
    const p=ev.hurtEntity;
    if(p.typeId!=="minecraft:player")return;
    const s=live.get(p.id);
    if(!s?.armor)return;
    const cause=ev.damageSource.cause;
    if((s.armor.Feet&&(cause==="fall"||cause==="flyIntoWall"||FIRE.has(cause))) ||
      (s.shield>system.currentTick&&s.powered&&cause!=="void"))ev.cancel=true;
  });
  supportsDamageFilter=!!beforeHurt;
  }catch{}
  world.afterEvents.entityHurt.subscribe(({hurtEntity:p,damageSource})=>{
    if(p.typeId!=="minecraft:player")return;
    const s=live.get(p.id);
    if(!s)return;
    s.hurtTick=system.currentTick;
    if(s.armor?.Chest && ["entityAttack","projectile","entityExplosion","blockExplosion"].includes(damageSource.cause)){
      system.run(()=>{try {
        if(!p.isValid||!live.get(p.id)?.armor.Chest)return;
        p.clearVelocity();
      }catch{}});
    }
    if(s.powered)fx(p.dimension,"impact",p.getHeadLocation());
  });
  world.afterEvents.entitySpawn.subscribe(({entity})=>{try{
    if(entity.typeId==="minecraft:item"&&VIEWS.has(entity.getComponent("minecraft:item")?.itemStack?.typeId))entity.remove();
  }catch{}});
  // デバッグ: /scriptevent orbital_foundry:debug_starforge で装備・効果・体力を表示
  system.afterEvents.scriptEventReceive.subscribe(ev=>{
    if(ev.id!=="orbital_foundry:debug_starforge")return;
    const p=ev.sourceEntity;if(p?.typeId!=="minecraft:player")return;
    try{const h=p.getComponent("minecraft:health"),a=equipped(p),hb=p.getEffect("health_boost"),rs=p.getEffect("resistance");
      p.sendMessage(`[星炉] 装備 ${JSON.stringify(a)} 一式:${fullSet(a)} 体力 ${h?.currentValue}/${h?.effectiveMax} 体力増強 ${hb?`Lv${hb.amplifier+1} 残${hb.duration}`:"なし"} 耐性 ${rs?`Lv${rs.amplifier+1}`:"なし"}`);}catch(e){p.sendMessage("debug_starforge: "+e);}
  });
  world.afterEvents.playerSpawn?.subscribe(({player})=>{live.delete(player.id);swapChest(player,null);cockpit(player,null,null);});

  function tickFlight(p,s) {
    const sprint=p.isSprinting;
    const input=p.inputInfo;
    const up=input.getButtonState("Jump")==="Pressed";
    const down=input.getButtonState("Sneak")==="Pressed"||p.isSneaking;
    const v=flightVelocity(p.getRotation(),input.getMovementVector(),up,down,sprint,p.getViewDirection());
    const boost=(s.boostUntil??0)>system.currentTick;
    if(boost){v.x*=S.boostMul;v.z*=S.boostMul;if(system.currentTick%2===0)fx(p.dimension,"surge",p.location);}
    // 水平は少しずつ目標速度へ寄せて慣性を出す。上下はそのまま (何も押さなければその場に浮く)
    const now=p.getVelocity(), k=.45;
    const hx=now.x+(v.x-now.x)*k, hz=now.z+(v.z-now.z)*k;
    try{p.applyKnockback({x:hx,z:hz},v.y);}catch{try{p.applyKnockback(hx,hz,Math.hypot(hx,hz),v.y);}catch{}}
    if(system.currentTick%20===0)chargeEffect(p,"slow_falling",0);
    if(system.currentTick%3===0){
      const at=plus(p.location,offset(0,.22,0));
      const yaw=p.getRotation().y*Math.PI/180,left=offset(Math.cos(yaw),0,Math.sin(yaw));
      fx(p.dimension,"thrust",plus(at,left,.30));fx(p.dimension,"thrust",plus(at,left,-.30));
    }
  }
  // 砲はプレイヤーの胴装備(アタッチャブル)として描く。状態ごとに胴部アイテムを差し替える → 移動しても絶対に遅れない
  function swapChest(p,state){
    try{
      const eq=p.getComponent("minecraft:equippable"), cur=eq?.getEquipment("Chest");
      const want=state?id("starforge_chest_"+state):id("starforge_chest");
      if(!cur||cur.typeId===want||!(cur.typeId===id("starforge_chest")||CHEST_STATES.has(cur.typeId)))return;
      eq.setEquipment("Chest",convert(cur,want));
    }catch{}
  }
  function convert(cur,want){
    const n=new ItemStack(want,1);
    try{if(cur.nameTag)n.nameTag=cur.nameTag;}catch{}
    try{const l=cur.getLore();if(l?.length)n.setLore(l);}catch{}
    try{const e=cur.getComponent("minecraft:enchantable")?.getEnchantments();if(e?.length)n.getComponent("minecraft:enchantable")?.addEnchantments(e);}catch{}
    return n;
  }
  function dropDrones(s,p){if(p)swapChest(p,null);}
    function pickTarget(p,s,eye) {
    if(s.focus&&!targetOK(s.focus,p)){s.focus=undefined;s.focusPart=undefined;}
    if(s.focus){
      const at=SW_INFO.partLocation(s.focus,s.focusPart);
      if(!at)s.focusPart=undefined;
      if(distance(eye,at??s.focus.location)<=S.range&&lineOfSight(p,eye,s.focus,at))return s.focus;
      return undefined;
    }
    if(s.target && targetOK(s.target,p) && distance(eye,s.target.location)<=S.range && lineOfSight(p,eye,s.target))return s.target;
    return p.dimension.getEntities({location:eye,maxDistance:S.range,excludeTypes:["minecraft:player"],closest:24}).find(e=>targetOK(e,p)&&lineOfSight(p,eye,e));
  }
  // 一人称の砲と HUD は左手スロットの「照準系」アイテムで描く。左手の物は空きスロットへ移す
  const vanilla=(p,name,at)=>{try{p.dimension.spawnParticle(name,at);}catch{}};
  const shake=(p,i,t)=>{try{p.runCommand(`camerashake add @s ${i} ${t} positional`);}catch{}};
  function freeOffhand(p){
    try{
      const eq=p.getComponent("minecraft:equippable"),off=eq.getEquipment("Offhand");
      if(!off||VIEWS.has(off.typeId))return true;
      const c=p.getComponent("minecraft:inventory").container;
      if(c.emptySlotsCount<1)return false;
      c.addItem(off);eq.setEquipment("Offhand",undefined);
      toast(p,"§7左手の物を持ち物に移しました");
      return true;
    }catch{return false;}
  }
  function cockpit(p,s,state){
    try{
      const eq=p.getComponent("minecraft:equippable"),off=eq.getEquipment("Offhand");
      if(!state){if(off&&VIEWS.has(off.typeId))eq.setEquipment("Offhand",undefined);return true;}
      const want=id("starforge_view_"+state);
      if(off?.typeId===want)return true;
      if(off&&!VIEWS.has(off.typeId)&&!freeOffhand(p))return false;
      eq.setEquipment("Offhand",new ItemStack(want,1));
      return true;
    }catch{return false;}
  }
  function deployFx(p){
    const at=p.getHeadLocation();
    sound(p,"block.piston.out",p.location,.9,.6);sound(p,"beacon.power",p.location,.8,1.3);
    shake(p,.08,.35);
    for(let k=0;k<6;k++)system.runTimeout(()=>{try{
      if(!p.isValid)return;
      const h=p.getHeadLocation(),yaw=p.getRotation().y*Math.PI/180;
      const back=offset(Math.sin(yaw)*.6,0,-Math.cos(yaw)*.6);
      for(const sd of[-1,1])fx(p.dimension,"thrust",plus(plus(h,back),offset(Math.cos(yaw)*sd*(.5+k*.12),-.5+k*.05,Math.sin(yaw)*sd*(.5+k*.12))));
      if(k%2===0)sound(p,"random.anvil_land",p.location,.18,1.8+k*.05);
    }catch{}},k*3);
    system.runTimeout(()=>{try{if(p.isValid){sound(p,"mob.irongolem.repair",p.location,.7,.8);toast(p,"§b星炉照準系 起動 · 四連ガトリング オンライン");}}catch{}},20);
  }
  function tickDrones(p,s) {
    if(!s.armed){if(s.gunState){s.gunState=undefined;s.modState=undefined;swapChest(p,null);cockpit(p,s,null);}return;}
    const tick=system.currentTick,eye=p.getHeadLocation();
    s.heat=s.heat??0;
    const cooling=(s.coolUntil??0)>tick;
    const target=(!cooling&&s.shield<=tick)?pickTarget(p,s,eye):undefined;
    s.target=target;
    const shotPart=target?(s.focusPart??SW_INFO.targetPart(p,target)):undefined;
    const charging=s.pressTick!==undefined&&tick-s.pressTick>=S.tapTicks&&!cooling;
    if(charging){
      const k=Math.min(1,(tick-s.pressTick)/S.chargeTicks);
      const vd=normalize(p.getViewDirection()),f=plus(eye,vd,3.2);
      if(tick%2===0){const m=gunMuzzles(plus(p.location,offset(0,1.5,0)),vd);
        for(const at of m){fx(p.dimension,k>=1?"surge":"thrust",plus(at,plus(f,at,-1),k*.6));
          for(let q=1;q<4;q++)fx(p.dimension,"tracer",plus(at,plus(f,at,-1),q/4*k));}
        // 吸い込まれる粒子のリング (視線に垂直な円)
        const ref=Math.abs(vd.y)>.97?offset(0,0,-1):offset(0,1,0),rt=normalize(cross(vd,ref)),up=normalize(cross(rt,vd));
        const rad=2.6*(1-k)+.35,ph=tick*.35;
        for(let q=0;q<10;q++){const a=ph+q*Math.PI/5;fx(p.dimension,q%2?"tracer":"surge",plus(plus(f,rt,Math.cos(a)*rad),up,Math.sin(a)*rad));}
        vanilla(p,"orbital_foundry:overseer_sparks",plus(f,offset((Math.random()-.5)*1.5,(Math.random()-.5)*1.5,(Math.random()-.5)*1.5)));
      }
      if(tick%10===0){vanilla(p,"minecraft:knockback_roar_particle",plus(p.location,offset(0,.1,0)));shake(p,.02+.05*k,.4);}
      if(tick%4===0)sound(p,"beacon.ambient",p.location,.5+.5*k,.6+1.4*k);
      if(k>=1&&!s.chargeReady){s.chargeReady=true;vanilla(p,"minecraft:sonic_explosion",plus(eye,normalize(p.getViewDirection()),3.2));sound(p,"random.orb",p.location,1,2);sound(p,"beacon.power",p.location,1,2);}
      if(tick%2===0){const n=Math.round(20*k);try{p.onScreenDisplay.setActionBar(`§fチャージ ${k>=1?"§b§l充填完了 · 離して発射":"§e"+"|".repeat(n)+"§8"+"|".repeat(20-n)}`);}catch{}}
    }else s.chargeReady=false;
    const firing=(!!target||charging)&&!cooling;
    const state=cooling?"cooling":firing?"firing":"armed";
    if(s.gunState!==state){s.gunState=state;swapChest(p,state);}
    // 左手の照準系をインベントリ画面で取り外したら格納する
    if(s.modState){
      const off=p.getComponent("minecraft:equippable")?.getEquipment("Offhand");
      if(!off||!VIEWS.has(off.typeId)){
        try{const cur=p.getComponent("minecraft:cursor_inventory");if(cur?.item&&VIEWS.has(cur.item.typeId))cur.clear();}catch{}
        s.armed=false;s.focus=undefined;s.focusPart=undefined;s.hudTarget=undefined;s.hudPart=undefined;s.target=undefined;s.modState=undefined;s.gunState=undefined;
        swapChest(p,null);
        sound(p,"beacon.deactivate",p.location,.65,1);
        toast(p,"照準系を外したので自律砲を格納しました");
        return;
      }
    }
    const vstate=(s.beamUntil??0)>tick?"beam":charging?"charging":state;
    if(s.modState!==vstate||tick%20===0){
      if(!cockpit(p,s,vstate)){s.armed=false;toast(p,"§c左手が空けられないので自律砲を格納しました");return;}
      s.modState=vstate;
    }
    if(!target){
      if(!cooling)s.heat=Math.max(0,s.heat-S.gatlingCoolRate);
      s.spin=Math.max(0,(s.spin??0)-1);
    }
    if(cooling){
      s.heat=Math.max(0,S.gatlingHeatMax*((s.coolUntil-tick)/s.coolDuration));
      if(tick===s.coolUntil-1){sound(p,"random.orb",p.location,.6,1.6);toast(p,"§b自律砲 冷却完了");}
    }
    if(!charging)hud(p,s,tick,cooling,shotPart);
    if(!firing||charging||!target)return;
    s.spin=Math.min(S.gatlingSpinUp,(s.spin??0)+1);
    if(s.spin<S.gatlingSpinUp){if(s.spin===1)sound(p,"block.grindstone.use",p.location,.6,1.6);return;}
    if(tick<s.nextShot)return;
    s.nextShot=tick+S.gatlingInterval;
    s.heat+=S.gatlingInterval;
    const aim=SW_INFO.partLocation(target,shotPart)??plus(target.getHeadLocation(),offset(0,-.25,0));
    const head=plus(p.location,plus(p.getVelocity(),offset(0,1.5,0)));
    const muzzles=gunMuzzles(head,p.getViewDirection());
    muzzles.forEach((muzzle,i)=>{
      fx(p.dimension,"muzzle",muzzle);
      if((tick/2+i)%2===0){const len=distance(muzzle,aim),n=Math.min(12,Math.max(3,Math.round(len*.7)));
        for(let step=1;step<n;step++)fx(p.dimension,"tracer",plus(muzzle,plus(aim,muzzle,-1),step/n));}
    });
    fx(p.dimension,"impact",aim);
    // 4門の発砲演出を出し、ダメージは一斉射分を1回だけ適用する。
    damageStarforge(target,p,GUN_PX.length*S.gatlingDamage,eye,"gatling",shotPart);
    sound(p,"firework.blast",p.location,.55,1.7+Math.random()*.2);
    if(tick%4===0){shake(p,.025,.15);fx(p.dimension,"impact",plus(aim,offset(Math.random()-.5,Math.random()-.5,Math.random()-.5)));}
    if(tick%6===0)for(const m of muzzles)fx(p.dimension,"thrust",plus(m,offset(0,-.3,0)));
    if(tick%4===0)sound(p,"random.explode",aim,.15,2);
    if(s.heat>=S.gatlingHeatMax){
      s.coolDuration=S.gatlingCool;s.coolUntil=tick+s.coolDuration;s.spin=0;
      sound(p,"random.fizz",p.location,1,.7);shake(p,.12,.5);
      for(let k=0;k<12;k++)system.runTimeout(()=>{try{if(p.isValid){const h=plus(p.location,offset(0,1.6,0));for(const m of gunMuzzles(h,p.getViewDirection()))fx(p.dimension,"thrust",plus(m,offset(0,.2,0)));}}catch{}},k*5);sound(p,"mob.blaze.breathe",p.location,.8,.6);
      toast(p,"§6自律砲 オーバーヒート · 強制冷却 "+(S.gatlingCool/20)+"秒");
    }
  }
  function hud(p,s,tick,cooling,shotPart) {
    if(tick%5!==0)return;
    if(SW_INFO.warn(p))return;   // ボスの即死技の警告を優先
    const n=Math.round(20*Math.min(1,s.heat/S.gatlingHeatMax));
    const bar=(cooling?"§b":n>15?"§c":n>9?"§6":"§a")+"|".repeat(n)+"§8"+"|".repeat(20-n);
    const candidate=s.target??s.focus??(cooling?s.hudTarget:undefined);
    const candidatePart=s.target?shotPart:(s.focus?s.focusPart:s.hudPart);
    const target=targetOK(candidate,p)?candidate:undefined;
    const part=target?(SW_INFO.partLocation(target,candidatePart)?candidatePart:SW_INFO.targetPart(p,target)):undefined;
    const status=cooling?"§b冷却中":s.focus?"§eロック中":s.target?"§c射撃":"§7待機";
    let line=`§f自律砲 ${status} ${bar}`;
    if(target){
      const detail=SW_INFO.lock(p,target,part)??(target.nameTag||target.typeId.split(":").at(-1));
      line+=`\n§7${s.focus?"固定":"標的"} · ${detail}`;
    }
    try{
      p.onScreenDisplay.setActionBar(line);
      s.hudTarget=target;
      s.hudPart=part;
    }catch{}
  }

  // 古い版の砲台エンティティを掃除し、インベントリに紛れた状態違いの胴部を元に戻す
  system.runInterval(()=>{
    for(const dim of ["overworld","nether","the_end"])try{for(const e of world.getDimension(dim).getEntities({families:["starforge_drone"]}))e.remove();}catch{}
    for(const p of world.getPlayers())try{
      const c=p.getComponent("minecraft:inventory")?.container;if(!c)continue;
      for(let i=0;i<c.size;i++){const it=c.getItem(i);if(it&&CHEST_STATES.has(it.typeId))c.setItem(i,convert(it,id("starforge_chest")));}
      const s=live.get(p.id);
      for(let i=0;i<c.size;i++){const it=c.getItem(i);if(it&&VIEWS.has(it.typeId))c.setItem(i,undefined);}
      if(!s?.armed)cockpit(p,s,null);
      if(!s?.armed){const ch=p.getComponent("minecraft:equippable")?.getEquipment("Chest");if(ch&&CHEST_STATES.has(ch.typeId))swapChest(p,null);}
    }catch{}
  },40);
  system.runInterval(()=>{
    const online=new Set();
    for(const p of world.getPlayers()){
      online.add(p.id);
      try{
        const armor=equipped(p);
        if(!Object.values(armor).some(Boolean)||!allowed(p)){const s=live.get(p.id);if(s)shutdown(p,s);continue;}
        const s=stateOf(p), tick=system.currentTick;
        s.armor=armor;
        const powered=fullSet(armor);
        const pieces=Object.values(armor).filter(Boolean).length;
        if(s.pieces!==pieces){s.pieces=pieces;if(pieces<4)toast(p,`§7星炉外骨格 ${pieces}/4部位 · 4部位そろうと体力+200・耐性60%・飛行`);}
        if(s.powered&&!powered){
          shutdown(p,s);
          stateOf(p).armor=armor;
          continue;
        }
        if(!supportsDamageFilter&&armor.Feet&&tick%10===0)chargeEffect(p,"slow_falling",0);
        if(tick%10===0){
          for(const [slot,list] of Object.entries(PIECE_EFFECTS))if(armor[slot])for(const [effect,amp,dur,low] of list)chargeEffect(p,effect,amp,dur,low);
          clearPieces(p,armor);
          if(armor.Feet)p.extinguishFire(false);
        }
        // 胴だけでも非戦闘時に回復 (一式なら下の強力回復)
        if(!powered&&armor.Chest&&tick-s.hurtTick>=S.healDelay&&(tick-s.hurtTick-S.healDelay)%20===0){
          const h=p.getComponent("minecraft:health");
          if(h&&h.currentValue>0&&h.currentValue<h.effectiveMax)h.setCurrentValue(Math.min(h.effectiveMax,h.currentValue+S.chestHeal));
        }
        if(!powered)continue;
        if(!s.powered){
          fx(p.dimension,"surge",p.getHeadLocation());
          sound(p,"beacon.activate",p.location,.45,.95);
          toast(p,"星炉外骨格 起動 · ジャンプを2回で飛行");
        }
        if(!s.powered||tick%10===0){
          const health=!s.powered?p.getComponent("minecraft:health"):undefined;
          const before=health?.currentValue;
          chargeEffect(p,"resistance",S.resistance);
          // 体力増強は掛け直すと現在体力が基本上限まで削られるので、1回だけ長時間で付ける
          const hb=p.getEffect("health_boost");
          if(!hb||hb.amplifier!==S.boost){
            p.addEffect("health_boost",HB_DURATION,{amplifier:S.boost,showParticles:false});
            if(health && before>0 && health.currentValue>before)health.setCurrentValue(before);
          }
          p.extinguishFire(false);
        }
        s.powered=true;
        if(s.pendingOff && tick>s.pendingOff){
          s.pendingOff=0;s.flight=false;
          fx(p.dimension,"surge",p.location);
          sound(p,"beacon.deactivate",p.location,.6,.8);
          toast(p,"星炉飛行を停止");
        }
        if(tick-s.hurtTick<S.healDelay && tick%20===0){const h=p.getComponent("minecraft:health");if(h&&h.currentValue>0&&h.currentValue<h.effectiveMax)h.setCurrentValue(Math.min(h.effectiveMax,h.currentValue+S.combatHeal));}
        if(tick-s.hurtTick>=S.healDelay && (tick-s.hurtTick-S.healDelay)%10===0){
          const health=p.getComponent("minecraft:health");
          if(health && health.currentValue>0 && health.currentValue<health.effectiveMax){
            health.setCurrentValue(Math.min(health.effectiveMax,health.currentValue+S.heal));
            fx(p.dimension,"repair",p.location);
          }
        }
        if(s.flight)tickFlight(p,s);
        if(s.armed && tick%5===0 && !carryingModule(p)){s.armed=false;s.focus=undefined;s.focusPart=undefined;s.hudTarget=undefined;s.hudPart=undefined;toast(p,"モジュールを手放したので自律砲を格納");}
        if(s.shield>tick && tick%4===0)fx(p.dimension,"surge",plus(p.location,offset(0,1,0)));
        tickDrones(p,s);
      }catch{}
    }
    for(const key of live.keys())if(!online.has(key))live.delete(key);
  },1);
}
