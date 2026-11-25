// 大容量コンテナの画面 (アイテム格子)・上に浮かぶ収納物表示・残量メーター
import { ItemStack } from "@minecraft/server";
import { BULK_TIERS, BULK_TYPES, isPlainItem, fillLevel } from "./bulk_storage.js";
import { ITEM_TEXTURES, DISPLAY_ICONS, DISPLAY_ICON_BLANK } from "./item_icons.js";
import { NS } from "./config.js";

const DISPLAY = `${NS}:storage_display`;
const HOLDER = `${NS}:item_holder`;   // アイコン画像のない品目 (ほかのアドオンの物など) は、このエンティティに実物を持たせて表示する
const fmt = n => String(BigInt(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// 画面のボタン用。登録のない品目は、バニラやほかのアドオンで一般的な textures/items/<名前> を使う
const iconOf = id => ITEM_TEXTURES[id] ?? "textures/items/" + id.split(":").pop();
const sorted = items => Object.entries(items).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : BigInt(b[1]) < BigInt(a[1]) ? -1 : 0));

export function installBulk(core) {
  const { world, system, registry, createGridForm, toast, nameOf, bulk } = core;
  const inventoryOf = p => p.getComponent("minecraft:inventory")?.container;
  const sameBlock = (block, type) => { try { return block.dimension.getBlock(block.location)?.typeId === type; } catch { return false; } };

  function roomInInventory(p, itemId) {
    const inv = inventoryOf(p); if (!inv) return 0;
    const max = new ItemStack(itemId).maxAmount;
    let room = 0;
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      if (!it) room += max; else if (it.typeId === itemId && isPlainItem(it)) room += max - it.amount;
    }
    return room;
  }
  function giveExact(p, itemId, amount) {
    const inv = inventoryOf(p); if (!inv) return amount;
    const max = new ItemStack(itemId).maxAmount;
    let left = amount;
    while (left > 0) {
      const n = Math.min(max, left);
      const rest = inv.addItem(new ItemStack(itemId, n));
      left -= n - (rest?.amount ?? 0);
      if (rest) break;
    }
    return left;
  }
  // 持ち物から預ける。itemId を省くと「入れられる物を全部」
  function depositFrom(p, type, key, itemId, onlySlot) {
    const inv = inventoryOf(p); if (!inv) return 0;
    let total = 0;
    const slots = onlySlot === undefined ? [...Array(inv.size).keys()] : [onlySlot];
    for (const i of slots) {
      const it = inv.getItem(i);
      if (!it || (itemId && it.typeId !== itemId) || !isPlainItem(it)) continue;
      const added = bulk.insert(type, key, it.typeId, it.amount);
      if (!added) break;
      total += added;
      if (added === it.amount) inv.setItem(i, undefined);
      else { it.amount -= added; inv.setItem(i, it); break; }
    }
    return total;
  }
  function withdraw(p, type, key, itemId, amount) {
    const want = Math.min(amount, roomInInventory(p, itemId));
    if (want <= 0) { toast(p, "持ち物に空きがありません"); return; }
    const taken = bulk.extract(key, itemId, want);
    const left = giveExact(p, itemId, taken);
    if (left) bulk.insert(type, key, itemId, left);
    toast(p, `${nameOf(itemId)}を${taken - left}個取り出しました`);
  }

  function header(type, key) {
    const tier = BULK_TIERS[type], state = bulk.read(key), total = bulk.total(key), cap = tier.capacity;
    const kinds = Object.keys(state.items).length;
    const bar = cap === null ? "" : (() => { const n = Number(total * 24n / cap); return "[" + "|".repeat(n) + ".".repeat(24 - n) + "]"; })();
    return [
      `保管 ${fmt(total)}${cap === null ? "（上限なし）" : " / " + fmt(cap)}個　${kinds}品目` + (cap === null ? "" : `　空き ${fmt(cap - total)}個`),
      bar,
      `搬入 ${state.accept ? "ON" : "OFF"}　搬出 ${state.export ? "ON" : "OFF"}　（6面どこからでもベルト・機械と出し入れ）`,
      kinds ? "品目を選ぶと取り出せます" : "空です。下のボタンか、ベルト・機械から入れてください",
    ].join("\n");
  }
  async function show(p, block, key) {
    const type = block.typeId, tier = BULK_TIERS[type];
    const state = bulk.read(key);
    const held = inventoryOf(p)?.getItem(p.selectedSlotIndex);
    const form = createGridForm().title(tier.name).body(header(type, key));
    const actions = [];
    for (const [id, n] of sorted(state.items)) { form.button(`${nameOf(id)}\n${fmt(n)}個`, iconOf(id)); actions.push(["item", id]); }
    if (held && isPlainItem(held)) { form.button(`手持ちを預ける\n${nameOf(held.typeId)} ${held.amount}`, "textures/ui/of_bulk_in"); actions.push(["hand"]); }
    form.button("持ち物を全部預ける\n入る物だけ", "textures/ui/of_bulk_in"); actions.push(["all"]);
    form.button(`搬入 ${state.accept ? "ON" : "OFF"}\n選ぶと切替`, "textures/ui/of_bulk_in"); actions.push(["toggle", "accept"]);
    form.button(`搬出 ${state.export ? "ON" : "OFF"}\n選ぶと切替`, "textures/ui/of_bulk_out"); actions.push(["toggle", "export"]);
    form.button("閉じる", "textures/ui/of_quarry_stop"); actions.push(["close"]);
    const result = await form.show(p);
    if (result.canceled || !sameBlock(block, type)) return;
    const [act, arg] = actions[result.selection] ?? [];
    if (act === "item") return showItem(p, block, key, arg);
    if (act === "hand") { const n = depositFrom(p, type, key, held.typeId, p.selectedSlotIndex); toast(p, n ? `${n}個預けました` : "これ以上入りません"); }
    else if (act === "all") { const n = depositFrom(p, type, key); toast(p, n ? `${n}個預けました` : "入れられる物がないか、満杯です"); }
    else if (act === "toggle") { const now = bulk.read(key); now[arg] = !now[arg]; bulk.write(key, now); }
    else return;
    return show(p, block, key);
  }
  async function showItem(p, block, key, itemId) {
    const type = block.typeId, have = BigInt(bulk.read(key).items[itemId] ?? "0");
    if (have === 0n) return show(p, block, key);
    const max = new ItemStack(itemId).maxAmount;
    const form = createGridForm().title(nameOf(itemId)).body(`${BULK_TIERS[type].name}\n保管 ${fmt(have)}個\n持ち物の空き ${roomInInventory(p, itemId)}個分`);
    const icon = iconOf(itemId);
    form.button("1個取り出す", icon).button(`1スタック\n${max}個`, icon).button("入る分を\n全部取り出す", icon)
      .button(`手持ちの${nameOf(itemId)}を\n全部預ける`, "textures/ui/of_bulk_in").button("一覧へ戻る", "textures/ui/of_quarry_survey");
    const result = await form.show(p);
    if (result.canceled || !sameBlock(block, type)) return;
    const amounts = [1, max, Number.MAX_SAFE_INTEGER];
    if (result.selection < 3) withdraw(p, type, key, itemId, amounts[result.selection]);
    else if (result.selection === 3) { const n = depositFrom(p, type, key, itemId); toast(p, n ? `${n}個預けました` : "これ以上入りません"); }
    else return show(p, block, key);
    return showItem(p, block, key, itemId);
  }

  // ---- 上に浮かぶ収納物表示 (多い順に4品目) ----
  const tagOf = key => "ofb_" + key.replace(/[^A-Za-z0-9_-]/g, "_");
  const displays = new Map();
  function display(m, dim, state) {
    let entity = displays.get(m.key);
    try { if (!entity?.isValid) entity = undefined; } catch { entity = undefined; }
    if (!entity) {
      const found = dim.getEntities({ type: DISPLAY, tags: [tagOf(m.key)], location: { x: m.x + .5, y: m.y, z: m.z + .5 }, maxDistance: 2 });
      for (const extra of found.slice(1)) try { extra.remove(); } catch {}
      entity = found[0];
      if (!entity) {
        entity = dim.spawnEntity(DISPLAY, { x: m.x + .5, y: m.y, z: m.z + .5 });
        entity.addTag(tagOf(m.key)); entity.setDynamicProperty("of:bulk", m.key);
      }
      displays.set(m.key, entity);
    }
    const top = sorted(state.items).slice(0, 4);
    const set = (name, value) => { if (entity.getProperty(name) !== value) entity.setProperty(name, value); };
    for (let i = 0; i < 4; i++) {
      const id = top[i]?.[0];
      const known = id === undefined || DISPLAY_ICONS[id] !== undefined;
      const held = !known && hold(m, dim, i, id);
      if (id !== undefined) set(`${NS}:icon${i}`, known ? DISPLAY_ICONS[id] : held ? DISPLAY_ICON_BLANK : 0);
      if (known) unhold(m.key, dim, m, i);
    }
    set(`${NS}:shown`, top.length);
  }
  // ---- 実物を持たせる表示 ----
  const holderTag = (key, i) => tagOf(key) + "_h" + i;
  const holders = new Map();   // key → [entity × 4]
  function findHolder(key, dim, at, i) {
    const list = holders.get(key) ?? []; holders.set(key, list);
    if (list[i] === null) return undefined;   // いないと確認済み (毎回探さない)
    let e = list[i]; try { if (!e?.isValid) e = undefined; } catch { e = undefined; }
    if (!e) {
      const found = dim.getEntities({ type: HOLDER, tags: [holderTag(key, i)], location: { x: at.x + .5, y: at.y, z: at.z + .5 }, maxDistance: 2 });
      for (const extra of found.slice(1)) try { extra.remove(); } catch {}
      e = found[0];
    }
    list[i] = e ?? null;
    return e;
  }
  function hold(m, dim, i, id) {
    try {
      let e = findHolder(m.key, dim, m, i);
      if (!e) {
        e = dim.spawnEntity(HOLDER, { x: m.x + .5, y: m.y, z: m.z + .5 });
        e.addTag(holderTag(m.key, i)); e.setDynamicProperty("of:bulk", m.key); e.setProperty(`${NS}:slot`, i);
        holders.get(m.key)[i] = e;
      }
      if (e.getDynamicProperty("of:item") !== id) {
        const r = e.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${id}`);
        if (!r?.successCount) return false;
        e.setDynamicProperty("of:item", id);
      }
      return true;
    } catch { return false; }
  }
  function unhold(key, dim, at, i) {
    const e = findHolder(key, dim, at, i);
    if (e) { try { e.remove(); } catch {} holders.get(key)[i] = null; }
  }
  function forget(key, dim, location) {
    try { displays.get(key)?.remove(); } catch {}
    displays.delete(key);
    try { for (const e of dim.getEntities({ type: DISPLAY, tags: [tagOf(key)], location: { x: location.x + .5, y: location.y, z: location.z + .5 }, maxDistance: 2 })) e.remove(); } catch {}
    core.dpSet?.("of_bulk:" + key, undefined);
    try { for (const e of dim.getEntities({ type: HOLDER, location: { x: location.x + .5, y: location.y, z: location.z + .5 }, maxDistance: 2 })) if (e.getDynamicProperty("of:bulk") === key) e.remove(); } catch {}
    holders.delete(key);
  }
  world.afterEvents.entityLoad?.subscribe(ev => {
    try {
      if (ev.entity?.typeId === HOLDER) {
        const key = ev.entity.getDynamicProperty("of:bulk");
        if (!key || !registry().some(m => m.key === key && BULK_TYPES.has(m.type))) ev.entity.remove();
        return;
      }
      if (ev.entity?.typeId !== DISPLAY) return;
      if (ev.entity.getDynamicProperty("of:product") !== undefined) return; // 機械の製品表示は machine_product_display.js が扱う
      const key = ev.entity.getDynamicProperty("of:bulk");
      if (!key || !registry().some(m => m.key === key && BULK_TYPES.has(m.type))) ev.entity.remove();
    } catch {}
  });

  let machines = [];
  system.runInterval(() => { machines = registry().filter(m => BULK_TYPES.has(m.type)); }, 20);
  const flowUntil = new Map(), lastTotal = new Map();
  system.runInterval(() => {
    for (const m of machines) {
      try {
        const dim = world.getDimension(m.dim), block = dim.getBlock(m);
        if (block?.typeId !== m.type) continue;
        const state = bulk.read(m.key), total = bulk.total(m.key);
        display(m, dim, state);
        // 残量メーターと搬入出の光
        const fill = fillLevel(total, bulk.capacityOf(m.type));
        const last = lastTotal.get(m.key);
        if (last !== undefined && last !== total) flowUntil.set(m.key, system.currentTick + 30);
        lastTotal.set(m.key, total);
        const flowing = (flowUntil.get(m.key) ?? 0) > system.currentTick;
        const perm = block.permutation;
        const flow = flowing ? ((perm.getState(`${NS}:flow`) ?? 0) % 3) + 1 : 0;
        if (perm.getState(`${NS}:fill`) !== fill || perm.getState(`${NS}:flow`) !== flow)
          block.setPermutation(perm.withState(`${NS}:fill`, fill).withState(`${NS}:flow`, flow));
      } catch {}
    }
  }, 10);

  return { show, forget };
}
