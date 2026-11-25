import { STARFORGE_AUTH } from "./starforge-spec.js";

export const CONSTRUCTION_PLAN = -2;
export const FOUNDRY_STARTUP_ENERGY = 500000;
export const FOUNDRY_STARTUP_MS = 30000;
export const FOUNDRY_DELIVERY_MS = 600000;

const ns = "orbital_foundry:";
const materials = names => names.map(([name, quantity])=>[ns+name,quantity]);

export const FOUNDRY_COMPONENTS = [
  {name:"軌道フレーム",id:"foundry_frame",quantity:8,sec:24,energy:1200,
   in:materials([["steel_plate",16],["aluminum_plate",8],["meteor_iron",4]])},
  {name:"軌道中継モジュール",id:"foundry_relay",quantity:4,sec:32,energy:2200,
   in:materials([["processing_unit",6],["orbital_crystal",6],["iridium",4]])},
  {name:"位相安定器",id:"foundry_stabilizer",quantity:2,sec:40,energy:3200,
   in:materials([["phase_stone",8],["orbital_crystal",2],["heat_alloy",3]])},
];
export const FOUNDRY_CARGO = [...materials(FOUNDRY_COMPONENTS.map(c=>[c.id,c.quantity])),[ns+"singularity_core",1]];
export const FOUNDRY_STARTER = materials([["meteor_iron",16],["orbital_crystal",8]]);
export const FOUNDRY_DELIVERIES = {
  starforge_chip:[[STARFORGE_AUTH,5]],
  meteor_iron:materials([["meteor_iron",8]]),
  orbital_crystal:materials([["orbital_crystal",8]]),
  iridium:materials([["iridium",8]]),
  phase_stone:materials([["phase_stone",6]]),
};
