import { noteShort } from "./hud.js";
import { ItemStack, ItemTypes } from "@minecraft/server";
import { NS } from "./config.js";
import { CROPS } from "./farming.js";
import { GROWER_TIERS, GROWER_CROPS } from "./growing_specs.js";
import { WORLD_NEIGHBORS } from "./connections.js";
import { affordableSpeed, nextSpeed } from "./machine-speed.js";

const IDS = Object.keys(GROWER_CROPS);
const outputLimit = tier => 64 * tier.plants;
const plantsIn = (state, tier) => Math.min(tier.plants, state.plants ?? (state.crop ? 1 : 0));
const BASE_POWER = 40;
const DIRECT_STORAGE = new Set(["minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel", "minecraft:hopper"]);
const id = name => `${NS}:${name}`;
const itemIds = new Map();
function itemId(candidates) {
  for (const candidate of candidates) {
    if (!itemIds.has(candidate)) {
      let resolved;
      try {
        if (ItemTypes.get(candidate)) resolved = new ItemStack(candidate).typeId;
      } catch {}
      itemIds.set(candidate, resolved);
    }
    if (itemIds.get(candidate)) return itemIds.get(candidate);
  }
}
const seed = name => GROWER_CROPS[name]?.seed ? itemId(GROWER_CROPS[name].seed) : id(CROPS[name].seed);
const produce = name => GROWER_CROPS[name]?.out ? itemId(GROWER_CROPS[name].out) : id(name);
export function growerVisual(state) {
  const crop = GROWER_CROPS[state.crop];
  return { active: state.speed > 0, family: crop?.visual ?? 0,
    stage: crop ? 1 + Math.min(3, Math.floor(4 * state.progress / crop.seconds)) : 0 };
}
const outputCount = state => Object.values(state.output).reduce((total, n) => total + n, 0);

export function growSecond(state, tier, water, energy, charge, useWater) {
  const crop = GROWER_CROPS[state.crop];
  state.speed = 0;
  if (!crop) return state.status = "種・苗が未設定";
  if (state.paused) return state.status = "一時停止中";
  const plants = plantsIn(state, tier);
  if (!plants) return state.status = "種・苗が未設定";
  const yieldCount = crop.count * plants, needed = crop.water * plants;
  if (outputCount(state) + yieldCount > outputLimit(tier)) return state.status = "搬出バッファ満杯";
  const topUp = Math.max(0, needed - (state.waterCredit ?? 0));
  if (water < topUp) return state.status = "水不足";
  const powerCost = speed => BASE_POWER * plants * speed ** 2;
  const speed = affordableSpeed(Math.min(tier.speed, state.limit), energy, powerCost);
  if (!speed || !charge(powerCost(speed))) return state.status = "電力不足";
  if (topUp) {
    if (!useWater(topUp)) return state.status = "水不足";
    state.waterCredit = (state.waterCredit ?? 0) + topUp;
  }
  state.speed = speed;
  state.status = "栽培中";
  state.progress += speed;
  if (state.progress >= crop.seconds) {
    state.output[state.crop] = (state.output[state.crop] ?? 0) + yieldCount;
    state.progress -= crop.seconds;
    state.waterCredit -= needed;
  }
  return state.status;
}

export function installGrowing(core) {
  const { world, registry, keyOf, dpGet, dpSet, createForm, toast, giveItems, countItem, removeItems,
    research, expansion, fluidSystem } = core;
  const property = key => "of_grow:" + key;
  const read = key => ({ crop: "", progress: 0, waterCredit: 0, output: {}, limit: 1, speed: 0, paused: false,
    status: "種・苗が未設定", ...JSON.parse(dpGet(property(key), "{}")) });
  const write = (key, state) => dpSet(property(key), JSON.stringify(state));
  const forget = key => dpSet(property(key), undefined);
  const canBreak = key => {
    const state = read(key);
    return state.crop || outputCount(state) ? "種・苗と収穫物を回収してから取り外してください" : undefined;
  };

  function outlet(block, key, output) {
    if (!GROWER_TIERS[block.typeId]) return undefined;
    if (!output) return null;
    const storage = {
      size: IDS.length,
      getItem(slot) {
        const name = IDS[slot], amount = read(key).output[name] ?? 0;
        const outputId = amount && produce(name);
        return outputId ? new ItemStack(outputId, Math.min(amount, new ItemStack(outputId).maxAmount)) : undefined;
      },
      setItem(slot, stack) {
        const name = IDS[slot], state = read(key);
        if (!name || (stack && stack.typeId !== produce(name))) return;
        const amount = state.output[name] ?? 0;
        const shown = Math.min(amount, new ItemStack(produce(name)).maxAmount);
        const remaining = amount - shown + (stack?.amount ?? 0);
        if (remaining > 0) state.output[name] = remaining;
        else delete state.output[name];
        write(key, state);
      },
    };
    return { block, storage, slots: IDS.map((_, index) => index) };
  }

  function deliver(m, dim, state) {
    if (!outputCount(state)) return;
    for (const [dx, dy, dz] of WORLD_NEIGHBORS) {
      const pos = { x: m.x + dx, y: m.y + dy, z: m.z + dz };
      let block;
      try { block = dim.getBlock(pos); } catch { continue; }
      if (!DIRECT_STORAGE.has(block?.typeId)) continue;
      const target = expansion.destinationFor(dim, keyOf(m.dim, pos), pos, dx, dz);
      if (!target?.storage) continue;
      for (const [name, count] of Object.entries(state.output)) {
        const outputId = produce(name);
        if (!outputId) continue;
        const stack = new ItemStack(outputId, Math.min(count, new ItemStack(outputId).maxAmount));
        expansion.insertCargo(target, stack, left => {
          const remaining = count - stack.amount + left;
          if (remaining) state.output[name] = remaining;
          else delete state.output[name];
          write(m.key, state);
        });
      }
      if (!outputCount(state)) return;
    }
  }

  function tick(list) {
    for (const m of list) {
      const tier = GROWER_TIERS[m.type];
      if (!tier || !research.allowsMachine(m.type, m)) continue;
      try {
        const dim = world.getDimension(m.dim);
        let block;
        try { block = dim.getBlock(m); } catch {}
        if (block && block.typeId !== m.type) continue;
        const state = read(m.key), previous = JSON.stringify(state);
        if (block) {
          const route = expansion.growerPowerRoute(m.key);
          if (route) state.route = route;
          deliver(m, dim, state);
        }
        if (state.crop && produce(state.crop)) {
          const remote = block ? undefined : expansion.remoteGrowerPower(state.route);
          const power = block ? expansion.availablePower(m.key) : remote?.available ?? 0;
          const water = fluidSystem.amount(m, "water");
          growSecond(state, tier, water, power,
            amount => block ? expansion.spend(m.key, amount) : remote?.spend(amount),
            amount => fluidSystem.consumeRecipe(m, { fluidsIn: [["water", amount]] }));
          if (state.status === "電力不足") noteShort(m.key, Math.max(1, BASE_POWER * plantsIn(state, tier) - power));
        }
        if (previous !== JSON.stringify(state)) write(m.key, state);
        if (block) {
          const visual = growerVisual(state);
          const original = block.permutation;
          let next = original;
          for (const [key, value] of Object.entries({
            active: visual.active, grower_family: visual.family, grower_stage: visual.stage,
          })) {
            if (original.getState(id(key)) !== value) next = next.withState(id(key), value);
          }
          if (next !== original) block.setPermutation(next);
        }
      } catch (error) { console.warn(`[Orbital Foundry] grower ${m.key}: ${error}`); }
    }
  }

  async function show(player, block, key) {
    const type = block.typeId, tier = GROWER_TIERS[type];
    const alive = () => core.sameMachine(block, type);
    const m = { key, type, dim: block.dimension.id, ...block.location };
    let page = "main";
    while (alive()) {
      const state = read(key), crop = GROWER_CROPS[state.crop], plants = plantsIn(state, tier);
      const actions = [];
      const form = createForm().title(tier.name);
      const add = (label, action, icon) => { form.button(label, icon); actions.push(action); };
      if (page === "seeds") {
        form.body("植えたい作物の種類を選んでください。");
        add("軌道工廠の野菜・果物", () => { page = "custom"; });
        add("バニラの畑作物", () => { page = "field"; });
        add("バニラの地上・水辺の作物", () => { page = "surface"; });
        add("バニラの洞窟・ネザー・エンドの作物", () => { page = "special"; });
        add("戻る", () => { page = "main"; });
      } else if (page !== "main") {
        form.body(`同じ種類を最大 ${tier.plants} 株まで同時に育てます。種・苗は繰り返し使い、入れ替えると成長度はリセットされます。`);
        for (const [name, entry] of Object.entries(GROWER_CROPS)) {
          if ((entry.group ?? "custom") !== page) continue;
          const plantingItem = seed(name);
          if (!plantingItem || !produce(name)) continue;
          if (name === state.crop) continue;
          add(`${entry.name} · 種／苗の所持 ${countItem(player, plantingItem)}`, () => {
            const current = read(key);
            const available = Math.min(tier.plants, countItem(player, plantingItem));
            if (current.crop === name || !available || !removeItems(player, plantingItem, available)) { toast(player, "種・苗が足りません"); return; }
            const old = current.crop, oldPlants = plantsIn(current, tier);
            Object.assign(current, { crop: name, plants: available, progress: 0, speed: 0, status: "開始待ち" });
            write(key, current);
            if (old && oldPlants) giveItems(player, seed(old), oldPlants);
            page = "main";
          }, entry.seed ? undefined : `textures/items/farming/${CROPS[name].seed}`);
        }
        add("戻る", () => { page = "seeds"; });
      } else {
        const stock = Object.entries(state.output).map(([name, n]) => `${GROWER_CROPS[name].name} ×${n}`).join("・");
        const eta = state.speed && crop ? ` · あと約${Math.ceil((crop.seconds - state.progress) / state.speed)}秒` : "";
        form.body(`${crop?.name ?? "未設定"} · ${state.status}\n成長 ${crop ? Math.floor(state.progress * 100 / crop.seconds) : 0}%${eta}\n水 ${fluidSystem.amount(m, "water")} / ${fluidSystem.capacity(m)} mB · 接続電力 ${expansion.availablePower(key)} SE\n同時栽培 ${plants} / ${tier.plants} 株\n速度 ${state.speed}倍 / 上限 ${Math.min(state.limit,tier.speed)}倍 · 消費 ${BASE_POWER * plants * state.speed ** 2} SE/秒\n収穫物 ${outputCount(state)}/${outputLimit(tier)} ${stock}\n\n水パイプと送電ケーブルを接続。隣接チェスト、樽、ホッパーまたはベルトに搬出します。`);
        add(crop ? "作物を入れ替える" : "種・苗をセット", () => { page = "seeds"; });
        if (crop && plants < tier.plants) add("同じ種・苗を空き枠に追加", () => {
          const current = read(key);
          if (current.crop !== state.crop) return;
          const id = seed(current.crop), oldPlants = plantsIn(current, tier);
          const additional = Math.min(tier.plants - oldPlants, countItem(player, id));
          if (additional <= 0 || !removeItems(player, id, additional)) { toast(player, "同じ種・苗が足りません"); return; }
          Object.assign(current, { plants: oldPlants + additional, progress: 0, speed: 0, status: "開始待ち" });
          write(key, current);
        });
        add(`速度上限を切り替える（現在 ${state.limit}倍）`, () => {
          const current = read(key);
          current.limit = nextSpeed(current.limit, tier.speed);
          write(key, current);
        });
        add(state.paused ? "運転を再開" : "一時停止", () => {
          const current = read(key);
          current.paused = !current.paused;
          write(key, current);
        });
        if (stock) add("収穫物をすべて回収", () => {
          const current = read(key);
          for (const [name, amount] of Object.entries(current.output)) {
            const outputId = produce(name);
            if (!outputId) continue;
            giveItems(player, outputId, amount);
            delete current.output[name];
            write(key, current);
          }
        });
        if (crop) add("種・苗を取り出す", () => {
          const current = read(key);
          if (!current.crop) return;
          const old = current.crop, oldPlants = plantsIn(current, tier);
          Object.assign(current, { crop: "", plants: 0, progress: 0, speed: 0, status: "種・苗が未設定" });
          write(key, current);
          if (oldPlants) giveItems(player, seed(old), oldPlants);
        });
        add("表示を更新", () => {});
      }
      const result = await form.show(player);
      if (result.canceled || !alive()) return;
      actions[result.selection]?.();
    }
  }
  return { tick, show, view: outlet, forget, canBreak };
}
