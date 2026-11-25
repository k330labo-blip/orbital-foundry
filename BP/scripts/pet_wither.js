// ミニ星炉ウィザー: 星炉ウィザー討伐で手に入る「星炉の幼核」から呼び出すペット (1人1体)
// 追従: 飼い主の周りをふわふわ浮く / 右クリック: 待機⇔追従 / 鉄インゴットで回復 / 敵に髑髏弾 (DPS 約2000)
import { ItemStack, GameMode } from "@minecraft/server";

const NS = "orbital_foundry";
export const PET = `${NS}:mini_star_wither`, PET_CORE = `${NS}:star_wither_seed`;
const BOSS = `${NS}:star_wither`;
export const PET_SPEC = {
  hp: 30000, shotEvery: 10, shotDamage: 1000,   // 0.5秒ごとに1000 = DPS 2000
  range: 22, heal: 1500, maxHit: 2000,          // 1発で受けるのは最大2000 (即死攻撃を防ぐ)
  reviveSec: 300, leash: 40,
};

export function installPetWither({ world, system, toast, damageTarget, hurtBoss, isBoss, hostileAddon }) {
  const petKey = pid => "of:pet:" + pid;
  const pets = new Map();          // entity.id -> entity
  const lastFoe = new Map();       // owner id -> { id, until }
  const fx = (dim, n, at) => { try { dim.spawnParticle(n, at); } catch { } };
  const snd = (dim, n, at, v = 1, p = 1) => { try { dim.playSound(n, at, { volume: v, pitch: p }); } catch { } };
  const ownerOf = e => { try { return e.getDynamicProperty("of:owner"); } catch { return undefined; } };
  const sitting = e => { try { return !!e.getDynamicProperty("of:sit"); } catch { return false; } };
  const playerById = id => world.getAllPlayers().find(p => p.id === id);

  function track(e) { if (e?.typeId === PET) pets.set(e.id, e); }
  world.afterEvents.entitySpawn.subscribe(({ entity }) => track(entity));
  world.afterEvents.entityLoad?.subscribe(({ entity }) => {
    if (entity?.typeId !== PET) return;
    // 1人1体: 飼い主の記録と違う個体 (古い個体) は消す
    const owner = ownerOf(entity);
    if (!owner || world.getDynamicProperty(petKey(owner)) !== entity.id) { try { entity.remove(); } catch { } return; }
    track(entity);
  });
  system.runInterval(() => {
    for (const d of ["overworld", "nether", "the_end"]) try { for (const e of world.getDimension(d).getEntities({ type: PET })) track(e); } catch { }
  }, 60);

  // ---- 呼び出し (幼核を使う) ----
  function summon(p) {
    const until = p.getDynamicProperty("of:pet_revive") ?? 0;
    if (system.currentTick < until && until - system.currentTick < PET_SPEC.reviveSec * 20 + 100) return toast(p, `§7幼核は再生中 · あと${Math.ceil((until - system.currentTick) / 20)}秒`);
    const curId = world.getDynamicProperty(petKey(p.id));
    const cur = curId && pets.get(curId);
    const at = { x: p.location.x, y: p.location.y + 2, z: p.location.z };
    if (cur?.isValid) {
      try { cur.teleport(at, { dimension: p.dimension }); cur.setDynamicProperty("of:sit", false); } catch { }
      toast(p, "§dミニ星炉ウィザーを呼び戻しました");
      return;
    }
    try {
      const e = p.dimension.spawnEntity(PET, at);
      e.setDynamicProperty("of:owner", p.id); e.setDynamicProperty("of:owner_name", p.name);
      e.nameTag = `§d${p.name}のミニ星炉ウィザー`;
      world.setDynamicProperty(petKey(p.id), e.id);
      track(e);
      for (let k = 0; k < 12; k++) fx(p.dimension, "orbital_foundry:sw_spark", { x: at.x + Math.random() - .5, y: at.y + Math.random(), z: at.z + Math.random() - .5 });
      snd(p.dimension, "mob.wither.spawn", at, .6, 1.8);
      toast(p, "§dミニ星炉ウィザーが目覚めた §7· 右クリックで待機/追従 · 鉄インゴットで回復");
    } catch (err) { toast(p, "§c呼び出せませんでした: " + err); }
  }
  try {
    system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
      itemComponentRegistry.registerCustomComponent(`${NS}:pet_core`, { onUse: ({ source }) => { if (source?.typeId === "minecraft:player") system.run(() => summon(source)); } });
    });
  } catch { }

  // ---- 右クリック: 待機⇔追従 / 鉄インゴットで回復 ----
  world.beforeEvents.playerInteractWithEntity?.subscribe(ev => {
    const e = ev.target, p = ev.player;
    if (e?.typeId !== PET) return;
    ev.cancel = true;
    const held = ev.itemStack?.typeId;
    system.run(() => {
      try {
        const h = e.getComponent("minecraft:health");
        if (ownerOf(e) !== p.id) return toast(p, `§7${e.getDynamicProperty("of:owner_name") ?? "誰か"}のミニ星炉ウィザー`);
        if (held === "minecraft:iron_ingot" && h && h.currentValue < h.effectiveMax) {
          const inv = p.getComponent("minecraft:inventory")?.container, slot = p.selectedSlotIndex, it = inv?.getItem(slot);
          if (p.getGameMode() !== GameMode.Creative && it?.typeId === "minecraft:iron_ingot") { if (it.amount <= 1) inv.setItem(slot, undefined); else { it.amount--; inv.setItem(slot, it); } }
          h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + PET_SPEC.heal));
          fx(e.dimension, "minecraft:heart_particle", { x: e.location.x, y: e.location.y + 1.2, z: e.location.z });
          snd(e.dimension, "random.anvil_use", e.location, .5, 1.8);
          return toast(p, `§a修理 +${PET_SPEC.heal}§r · 体力 ${Math.round(h.currentValue)} / ${h.effectiveMax}`);
        }
        const sit = !sitting(e);
        e.setDynamicProperty("of:sit", sit);
        if (sit) e.setDynamicProperty("of:sit_at", JSON.stringify(e.location));
        snd(e.dimension, sit ? "random.click" : "mob.wither.ambient", e.location, .5, sit ? .8 : 2);
        toast(p, `${sit ? "§e待機" : "§a追従"}§r · 体力 ${Math.round(h?.currentValue ?? 0)} / ${h?.effectiveMax ?? PET_SPEC.hp}`);
      } catch { }
    });
  });

  // ---- 被弾: 星炉ウィザーと飼い主の攻撃は無効、1発の上限で即死を防ぐ ----
  try {
    world.beforeEvents.entityHurt?.subscribe(ev => {
      const e = ev.hurtEntity;
      if (e?.typeId !== PET) return;
      const src = ev.damageSource?.damagingEntity;
      if (src?.typeId === BOSS || src?.typeId === PET || src?.typeId === "minecraft:player" || ev.damageSource?.cause === "override") { ev.cancel = true; return; }
      if (ev.damage > PET_SPEC.maxHit) ev.damage = PET_SPEC.maxHit;
    });
  } catch { }
  world.afterEvents.entityHurt.subscribe(({ hurtEntity, damageSource }) => {
    const src = damageSource?.damagingEntity;
    try {
      // 飼い主を殴った敵・飼い主が殴った敵を優先して狙う
      if (hurtEntity?.typeId === "minecraft:player" && src && src.typeId !== "minecraft:player") lastFoe.set(hurtEntity.id, { id: src.id, until: system.currentTick + 200 });
      if (src?.typeId === "minecraft:player" && hurtEntity && hurtEntity.typeId !== "minecraft:player" && hurtEntity.typeId !== PET && foe(hurtEntity)) lastFoe.set(src.id, { id: hurtEntity.id, until: system.currentTick + 200 });
    } catch { }
  });
  world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity?.typeId !== PET) return;
    try {
      const owner = deadEntity.getDynamicProperty("of:owner");
      pets.delete(deadEntity.id);
      if (!owner) return;
      world.setDynamicProperty(petKey(owner), undefined);
      const p = playerById(owner);
      if (p) { p.setDynamicProperty("of:pet_revive", system.currentTick + PET_SPEC.reviveSec * 20); toast(p, `§cミニ星炉ウィザーが倒れた §7· 幼核は${PET_SPEC.reviveSec / 60}分で再生します`); }
    } catch { }
  });

  function foe(e) {
    try {
      if (!e?.isValid || e.typeId === "minecraft:player" || e.typeId === PET || !e.getComponent("minecraft:health")) return false;
      if (e.getComponent("minecraft:tameable")?.isTamed) return false;
      return e.matches({ families: ["monster"] }) || e.matches({ families: ["orbital_foundry_boss"] }) || !!hostileAddon?.(e);
    } catch { return false; }
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  function pickTarget(e, owner) {
    const lf = owner && lastFoe.get(owner.id);
    if (lf && lf.until > system.currentTick) { const t = world.getEntity(lf.id); if (foe(t) && t.dimension.id === e.dimension.id && dist(t.location, e.location) <= PET_SPEC.range * 1.5) return t; }
    let best, bd = PET_SPEC.range;
    try {
      for (const t of e.dimension.getEntities({ location: e.location, maxDistance: PET_SPEC.range, excludeTypes: ["minecraft:item", "minecraft:xp_orb", "minecraft:player", PET] })) {
        if (!foe(t)) continue;
        const d = dist(t.location, e.location); if (d < bd) { bd = d; best = t; }
      }
    } catch { }
    return best;
  }
  function shoot(e, owner, t) {
    const from = { x: e.location.x, y: e.location.y + .9, z: e.location.z };
    let to; try { to = t.getHeadLocation(); } catch { to = t.location; }
    const d = dist(from, to), n = Math.max(2, Math.floor(d / .8));
    for (let k = 1; k <= n; k++) { const f = k / n; fx(e.dimension, k === n ? "orbital_foundry:sw_spark" : "orbital_foundry:sw_skull", { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: from.z + (to.z - from.z) * f }); }
    snd(e.dimension, "mob.wither.shoot", from, .4, 1.6);
    try { e.setProperty(`${NS}:attack`, 1); system.runTimeout(() => { try { if (e.isValid) e.setProperty(`${NS}:attack`, 0); } catch { } }, 6); } catch { }
    const shooter = owner ?? e;
    try { if (isBoss(t)) hurtBoss(t, shooter, PET_SPEC.shotDamage, from); else damageTarget(t, shooter, PET_SPEC.shotDamage, from); } catch { }
  }

  // ---- 毎ティック: ふわふわ追従・待機・射撃 ----
  system.runInterval(() => {
    const now = system.currentTick;
    for (const [id, e] of pets) {
      if (!e.isValid) { pets.delete(id); continue; }
      try {
        const ownerId = ownerOf(e), owner = ownerId && playerById(ownerId);
        const phase = (parseInt(id.slice(-4), 36) || 0) % 628 / 100;
        const bob = Math.sin(now * .08 + phase) * .25;
        let goal, look;
        if (sitting(e) || !owner) {
          let at; try { at = JSON.parse(e.getDynamicProperty("of:sit_at") ?? "null"); } catch { }
          at ??= e.location;
          goal = { x: at.x, y: at.y + bob * .5, z: at.z };
        } else {
          if (owner.dimension.id !== e.dimension.id || dist(owner.location, e.location) > PET_SPEC.leash) {
            e.teleport({ x: owner.location.x, y: owner.location.y + 2.2, z: owner.location.z }, { dimension: owner.dimension }); continue;
          }
          const a = now * .025 + phase, o = owner.location;
          goal = { x: o.x + Math.cos(a) * 2.2, y: o.y + 2.1 + bob, z: o.z + Math.sin(a) * 2.2 };
          look = owner.getHeadLocation();
        }
        const t = (!sitting(e) && owner) ? pickTarget(e, owner) : undefined;
        if (t) look = t.location;
        const l = e.location, k = .22;
        const next = { x: l.x + (goal.x - l.x) * k, y: l.y + (goal.y - l.y) * k, z: l.z + (goal.z - l.z) * k };
        e.teleport(next, look ? { facingLocation: look } : undefined);
        if (t && (now + (parseInt(id.slice(-2), 36) || 0)) % PET_SPEC.shotEvery === 0) shoot(e, owner, t);
        if (now % 6 === 0) fx(e.dimension, "orbital_foundry:sw_ember", { x: l.x, y: l.y + .6, z: l.z });
      } catch { }
    }
  }, 1);

  return { summon, PET, PET_CORE };
}
