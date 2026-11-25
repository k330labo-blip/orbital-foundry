// 防具の対兵器耐性: ゲリラアドオン等の銃・重火器・爆発によるダメージを減らす
//  鋼の防具 … 1部位15% (一式60%)
//  星炉外骨格 … 4部位そろうと100%カット (1部位ずつでも25%)
// このアドオン自身のボスの攻撃 (override) は対象外
import { NS } from "./config.js";

export const ARMOR_GUARD = {
  [NS + ":steel_helmet"]: .15, [NS + ":steel_chestplate"]: .15, [NS + ":steel_leggings"]: .15, [NS + ":steel_boots"]: .15,
  [NS + ":starforge_helmet"]: .25, [NS + ":starforge_chest"]: .25, [NS + ":starforge_legs"]: .25, [NS + ":starforge_boots"]: .25,
};
const STARFORGE_FULL = ["starforge_helmet", "starforge_chest", "starforge_legs", "starforge_boots"];
const SLOTS = ["Head", "Chest", "Legs", "Feet"];
const ours = id => !id || id === "minecraft:player" || id.startsWith("minecraft:") || id.startsWith(NS + ":");
const WEAPON_CAUSES = new Set(["projectile", "entityExplosion", "blockExplosion", "fireworks", "sonicBoom", "ramAttack", "piston"]);
const PLAIN_CAUSES = new Set(["entityAttack", "fire", "fireTick", "lava", "drowning", "fall", "suffocation", "magic", "wither", "starve", "contact",
  "freezing", "lightning", "anvil", "fallingBlock", "flyIntoWall", "stalactite", "stalagmite", "void", "selfDestruct", "temperature", "thorns", "campfire", "soulCampfire", "suicide", "dehydration", "maceSmash"]);

// 兵器 (銃・重火器・爆発・他アドオン由来) によるダメージか
export function isWeaponDamage(src) {
  const cause = src?.cause;
  if (cause === "override") return false;   // このアドオンのボスの固定ダメージ
  const attacker = src?.damagingEntity?.typeId, projectile = src?.damagingProjectile?.typeId;
  if (projectile && !ours(projectile)) return true;
  if (attacker && !ours(attacker)) return true;
  if (WEAPON_CAUSES.has(cause)) return true;
  if (cause && !PLAIN_CAUSES.has(cause)) return true;   // スクリプトの独自原因 (ゲリラの銃など)
  return false;
}
export function guardOf(p) {
  let eq; try { eq = p.getComponent("minecraft:equippable"); } catch { return 0; }
  const ids = SLOTS.map(s => { try { return eq?.getEquipment(s)?.typeId; } catch { return undefined; } });
  const full = STARFORGE_FULL.every((k, i) => ids[i] === NS + ":" + k || (i === 1 && ids[i]?.startsWith(NS + ":starforge_chest")));
  if (full) return 1;
  let g = 0;
  for (const id of ids) g += ARMOR_GUARD[id] ?? (id?.startsWith(NS + ":starforge_chest") ? .25 : 0);
  return Math.min(.95, g);
}

export function installArmorGuard({ world, system }) {
  let cancelled = false;   // 被弾前イベントで打ち消せる版か
  try {
    world.beforeEvents.entityHurt?.subscribe(ev => {
      const p = ev.hurtEntity;
      if (p?.typeId !== "minecraft:player" || !isWeaponDamage(ev.damageSource)) return;
      const g = guardOf(p);
      if (g <= 0) return;
      if (g >= 1) { ev.cancel = true; cancelled = true; }
    });
  } catch { }
  world.afterEvents.entityHurt.subscribe(({ hurtEntity: p, damage, damageSource }) => {
    if (p?.typeId !== "minecraft:player" || !isWeaponDamage(damageSource)) return;
    let g = guardOf(p);
    if (g >= 1 && cancelled) return;   // 既に打ち消し済み
    if (g <= 0) return;
    try {
      const h = p.getComponent("minecraft:health");
      if (h && h.currentValue > 0) h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + damage * Math.min(1, g)));
    } catch { }
  });
}
