// チャンクデストロイヤーの掘削対象と回収物。初回実装は「明示した自然地形・バニラ鉱石・専用鉱床・液体」だけを掘る。
// ここに無いブロック (チェスト・機械・建材・構造物など) は保護して残す。
import { NS } from "./config.js";

const mc = name => "minecraft:" + name;

// 廃棄フィルターの分類。discard=true ならゴミ箱へ、false なら搬出する。
export const TERRAIN_CATEGORIES = [
  { id: "stone", name: "石系", hint: "石・丸石・花崗岩・閃緑岩・安山岩・凝灰岩・方解石", icon: "textures/ui/of_filter_stone" },
  { id: "deepslate", name: "深層岩系", hint: "深層岩・深層岩の丸石", icon: "textures/ui/of_filter_deepslate" },
  { id: "dirt", name: "土系", hint: "土・草ブロック・粗い土・泥・粘土・苔", icon: "textures/ui/of_filter_dirt" },
  { id: "sand", name: "砂系", hint: "砂・赤い砂・砂利・砂岩", icon: "textures/ui/of_filter_sand" },
  { id: "nether", name: "ネザー系", hint: "ネザーラック・ソウルサンド・玄武岩・ブラックストーン・ナイリウム", icon: "textures/ui/of_filter_nether" },
  { id: "end", name: "エンド系", hint: "エンドストーン", icon: "textures/ui/of_filter_end" },
];
export const DEFAULT_FILTER = Object.fromEntries(TERRAIN_CATEGORIES.map(c => [c.id, true]));

// [カテゴリ, ドロップ品, 個数]
const TERRAIN = new Map([
  ...[["stone", "cobblestone"], ["cobblestone"], ["granite"], ["diorite"], ["andesite"], ["tuff"], ["calcite"], ["dripstone_block"],
    ["infested_stone", null], ["infested_cobblestone", null]]
    .map(([block, drop = block]) => [mc(block), ["stone", drop && mc(drop), 1]]),
  ...[["deepslate", "cobbled_deepslate"], ["cobbled_deepslate"], ["infested_deepslate", null]]
    .map(([block, drop = block]) => [mc(block), ["deepslate", drop && mc(drop), 1]]),
  ...[["dirt"], ["grass_block", "dirt"], ["coarse_dirt"], ["podzol", "dirt"], ["mycelium", "dirt"], ["dirt_with_roots"],
    ["farmland", "dirt"], ["grass_path", "dirt"], ["dirt_path", "dirt"], ["mud"], ["moss_block"]]
    .map(([block, drop = block]) => [mc(block), ["dirt", mc(drop), 1]]),
  [mc("clay"), ["dirt", mc("clay_ball"), 4]],
  ...[["sand"], ["red_sand"], ["gravel"], ["sandstone"], ["red_sandstone"]]
    .map(([block, drop = block]) => [mc(block), ["sand", mc(drop), 1]]),
  ...[["netherrack"], ["crimson_nylium", "netherrack"], ["warped_nylium", "netherrack"], ["soul_sand"], ["soul_soil"],
    ["basalt"], ["smooth_basalt"], ["blackstone"], ["magma", "magma"], ["nether_wart_block"], ["warped_wart_block"]]
    .map(([block, drop = block]) => [mc(block), ["nether", mc(drop), 1]]),
  [mc("end_stone"), ["end", mc("end_stone"), 1]],
]);

// 地表の草花・雪など。回収せずに撤去する。
const CLEAR = new Set([
  "short_grass", "tall_grass", "tallgrass", "fern", "large_fern", "double_plant", "dead_bush", "deadbush", "seagrass", "kelp",
  "glow_lichen", "vine", "moss_carpet", "snow_layer", "pointed_dripstone", "hanging_roots", "cave_vines",
  "cave_vines_body_with_berries", "cave_vines_head_with_berries", "sculk_vein", "small_dripleaf_block", "big_dripleaf",
  "spore_blossom", "red_flower", "yellow_flower", "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip",
  "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy", "cornflower", "lily_of_the_valley", "sunflower", "lilac",
  "rose_bush", "peony", "brown_mushroom", "red_mushroom", "snow", "ice", "packed_ice", "pink_petals", "sweet_berry_bush",
  // ネザー・エンドの草木と炎
  "crimson_roots", "warped_roots", "nether_sprouts", "crimson_fungus", "warped_fungus", "weeping_vines", "twisting_vines",
  "fire", "soul_fire", "chorus_plant", "chorus_flower",
].map(mc));

export const LIQUIDS = new Set(["water", "flowing_water", "lava", "flowing_lava"].map(mc));
export const AIR = new Set(["air", "cave_air", "void_air"].map(mc));
export const BEDROCK = mc("bedrock");

// 鉱石: 通常の採掘ドロップ (幸運・シルクタッチなし)
const ORES = new Map([
  ...["coal", "iron", "copper", "gold", "redstone", "lapis", "diamond", "emerald"].flatMap(ore => {
    const drop = { coal: ["coal", 1, 1], iron: ["raw_iron", 1, 1], copper: ["raw_copper", 2, 5], gold: ["raw_gold", 1, 1],
      redstone: ["redstone", 4, 5], lapis: ["lapis_lazuli", 4, 9], diamond: ["diamond", 1, 1], emerald: ["emerald", 1, 1] }[ore];
    const ids = [mc(ore + "_ore"), mc("deepslate_" + ore + "_ore")];
    if (ore === "redstone") ids.push(mc("lit_redstone_ore"), mc("lit_deepslate_redstone_ore"));
    return ids.map(block => [block, [mc(drop[0]), drop[1], drop[2]]]);
  }),
  [mc("quartz_ore"), [mc("quartz"), 1, 1]],
  [mc("nether_gold_ore"), [mc("gold_nugget"), 2, 6]],
  [mc("gilded_blackstone"), [mc("gold_nugget"), 2, 5]],
  [mc("ancient_debris"), [mc("ancient_debris"), 1, 1]],
  [`${NS}:nickel_ore`, [`${NS}:raw_nickel`, 1, 2]],
  [`${NS}:bauxite_ore`, [`${NS}:raw_bauxite`, 1, 2]],
  [`${NS}:sulfur_ore`, [`${NS}:sulfur`, 1, 2]],
]);

export const DEPOSIT_PREFIX = `${NS}:deposit_`;
export const DEPOSIT_UNIT_CAP = 60;
// 希少な資源は1鉱床あたりの上限を下げる (古代の残骸を一度に大量に得られないように)
export const DEPOSIT_CAPS = { ancient_debris: 4, diamond: 12, emerald: 12 };
export const depositCap = kind => DEPOSIT_CAPS[kind] ?? DEPOSIT_UNIT_CAP;

// ブロック1つの扱いを返す。
// kind: "air" | "bedrock" | "liquid" | "clear" | "terrain" | "ore" | "deposit" | "protected"
export function classify(typeId, random = Math.random) {
  if (!typeId || AIR.has(typeId)) return { kind: "air" };
  if (typeId === BEDROCK) return { kind: "bedrock" };
  if (LIQUIDS.has(typeId)) return { kind: "liquid" };
  if (CLEAR.has(typeId)) return { kind: "clear" };
  const terrain = TERRAIN.get(typeId);
  if (terrain) {
    const [category, item, amount] = terrain;
    return { kind: "terrain", category, drops: item ? [[item, amount]] : [] };
  }
  const ore = ORES.get(typeId);
  if (ore) {
    const [item, min, max] = ore;
    return { kind: "ore", drops: [[item, min + Math.floor(random() * (max - min + 1))]] };
  }
  if (typeId.startsWith(DEPOSIT_PREFIX)) return { kind: "deposit" };
  return { kind: "protected" };
}

// チャンク座標。負座標も16で床除算する。
export const chunkOf = (x, z) => ({ cx: Math.floor(x / 16), cz: Math.floor(z / 16) });
export const chunkBounds = (cx, cz) => ({ minX: cx * 16, minZ: cz * 16, maxX: cx * 16 + 15, maxZ: cz * 16 + 15 });

// 層ごとの蛇行順。層の偶奇で行の向きを反転し、ドリル頭が端から端へ飛ばないようにする。
export function cellOffset(layerIndex, i) {
  const row = Math.floor(i / 16), col = i % 16;
  const z = layerIndex % 2 === 0 ? row : 15 - row;
  const x = row % 2 === 0 ? col : 15 - col;
  return { dx: x, dz: z, column: z * 16 + x };
}

// 掘削機の性能 (速度の基準: 16×16×128 = 32,768 セル)
export const BASE_CELLS = 16 * 16 * 128;
export const QUARRY_TIERS = {
  [`${NS}:chunk_destroyer_mk1`]: { name: "チャンクデストロイヤー Mk I", baseSeconds: 900, powerPerSecond: 1200, buffer: 512, push: 64, queue: 0, rows: 1, area: 1, markerRange: 4, icon: "textures/blocks/chunk_destroyer_mk1" },
  [`${NS}:chunk_destroyer_mk2`]: { name: "チャンクデストロイヤー Mk II", baseSeconds: 450, powerPerSecond: 4800, buffer: 2048, push: 192, queue: 4, rows: 2, area: 2, markerRange: 8, icon: "textures/blocks/chunk_destroyer_mk2" },
  [`${NS}:chunk_destroyer_mk3`]: { name: "チャンクデストロイヤー Mk III", baseSeconds: 225, powerPerSecond: 9600, buffer: 8192, push: 512, queue: 16, rows: 3, area: 4, markerRange: 16, icon: "textures/blocks/chunk_destroyer_mk3" },
};
export const QUARRY_TYPES = new Set(Object.keys(QUARRY_TIERS));
export const cellsPerSecond = tier => BASE_CELLS / tier.baseSeconds;
export const energyPerCell = tier => tier.powerPerSecond / cellsPerSecond(tier);
export function estimate(tier, depth) {
  const cells = 256 * Math.max(0, depth);
  return { cells, seconds: cells / cellsPerSecond(tier), energy: Math.round(cells * energyPerCell(tier)) };
}
