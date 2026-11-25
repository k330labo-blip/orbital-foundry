import { PROCESS_RECIPES, ROCKET1, ROCKET_COST } from "./config.js";
export const MACHINE_LAYOUTS = [
  {
    "id": "science_mechanical",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:gear",
        1
      ],
      [
        "minecraft:copper_ingot",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:science_mechanical",
        2
      ]
    ],
    "hint": "4秒 · 15 SE / 回",
    "marker": 31400
  },
  {
    "id": "steel_ingot",
    "type": "orbital_foundry:alloy_furnace",
    "name": "合金炉",
    "inputs": [
      [
        "minecraft:iron_ingot",
        2
      ],
      [
        "minecraft:coal",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:steel_ingot",
        2
      ]
    ],
    "hint": "8秒 · 40 SE / 回",
    "marker": 31401
  },
  {
    "id": "steel_plate",
    "type": "orbital_foundry:press",
    "name": "プレス機",
    "inputs": [
      [
        "orbital_foundry:steel_ingot",
        2
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:steel_plate",
        2
      ]
    ],
    "hint": "5秒 · 20 SE / 回",
    "marker": 31402
  },
  {
    "id": "copper_wire",
    "type": "orbital_foundry:wire_mill",
    "name": "製線機",
    "inputs": [
      [
        "minecraft:copper_ingot",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:copper_wire",
        4
      ]
    ],
    "hint": "4秒 · 15 SE / 回",
    "marker": 31403
  },
  {
    "id": "silicon",
    "type": "orbital_foundry:electric_furnace",
    "name": "電気炉",
    "inputs": [
      [
        "minecraft:sand",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:silicon",
        1
      ]
    ],
    "hint": "5秒 · 20 SE / 回",
    "marker": 31404
  },
  {
    "id": "nickel_ingot",
    "type": "orbital_foundry:electric_furnace",
    "name": "電気炉",
    "inputs": [
      [
        "orbital_foundry:raw_nickel",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:nickel_ingot",
        1
      ]
    ],
    "hint": "6秒 · 25 SE / 回",
    "marker": 31405
  },
  {
    "id": "aluminum_plate",
    "type": "orbital_foundry:press",
    "name": "プレス機",
    "inputs": [
      [
        "orbital_foundry:raw_bauxite",
        2
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:aluminum_plate",
        2
      ]
    ],
    "hint": "6秒 · 120 SE / 回",
    "marker": 31406
  },
  {
    "id": "heat_alloy",
    "type": "orbital_foundry:alloy_furnace",
    "name": "合金炉",
    "inputs": [
      [
        "orbital_foundry:nickel_ingot",
        1
      ],
      [
        "orbital_foundry:steel_ingot",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:heat_alloy",
        1
      ]
    ],
    "hint": "10秒 · 250 SE / 回",
    "marker": 31407
  },
  {
    "id": "gear",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:steel_plate",
        1
      ],
      [
        "minecraft:iron_ingot",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:gear",
        1
      ]
    ],
    "hint": "6秒 · 20 SE / 回",
    "marker": 31408
  },
  {
    "id": "bearing",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:steel_ingot",
        1
      ],
      [
        "orbital_foundry:copper_wire",
        2
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:bearing",
        1
      ]
    ],
    "hint": "6秒 · 20 SE / 回",
    "marker": 31409
  },
  {
    "id": "motor",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:copper_wire",
        4
      ],
      [
        "orbital_foundry:steel_ingot",
        2
      ],
      [
        "orbital_foundry:gear",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:motor",
        1
      ]
    ],
    "hint": "10秒 · 120 SE / 回",
    "marker": 31410
  },
  {
    "id": "basic_circuit",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:copper_wire",
        4
      ],
      [
        "orbital_foundry:silicon",
        2
      ],
      [
        "minecraft:redstone",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:basic_circuit",
        2
      ]
    ],
    "hint": "8秒 · 80 SE / 回",
    "marker": 31411
  },
  {
    "id": "control_board",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:basic_circuit",
        2
      ],
      [
        "orbital_foundry:resin",
        2
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:control_board",
        1
      ]
    ],
    "hint": "10秒 · 160 SE / 回",
    "marker": 31412
  },
  {
    "id": "solar_cell",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:silicon",
        3
      ],
      [
        "orbital_foundry:copper_wire",
        2
      ],
      [
        "minecraft:glass",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:solar_cell",
        1
      ]
    ],
    "hint": "10秒 · 300 SE / 回",
    "marker": 31413
  },
  {
    "id": "rocket_body_section",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:aluminum_plate",
        8
      ],
      [
        "orbital_foundry:steel_plate",
        4
      ],
      [
        "orbital_foundry:heat_alloy",
        2
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:rocket_body_section",
        1
      ]
    ],
    "hint": "20秒 · 18000 SE / 回",
    "marker": 31414
  },
  {
    "id": "guidance_device",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:control_board",
        4
      ],
      [
        "minecraft:redstone",
        8
      ],
      [
        "orbital_foundry:copper_wire",
        8
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:guidance_device",
        1
      ]
    ],
    "hint": "20秒 · 22000 SE / 回",
    "marker": 31415
  },
  {
    "id": "rocket_fuel",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "minecraft:coal",
        4
      ],
      [
        "orbital_foundry:resin",
        2
      ],
      [
        "orbital_foundry:sulfur",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:rocket_fuel",
        4
      ]
    ],
    "hint": "10秒 · 40 SE / 回",
    "marker": 31416
  },
  {
    "id": "wash_iron",
    "type": "orbital_foundry:washer",
    "name": "洗浄機",
    "inputs": [
      [
        "minecraft:raw_iron",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:crushed_iron",
        3
      ]
    ],
    "hint": "7秒 · 80 SE / 回",
    "marker": 31417
  },
  {
    "id": "beneficiate_iron",
    "type": "orbital_foundry:ore_beneficiator",
    "name": "高度選鉱機",
    "inputs": [
      [
        "minecraft:raw_iron",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:crushed_iron",
        5
      ]
    ],
    "hint": "14秒 · 400 SE / 回",
    "marker": 31442
  },
  {
    "id": "refine_oil",
    "type": "orbital_foundry:refinery",
    "name": "精製機",
    "inputs": [],
    "outputs": [
      [
        "orbital_foundry:resin",
        1
      ]
    ],
    "hint": "8秒 · 1000 SE / 回",
    "marker": 31418
  },
  {
    "id": "rocket_fuel_refined",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:sulfur",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:rocket_fuel",
        8
      ]
    ],
    "hint": "8秒 · 1500 SE / 回",
    "marker": 31419
  },
  {
    "id": "activation_core",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:meteor_iron",
        32
      ],
      [
        "orbital_foundry:orbital_crystal",
        16
      ],
      [
        "orbital_foundry:phase_stone",
        8
      ],
      [
        "orbital_foundry:military_control_core",
        2
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:activation_core",
        1
      ]
    ],
    "hint": "60秒 · 80000 SE / 回",
    "marker": 31421
  },
  {
    "id": "drill_output",
    "type": "orbital_foundry:fixed_drill",
    "name": "固定ドリル",
    "inputs": [],
    "outputs": [
      [
        "minecraft:raw_iron",
        1
      ]
    ],
    "hint": "鉱床・残量・停止設定はしゃがみ＋右クリック",
    "marker": 31422
  },
  {
    "id": "oil_output",
    "type": "orbital_foundry:oil_pump",
    "name": "原油ポンプ",
    "inputs": [
      [
        "minecraft:coal",
        1
      ]
    ],
    "outputs": [],
    "hint": "水1000+石炭1 > 原油500 mB / 4秒",
    "marker": 31423
  },
  {
    "id": "rocket_supply",
    "type": "orbital_foundry:launch_pad",
    "name": "発射台",
    "inputs": ROCKET_COST,
    "outputs": [],
    "hint": `しゃがみ＋右クリックで発射 · ${ROCKET1.launchEnergy} SE・着陸台が必要`,
    "marker": 31424
  },
  {
    "id": "science_supply",
    "type": "orbital_foundry:research_lab",
    "name": "研究所",
    "inputs": [
      [
        "orbital_foundry:science_mechanical",
        1
      ],
      [
        "orbital_foundry:science_automation",
        1
      ],
      [
        "orbital_foundry:science_chemical",
        1
      ],
      [
        "orbital_foundry:science_aerospace",
        1
      ]
    ],
    "outputs": [],
    "hint": "しゃがみ＋右クリックで技術ツリー · 赤パックを供給",
    "marker": 31425
  },
  {
    "id": "science_automation",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:motor",
        1
      ],
      [
        "orbital_foundry:basic_circuit",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:science_automation",
        2
      ]
    ],
    "hint": "6秒 · 120 SE / 回",
    "marker": 31426
  },
  {
    "id": "science_chemical",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:control_board",
        1
      ],
      [
        "orbital_foundry:heat_alloy",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:science_chemical",
        2
      ]
    ],
    "hint": "8秒 · 1200 SE / 回",
    "marker": 31427
  },
  {
    "id": "processing_unit",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:control_board",
        2
      ],
      [
        "orbital_foundry:silicon",
        2
      ],
      [
        "orbital_foundry:sulfur",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:processing_unit",
        1
      ]
    ],
    "hint": "10秒 · 3000 SE / 回",
    "marker": 31428
  },
  {
    "id": "science_aerospace",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:processing_unit",
        1
      ],
      [
        "orbital_foundry:heat_alloy",
        1
      ],
      [
        "orbital_foundry:motor",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:science_aerospace",
        2
      ]
    ],
    "hint": "10秒 · 5000 SE / 回",
    "marker": 31429
  },
  {
    "id": "uranium_ingot",
    "type": "orbital_foundry:electric_furnace",
    "name": "電気炉",
    "inputs": [
      [
        "orbital_foundry:raw_uranium",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:uranium_ingot",
        1
      ]
    ],
    "hint": "12秒 · 2000 SE / 回",
    "marker": 31430
  },
  {
    "id": "uranium_fuel",
    "type": "orbital_foundry:assembler",
    "name": "組立機",
    "inputs": [
      [
        "orbital_foundry:uranium_ingot",
        4
      ],
      [
        "orbital_foundry:steel_plate",
        2
      ],
      [
        "orbital_foundry:heat_alloy",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:uranium_fuel",
        1
      ]
    ],
    "hint": "15秒 · 4000 SE / 回",
    "marker": 31431
  },
  {
    "id": "nuclear_power",
    "type": "orbital_foundry:nuclear_reactor",
    "name": "原子炉 · しゃがみ＋右クリックで温度・起動設定",
    "inputs": [
      [
        "orbital_foundry:uranium_fuel",
        1
      ]
    ],
    "outputs": [
      [
        "orbital_foundry:depleted_uranium_fuel",
        1
      ]
    ],
    "hint": "起動10000度 · 12000 SE/秒 · 冷却水500 mB/秒",
    "marker": 31432
  },
  {"id": "drive_component", "type": "orbital_foundry:assembler", "name": "組立機", "inputs": [["orbital_foundry:motor", 1], ["orbital_foundry:bearing", 2], ["orbital_foundry:heat_alloy", 1]], "outputs": [["orbital_foundry:drive_component", 1]], "hint": "8秒 · 250 SE / 回", "marker": 31437},
  {"id": "industrial_ammo", "type": "orbital_foundry:assembler", "name": "組立機", "inputs": [["minecraft:iron_ingot", 2], ["minecraft:copper_ingot", 1], ["minecraft:coal", 1]], "outputs": [["orbital_foundry:industrial_ammo", 16]], "hint": "4秒 · 80 SE / 回", "marker": 31433},
  {"id": "repair_kit", "type": "orbital_foundry:assembler", "name": "組立機", "inputs": [["orbital_foundry:steel_plate", 2], ["orbital_foundry:copper_wire", 2], ["orbital_foundry:resin", 1]], "outputs": [["orbital_foundry:repair_kit", 2]], "hint": "4秒 · 40 SE / 回", "marker": 31434},
  {"id": "railgun_round", "type": "orbital_foundry:assembler", "name": "組立機", "inputs": [["orbital_foundry:steel_ingot", 2], ["orbital_foundry:copper_wire", 2], ["minecraft:redstone", 1]], "outputs": [["orbital_foundry:railgun_round", 8]], "hint": "6秒 · 160 SE / 回", "marker": 31435},
  {"id": "shotgun_shell", "type": "orbital_foundry:assembler", "name": "組立機", "inputs": [["minecraft:iron_ingot", 2], ["minecraft:copper_ingot", 1], ["minecraft:coal", 2]], "outputs": [["orbital_foundry:shotgun_shell", 12]], "hint": "4秒 · 100 SE / 回", "marker": 31436},
  {"id": "storage_cell", "type": "orbital_foundry:assembler", "name": "組立機", "inputs": [["orbital_foundry:copper_wire", 4], ["orbital_foundry:silicon", 2], ["orbital_foundry:nickel_ingot", 1], ["orbital_foundry:basic_circuit", 1]], "outputs": [["orbital_foundry:storage_cell", 1]], "hint": "6秒 · 70 SE / 回", "marker": 31441}
];
export function machineLayout(type,state,container) {
  const options=MACHINE_LAYOUTS.filter(layout=>layout.type===type);
  if(!options.length) return;
  if(state.job) {
    const recipeId=state.job.recipeId ?? PROCESS_RECIPES.find(recipe=>recipe.label===state.job.label && `orbital_foundry:${recipe.machine}`===type)?.id;
    const running=options.find(layout=>layout.id===recipeId);
    if(running) return running;
  }
  const chosen=options.find(layout=>layout.id===state.selectedRecipe);
  if(chosen) return chosen;
  const counts=new Map();
  for(let slot=0;slot<18;slot++) {
    const item=container?.getItem(slot);
    if(item) counts.set(item.typeId,(counts.get(item.typeId)??0)+item.amount);
  }
  return options.find(layout=>layout.inputs.length && layout.inputs.every(([id,n])=>(counts.get(id)??0)>=n))
    ?? options.find(layout=>layout.inputs.some(([id])=>counts.has(id))) ?? options[0];
}
export function consolidateMachineSlots(container,layout) {
  for(let target=0;target<layout.inputs.length;target++) {
    const id=layout.inputs[target][0];
    const old=container.getItem(target);
    if(old && old.typeId!==id) {
      for(let slot=layout.inputs.length;slot<18;slot++) {
        if(container.getItem(slot)) continue;
        container.setItem(slot,old);container.setItem(target,undefined);break;
      }
    }
    compact(container,id,target,0,18);
  }
  for(let index=0;index<layout.outputs.length;index++) {
    const target=18+index;
    // Drill yields depend on its deposit. Preserve its current output type.
    const id=layout.id==="drill_output" ? firstProduct(container) : layout.outputs[index][0];
    if(id) compact(container,id,target,18,25);
  }
}
function firstProduct(container) {
  for(let slot=18;slot<25;slot++) if(container.getItem(slot))return container.getItem(slot).typeId;
}
function compact(container,id,target,start,end) {
  for(let source=start;source<end;source++) {
    if(source===target) continue;
    const item=container.getItem(source),old=container.getItem(target);
    if(item?.typeId!==id || (old && !old.isStackableWith(item)))continue;
    const moved=Math.min(item.amount,item.maxAmount-(old?.amount??0));
    if(!moved)continue;
    const stack=item.clone();stack.amount=(old?.amount??0)+moved;
    container.setItem(target,stack);
    if(moved===item.amount)container.setItem(source,undefined);
    else {item.amount-=moved;container.setItem(source,item);}
  }
}
