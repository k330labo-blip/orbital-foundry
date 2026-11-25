// 大容量コンテナをシュルカーボックスのように中身ごと持ち運ぶ。
// 壊すと「中身入り」アイテム (1個ずつ、中身はアイテムの独自データ) になり、置くと中身ごと元に戻る。
// 空のときは普通のコンテナとして落ちる (ブロックのルートテーブルは空にして、ここで落とす)。
import { GameMode, ItemStack } from "@minecraft/server";
import { BULK_TIERS } from "./bulk_storage.js";

const DATA = "of:bulk_items";
const LIMIT = 30000;   // アイテムの独自データ1つの上限 (約32KB) より少し下
const PACKED = type => type + "_packed";
const TYPE_OF = Object.fromEntries(Object.keys(BULK_TIERS).map(t => [PACKED(t), t]));
const DIRECTIONS = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function installBulkPack({ world, system, keyOf, bulk, nameOf }) {
  const placements = new Map();
  const readPacked = item => { try { const d = JSON.parse(item.getDynamicProperty(DATA) ?? "{}"); return d && typeof d.items === "object" ? d : undefined; } catch { return undefined; } };

  world.beforeEvents.playerInteractWithBlock.subscribe(ev => {
    const { player, itemStack, block } = ev;
    const type = TYPE_OF[itemStack?.typeId];
    if (!type) return;
    const data = readPacked(itemStack);
    if (!data) return;
    const { x, y, z } = block.location, [dx, dy, dz] = DIRECTIONS[String(ev.blockFace).toLowerCase()] ?? [0, 1, 0], dim = block.dimension.id;
    placements.set(player.id, { type, data, raw: itemStack.getDynamicProperty(DATA), slot: player.selectedSlotIndex, tick: system.currentTick,
      positions: [keyOf(dim, { x, y, z }), keyOf(dim, { x: x + dx, y: y + dy, z: z + dz })] });
  });

  // main.js の設置処理 (登録のあと) から呼ぶ
  function onPlace(ev, key) {
    const pending = placements.get(ev.player?.id);
    placements.delete(ev.player?.id);
    if (!pending || pending.type !== ev.block.typeId || system.currentTick - pending.tick > 2 || !pending.positions.includes(key)) return;
    if (ev.player.getGameMode() === GameMode.Creative) {
      // クリエイティブでは手持ちが減らないので、増殖しないよう手持ちの中身入りを消す
      const inv = ev.player.getComponent("minecraft:inventory")?.container;
      const item = inv?.getItem(pending.slot);
      if (item?.typeId === PACKED(pending.type) && item.getDynamicProperty(DATA) === pending.raw) inv.setItem(pending.slot, undefined);
    }
    const state = bulk.read(key);
    for (const [id, n] of Object.entries(pending.data.items)) state.items[id] = (BigInt(state.items[id] ?? "0") + BigInt(n)).toString();
    if (typeof pending.data.accept === "boolean") state.accept = pending.data.accept;
    if (typeof pending.data.export === "boolean") state.export = pending.data.export;
    bulk.write(key, state);
  }

  // 設置を取り消されたとき (未研究など) に中身入りを返す。返したら true
  function refund(ev) {
    const pending = placements.get(ev.player?.id);
    if (!pending || pending.type !== ev.block.typeId || system.currentTick - pending.tick > 2) return false;
    placements.delete(ev.player.id);
    if (ev.player.getGameMode() !== GameMode.Creative) {
      const item = new ItemStack(PACKED(pending.type)); item.setDynamicProperty(DATA, pending.raw);
      const rest = ev.player.getComponent("minecraft:inventory")?.container?.addItem(item);
      if (rest) ev.dimension.spawnItem(rest, ev.player.location);
    }
    return true;
  }
  // 壊したときに落とすアイテム。空なら普通のコンテナ、中身があれば中身入り
  function packItem(type, key) {
    const state = bulk.read(key);
    const entries = Object.entries(state.items).filter(([, n]) => BigInt(n) > 0n);
    if (!entries.length) return new ItemStack(type);
    const raw = JSON.stringify({ items: Object.fromEntries(entries), accept: state.accept, export: state.export });
    if (raw.length > LIMIT) return undefined;
    const item = new ItemStack(PACKED(type));
    item.setDynamicProperty(DATA, raw);
    const sorted = entries.sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1));
    const total = entries.reduce((t, [, n]) => t + BigInt(n), 0n);
    const cut = t => t.length > 48 ? t.slice(0, 47) + "." : t;   // 説明文は1行50文字まで
    item.setLore([
      `§7中身 ${entries.length}種類 · 合計 ${fmt(total)}個`,
      ...sorted.slice(0, 6).map(([id, n]) => cut(`§f${nameOf(id)} §7x${fmt(n)}`)),
      ...(sorted.length > 6 ? [`§8ほか ${sorted.length - 6}種類`] : []),
    ]);
    return item;
  }
  // 品目が多すぎて1つのアイテムに書き込めないときだけ壊せない
  function canBreak(type, key) {
    const state = bulk.read(key);
    const raw = JSON.stringify({ items: state.items, accept: state.accept, export: state.export });
    return raw.length > LIMIT ? `品目の種類が多すぎて持ち運べません (${Object.keys(state.items).length}種類)。少し取り出してから回収してください` : undefined;
  }
  return { onPlace, refund, packItem, canBreak, isPacked: id => !!TYPE_OF[id] };
}
