// 野菜8種: 耕地で育つ作物 (6段階)。成長はランダムティック、収穫は右クリック (何度も採れる4種) か破壊。
// 草(背の低い草)を刈ると 12% で種・苗が1つ。種はクラフトでも増やせる (レシピは BP/recipes/farming)
import { world, system, ItemStack, GameMode } from "@minecraft/server";
import { NS } from "./config.js";

// minutes: 明るく湿った耕地での成熟までの平均 (分)。drops: 成熟株から得る [最小, 最大]
export const CROPS = {
  tomato:       { minutes: 9,  seed: "tomato_seeds",      regrow: true,  drops: [2, 4], weight: 16 },
  corn:         { minutes: 12, seed: "corn_seeds",        regrow: false, drops: [1, 2], weight: 12, tall: true },
  edamame:      { minutes: 8,  seed: "edamame_seeds",     regrow: true,  drops: [2, 4], weight: 16 },
  sweet_potato: { minutes: 14, seed: "sweet_potato",      regrow: false, drops: [2, 3], weight: 8 },
  cabbage:      { minutes: 10, seed: "cabbage_seeds",     regrow: false, drops: [1, 1], weight: 12, seedDrops: [1, 2] },
  onion:        { minutes: 9,  seed: "onion",             regrow: false, drops: [2, 4], weight: 12 },
  paprika:      { minutes: 11, seed: "paprika_seeds",     regrow: true,  drops: [1, 3], weight: 8 },
  strawberry:   { minutes: 7,  seed: "strawberry_runner", regrow: true,  drops: [2, 5], weight: 16, runner: .3 },
};
const AGE = `${NS}:age`, PICKED = `${NS}:picked`, MATURE = 5;
const RANDOM_TICK_SEC = 68.3;      // 既定 randomTickSpeed=3 での1ブロックあたりの平均間隔
const REGROW_MIN = 3;              // 右クリック収穫後、未熟な実から再び熟すまでの目安 (2〜4分)
const GRASS_CHANCE = .12;
const CROP_FOOD = new Set([...Object.keys(CROPS), "canned_ration"].map(name => `${NS}:${name}`));

world.beforeEvents.itemUse.subscribe(event => {
  if (!CROP_FOOD.has(event.itemStack.typeId)) return;
  const hunger = event.source.getComponent("minecraft:player.hunger");
  if (hunger && hunger.currentValue >= hunger.effectiveMax) event.cancel = true;
});
const cropOf = typeId => typeId?.startsWith(`${NS}:`) && typeId.endsWith("_crop") ? CROPS[typeId.slice(NS.length + 1, -5)] && typeId.slice(NS.length + 1, -5) : undefined;
const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));
const center = b => ({ x: b.location.x + .5, y: b.location.y + .4, z: b.location.z + .5 });

function drop(dim, at, id, n) {
  while (n > 0) { const k = Math.min(64, n); try { dim.spawnItem(new ItemStack(`${NS}:${id}`, k), at); } catch {} n -= k; }
}
// 1回のランダムティックで1段階進む確率。5段階を minutes 分で終える平均値、乾いた耕地は半分
function growChance(name, block, regrowing) {
  const minutes = regrowing ? REGROW_MIN : CROPS[name].minutes;
  const steps = regrowing ? 1 : MATURE;
  let p = steps * RANDOM_TICK_SEC / (minutes * 60);
  let wet = true; try { wet = (block.below()?.permutation.getState("moisturized_amount") ?? 0) > 0; } catch {}
  if (!wet) p /= 2;
  return Math.min(1, p);
}
function bright(block) {
  try {
    const above = block.above() ?? block;
    const sky = block.dimension.getSkyLightLevel?.(above.location), light = block.dimension.getLightLevel?.(above.location);
    if (typeof light === "number") return light >= 9 || (typeof sky === "number" && sky >= 9 && isDay());
  } catch {}
  return true;   // 明るさを取れない環境では制限しない
}
function isDay() { try { const t = world.getTimeOfDay(); return t < 12500 || t > 23500; } catch { return true; } }
// トウモロコシは後半の2段階で上へ伸びる。上が塞がっていればその手前で止まる
function roomAbove(name, block, next) {
  if (!CROPS[name].tall || next < 3) return true;
  try { const up = block.above(); return !up || up.isAir; } catch { return true; }
}
function setAge(block, age, picked = false) {
  try { block.setPermutation(block.permutation.withState(AGE, age).withState(PICKED, picked)); } catch {}
}

system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent(`${NS}:crop`, {
    onRandomTick({ block }) {
      const name = cropOf(block.typeId); if (!name) return;
      const age = block.permutation.getState(AGE) ?? 0; if (age >= MATURE) return;
      const regrowing = !!block.permutation.getState(PICKED) && age === MATURE - 1;
      if (!bright(block) || !roomAbove(name, block, age + 1)) return;
      if (Math.random() < growChance(name, block, regrowing)) setAge(block, age + 1, false);
    },
    onPlayerInteract({ block, player }) {
      const name = cropOf(block.typeId); if (!name || !player) return;
      const crop = CROPS[name], age = block.permutation.getState(AGE) ?? 0, dim = block.dimension;
      let held; try { held = player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex); } catch {}
      // 骨粉: 1〜2段階進める
      if (held?.typeId === "minecraft:bone_meal" && age < MATURE) {
        let next = Math.min(MATURE, age + 1 + (Math.random() < .5 ? 1 : 0));
        while (next > age && !roomAbove(name, block, next)) next--;
        if (next === age) return;
        setAge(block, next, false);
        let creative = false; try { creative = player.getGameMode() === GameMode.Creative; } catch {}
        if (!creative) {
          try {
            const inv = player.getComponent("minecraft:inventory").container, it = inv.getItem(player.selectedSlotIndex);
            if (it.amount > 1) { it.amount -= 1; inv.setItem(player.selectedSlotIndex, it); } else inv.setItem(player.selectedSlotIndex);
          } catch {}
        }
        try { dim.spawnParticle("minecraft:crop_growth_emitter", center(block)); dim.playSound("item.bone_meal.use", center(block)); } catch {}
        return;
      }
      // 何度も採れる4種: 熟した株を右クリックで収穫し、未熟な実の段階に戻る
      if (crop.regrow && age === MATURE) {
        drop(dim, center(block), name, rand(crop.drops));
        if (crop.runner && Math.random() < crop.runner) drop(dim, center(block), crop.seed, 1);
        setAge(block, MATURE - 1, true);
        try { dim.playSound("block.sweet_berry_bush.pick", center(block), { pitch: 1.1 }); } catch {}
      }
    },
  });
});

// 破壊: ルートテーブルが種/苗1個を落とす。熟していれば収穫物を足す (クリエイティブは何も足さない)
world.afterEvents.playerBreakBlock.subscribe(ev => {
  const id = ev.brokenBlockPermutation?.type?.id, dim = ev.dimension, at = { x: ev.block.location.x + .5, y: ev.block.location.y + .3, z: ev.block.location.z + .5 };
  let creative = false; try { creative = ev.player.getGameMode() === GameMode.Creative; } catch {}
  if (creative) return;
  // 背の低い草: 12% で8種のどれか (トマト・枝豆・イチゴは出やすく、パプリカ・サツマイモは少しレア)
  if (id === "minecraft:short_grass" || id === "minecraft:tallgrass") {
    if (Math.random() >= GRASS_CHANCE) return;
    const list = Object.entries(CROPS), total = list.reduce((s, [, c]) => s + c.weight, 0);
    let r = Math.random() * total;
    for (const [, c] of list) { r -= c.weight; if (r < 0) { drop(dim, at, c.seed, 1); break; } }
    return;
  }
  const name = cropOf(id); if (!name) return;
  if ((ev.brokenBlockPermutation.getState(AGE) ?? 0) < MATURE) return;
  const crop = CROPS[name];
  // サツマイモ・タマネギは収穫物そのものが植え付け用。ルートの1個と合わせて規定の数にする
  const extra = crop.seed === name ? rand(crop.drops) - 1 : rand(crop.drops);
  drop(dim, at, name, extra);
  if (crop.seedDrops) drop(dim, at, crop.seed, rand(crop.seedDrops) - 1);   // キャベツは種1〜2個 (ルートの1個を含む)
  if (crop.runner && Math.random() < crop.runner) drop(dim, at, crop.seed, 1);
});

// ---- 野生株の生成 (スクリプト) ----
const WILD = {
  tomato:       { biomes: ["plains", "forest"], n: 6 },
  corn:         { biomes: ["plains", "savanna"], n: 6 },
  edamame:      { biomes: ["forest", "river"], n: 6 },
  sweet_potato: { biomes: ["savanna", "badlands", "mesa"], n: 8 },
  cabbage:      { biomes: ["taiga", "windswept", "extreme_hills", "meadow", "grove"], n: 7 },
  onion:        { biomes: ["plains", "savanna"], n: 7 },
  paprika:      { biomes: ["savanna", "jungle"], n: 8 },
  strawberry:   { biomes: ["forest", "flower", "cherry"], n: 6 },
};
const NO_WILD = ["frozen", "snowy", "ice", "ocean", "desert", "mushroom", "swamp", "deep_dark", "beach"];
const SOIL = new Set(["minecraft:grass_block", "minecraft:grass", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol"]);
const LOW_GRASS = new Set(["minecraft:short_grass", "minecraft:tallgrass"]);
const regionCache = new Map();
// v0.8.120 could mark a chunk complete before checking whether its sites could be planted.
function wildRegion(cx, cz) {
  const key = `of_wild_v2:${Math.floor(cx / 16)},${Math.floor(cz / 16)}`;
  let bits = regionCache.get(key);
  if (!bits) {
    const saved = world.getDynamicProperty(key);
    bits = typeof saved === "string" && /^[0-9a-f]{64}$/.test(saved)
      ? Array.from(saved, char => parseInt(char, 16)) : new Array(64).fill(0);
    if (regionCache.size >= 256) regionCache.delete(regionCache.keys().next().value);
    regionCache.set(key, bits);
  }
  const i = ((cx & 15) << 4) | (cz & 15);
  return { key, bits, index: i >> 2, mask: 1 << (i & 3) };
}
function chunkDone(cx, cz) {
  const { bits, index, mask } = wildRegion(cx, cz);
  return (bits[index] & mask) !== 0;
}
function markChunk(cx, cz) {
  const { key, bits, index, mask } = wildRegion(cx, cz);
  const next = bits.slice();
  next[index] |= mask;
  world.setDynamicProperty(key, next.map(value => value.toString(16)).join(""));
  regionCache.set(key, next);
}
function biomeId(dim, at) {
  try {
    const biome = dim.getBiome?.(at);
    const id = biome?.id ?? biome?.typeId ?? (typeof biome === "string" ? biome : "");
    return id.replace(/^minecraft:/, "");
  } catch { return ""; }
}
function surface(dim, x, z) {
  let block = dim.getTopmostBlock({ x, z });
  if (!block) return undefined;
  // Air/short grass may be above the ground, and forest canopies hide the soil.
  for (let depth = 0; block && depth < 32; depth++) {
    const id = block.typeId;
    if (SOIL.has(id)) {
      const above = block.above();
      if (above?.typeId.startsWith(`${NS}:wild_`)) return { existing: true };
      const available = above && (above.isAir || LOW_GRASS.has(above.typeId));
      return { spot: available ? above : undefined };
    }
    if (id.startsWith(`${NS}:wild_`)) return { existing: true };
    const foliage = block.isAir || LOW_GRASS.has(id) ||
      /leaves|log|fern|vine|flower|bush|azalea|mushroom/.test(id);
    if (!foliage) break;
    block = block.below();
  }
  return {};
}
const WILD_DENSITY_DIVISOR = 2;
const WILD_PATCH_LIMIT = 5;
export function plantWildPatch(dim, name, x, z, tries = 8, spread = 3) {
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  let placed = 0;
  const offset = () => Math.round((Math.random() + Math.random() - 1) * spread * 1.4);
  for (let i = 0; i < tries && placed < WILD_PATCH_LIMIT; i++) {
    const px = x + (i ? offset() : 0), pz = z + (i ? offset() : 0);
    // A neighboring chunk has its own scan. Do not make this patch depend on it loading.
    if (Math.floor(px / 16) !== cx || Math.floor(pz / 16) !== cz) continue;
    if (i && Math.random() < .35) continue;
    const result = surface(dim, px, pz);
    if (!result) throw new Error("Wild crop column unloaded during placement");
    const spot = result.spot;
    if (!spot) continue;
    if (CROPS[name].tall && !spot.above()?.isAir) continue;
    spot.setType(`${NS}:wild_${name}`);
    placed++;
  }
  return placed;
}
const SURFACE_PROBES = [[8, 8], [3, 4], [12, 11], [4, 12], [11, 3], [8, 4], [4, 8], [11, 8], [8, 12]];
export function populateChunk(dim, cx, cz) {
  const x0 = cx * 16, z0 = cz * 16;
  const sites = [];
  for (const [dx, dz] of SURFACE_PROBES) {
    const x = x0 + dx, z = z0 + dz;
    const probe = surface(dim, x, z);
    if (!probe) return false;
    // A crop from v0.8.120 or a previous interrupted write is already growing here.
    if (probe.existing) { markChunk(cx, cz); return true; }
    if (!probe.spot) continue;
    const biome = biomeId(dim, probe.spot.location);
    if (!NO_WILD.some(term => biome.includes(term))) sites.push({ x, z, biome });
  }
  if (sites.length) {
    // Roll once per chunk so overlapping habitats cannot stack several patches.
    let roll = Math.random();
    for (const [name, rule] of Object.entries(WILD)) {
      const suitable = sites.filter(site => !site.biome || rule.biomes.some(term => site.biome.includes(term)));
      if (!suitable.length) continue;
      roll -= 1 / (rule.n * WILD_DENSITY_DIVISOR);
      if (roll >= 0) continue;
      const first = Math.floor(Math.random() * suitable.length);
      // Try another viable anchor if the chosen spot cannot fit the crop, e.g. corn under a leaf.
      for (let index = 0; index < suitable.length; index++) {
        const { x, z } = suitable[(first + index) % suitable.length];
        if (plantWildPatch(dim, name, x, z, 6 + Math.floor(Math.random() * 4))) break;
      }
      break;
    }
  }
  markChunk(cx, cz);
  return true;
}

const WILD_RADIUS = 4;
const scanOffsets = [];
for (let radius = 0; radius <= WILD_RADIUS; radius++) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === radius) scanOffsets.push([dx, dz]);
    }
  }
}
let nextPlayer = 0;
const retryAt = new Map();
system.runInterval(() => {
  const players = world.getAllPlayers().filter(player => player.dimension.id === "minecraft:overworld");
  if (!players.length) return;
  const tick = system.currentTick;
  for (const [key, deadline] of retryAt) if (deadline <= tick) retryAt.delete(key);
  let budget = 6;
  for (let i = 0; i < players.length && budget > 0; i++) {
    const player = players[(nextPlayer + i) % players.length];
    const pcx = Math.floor(player.location.x / 16), pcz = Math.floor(player.location.z / 16);
    const allotment = Math.ceil(budget / (players.length - i));
    let checked = 0;
    for (const [dx, dz] of scanOffsets) {
      if (checked === allotment) break;
      const cx = pcx + dx, cz = pcz + dz, key = `${cx},${cz}`;
      if (retryAt.has(key) || chunkDone(cx, cz)) continue;
      budget--;
      checked++;
      try {
        if (populateChunk(player.dimension, cx, cz)) continue;
      } catch (error) {
        // A neighboring chunk may not be loaded or accessible yet; leave it unmarked.
        if (!(error?.name === "LocationInUnloadedChunkError" || error?.message === "Wild crop column unloaded during placement")) {
          console.warn(`[Orbital Foundry] wild crops at ${key}: ${error}`);
        }
      }
      retryAt.set(key, tick + 100);
    }
  }
  nextPlayer = (nextPlayer + 1) % players.length;
}, 20);
