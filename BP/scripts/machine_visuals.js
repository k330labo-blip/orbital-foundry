import { BATTERIES } from "./battery.js";
import { visualStepTicks } from "./machine-speed.js";
import { NS } from "./config.js";
import { nearMachine } from "./lod.js";

export const WORKSHOP_MACHINES = new Set([
  "washer", "ore_beneficiator", "electric_furnace", "alloy_furnace", "press", "wire_mill",
  "assembler", "refinery", "oil_pump", "battery", "battery_mk2", "battery_mk3",
  "research_lab", "research_terminal", "orbital_terminal",
  "launch_pad", "landing_pad", "water_pump", "thermal_generator", "nuclear_reactor",
].map(name => `${NS}:${name}`));

export function installMachineVisuals({ world, system, registry, machineState, desiredActive, visualSpeed, chargeFraction }) {
  let machines = [];
  const nextPose=new Map();
  system.runInterval(() => {
    machines = registry().filter(machine => WORKSHOP_MACHINES.has(machine.type));
    const keys=new Set(machines.map(machine=>machine.key));
    for(const key of nextPose.keys())if(!keys.has(key))nextPose.delete(key);
  }, 20);

  // Four model poses animate only loaded, working machines. No display entities are spawned.
  system.runInterval(() => {
    for (const machine of machines) {
      if ((nextPose.get(machine.key)?.tick ?? 0)>system.currentTick) continue;
      if (!nearMachine(machine)) { nextPose.set(machine.key,{speed:-1,tick:system.currentTick+40}); continue; }   // 遠くの機械は見た目を動かさない
      try {
        const block = world.getDimension(machine.dim).getBlock(machine);
        if (block?.typeId !== machine.type) {
          nextPose.set(machine.key,{speed:0,tick:system.currentTick+20});
          continue;
        }
        const state=machineState(machine.key);
        const working = desiredActive(machine,state);
        const current = block.permutation;
        const phase = current.getState(`${NS}:visual_phase`);
        if (phase === undefined) continue;
        const speed=working?visualSpeed(machine,state):0;
        const last=nextPose.get(machine.key);
        const step=working && (!last || last.speed!==speed || system.currentTick>=last.tick);
        if(step)nextPose.set(machine.key,{speed,tick:system.currentTick+visualStepTicks(speed)});
        else if(!working)nextPose.set(machine.key,{speed:0,tick:system.currentTick+4});
        const nextPhase = BATTERIES[machine.type] && chargeFraction
          ? Math.min(3,Math.max(0,Math.round(chargeFraction(machine.key)*3)))
          : !working ? 0 : step ? (phase + 1) % 4 : phase;
        if (phase !== nextPhase || current.getState(`${NS}:active`) !== working) {
          block.setPermutation(current.withState(`${NS}:visual_phase`, nextPhase).withState(`${NS}:active`, working));
        }
        if (step && nextPhase === 0 && ["washer", "ore_beneficiator", "electric_furnace", "alloy_furnace", "refinery", "water_pump", "thermal_generator", "nuclear_reactor"].some(name => machine.type === `${NS}:${name}`)) {
          block.dimension.spawnParticle(`${NS}:steam`, {
            x: machine.x + .5, y: machine.y + 1.2, z: machine.z + .5,
          });
        }
      } catch {
        nextPose.set(machine.key,{speed:0,tick:system.currentTick+20});
      }
    }
  }, 1);
}
