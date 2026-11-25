// ============================================================
// 軌道工廠 config.js - 全バランス値の集約 (仕様§8: 内部データに集約)
// 値を変える場合は docs/DESIGN_NOTES.md に理由と実際の値を記録すること
// ============================================================
import { oreProcessing } from "./ore-processing.js";

import { FOUNDRY_COMPONENTS } from "./foundry-spec.js";

export const VERSION = "0.8.206";
export const NS = "orbital_foundry";
export const ORE_PROCESSING = oreProcessing(NS);

// --- 電力 (単位: 蒸気エネルギー SE) ---
export const ENERGY = {
  baseCapacity: 5000,        // 蓄電池なしの系統容量
  coal: 100, charcoal: 80, coalBlock: 900, blazeRod: 240, lavaBucket: 600,
  drillPerBlock: 10,         // 固定ドリル 1ブロックあたり
};

// --- 加工レシピ (明示的な登録制 / 仕様§3) ---
// machine: 使用機械 / in: [[item,count]...] / out: [[item,count]...] / sec: 秒 / energy: SE
export const MECHANICAL_SCIENCE = `${NS}:science_mechanical`;
export const BELT_RESEARCH = {
  id: "belt_capacity", label: "ベルト積載量アップ", packs: 20, energy: 15, intervalTicks: 80, capacity: 8,
};

export const SCIENCE_PACKS = [
  MECHANICAL_SCIENCE, `${NS}:science_automation`, `${NS}:science_chemical`, `${NS}:science_aerospace`,
];
export const PROCESS_RECIPES = [
  ...FOUNDRY_COMPONENTS.map(c=>({id:c.id,machine:"assembler",label:c.name,icon:c.id,in:c.in,
    out:[[`${NS}:${c.id}`,1]],sec:c.sec,energy:c.energy})),
  ...ORE_PROCESSING.recipes,
  {"id": "drive_component", "machine": "assembler", "label": "駆動部品", "icon": "drive_component", "in": [["orbital_foundry:motor", 1], ["orbital_foundry:bearing", 2], ["orbital_foundry:heat_alloy", 1]], "out": [["orbital_foundry:drive_component", 1]], "sec": 8, "energy": 250},
  {"id": "railgun_round", "machine": "assembler", "label": "レールガン弾 ×8", "icon": "railgun_round", "in": [["orbital_foundry:steel_ingot", 2], ["orbital_foundry:copper_wire", 2], ["minecraft:redstone", 1]], "out": [["orbital_foundry:railgun_round", 8]], "sec": 6, "energy": 160},
  {"id": "shotgun_shell", "machine": "assembler", "label": "ショットガン弾 ×12", "icon": "shotgun_shell", "in": [["minecraft:iron_ingot", 2], ["minecraft:copper_ingot", 1], ["minecraft:coal", 2]], "out": [["orbital_foundry:shotgun_shell", 12]], "sec": 4, "energy": 100},
  {"id": "industrial_ammo", "machine": "assembler", "label": "工業弾薬 ×16", "icon": "industrial_ammo", "in": [["minecraft:iron_ingot", 2], ["minecraft:copper_ingot", 1], ["minecraft:coal", 1]], "out": [["orbital_foundry:industrial_ammo", 16]], "sec": 4, "energy": 80},
  {"id": "repair_kit", "machine": "assembler", "label": "補修キット ×2", "icon": "repair_kit", "in": [["orbital_foundry:steel_plate", 2], ["orbital_foundry:copper_wire", 2], ["orbital_foundry:resin", 1]], "out": [["orbital_foundry:repair_kit", 2]], "sec": 4, "energy": 40},
  {"id": "storage_cell", "machine": "assembler", "label": "蓄電セル", "icon": "storage_cell", "in": [["orbital_foundry:copper_wire", 4], ["orbital_foundry:silicon", 2], ["orbital_foundry:nickel_ingot", 1], ["orbital_foundry:basic_circuit", 1]], "out": [["orbital_foundry:storage_cell", 1]], "sec": 6, "energy": 70},
  {
    "id": "uranium_ingot",
    "machine": "electric_furnace",
    "label": "ウランインゴット ×1",
    "icon": "uranium_ingot",
    "in": [
      [
        "orbital_foundry:raw_uranium",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:uranium_ingot",
        1
      ]
    ],
    "sec": 12,
    "energy": 2000
  },
  {
    "id": "uranium_fuel",
    "machine": "assembler",
    "label": "ウラン燃料棒 ×1",
    "icon": "uranium_fuel",
    "in": [
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
    "out": [
      [
        "orbital_foundry:uranium_fuel",
        1
      ]
    ],
    "sec": 15,
    "energy": 4000
  },
  {
    "id": "science_automation",
    "machine": "assembler",
    "label": "自動化サイエンスパック ×2",
    "icon": "science_automation",
    "in": [
      [
        "orbital_foundry:motor",
        1
      ],
      [
        "orbital_foundry:basic_circuit",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:science_automation",
        2
      ]
    ],
    "sec": 6,
    "energy": 120
  },
  {
    "id": "science_chemical",
    "machine": "assembler",
    "label": "化学サイエンスパック ×2",
    "icon": "science_chemical",
    "in": [
      [
        "orbital_foundry:control_board",
        1
      ],
      [
        "orbital_foundry:heat_alloy",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:science_chemical",
        2
      ]
    ],
    "sec": 8,
    "energy": 1200,
    "fluidsIn": [
      [
        "refined_fuel",
        500
      ]
    ]
  },
  {
    "id": "processing_unit",
    "machine": "assembler",
    "label": "高度制御ユニット ×1",
    "icon": "processing_unit",
    "in": [
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
    "out": [
      [
        "orbital_foundry:processing_unit",
        1
      ]
    ],
    "sec": 10,
    "energy": 3000
  },
  {
    "id": "science_aerospace",
    "machine": "assembler",
    "label": "航空宇宙サイエンスパック ×2",
    "icon": "science_aerospace",
    "in": [
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
    "out": [
      [
        "orbital_foundry:science_aerospace",
        2
      ]
    ],
    "sec": 10,
    "energy": 5000
  },
  {
    "id": "science_mechanical",
    "machine": "assembler",
    "label": "機械サイエンスパック ×2",
    "icon": "science_mechanical",
    "in": [
      [
        "orbital_foundry:gear",
        1
      ],
      [
        "minecraft:copper_ingot",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:science_mechanical",
        2
      ]
    ],
    "sec": 4,
    "energy": 15
  },
  {
    "id": "steel_ingot",
    "machine": "alloy_furnace",
    "label": "鋼インゴット ×2",
    "icon": "steel_ingot",
    "in": [
      [
        "minecraft:iron_ingot",
        2
      ],
      [
        "minecraft:coal",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:steel_ingot",
        2
      ]
    ],
    "sec": 8,
    "energy": 40
  },
  {
    "id": "steel_plate",
    "machine": "press",
    "label": "鋼板 ×2",
    "icon": "steel_plate",
    "in": [
      [
        "orbital_foundry:steel_ingot",
        2
      ]
    ],
    "out": [
      [
        "orbital_foundry:steel_plate",
        2
      ]
    ],
    "sec": 5,
    "energy": 20
  },
  {
    "id": "copper_wire",
    "machine": "wire_mill",
    "label": "銅線 ×4",
    "icon": "copper_wire",
    "in": [
      [
        "minecraft:copper_ingot",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:copper_wire",
        4
      ]
    ],
    "sec": 4,
    "energy": 15
  },
  {
    "id": "silicon",
    "machine": "electric_furnace",
    "label": "シリコン ×1",
    "icon": "silicon",
    "in": [
      [
        "minecraft:sand",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:silicon",
        1
      ]
    ],
    "sec": 5,
    "energy": 20
  },
  {
    "id": "resin_from_log",
    "machine": "crusher",
    "label": "樹脂 ×1 (原木の圧搾・暫定)",
    "icon": "resin",
    "in": [
      [
        "minecraft:oak_log",
        2
      ]
    ],
    "out": [
      [
        "orbital_foundry:resin",
        1
      ]
    ],
    "sec": 6,
    "energy": 15
  },
  {
    "id": "crush_iron",
    "machine": "crusher",
    "label": "粉砕鉄鉱 ×2",
    "icon": "crushed_iron",
    "in": [
      [
        "minecraft:raw_iron",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:crushed_iron",
        2
      ]
    ],
    "sec": 4,
    "energy": 15
  },
  {
    "id": "nickel_ingot",
    "machine": "electric_furnace",
    "label": "ニッケルインゴット ×1",
    "icon": "nickel_ingot",
    "in": [
      [
        "orbital_foundry:raw_nickel",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:nickel_ingot",
        1
      ]
    ],
    "sec": 6,
    "energy": 25
  },
  {
    "id": "aluminum_plate",
    "machine": "press",
    "label": "アルミ板 ×2",
    "icon": "aluminum_plate",
    "in": [
      [
        "orbital_foundry:raw_bauxite",
        2
      ]
    ],
    "out": [
      [
        "orbital_foundry:aluminum_plate",
        2
      ]
    ],
    "sec": 6,
    "energy": 120
  },
  {
    "id": "heat_alloy",
    "machine": "alloy_furnace",
    "label": "耐熱合金 ×1",
    "icon": "heat_alloy",
    "in": [
      [
        "orbital_foundry:nickel_ingot",
        1
      ],
      [
        "orbital_foundry:steel_ingot",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:heat_alloy",
        1
      ]
    ],
    "sec": 10,
    "energy": 250
  },
  {
    "id": "gear",
    "machine": "assembler",
    "label": "歯車 ×1",
    "icon": "gear",
    "in": [
      [
        "orbital_foundry:steel_plate",
        1
      ],
      [
        "minecraft:iron_ingot",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:gear",
        1
      ]
    ],
    "sec": 6,
    "energy": 20
  },
  {
    "id": "bearing",
    "machine": "assembler",
    "label": "軸受 ×1",
    "icon": "bearing",
    "in": [
      [
        "orbital_foundry:steel_ingot",
        1
      ],
      [
        "orbital_foundry:copper_wire",
        2
      ]
    ],
    "out": [
      [
        "orbital_foundry:bearing",
        1
      ]
    ],
    "sec": 6,
    "energy": 20
  },
  {
    "id": "motor",
    "machine": "assembler",
    "label": "モーター ×1",
    "icon": "motor",
    "in": [
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
    "out": [
      [
        "orbital_foundry:motor",
        1
      ]
    ],
    "sec": 10,
    "energy": 120
  },
  {
    "id": "basic_circuit",
    "machine": "assembler",
    "label": "基礎回路 ×2",
    "icon": "basic_circuit",
    "in": [
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
    "out": [
      [
        "orbital_foundry:basic_circuit",
        2
      ]
    ],
    "sec": 8,
    "energy": 80
  },
  {
    "id": "control_board",
    "machine": "assembler",
    "label": "制御基板 ×1",
    "icon": "control_board",
    "in": [
      [
        "orbital_foundry:basic_circuit",
        2
      ],
      [
        "orbital_foundry:resin",
        2
      ]
    ],
    "out": [
      [
        "orbital_foundry:control_board",
        1
      ]
    ],
    "sec": 10,
    "energy": 160
  },
  {
    "id": "solar_cell",
    "machine": "assembler",
    "label": "太陽電池 ×1",
    "icon": "solar_cell",
    "in": [
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
    "out": [
      [
        "orbital_foundry:solar_cell",
        1
      ]
    ],
    "sec": 10,
    "energy": 300
  },
  {
    "id": "rocket_body_section",
    "machine": "assembler",
    "label": "ロケット機体区画 ×1",
    "icon": "rocket_body_section",
    "in": [
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
    "out": [
      [
        "orbital_foundry:rocket_body_section",
        1
      ]
    ],
    "sec": 20,
    "energy": 18000
  },
  {
    "id": "guidance_device",
    "machine": "assembler",
    "label": "誘導装置 ×1",
    "icon": "guidance_device",
    "in": [
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
    "out": [
      [
        "orbital_foundry:guidance_device",
        1
      ]
    ],
    "sec": 20,
    "energy": 22000
  },
  {
    "id": "rocket_fuel",
    "machine": "assembler",
    "label": "ロケット燃料 ×4",
    "icon": "rocket_fuel",
    "in": [
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
    "out": [
      [
        "orbital_foundry:rocket_fuel",
        4
      ]
    ],
    "sec": 10,
    "energy": 40
  },
  {
    "id": "wash_iron",
    "machine": "washer",
    "label": "鉄鉱石の洗浄 ×3",
    "icon": "crushed_iron",
    "in": [
      [
        "minecraft:raw_iron",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:crushed_iron",
        3
      ]
    ],
    "fluidsIn": [
      [
        "water",
        1000
      ]
    ],
    "sec": 7,
    "energy": 80
  },
  {
    "id": "refine_oil",
    "machine": "refinery",
    "label": "原油精製 · 燃料600 mB+樹脂1",
    "icon": "refined_fuel",
    "in": [],
    "out": [
      [
        "orbital_foundry:resin",
        1
      ]
    ],
    "fluidsIn": [
      [
        "crude_oil",
        1000
      ]
    ],
    "fluidsOut": [
      [
        "refined_fuel",
        600
      ]
    ],
    "sec": 8,
    "energy": 1000
  },
  {
    "id": "rocket_fuel_refined",
    "machine": "assembler",
    "label": "精製ロケット燃料 ×8",
    "icon": "rocket_fuel",
    "in": [
      [
        "orbital_foundry:sulfur",
        1
      ]
    ],
    "out": [
      [
        "orbital_foundry:rocket_fuel",
        8
      ]
    ],
    "fluidsIn": [
      [
        "refined_fuel",
        1000
      ]
    ],
    "sec": 8,
    "energy": 1500
  },
  {
    "id": "activation_core",
    "machine": "assembler",
    "label": "起動核 ×1 (オーバーシア召喚)",
    "icon": "activation_core",
    "in": [
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
    "out": [
      [
        "orbital_foundry:activation_core",
        1
      ]
    ],
    "sec": 60,
    "energy": 80000
  }
];

// --- 掘削 (仕様§3: 固定ドリル初期 0.5ブロック/秒) ---
export const DRILL = { blocksPerSec: 0.5, radius: 2, depth: 16,
  excluded: ["minecraft:bedrock","minecraft:chest","minecraft:trapped_chest","minecraft:barrel","minecraft:furnace","minecraft:blast_furnace","minecraft:smoker","minecraft:shulker_box"],
  drops: { "minecraft:iron_ore":"minecraft:raw_iron","minecraft:deepslate_iron_ore":"minecraft:raw_iron",
    "minecraft:copper_ore":"minecraft:raw_copper","minecraft:deepslate_copper_ore":"minecraft:raw_copper",
    "minecraft:gold_ore":"minecraft:raw_gold","minecraft:deepslate_gold_ore":"minecraft:raw_gold",
    "minecraft:coal_ore":"minecraft:coal","minecraft:deepslate_coal_ore":"minecraft:coal",
    "minecraft:diamond_ore":"minecraft:diamond","minecraft:deepslate_diamond_ore":"minecraft:diamond",
    "minecraft:redstone_ore":"minecraft:redstone","minecraft:deepslate_redstone_ore":"minecraft:redstone",
    "minecraft:lapis_ore":"minecraft:lapis_lazuli","minecraft:deepslate_lapis_ore":"minecraft:lapis_lazuli",
    "minecraft:emerald_ore":"minecraft:emerald","minecraft:deepslate_emerald_ore":"minecraft:emerald",
    "orbital_foundry:sulfur_ore":"orbital_foundry:sulfur","orbital_foundry:nickel_ore":"orbital_foundry:raw_nickel","orbital_foundry:bauxite_ore":"orbital_foundry:raw_bauxite",
    "minecraft:stone":"minecraft:cobblestone","minecraft:deepslate":"minecraft:cobbled_deepslate","minecraft:dirt":"minecraft:dirt","minecraft:gravel":"minecraft:gravel","minecraft:sand":"minecraft:sand" }
};

// --- 進行段階 (仕様§1) ---
export const STAGES = [
  { id:"T0", name:"機械化",     goal:"鉄・銅・石炭を確保し、発電機とドリルを動かす", keyItem:"orbital_foundry:steel_ingot", keyLabel:"鋼インゴット" },
  { id:"T1", name:"地上工場",   goal:"鋼板と基礎回路で工場を自動化する",             keyItem:"orbital_foundry:control_board", keyLabel:"制御基板" },
  { id:"T2", name:"初打ち上げ", goal:"発射台に機体・燃料・誘導装置を供給する",       keyItem:"orbital_foundry:meteor_iron", keyLabel:"隕鉄 (初回便 回収)" },
  { id:"T3", name:"軌道産業",   goal:"隕鉄掘削機・採掘衛星を配備する",   keyItem:"orbital_foundry:orbital_crystal", keyLabel:"軌道結晶" },
  { id:"T4", name:"最終決戦",   goal:"起動核を作り、軌道要塞機オーバーシアを討伐する", keyItem:"orbital_foundry:activation_core", keyLabel:"起動核" },
  { id:"T5", name:"軌道工廠建設", goal:"軌道ターミナルで資材を投入し、建設便を打ち上げて工廠を起動する", keyItem:"orbital_foundry:singularity_core", keyLabel:"特異炉心" },
  { id:"T6", name:"本編クリア", goal:"軌道ターミナルで定期便を設定し、着陸台で資源を回収する", keyItem:"orbital_foundry:orbital_crystal", keyLabel:"軌道結晶" },
];

// --- 最終ボス / 強化 (仕様§7: Phase4で使用する初期値をここに集約) ---
// 樹脂はオーク以外の原木からも作れる。生産ツリーには代表の resin_from_log だけを表示する。
export const LOG_VARIANTS = [
  ["spruce_log","トウヒの原木"],["birch_log","シラカバの原木"],["jungle_log","ジャングルの原木"],
  ["acacia_log","アカシアの原木"],["dark_oak_log","ダークオークの原木"],["mangrove_log","マングローブの原木"],
  ["cherry_log","サクラの原木"],["pale_oak_log","ペールオークの原木"],
];
{
  const base = PROCESS_RECIPES.find(recipe => recipe.id === "resin_from_log");
  base.note = "オーク以外の原木（トウヒ・シラカバ・ジャングル・アカシア・ダークオーク・マングローブ・サクラ・ペールオーク）も2個で使えます。";
  for (const [log] of LOG_VARIANTS)
    PROCESS_RECIPES.push({ ...base, id: `resin_from_${log}`, in: [[`minecraft:${log}`, 2]], variantOf: "resin_from_log" });
}

export const BOSS = { baseHp: 3000, perExtraPlayerPct: 0.35, singleHitCapPct: 0.03, coreExposureSec: 5, minExposureSec: 2 };

// --- ロケット初号機 (仕様§3) ---
export const ROCKET1 = { bodySections: 16, fuel: 32, guidance: 4, launchEnergy: 60000, firstFlightSec: 300,
  firstCargo: [["orbital_foundry:meteor_iron",24],["orbital_foundry:orbital_crystal",12]] };

export const ROCKET_COST = [
  [`${NS}:rocket_body_section`, ROCKET1.bodySections],
  [`${NS}:rocket_fuel`, ROCKET1.fuel],
  [`${NS}:guidance_device`, ROCKET1.guidance],
];

// --- 実績クエスト (2026-11-18 TANAKA指示: 実績風UIで「次にやること」を示し、達成で次に役立つ報酬) ---
// cond: {kind:"have", item, n} 所持 / {kind:"place", block} 設置 (チーム共有レジストリで判定)
//       {kind:"energy", n} 現在の蒸気エネルギー / {kind:"counter", key:"processed"|"drill", n} 累計回数
// reward: [[item, n]...] 次のクエストで使う素材を渡す (詰み回避と前進の補助)
export const QUESTS = [
  { id:"guide",   title:"工廠、開設",       icon:"guide_book",      cond:{kind:"have", item:"orbital_foundry:guide_book", n:1},
    desc:"工廠ガイドを手に入れる", hint:"作業台で 本 + 紙4枚 から作れます。最初に配られた場合はそのまま達成です。",
    reward:[["minecraft:coal",4]] },
  { id:"generator", title:"蒸気を起こせ",   icon:"coal_generator",  cond:{kind:"place", block:"orbital_foundry:coal_generator"},
    desc:"石炭発電機を設置する", hint:"作業台: 丸石×4 + 板材×4 (種類自由) + かまど。設置したらタップして石炭を入れます。",
    reward:[["minecraft:coal",8]] },
  { id:"steam100", title:"圧力上昇",        icon:"battery",         cond:{kind:"energy", n:100},
    desc:"蒸気エネルギーを 100 SE 貯める", hint:"発電機に石炭を入れると +100 SE。満タンは 5,000 SE です。",
    reward:[["minecraft:iron_ingot",4]] },
  { id:"steel",   title:"鋼の時代",         icon:"steel_ingot",     cond:{kind:"have", item:"orbital_foundry:steel_ingot", n:1},
    desc:"鋼インゴットを作る", hint:"合金炉で 鉄×2 + 石炭×1 - 鋼×2。合金炉は 鉄×6 + 高炉 + 石炭ブロック×3 で作れます。",
    reward:[["minecraft:coal_block",1]] },
  { id:"plate",   title:"板金加工",         icon:"steel_plate",     cond:{kind:"have", item:"orbital_foundry:steel_plate", n:1},
    desc:"鋼板を作る", hint:"プレス機で 鋼インゴット×2 - 鋼板×2。プレス機は 鉄 + ピストン で作れます。",
    reward:[["orbital_foundry:gear",1]] },
  { id:"drill",   title:"大地を穿て",       icon:"fixed_drill",     cond:{kind:"place", block:"orbital_foundry:fixed_drill"},
    desc:"固定ドリルを設置する", hint:"作業台で板材・丸石・石のツルハシを組み合わせます。鉱床の真上に設置して給電します。",
    reward:[["minecraft:iron_ingot",4]] },
  { id:"drill_first", title:"初掘削",       icon:"gear",            cond:{kind:"counter", key:"drill", n:10},
    desc:"ドリルから素材を 10 個受け取る", hint:"ドリルをタップ >「稼働を開始」> しばらく待って「貯蔵を受け取る」。真下に鉱石や石がある場所に置くのがコツ。",
    reward:[["orbital_foundry:copper_wire",4]] },
  { id:"wire",    title:"電線を引け",       icon:"copper_wire",     cond:{kind:"have", item:"orbital_foundry:copper_wire", n:4},
    desc:"銅線を 4 本作る", hint:"製線機で 銅インゴット×1 - 銅線×4。",
    reward:[["orbital_foundry:silicon",2]] },
  { id:"circuit", title:"回路の芽",         icon:"basic_circuit",   cond:{kind:"have", item:"orbital_foundry:basic_circuit", n:1},
    desc:"基礎回路を作る", hint:"組立機か作業台で 銅線 + シリコン×2 + レッドストーン。シリコンは電気炉で砂から作ります。",
    reward:[["orbital_foundry:resin",2]] },
  { id:"board",   title:"制御の心臓",       icon:"control_board",   cond:{kind:"have", item:"orbital_foundry:control_board", n:1},
    desc:"制御基板を作る", hint:"組立機で 基礎回路×2 + 樹脂×2。樹脂は粉砕機で原木×2を圧搾すると得られます。",
    reward:[["orbital_foundry:copper_wire",4],["orbital_foundry:gear",1]] },
  { id:"motor",   title:"回れ、駆動部",     icon:"motor",           cond:{kind:"have", item:"orbital_foundry:motor", n:1},
    desc:"モーターを作る", hint:"組立機で 銅線×4 + 鋼×2 + 歯車×1。歯車は作業台でも作れます。",
    reward:[["orbital_foundry:raw_nickel",4]] },
  { id:"process10", title:"工場長への道",   icon:"assembler",       cond:{kind:"counter", key:"processed", n:10},
    desc:"機械加工を累計 10 回受け取る", hint:"どの機械でもOK。加工 >「受け取る」の回数で数えます。",
    reward:[["orbital_foundry:steel_plate",4]] },
  { id:"terminal", title:"研究開始",        icon:"research_terminal", cond:{kind:"place", block:"orbital_foundry:research_terminal"},
    desc:"研究端末を設置する", hint:"作業台: ガラス×4 + 制御基板 + 鋼板×3。進行状況とクエストがここからも見られます。",
    reward:[["orbital_foundry:copper_wire",8]] },
  { id:"battery", title:"蓄える力",         icon:"battery",         cond:{kind:"place", block:"orbital_foundry:battery"},
    desc:"蓄電池を設置する", hint:"高度素材の設備製作: 鋼板×4 + ニッケル×3。粗ニッケルを採掘して電気炉で精錬します。最大20,000 SEを充電できます。",
    reward:[["minecraft:coal_block",2]] },
  { id:"rocket_prep", title:"空への部品",   icon:"rocket_body_section", cond:{kind:"have", item:"orbital_foundry:rocket_body_section", n:1},
    desc:"ロケット機体区画を作る", hint:"組立機で アルミ板×8 + 鋼板×4 + 耐熱合金×2。アルミはボーキサイト、耐熱合金はニッケル+鋼。打ち上げ自体は Phase2 で解放されます。",
    reward:[["orbital_foundry:rocket_fuel",4]] },
  { id:"guidance", title:"星を狙え",        icon:"guidance_device", cond:{kind:"have", item:"orbital_foundry:guidance_device", n:1},
    desc:"誘導装置を作る", hint:"組立機で 制御基板×4 + レッドストーン×8 + 銅線×8。これと機体区画×16・燃料×32で初号機の準備が整います (Phase2)。",
    reward:[["orbital_foundry:solar_cell",1]] },
];

export const EXPANSION = {
  beltItems: 4, cableRange: 64, pumpCost: 20, pumpSeconds: 6,
  orbitSeconds: 150, orbitFuel: 12, orbitIceFuel: 4,
  outpostRadius: 24, bossCombatRange: 24, bossReward: 3,
};
