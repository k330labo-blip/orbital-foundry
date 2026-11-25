// 大容量コンテナ: 複数品目を個数で保管する数値在庫 (容量は全品目の合計)。
// 既存の物流からは、搬出側は品目ごとの「仮想スロット」、搬入側は virtualInsert で出し入れする。
// 巨大数でも整数を失わないよう、個数は10進文字列で保存する。
import { ItemStack } from "@minecraft/server";
import { NS } from "./config.js";

export const BULK_TIERS = {
  [`${NS}:industrial_container_mk1`]: { name: "工業コンテナ Mk I", capacity: 4096n },
  [`${NS}:industrial_container_mk2`]: { name: "工業コンテナ Mk II", capacity: 32768n },
  [`${NS}:orbital_container_mk3`]: { name: "軌道コンテナ Mk III", capacity: 262144n },
  [`${NS}:singularity_container`]: { name: "特異点コンテナ", capacity: null },
};
export const BULK_TYPES = new Set(Object.keys(BULK_TIERS));

const KEY = key => "of_bulk:" + key;
const DEFAULT = () => ({ items: {}, accept: true, export: true });

// 個体データを失わせないため、名札・説明文・耐久・エンチャント・独自データ付きは受け付けない。
export function isPlainItem(item) {
  if (!item || item.maxAmount <= 1) return false;
  try { if (item.nameTag) return false; } catch {}
  try { if (item.getLore?.().length) return false; } catch {}
  try { if (item.getDynamicPropertyIds?.().length) return false; } catch {}
  try { if (item.getComponent?.("minecraft:durability")) return false; } catch {}
  try { if (item.getComponent?.("minecraft:enchantable")?.getEnchantments?.().length) return false; } catch {}
  return true;
}

const maxOf = (() => { const cache = new Map(); return id => {
  if (!cache.has(id)) { let n = 64; try { n = new ItemStack(id).maxAmount; } catch {} cache.set(id, n); }
  return cache.get(id);
}; })();
const min = (a, b) => a < b ? a : b;

export function createBulkStorage({ dpGet, dpSet }) {
  function read(key) {
    let raw; try { raw = JSON.parse(dpGet(KEY(key), "{}")); } catch { raw = {}; }
    const state = { ...DEFAULT(), ...raw, items: { ...(raw.items ?? {}) } };
    // v0.8.76〜77 の1品目形式から移行
    if (raw.item && raw.count && raw.count !== "0") state.items[raw.item] = (BigInt(state.items[raw.item] ?? "0") + BigInt(raw.count)).toString();
    delete state.item; delete state.count; delete state.push;
    return state;
  }
  const write = (key, state) => dpSet(KEY(key), JSON.stringify(state));
  const totalOf = state => Object.values(state.items).reduce((sum, n) => sum + BigInt(n), 0n);
  const capacityOf = type => BULK_TIERS[type]?.capacity ?? null; // null = 上限なし
  const roomOf = (type, state) => { const cap = capacityOf(type); return cap === null ? null : cap - totalOf(state); };
  function add(state, itemId, n) {
    const next = BigInt(state.items[itemId] ?? "0") + n;
    if (next > 0n) state.items[itemId] = next.toString(); else delete state.items[itemId];
  }
  // 入る数を返す (状態は変えない)
  function fits(type, state, amount) {
    const left = roomOf(type, state);
    return left === null ? BigInt(amount) : min(BigInt(amount), left < 0n ? 0n : left);
  }
  function insert(type, key, itemId, amount) {
    const state = read(key);
    const n = fits(type, state, amount);
    if (n <= 0n) return 0;
    add(state, itemId, n); write(key, state);
    return Number(n);
  }
  function extract(key, itemId, amount) {
    const state = read(key);
    const have = BigInt(state.items[itemId] ?? "0");
    const take = min(BigInt(amount), have);
    if (take <= 0n) return 0;
    add(state, itemId, -take); write(key, state);
    return Number(take);
  }
  // 搬出用: 品目ごとに1スロット。getItem は最大1スタック分を見せ、setItem で差分を反映する。
  function outputView(key) {
    const ids = Object.keys(read(key).items);
    const shown = (state, id) => Number(min(BigInt(state.items[id] ?? "0"), BigInt(maxOf(id))));
    return {
      size: ids.length,
      getItem(slot) { const id = ids[slot], state = read(key), n = id ? shown(state, id) : 0; return n ? new ItemStack(id, n) : undefined; },
      setItem(slot, item) {
        const id = ids[slot]; if (!id) return;
        const state = read(key);
        if (item && item.typeId !== id) return;
        add(state, id, BigInt(item?.amount ?? 0) - BigInt(shown(state, id)));
        write(key, state);
      },
      ids,
    };
  }
  function view(block, key, output) {
    if (!BULK_TYPES.has(block.typeId)) return undefined;
    const state = read(key), type = block.typeId;
    if (output) {
      if (!state.export) return null;
      const storage = outputView(key);
      return { block, storage, slots: storage.ids.map((_, i) => i), bulk: true };
    }
    if (!state.accept) return null;
    return {
      block, storage: { size: 0, getItem() {}, setItem() {} }, slots: [], bulk: true, itemFilter: isPlainItem,
      virtualRoom: item => Number(min(fits(type, read(key), item.amount), BigInt(item.amount))),
      virtualInsert: item => insert(type, key, item.typeId, item.amount),
    };
  }
  const isEmpty = key => totalOf(read(key)) === 0n;
  return { read, write, view, insert, extract, isEmpty, capacityOf, total: key => totalOf(read(key)) };
}

export function fillLevel(count, capacity) {
  if (count <= 0n) return 0;
  if (capacity === null) return 4;
  // 4段階 (1/4ごと)。端数は切り上げ: 1個でも入っていれば1段目が点く
  return Math.min(4, Math.max(1, Number((count * 4n + capacity - 1n) / capacity)));
}
