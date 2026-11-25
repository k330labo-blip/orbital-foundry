// 機械の上に浮かぶ「いま作っている物」表示。大容量コンテナの収納物表示と同じ storage_display を1枠モードで使う。
// 加工中はそのレシピの製品、待機中でもレシピを指定していればその製品を出し、何も無ければ枠ごと消す。
import { DISPLAY_ICONS } from "./item_icons.js";
import { NS, PROCESS_RECIPES } from "./config.js";
import { nearMachine } from "./lod.js";

const DISPLAY = `${NS}:storage_display`;
const KEY_PROP = "of:product";

// 表示の高さ (ブロック単位)。モデルが1ブロックより高い機械は、その分だけ持ち上げて重ならないようにする
export const PRODUCT_DISPLAY_LIFT = {
  [`${NS}:crusher`]: 0.92,
  [`${NS}:electric_furnace`]: 0.22,
  [`${NS}:alloy_furnace`]: 0.22,
  [`${NS}:refinery`]: 0.17,
  [`${NS}:washer`]: 0.11,
  [`${NS}:ore_beneficiator`]: 0.30, // 上部のモーターとファンの分
};
const RECIPE_MACHINES = new Set(PROCESS_RECIPES.map(r => `${NS}:${r.machine}`));
const OIL_PUMP = `${NS}:oil_pump`;
export const PRODUCT_DISPLAY_TYPES = new Set([...RECIPE_MACHINES, OIL_PUMP]);

const iconIndex = id => id ? DISPLAY_ICONS[id] : undefined;
// レシピの代表アイコン (例: 精製機は燃料) を優先し、無ければ最初の製品
function recipeIcon(recipe) {
  if (!recipe) return undefined;
  for (const id of [recipe.icon && `${NS}:${recipe.icon}`, recipe.icon && `minecraft:${recipe.icon}`,
    ...(recipe.out ?? []).map(([item]) => item), ...(recipe.fluidsOut ?? []).map(([fluid]) => `${NS}:${fluid}`)]) {
    const index = iconIndex(id);
    if (index !== undefined) return index;
  }
  return 0; // 絵が無い製品は小包アイコン
}
const recipeOf = (type, id) => id && PROCESS_RECIPES.find(r => `${NS}:${r.machine}` === type && r.id === id);

export function installMachineProductDisplay({ world, system, registry, machineState, desiredActive }) {
  const tagOf = key => "ofp_" + key.replace(/[^A-Za-z0-9_-]/g, "_");
  const displays = new Map();
  const near = m => ({ x: m.x + .5, y: m.y + (PRODUCT_DISPLAY_LIFT[m.type] ?? 0), z: m.z + .5 });

  function productOf(m) {
    const st = machineState(m.key);
    if (m.type === OIL_PUMP) return desiredActive(m, st) ? iconIndex(`${NS}:crude_oil`) ?? 0 : -1;
    const job = st.job;
    if (job) {
      const icon = recipeIcon(recipeOf(m.type, job.recipeId));
      if (icon !== undefined) return icon;
      const out = iconIndex(job.out?.[0]?.[0]);
      return out ?? 0;
    }
    return recipeIcon(recipeOf(m.type, st.selectedRecipe)) ?? -1;
  }

  function find(m, dim) {
    let entity = displays.get(m.key);
    try { if (!entity?.isValid) entity = undefined; } catch { entity = undefined; }
    if (entity) return entity;
    const found = dim.getEntities({ type: DISPLAY, tags: [tagOf(m.key)], location: near(m), maxDistance: 2 });
    for (const extra of found.slice(1)) try { extra.remove(); } catch {}
    entity = found[0];
    if (entity) displays.set(m.key, entity);
    return entity;
  }
  function spawn(m, dim) {
    const entity = dim.spawnEntity(DISPLAY, near(m));
    entity.addTag(tagOf(m.key));
    entity.setDynamicProperty(KEY_PROP, m.key);
    entity.setProperty(`${NS}:single`, true);
    displays.set(m.key, entity);
    return entity;
  }
  function remove(key, dim, m) {
    try { displays.get(key)?.remove(); } catch {}
    displays.delete(key);
    if (dim && m) try { for (const e of dim.getEntities({ type: DISPLAY, tags: [tagOf(key)], location: near(m), maxDistance: 2 })) e.remove(); } catch {}
  }

  // 読み込まれた表示のうち、もう機械が無いものは消す
  world.afterEvents.entityLoad?.subscribe(ev => {
    try {
      if (ev.entity?.typeId !== DISPLAY) return;
      const key = ev.entity.getDynamicProperty(KEY_PROP);
      if (key === undefined) return; // コンテナ側の表示は bulk_machine.js が扱う
      if (!registry().some(m => m.key === key && PRODUCT_DISPLAY_TYPES.has(m.type))) ev.entity.remove();
    } catch {}
  });

  let machines = [];
  system.runInterval(() => {
    machines = registry().filter(m => PRODUCT_DISPLAY_TYPES.has(m.type));
    const keys = new Set(machines.map(m => m.key));
    for (const key of [...displays.keys()]) if (!keys.has(key)) remove(key);
  }, 20);

  system.runInterval(() => {
    for (const m of machines) {
      if (!nearMachine(m, 48)) continue;   // 遠くの機械は表示を更新しない
      try {
        const dim = world.getDimension(m.dim), block = dim.getBlock(m);
        if (!block) continue; // 未読み込み
        if (block.typeId !== m.type) { remove(m.key, dim, m); continue; }
        const product = productOf(m);
        let entity = find(m, dim);
        if (!entity) {
          if (product < 0) continue; // 何も作っていない機械には出さない
          entity = spawn(m, dim);
        }
        const set = (name, value) => { if (entity.getProperty(name) !== value) entity.setProperty(name, value); };
        set(`${NS}:single`, true);
        set(`${NS}:shown`, 0);
        set(`${NS}:product`, product);
      } catch {}
    }
  }, 10);

  return { remove };
}
