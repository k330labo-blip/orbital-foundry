import { NS, ROCKET1 } from "./config.js";

const LAUNCH = `${NS}:launch_pad`;
const LAND = `${NS}:landing_pad`;
const VEHICLE = `${NS}:rocket_vehicle`;
const MARKER = `${NS}:rocket_plot`;
const DIRECTION = {north:[0,-1], east:[1,0], south:[0,1], west:[-1,0]};
const OPEN = new Set(["minecraft:short_grass", "minecraft:tallgrass", "minecraft:fern"]);
const HEIGHT = 13;
const ASCENT = 48;
const IGNITION_MS = 1400;
const DEPART_MS = 7000;
const RETURN_MS = 6000;
const prop = name => `${NS}:${name}`;

export function rocketPlot(block) {
  const [dx, dz] = DIRECTION[block.permutation.getState("minecraft:cardinal_direction")] ?? DIRECTION.north;
  const { x, y, z } = block.location;
  return { x: x - 2*dx + .5, y, z: z - 2*dz + .5 };
}

export function assemblyState(body, fuel, guidance) {
  return {
    phase: [1, 4, 8, 12, 16].filter(amount => body >= amount).length,
    fuel: Math.min(4, Math.floor(4*fuel/ROCKET1.fuel)),
    guidance: Math.min(4, guidance),
  };
}

export function flightHeight(elapsed) {
  const t = Math.max(0, Math.min(1, (elapsed-IGNITION_MS)/(DEPART_MS-IGNITION_MS)));
  return ASCENT * t ** 2;
}
export function returnHeight(remaining) {
  const t = Math.max(0, Math.min(1, remaining/RETURN_MS));
  return ASCENT * t ** 2;
}

export function installRocketScene({world,system,registry,gameClock,rocketFlights,isParked,machineContainer,countSlots,rocketCost}) {
  const visuals = new Map();
  let anchorTime=-1, anchorTick=0;
  function now() {
    const time=gameClock.now(), tick=system.currentTick;
    if (time!==anchorTime) { anchorTime=time; anchorTick=tick; }
    return time + Math.min(950,(tick-anchorTick)*50);
  }
  function inspect(block, forFlight=false) {
    const center=rocketPlot(block), dim=block.dimension;
    const levels=HEIGHT+(forFlight?ASCENT:0);
    try {
      const maxY=dim.heightRange?.max;
      if (maxY!==undefined && center.y+levels>=maxY) return {center,reason:"高度上限に近すぎます"};
      for (let dx=-1;dx<=1;dx++) for (let dz=-1;dz<=1;dz++) {
        const x=Math.floor(center.x)+dx, z=Math.floor(center.z)+dz;
        const floor=dim.getBlock({x,y:center.y-1,z});
        if (!floor) return {center,reason:"区画が読み込まれていません"};
        if (floor.isAir || floor.isLiquid || OPEN.has(floor.typeId) || /flower|sapling|vine|snow_layer/.test(floor.typeId))
          return {center,reason:"奥側に3×3の平らな床が必要です"};
        for (let up=0;up<levels;up++) {
          const at=dim.getBlock({x,y:center.y+up,z});
          if (!at) return {center,reason:"区画が読み込まれていません"};
          if (!at.isAir && !OPEN.has(at.typeId)) return {center,reason:up<HEIGHT?"3×3の区画に障害物があります":"上空の飛行経路に障害物があります"};
        }
      }
      for (const m of registry()) {
        if ((m.type!==LAUNCH && m.type!==LAND) || m.dim!==dim.id ||
            (m.x===block.location.x && m.y===block.location.y && m.z===block.location.z)) continue;
        if (Math.abs(m.y-center.y)>1 || Math.abs(m.x+.5-center.x)>4 || Math.abs(m.z+.5-center.z)>4) continue;
        const other=dim.getBlock(m);
        if (other?.typeId!==m.type) continue;
        const p=rocketPlot(other);
        if (Math.abs(p.x-center.x)<3 && Math.abs(p.z-center.z)<3) return {center,reason:"別の発射台・着陸台の区画と重なっています"};
      }
      return {center};
    } catch { return {center,reason:"区画が読み込まれていません"}; }
  }
  const keyOf=(owner,type)=>owner+"|"+type;
  function getVisual(owner,type) {
    const entity=visuals.get(keyOf(owner,type));
    try { if(entity?.isValid) return entity; } catch {}
    visuals.delete(keyOf(owner,type));
  }
  function ensure(owner,type,dim,at,anchor=at) {
    const key=keyOf(owner,type);
    let entity=getVisual(owner,type);
    if (!entity) {
      const existing=dim.getEntities({type,location:anchor,maxDistance:type===VEHICLE?ASCENT+3:5})
        .filter(e=>e.getDynamicProperty("of:rocket_owner")===owner);
      entity=existing.shift();
      for (const extra of existing) extra.remove();
      if (!entity) {
        entity=dim.spawnEntity(type,at);
        entity.setDynamicProperty("of:rocket_owner",owner);
      }
      visuals.set(key,entity);
    }
    if (Math.hypot(entity.location.x-at.x,entity.location.y-at.y,entity.location.z-at.z)>.015) entity.teleport(at);
    return entity;
  }
  function remove(owner,type) {
    const entity=getVisual(owner,type);
    if (entity) { try { entity.remove(); } catch {} }
    visuals.delete(keyOf(owner,type));
  }
  function state(entity, values) {
    for (const [name,value] of Object.entries(values)) if (entity.getProperty(prop(name))!==value) entity.setProperty(prop(name),value);
  }
  function emit(dim,id,at) { try { dim.spawnParticle(prop(id),at); } catch {} }
  function sound(dim,id,at,volume=1) { try { dim.playSound(`${NS}.${id}`,at,{volume,pitch:1}); } catch {} }
  function launchAudio(flight) {
    try {
      const dim=world.getDimension(flight.launchSite.dim), at=flight.launchSite;
      sound(dim,"rocket_ignition",at,1.3);
      emit(dim,"rocket_cloud",at);
    } catch {}
  }
  function exhaust(dim,at,hot,ground) {
    const tick=system.currentTick;
    if (tick%4) return;
    emit(dim,hot?"rocket_exhaust":"rocket_cloud",{...at,y:at.y+.14});
    if (ground && tick%8===0) emit(dim,"rocket_cloud",ground);
  }
  const activeRender = new Map();
  const arrivals=new Map();
  system.runInterval(()=>{
    const records=registry().filter(m=>m.type===LAUNCH||m.type===LAND);
    const flights=rocketFlights(), time=now();
    const departing=new Map(flights.map(f=>[f.key,f]));
    const returning=new Map(flights.map(f=>[f.landing,f]));
    arrivals.clear();
    for (const m of records) {
      try {
        const dim=world.getDimension(m.dim), block=dim.getBlock(m);
        if (!block) continue;
        if (block.typeId!==m.type) { remove(m.key,MARKER); remove(m.key,VEHICLE); continue; }
        const plot=inspect(block), center=plot.center;
        if (plot.reason==="区画が読み込まれていません") { remove(m.key,MARKER); continue; }
        const marker=ensure(m.key,MARKER,dim,{...center,y:center.y+.07});
        state(marker,{plot_style:plot.reason?2:m.type===LAND?1:0});
        const flight=m.type===LAUNCH?departing.get(m.key):returning.get(m.key);
        if (m.type===LAUNCH && flight?.launchSite && time-flight.startedAt<DEPART_MS) continue;
        if (m.type===LAUNCH && !plot.reason && !flight) {
          const container=machineContainer(block,m.key);
          const [body,fuel,guide]=rocketCost.map(([id])=>container?countSlots(container,id):0);
          const build=!body&&isParked(m.key)?{phase:5,fuel:1,guidance:4}:assemblyState(body,fuel,guide);
          if (!build.phase) { remove(m.key,VEHICLE); continue; }
          const vehicle=ensure(m.key,VEHICLE,dim,center);
          if (vehicle.getProperty(prop("phase"))!==build.phase) {
            sound(dim,"rocket_assembly",{...center,y:center.y+1},.65);
            emit(dim,"rocket_cloud",{...center,y:center.y+.4});
          }
          state(vehicle,{...build,engine:false});
          continue;
        }
        if (m.type===LAND && flight?.landing===m.key && !plot.reason &&
            flight.readyAt-time<=RETURN_MS && (flight.readyAt<=time || !inspect(block,true).reason)) {
          arrivals.set(m.key,{m,center});
          continue;
        }
        remove(m.key,VEHICLE);
      } catch {}
    }
  },20);
  system.runInterval(()=>{
    const flights=rocketFlights(), time=now();
    const rendering=new Set();
    for (const flight of flights) {
      renderFlight(flight,time,rendering);
    }
    for (const key of activeRender.keys()) if (!rendering.has(key)) activeRender.delete(key);
  },2);
  function renderFlight(flight,time,rendering) {
    const elapsed=time-flight.startedAt;
    if (flight.launchSite && elapsed>=0 && elapsed<DEPART_MS) {
      rendering.add(flight.key);
      try {
        const site=flight.launchSite, dim=world.getDimension(site.dim);
        const at={x:site.x,y:site.y+flightHeight(elapsed),z:site.z};
        if (dim.getBlock({x:Math.floor(site.x),y:site.y,z:Math.floor(site.z)})) {
          const vehicle=ensure(flight.key,VEHICLE,dim,at,site);
          const hot=elapsed>=IGNITION_MS;
          state(vehicle,{phase:5,fuel:4,guidance:4,engine:hot});
          if (hot && activeRender.get(flight.key)!==flight.startedAt) {
            activeRender.set(flight.key,flight.startedAt);
            sound(dim,"rocket_liftoff",at,1.5);
          }
          exhaust(dim,at,hot,elapsed<3400?site:undefined);
        }
      } catch {}
    } else if (activeRender.has(flight.key)) {
      remove(flight.key,VEHICLE);
      activeRender.delete(flight.key);
    }
    const arrival=arrivals.get(flight.landing);
    if (arrival) {
      rendering.add(flight.landing);
      try {
        const { m, center }=arrival, dim=world.getDimension(m.dim);
        const remaining=flight.readyAt-time;
        const at={...center,y:center.y+returnHeight(remaining)};
        const vehicle=ensure(m.key,VEHICLE,dim,at,center);
        state(vehicle,{phase:5,fuel:1,guidance:4,engine:remaining>0});
        if (remaining>0) {
          if (activeRender.get(m.key)!==flight.startedAt) {
            activeRender.set(m.key,flight.startedAt);
            sound(dim,"rocket_liftoff",center,.75);
          }
          exhaust(dim,at,true,remaining<2200?center:undefined);
        } else if (activeRender.has(m.key)) {
          activeRender.delete(m.key);
          sound(dim,"rocket_assembly",center,1.2);
          emit(dim,"rocket_cloud",center);
        }
      } catch {}
    }
  }
  world.afterEvents.entityLoad?.subscribe(({entity})=>{
    if (entity.typeId!==VEHICLE && entity.typeId!==MARKER) return;
    system.run(()=>{
      try {
        if (!entity.isValid) return;
        const owner=entity.getDynamicProperty("of:rocket_owner");
        if (!registry().some(m=>m.key===owner && (m.type===LAUNCH||m.type===LAND))) { entity.remove(); return; }
        const current=getVisual(owner,entity.typeId);
        if (current && current.id!==entity.id) entity.remove();
        else visuals.set(keyOf(owner,entity.typeId),entity);
      } catch {}
    });
  });
  function landingPad(dim) {
    const reserved=new Set(rocketFlights().map(f=>f.landing));
    let unloaded;
    for (const m of registry()) {
      if (m.type!==LAND || m.dim!==dim.id || reserved.has(m.key)) continue;
      let block;
      try { block=dim.getBlock(m); } catch {}
      if (!block) { unloaded??=m; continue; }
      if (block.typeId!==LAND) continue;
      const {reason}=inspect(block,true);
      if (!reason) return m;
      if (reason==="区画が読み込まれていません") unloaded??=m;
    }
    return unloaded;
  }
  function launchPad(dim) {
    return registry().find(m=>{
      if (m.type!==LAUNCH || m.dim!==dim.id) return false;
      try {
        const block=dim.getBlock(m);
        return block?.typeId===LAUNCH && !inspect(block,true).reason;
      } catch { return false; }
    });
  }
  return { inspect, now, launchAudio, landingPad, launchPad, forget(owner){ remove(owner,MARKER); remove(owner,VEHICLE); } };
}
