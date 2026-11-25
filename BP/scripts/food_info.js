// 食料の回復量 (満腹度 / 隠し満腹度) をツールチップ (説明文) に書き込み、手持ち食料の効果を HUD 用に返す。
// 値は統合版の実値 (Java版とほぼ同じ)。隠し満腹度 = 満腹度 × 隠し倍率 × 2。

// [満腹度, 隠し満腹度, 補足]
const V = {
  apple: [4, 2.4], baked_potato: [5, 6], beef: [3, 1.8], beetroot: [1, 1.2], beetroot_soup: [6, 7.2],
  bread: [5, 6], carrot: [3, 3.6], chicken: [2, 1.2, "30%で空腹 (30秒)"], chorus_fruit: [4, 2.4, "ランダムにテレポート"],
  cod: [2, 0.4], cooked_beef: [8, 12.8], cooked_chicken: [6, 7.2], cooked_cod: [5, 6], cooked_mutton: [6, 9.6],
  cooked_porkchop: [8, 12.8], cooked_rabbit: [5, 6], cooked_salmon: [6, 9.6], cookie: [2, 0.4], dried_kelp: [1, 0.6],
  enchanted_golden_apple: [4, 9.6, "再生II・衝撃吸収IV・耐性・火炎耐性"], golden_apple: [4, 9.6, "再生II・衝撃吸収"],
  golden_carrot: [6, 14.4], glow_berries: [2, 0.4], honey_bottle: [6, 1.2, "毒を治す"], melon_slice: [2, 1.2],
  mushroom_stew: [6, 7.2], mutton: [2, 1.2], poisonous_potato: [2, 1.2, "60%で毒 (5秒)"], porkchop: [3, 1.8],
  potato: [1, 0.6], pufferfish: [1, 0.2, "毒IV・吐き気・空腹III"], pumpkin_pie: [8, 4.8], rabbit: [3, 1.8],
  rabbit_stew: [10, 12], rotten_flesh: [4, 0.8, "80%で空腹 (30秒)"], salmon: [2, 0.4], spider_eye: [2, 3.2, "毒 (5秒)"],
  suspicious_stew: [6, 7.2, "材料の花で効果が変わる"], sweet_berries: [2, 0.4], tropical_fish: [1, 0.2],
};
// 本アドオンの作物 (items/*.json の nutrition と saturation_modifier から)
const CUSTOM = { tomato: [6, .8], canned_ration: [12, .75], paprika: [7, .9], corn: [8, .8], sweet_potato: [10, .7],
  edamame: [6, 1], cabbage: [8, .7], strawberry: [5, .8], onion: [7, .8] };

const r1 = n => Math.round(n * 10) / 10;
export function foodValue(item) {
  if (!item) return;
  const id = item.typeId;
  if (id.startsWith("minecraft:")) { const v = V[id.slice(10)]; if (v) return { n: v[0], s: v[1], note: v[2] }; }
  if (id.startsWith("orbital_foundry:")) { const v = CUSTOM[id.slice(16)]; if (v) return { n: v[0], s: r1(v[0] * v[1] * 2) }; }
  try {   // ほかのアドオンの食べ物も、食料コンポーネントがあれば表示する
    const f = item.getComponent("minecraft:food");
    if (f && f.nutrition > 0) return { n: f.nutrition, s: r1(f.nutrition * f.saturationModifier * 2) };
  } catch {}
}

// 以前の版は食料の説明文 (lore) に回復量を書き込んでいたが、説明文の違う食料は重ならない (拾った物・チェストの物と
// スタックしない、説明文付きは大容量コンテナにも入らない)。今は書き込まず、手に持ったときに画面下へ表示する。
// 以前の版で付けた説明文の行は、持ち物から取り除いて元どおり重なるようにする。
const OLD_TAGS = ["§r§f§r", "§r§8§o§f"];
const isOldLine = l => OLD_TAGS.some(t => l.startsWith(t));
export function cleanInventory(player) {
  let inv; try { inv = player.getComponent("minecraft:inventory")?.container; } catch { return; }
  if (!inv) return;
  let changed = false;
  for (let i = 0; i < inv.size; i++) {
    let item; try { item = inv.getItem(i); } catch { continue; }
    if (!item || !foodValue(item)) continue;
    let lore = []; try { lore = item.getLore(); } catch {}
    if (!lore.some(isOldLine)) continue;
    try { item.setLore(lore.filter(l => !isOldLine(l))); inv.setItem(i, item); changed = true; } catch {}
  }
  if (changed) mergeFood(inv);
}
// 手に持った食料の回復量 (画面下の表示用)
export function heldFoodText(player) {
  let item; try { item = player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex); } catch {}
  const v = item && foodValue(item);
  if (!v) return;
  return `§7満腹度 §a+${v.n} §7(ゲージ ${v.n / 2}個分)  隠し満腹度 §e+${v.s}` + (v.note ? `  §7${v.note}` : "");
}
function mergeFood(inv) {
  const seen = [];
  for (let i = 0; i < inv.size; i++) {
    let item; try { item = inv.getItem(i); } catch { continue; }
    if (!item || !foodValue(item) || item.amount >= item.maxAmount) { if (item && foodValue(item)) seen.push(i); continue; }
    for (const j of seen) {
      const base = inv.getItem(j);
      if (!base || base.amount >= base.maxAmount || !base.isStackableWith(item)) continue;
      const n = Math.min(item.amount, base.maxAmount - base.amount);
      base.amount += n; inv.setItem(j, base);
      item.amount -= n;
      if (item.amount <= 0) { inv.setItem(i, undefined); item = undefined; break; }
    }
    if (item) { inv.setItem(i, item); seen.push(i); }
  }
}

// 満腹度・隠し満腹度・消耗度 (どれも Script API の属性)
export function hungerOf(player) {
  const get = id => { try { return player.getComponent(id); } catch {} };
  const h = get("minecraft:player.hunger"), s = get("minecraft:player.saturation"), e = get("minecraft:player.exhaustion");
  if (!h || !s) return;
  return { hunger: h.currentValue, hungerMax: h.effectiveMax || 20, sat: s.currentValue, ex: e?.currentValue ?? 0, exMax: e?.effectiveMax || 4 };
}
// 手に持った食料を食べたらどうなるか (隠し満腹度は満腹度を超えられない)
export function previewEat(player, st) {
  let item; try { item = player.getComponent("minecraft:equippable")?.getEquipment("Mainhand"); } catch {}
  if (!item) { try { item = player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex); } catch {} }
  const v = foodValue(item);
  if (!v || !st) return;
  const hunger = Math.min(st.hungerMax, st.hunger + v.n);
  return { n: v.n, s: v.s, hunger, sat: r1(Math.min(hunger, st.sat + v.s)) };
}
