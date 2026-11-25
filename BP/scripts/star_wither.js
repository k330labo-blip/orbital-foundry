// 星炉ウィザー: 工業頭部3種を鉄のT字に載せ、本編クリア者が星炉頭部にレンチを使うと起動する強化ウィザー
//  追尾頭部 … 誘導弾。空中の相手には弾数と速度が増える
//  重装頭部 … 正面からの攻撃を装甲で大きく減らす。突進
//  星炉頭部 … 照射ビーム。両脇を壊すと露出して本体ダメージが通る (第二形態)
// 撃破で終焉星核。軌道工廠へ送り返すと軌道爆撃指示器が使えるようになる
import { GameMode, ItemStack, MolangVariableMap } from "@minecraft/server";
import { NS } from "./config.js";

const id = n => NS + ":" + n;
const BOSS = id("star_wither"), CORE = id("end_star_core"), DESIGNATOR = id("orbital_strike_designator"), WRENCH = id("wrench");
const HEAD = { tracker: id("head_tracker"), star: id("head_star"), heavy: id("head_heavy") };
export const WITHER = {
  hp: { tracker: 14000, heavy: 21000, star: 45000 },
  regenPerSecond: { armored: 200, exposed: 550, final: 1000 },
  regenBreakTicks: 80,
  coreGuard: .1,          // 両脇が残っている間、星炉頭部に通るダメージの割合
  frontGuard: .25,        // 重装頭部が残っている間、正面から本体へ通る割合
  frontArc: 65,           // 正面とみなす角度 (度)
  riftLaserMinRange: 50,
  riftLaserInterval: { armored: 120, exposed: 100, final: 80 },
  riftLaserDamage: { armored: 36, exposed: 44, final: 52 },
  warpDist: 100, warpCooldown: 400,   // これより遠いと瞬間移動で詰めてくる (20秒に1回まで)
  bulletSpeed: 2.2,
  orbDamage: 20, bigDamage: 40, orbRatio: .12, aimedSpeed: 1.35, bigRatio: .25,
  missileBlast: 18, beamBlast: 8, blastCooldown: 15,   // 爆発ダメージは0.75秒に1回まで   // 爆発の固定ダメージ (叩きつけ・突進・隕石・崩壊の爆発はダメージなし。即死判定は別)   // 通常弾 (防具・耐性無視)       // 外骨格の飛行 (最大約50ブロック/秒) に合わせた弾速の倍率
  moveSpeed: 2,           // ボスの移動速度の倍率
  missileEvery: 40, missileDamage: 10, missileSpeed: .85, missileAirSpeed: 1.25,
  beamEvery: 100, beamTelegraph: 30, beamDamage: 18, beamRange: 48,
  ramEvery: 140, ramDamage: 16,
  novaEvery: 160, novaDamage: 14, novaRadius: 9,
  despawnTicks: 10 * 60 * 20,
  strikeCooldown: 90 * 20, strikeDamage: 2500, strikeRadius: 9, strikeDelay: 50,
};
const W = WITHER;
const FUSION = "koke_blade:seimetsu";
const mainBlade = p => { try { return p.getComponent("minecraft:equippable")?.getEquipment("Mainhand")?.typeId; } catch { return undefined; } };
const hasFusion = p => mainBlade(p) === FUSION;
function bladeRules(type, awakened, kind) {
  if (type === FUSION) return { mult: 5, stop: 100, ignoreFront: true };
  if (type === "koke_blade:tenmetsu") return { mult: awakened ? 2 : 1.5, stop: awakened && kind === "finale" ? 60 : 0 };
  if (type === "koke_blade:seirou") return { mult: 2.5, stop: 0, frontFactor: .75 };
  return { mult: 1, stop: 0 };
}
const LEGACY_HP = { tracker: 8000, heavy: 12000, star: 30000 };
const DEBUG_ANYONE = true;
const plus = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = v => Math.hypot(v.x, v.y, v.z);
const norm = v => { const d = len(v) || 1; return { x: v.x / d, y: v.y / d, z: v.z / d }; };
const dist = (a, b) => len(sub(a, b));
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

// モデル (scale 1.6, 1px = 0.1 block) 上の頭部の位置。ファイル +x はワールド +x (yaw 0)、正面は yaw 方向
const HEAD_AT = { tracker: [3.25, 8.45], star: [0, 9.1], heavy: [-3.25, 8.45] };   // scale 2.6 (1px = 0.1625)
export function headWorld(loc, yaw, part) {
  const r = yaw * Math.PI / 180, [x, y] = HEAD_AT[part];
  return { x: loc.x + Math.cos(r) * x, y: loc.y + y, z: loc.z + Math.sin(r) * x };
}
const facing = yaw => { const r = yaw * Math.PI / 180; return { x: -Math.sin(r), y: 0, z: Math.cos(r) }; };

// 鉄のT字 + 頭部3つ。center = 星炉頭部の位置
export function findAltar(getType, c) {
  if (getType(c) !== HEAD.star) return undefined;
  for (const [ax, az] of [[1, 0], [0, 1]]) {
    const a = { x: c.x + ax, y: c.y, z: c.z + az }, b = { x: c.x - ax, y: c.y, z: c.z - az };
    const ta = getType(a), tb = getType(b);
    const ok = (ta === HEAD.tracker && tb === HEAD.heavy) || (ta === HEAD.heavy && tb === HEAD.tracker);
    if (!ok) continue;
    const iron = [{ x: c.x, y: c.y - 1, z: c.z }, { x: a.x, y: c.y - 1, z: a.z }, { x: b.x, y: c.y - 1, z: b.z }, { x: c.x, y: c.y - 2, z: c.z }];
    if (!iron.every(p => getType(p) === "minecraft:iron_block")) continue;
    return { tracker: ta === HEAD.tracker ? a : b, heavy: ta === HEAD.heavy ? a : b, star: c, iron };
  }
  return undefined;
}

// 外骨格 HUD から参照する: 危険警告とロックオン表示
export const SW_INFO = {
  warn: () => undefined, lock: () => undefined,
  targetPart: () => undefined, partLocation: () => undefined,
};
const SPELL_NAME = { ram: "断罪の突進", beam: "星炉照射", collapse: "星炉崩壊", lasers: "四重断頭光", meteors: "軌道落星" };
export function installStarWither(core) {
  const { world, system, toast, hasCompleted, hasBombard, damageTarget } = core;
  const live = new Map();      // boss.id -> state
  const missiles = [];
  const summoning = new Set();
  const fx = (dim, name, at) => { try { dim.spawnParticle(name, at); } catch { } };
  const of = n => "orbital_foundry:starforge_" + n;
  const snd = (dim, key, at, volume = 1, pitch = 1) => { try { dim.playSound(key, at, { volume, pitch }); } catch { } };
  const shake = (p, i, t) => { try { p.runCommand(`camerashake add @s ${i} ${t} positional`); } catch { } };
  // 即死攻撃を無効にする瞬間だけ専用バリアを表示。多重弾でも描画は5tickに1回。
  const shieldFxAt = new Map(), shieldCreditAt = new Map();
  function absorb(p) {
    if (!hasFusion(p)) return false;
    const now = system.currentTick;
    if (shieldCreditAt.get(p.id) !== now) {
      shieldCreditAt.set(p.id,now);
      try { p.addTag(`kb_sw_absorb|${now}`); } catch { }
    }
    if (now >= (shieldFxAt.get(p.id) ?? -1)) {
      shieldFxAt.set(p.id, now+5);
      const at = plus(p.location,{x:0,y:1.05,z:0});
      fx(p.dimension,"orbital_foundry:sw_astral_shield",at);
      for (let i=0;i<6;i++) {
        const a=i*Math.PI/3;
        fx(p.dimension,"orbital_foundry:sw_astral_gold",plus(at,{x:Math.cos(a)*1.15,y:.35,z:Math.sin(a)*1.15}));
      }
      snd(p.dimension,"random.anvil_land",at,.65,1.8);
      snd(p.dimension,"beacon.power",at,.55,1.55);
    }
    return true;
  }
  world.afterEvents.playerLeave.subscribe(({playerId})=>{shieldFxAt.delete(playerId);shieldCreditAt.delete(playerId);});
  const players = (dim, at, r) => dim.getPlayers({ location: at, maxDistance: r }).filter(p => { try { const m = p.getGameMode(); return m !== GameMode.Creative && m !== GameMode.Spectator; } catch { return true; } });

  // ---------- 召喚 ----------
  function skyBeam(dim, to, color = "surge") {
    for (let y = 0; y < 42; y += 1.2) fx(dim, of(y % 3.6 < 1.2 ? color : "tracer"), { x: to.x + .5, y: to.y + .5 + y, z: to.z + .5 });
  }
  function setLit(dim, pos, lit) { try { const b = dim.getBlock(pos); b.setPermutation(b.permutation.withState("orbital_foundry:lit", lit)); } catch { } }
  function summon(p, block) {
    const dim = block.dimension, key = dim.id + ":" + block.location.x + "," + block.location.y + "," + block.location.z;
    if (summoning.has(key)) return;
    // デバッグ中: 本編クリア前でも起動できる (DEBUG_ANYONE を false に戻すと本編クリア者限定)
    if (!DEBUG_ANYONE && !hasCompleted(p)) return toast(p, "§c軌道工廠を完成させたプレイヤーだけが起動できます");
    const altar = findAltar(pos => { try { return dim.getBlock(pos)?.typeId; } catch { return undefined; } }, block.location);
    if (!altar) return toast(p, "§c鉄ブロック4個のT字の上段に、追尾・星炉・重装の頭部を横一列に並べてください");
    summoning.add(key);
    const c = altar.star, center = { x: c.x + .5, y: c.y - .5, z: c.z + .5 };
    toast(p, "§d軌道工廠より照射開始 · 星炉ウィザー起動シーケンス");
    snd(dim, "beacon.activate", center, 2, .5);
    const steps = [[0, "tracker"], [22, "heavy"], [44, "star"]];
    for (const [t, part] of steps) {
      for (let k = 0; k < 16; k += 2) system.runTimeout(() => skyBeam(dim, altar[part]), t + k);
      system.runTimeout(() => {
        setLit(dim, altar[part], true);
        const at = { x: altar[part].x + .5, y: altar[part].y + .5, z: altar[part].z + .5 };
        fx(dim, of("surge"), at); fx(dim, "minecraft:sonic_explosion", at);
        snd(dim, "beacon.power", at, 1.5, part === "star" ? .6 : 1.2);
        snd(dim, "ambient.weather.thunder", at, .5, 1.6);
      }, t + 16);
    }
    // 鉄の骨格が浮かび上がる
    system.runTimeout(() => {
      try {
        for (const pos of [...altar.iron, altar.tracker, altar.heavy, altar.star]) {
          const at = { x: pos.x + .5, y: pos.y + .5, z: pos.z + .5 };
          for (let k = 0; k < 4; k++) system.runTimeout(() => { fx(dim, of("thrust"), { x: at.x, y: at.y + k * .5, z: at.z }); fx(dim, "orbital_foundry:overseer_sparks", at); }, k * 3);
          dim.getBlock(pos)?.setType("minecraft:air");
        }
        snd(dim, "mob.wither.spawn", center, 2, .7);
        snd(dim, "random.anvil_land", center, 1, .5);
        const boss = dim.spawnEntity(BOSS, { x: center.x, y: center.y - 1, z: center.z });
        const s = fresh(); s.home = center; s.summoner = p.id;
        live.set(boss.id, s); save(boss, s);
        assemble(boss, s);
      } catch { }
      summoning.delete(key);
    }, 70);
  }
  // 鉄の骨格が下から順に組み上がる (尻尾→背骨→歯車→肩→背の大歯車→首→頭→翼と触手)
  const BUILD_Y = [0, 1.5, 4, 5, 6.8, 6, 7.5, 8.8, 7];
  function assemble(e, s) {
    const dim = e.dimension, now = system.currentTick;
    s.awakenUntil = now + 100; s.startTick = now + 100;
    try { e.setProperty("orbital_foundry:build", 0); } catch { }
    for (let k = 1; k <= 8; k++) system.runTimeout(() => {
      try {
        e.setProperty("orbital_foundry:build", k);
        const at = plus(e.location, { x: 0, y: BUILD_Y[k], z: 0 });
        fx(dim, "orbital_foundry:sw_spark", at); fx(dim, "orbital_foundry:overseer_sparks", at); fx(dim, of("surge"), at);
        for (let y = 0; y < 30; y += 1.5) fx(dim, of("tracer"), plus(at, { x: 0, y, z: 0 }));
        snd(dim, "random.anvil_land", at, 1.5, .5 + k * .08); snd(dim, k % 2 ? "tile.piston.out" : "block.grindstone.use", at, 1.5, .6);
        for (const q of players(dim, at, 64)) shake(q, .05 + k * .01, .3);
      } catch { }
    }, k * 10);
    system.runTimeout(() => {
      try {
        e.setProperty("orbital_foundry:build", 9);
        const at = plus(e.location, { x: 0, y: 6, z: 0 });
        fx(dim, "minecraft:huge_explosion_emitter", at); fx(dim, "orbital_foundry:overseer_core_burst", at);
        snd(dim, "mob.wither.spawn", at, 3, .6); snd(dim, "mob.enderdragon.growl", at, 3, .5);
        for (const q of dim.getPlayers({ location: at, maxDistance: 90 })) {
          shake(q, .3, 1.5);
          try { q.onScreenDisplay.setTitle("§5§l星炉ウィザー", { subtitle: "§d軌道工廠の亡霊が目を覚ます", fadeInDuration: 5, stayDuration: 50, fadeOutDuration: 15 }); } catch { }
          try { const v = norm({ ...sub(q.location, at), y: 0 }); if (!hasFusion(q) && dist(q.location, at) < 16) q.applyKnockback({ x: v.x * 2, z: v.z * 2 }, .5); } catch { }
        }
      } catch { }
    }, 92);
  }
  world.beforeEvents.playerInteractWithBlock.subscribe(ev => {
    if (ev.block?.typeId !== HEAD.star) return;
    if (ev.itemStack?.typeId !== WRENCH) return;
    ev.cancel = true;
    const p = ev.player, block = ev.block;
    system.run(() => summon(p, block));
  });

  // ---------- 状態 ----------
  const fresh = () => ({ hp: { ...W.hp }, t: 0, hitTag: 0, next: { missile: 60, beam: 120, ram: 160, nova: 200 }, beam: undefined, ram: undefined, dead: false });
  const save = (e, s) => { try { e.setDynamicProperty("of:sw", JSON.stringify({ hp: s.hp, maxHp: W.hp, home: s.home, final: !!s.final })); } catch { } };
  function stateOf(e) {
    let s = live.get(e.id);
    if (!s) {
      s = fresh();
      try {
        const d = JSON.parse(e.getDynamicProperty("of:sw") ?? "{}");
        if (d.hp) {
          for (const part of Object.keys(W.hp)) {
            if (!Number.isFinite(d.hp[part])) continue;
            const previousMax = d.maxHp?.[part] || LEGACY_HP[part];
            s.hp[part] = Math.max(0, Math.min(W.hp[part], d.hp[part] * W.hp[part] / previousMax));
          }
        }
        s.home = d.home;
        s.final = d.final ?? (e.getProperty("orbital_foundry:final") === 1);
      } catch { }
      live.set(e.id, s);
    }
    return s;
  }
  const total = s => Math.max(0, s.hp.tracker) + Math.max(0, s.hp.heavy) + Math.max(0, s.hp.star);
  const MAX = W.hp.tracker + W.hp.heavy + W.hp.star;
  function mirror(e, s) {
    try { e.getComponent("minecraft:health")?.setCurrentValue(Math.max(1, Math.round(100000 * total(s) / MAX))); } catch { }
    const heads = (s.hp.tracker <= 0 ? 1 : 0) + (s.hp.heavy <= 0 ? 2 : 0);
    try { if (e.getProperty("orbital_foundry:heads") !== heads) e.setProperty("orbital_foundry:heads", heads); } catch { }
  }

  // ---------- 被弾 (部位の振り分け) ----------
  function pickPart(e, s, attacker, origin) {
    const loc = e.location, yaw = e.getRotation().y;
    const alive = ["tracker", "heavy", "star"].filter(k => s.hp[k] > 0);
    let from = origin, dir;
    if (attacker?.typeId === "minecraft:player") { from = attacker.getHeadLocation(); dir = norm(attacker.getViewDirection()); }
    if (from && dir) {
      let best, bd = 2.4;
      for (const k of alive) {
        const h = headWorld(loc, yaw, k), v = sub(h, from), t = dot(v, dir);
        if (t < 0) continue;
        const d = dist(h, plus(from, dir, t));
        if (d < bd) { bd = d; best = k; }
      }
      if (best) return best;
    }
    if (from) { let best, bd = 1e9; for (const k of alive) { const d = dist(headWorld(loc, yaw, k), from); if (d < bd) { bd = d; best = k; } } return best ?? "star"; }
    return "star";
  }
  function hurt(e, amount, attacker, origin, attack, lockedPart, blade) {
    const s = stateOf(e);
    const tick = system.currentTick;
    if (s.dead || s.leaving || s.hp.star <= 0 || (s.awakenUntil ?? 0) > tick || (s.transformUntil ?? 0) > s.t) {
      mirror(e, s);
      return false;
    }
    if (lockedPart && !(s.hp[lockedPart] > 0)) return false;
    let part = lockedPart ?? pickPart(e, s, attacker, origin);
    if (s.hp[part] <= 0) part = "star";
    const rule = blade ? bladeRules(blade.type,blade.awakened,blade.kind) : {mult:1,stop:0};
    let dmg = amount * rule.mult, deflect = false;
    const sides = (s.hp.tracker > 0) + (s.hp.heavy > 0);
    // 星滅は正面装甲を無視するが、両脇の頭部破壊は省略できない。
    if (rule.ignoreFront && part === "star" && sides) part = s.hp.heavy > 0 ? "heavy" : "tracker";
    // 重装頭部: 正面からの攻撃を装甲で受ける (重装頭部そのものを狙った場合を除く)
    if (!rule.ignoreFront && s.hp.heavy > 0 && part !== "heavy") {
      const src = attacker?.location ?? origin;
      if (src) {
        const f = facing(e.getRotation().y), v = norm({ ...sub(src, e.location), y: 0 });
        if (Math.acos(Math.max(-1, Math.min(1, dot(f, v)))) * 180 / Math.PI < W.frontArc) {
          dmg *= rule.frontFactor ?? W.frontGuard; deflect = true;
          const sh = plus(headWorld(e.location, e.getRotation().y, "heavy"), f, 1.4);
          fx(e.dimension, "orbital_foundry:sw_spark", sh); fx(e.dimension, "orbital_foundry:overseer_sparks", sh); fx(e.dimension, of("impact"), sh);
          if (system.currentTick - (s.lastDeflect ?? 0) >= 3) { s.lastDeflect = system.currentTick; snd(e.dimension, "random.anvil_land", sh, 1, 1.7); snd(e.dimension, "mob.irongolem.hit", sh, 1, .6); }
        }
      }
    }
    if (part === "star" && sides > 0) dmg *= W.coreGuard;
    const breaksRegen = attack === "charge" && part === "star" && sides === 0 && s.final;
    if (breaksRegen || rule.stop) s.regenBlockedUntil = Math.max(s.regenBlockedUntil ?? 0, s.t + Math.max(breaksRegen ? W.regenBreakTicks : 0,rule.stop));
    if (rule.stop && s.t >= (s.nextBladeFx ?? 0)) {
      s.nextBladeFx = s.t + 5;
      fx(e.dimension,"orbital_foundry:sw_astral_cut",headWorld(e.location,e.getRotation().y,part));
    }
    // 星滅の大ダメージでも部位と最終形態を飛ばさない。
    if (rule.ignoreFront && part === "star" && !s.final && sides === 0 && s.hp.star-dmg <= W.hp.star*.25) dmg = Math.min(dmg,s.hp.star-Math.floor(W.hp.star*.25)+1);
    s.hp[part] = Math.max(0, s.hp[part] - dmg);
    // 当たった頭部だけ光らせる (装甲で弾いた時は盾が光る)
    try {
      e.setProperty("orbital_foundry:hit", deflect ? 4 : part === "tracker" ? 1 : part === "heavy" ? 2 : 3);
      const tag = ++s.hitTag; system.runTimeout(() => { try { if (s.hitTag === tag) e.setProperty("orbital_foundry:hit", 0); } catch { } }, 4);
      if (part === "star" && sides === 0) { e.setProperty("orbital_foundry:hurt", true); system.runTimeout(() => { try { e.setProperty("orbital_foundry:hurt", false); } catch { } }, 3); }
    } catch { }
    if (!deflect) {
      const hp = headWorld(e.location, e.getRotation().y, part);
      fx(e.dimension, "orbital_foundry:sw_spark", hp);
      if (system.currentTick % 3 === 0) fx(e.dimension, "orbital_foundry:overseer_debris", hp);
      if (system.currentTick - (s.lastHitSnd ?? 0) >= 3) { s.lastHitSnd = system.currentTick;
        snd(e.dimension, part === "star" ? "mob.wither.hurt" : part === "heavy" ? "random.anvil_land" : "mob.irongolem.hit", hp, 1, part === "star" ? (sides ? .5 : .8) : 1.2); }
    }
    if (sides === 0 && !s.final && s.hp.star < W.hp.star * .25 && s.hp.star > 0) { enterFinal(e, s); save(e, s); mirror(e, s); return; }
    if (part !== "star" && s.hp[part] <= 0) breakHead(e, s, part);
    save(e, s); mirror(e, s);
    if (s.hp.star <= 0) {
      if (blade && attacker?.typeId === "minecraft:player") try { attacker.addTag(`kb_sw_credit|${blade.type}|${e.id}`); } catch { }
      die(e, s);
    }
    return !!breaksRegen;
  }
  function breakHead(e, s, part) {
    const at = headWorld(e.location, e.getRotation().y, part), dim = e.dimension;
    for (let k = 0; k < 8; k++) system.runTimeout(() => { fx(dim, "minecraft:large_explosion", plus(at, { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 2 - 1 })); fx(dim, of("impact"), at); }, k * 2);
    snd(dim, "random.explode", at, 2, .7);
    snd(dim, "mob.irongolem.death", at, 1.5, .6);
    const name = part === "tracker" ? "追尾頭部" : "重装頭部";
    const both = s.hp.tracker <= 0 && s.hp.heavy <= 0;
    for (const p of dim.getPlayers({ location: e.location, maxDistance: 96 })) {
      toast(p, both ? "§d両脇の頭部を破壊 · 星炉が露出した！" : `§6${name}を破壊`);
      if (both) shake(p, .2, 1);
    }
    if (both) transform(e, s, 2);
  }
  // カメラ演出: 近くのプレイヤーの視点を一時的にボスを映す位置へ移す (ボスは静止・弾幕なし)
  function cinematic(e, ticks, height = 5, dist_ = 16) {
    const dim = e.dimension, c = plus(e.location, { x: 0, y: height, z: 0 });
    for (const p of dim.getPlayers({ location: e.location, maxDistance: 120 })) {
      try {
        const v = norm({ ...sub(p.location, e.location), y: 0 }), side = { x: -v.z, y: 0, z: v.x };
        const a = plus(plus(c, v, dist_), { x: side.x * 6, y: 2, z: side.z * 6 }), b = plus(plus(c, v, dist_ * .7), { x: -side.x * 5, y: 1, z: -side.z * 5 });
        const f = n => n.toFixed(2), cmd = (pos, ease) => `camera @s set minecraft:free ${ease ? `ease ${ease} in_out_cubic ` : ""}pos ${f(pos.x)} ${f(pos.y)} ${f(pos.z)} facing ${f(c.x)} ${f(c.y)} ${f(c.z)}`;
        p.runCommand(`camera @s fade time 0.15 0.1 0.25 color 0 0 0`);
        system.runTimeout(() => { try { p.runCommand(cmd(a)); p.runCommand(cmd(b, (ticks / 20 - .3).toFixed(1))); } catch { } }, 3);
        system.runTimeout(() => { try { p.runCommand(`camera @s fade time 0.1 0.1 0.2 color 0 0 0`); } catch { } }, ticks - 2);
        system.runTimeout(() => { try { p.runCommand("camera @s clear"); } catch { } }, ticks + 1);
      } catch { }
    }
  }
  // 形態変化: 一瞬止まり、爆発の連鎖とともに星炉がむき出しになる
  function transform(e, s, stage) {
    const dim = e.dimension, len_ = stage === 3 ? 60 : 80;
    s.spell = undefined; s.transformUntil = s.t + len_; s.gap = s.t + len_ + 10;
    bullets.length = 0;
    try { e.setProperty("orbital_foundry:attack", 3); } catch { }
    cinematic(e, Math.min(70, len_ - 5), 6, stage === 3 ? 13 : 16);
    snd(dim, "mob.enderdragon.growl", e.location, 3, stage === 3 ? .5 : .8); snd(dim, "mob.wither.spawn", e.location, 2, stage === 3 ? .4 : .6);
    for (const q of dim.getPlayers({ location: e.location, maxDistance: 110 })) {
      shake(q, .35, 2.5);
      try { q.onScreenDisplay.setTitle(stage === 3 ? "§4§l最終形態" : "§d§l星炉露出", { subtitle: stage === 3 ? "§c外れた大歯車が周回する · 広がる輪の隙間を抜けろ" : "§f胸の星炉にダメージが通る", fadeInDuration: 2, stayDuration: 40, fadeOutDuration: 10 }); } catch { }
    }
    for (let k = 0; k < len_; k += 3) system.runTimeout(() => {
      try {
        const at = plus(e.location, { x: Math.random() * 8 - 4, y: 2 + Math.random() * 8, z: Math.random() * 8 - 4 });
        fx(dim, "minecraft:large_explosion", at); fx(dim, "orbital_foundry:sw_spark", at);
        if (k % 9 === 0) snd(dim, "random.explode", at, 1.5, .6 + Math.random() * .4);
        if (k % 6 === 0) for (let a = 0; a < 360; a += 15) { const t = a * Math.PI / 180, rr = 3 + k * .25; fx(dim, of("surge"), plus(e.location, { x: Math.cos(t) * rr, y: 5, z: Math.sin(t) * rr })); }
      } catch { }
    }, k);
    system.runTimeout(() => { try { fx(dim, "minecraft:huge_explosion_emitter", plus(e.location, { x: 0, y: 5, z: 0 })); fx(dim, "orbital_foundry:overseer_core_burst", plus(e.location, { x: 0, y: 5, z: 0 })); snd(dim, "ambient.weather.thunder", e.location, 3, .5); e.setProperty("orbital_foundry:attack", 0); } catch { } }, len_);
  }
  function enterFinal(e, s) {
    s.final = true;
    try { e.setProperty("orbital_foundry:final", 1); } catch { }
    transform(e, s, 3);
  }
  function die(e, s) {
    if (s.dead) return; s.dead = true;
    for (const pl of e.dimension.getPlayers()) try { pl.playSound("mob.enderdragon.death", { volume: 1 }); } catch { }
    const dim = e.dimension, at = { ...e.location }, top = plus(at, { x: 0, y: 6, z: 0 });
    bullets.length = 0;
    try { e.setProperty("orbital_foundry:attack", 0); e.setProperty("orbital_foundry:dying", 1); } catch { }
    snd(dim, "mob.wither.death", at, 3, .7);
    cinematic(e, 80, 6, 18);
    for (const q of dim.getPlayers({ location: at, maxDistance: 110 })) shake(q, .25, 3.5);
    // 空中で静止し、歯車が外れて飛び散る
    for (let k = 0; k < 70; k += 2) system.runTimeout(() => {
      try {
        const p = plus(at, { x: Math.random() * 8 - 4, y: 2 + Math.random() * 8, z: Math.random() * 8 - 4 });
        fx(dim, k % 4 ? "orbital_foundry:sw_spark" : "minecraft:large_explosion", p);
        if (k % 6 === 0) { fx(dim, "orbital_foundry:overseer_debris", p); snd(dim, k % 12 ? "random.anvil_land" : "random.explode", p, 1.5, .5 + k / 100); }
        fx(dim, of("surge"), top);
      } catch { }
    }, k);
    // 星炉の大爆発 → 軌道工廠まで届く光の柱
    system.runTimeout(() => {
      try {
        fx(dim, "minecraft:huge_explosion_emitter", top); fx(dim, "orbital_foundry:overseer_core_burst", top); fx(dim, "minecraft:sonic_explosion", top);
        snd(dim, "ambient.weather.thunder", at, 3, .5); snd(dim, "random.explode", at, 3, .4); snd(dim, "mob.enderdragon.death", at, 2, 1.4);
        for (const q of dim.getPlayers({ location: at, maxDistance: 120 })) { shake(q, .5, 1.2); try { q.onScreenDisplay.setTitle("§f§l撃破", { subtitle: `§d星炉ウィザー · ${fmtTime(system.currentTick - (s.startTick ?? system.currentTick))}`, fadeInDuration: 2, stayDuration: 60, fadeOutDuration: 20 }); } catch { } }
        for (let k = 0; k < 12; k++) dim.spawnEntity("minecraft:xp_orb", plus(at, { x: Math.random() * 2 - 1, y: 2, z: Math.random() * 2 - 1 }));
        if (e.isValid) e.remove();
      } catch { }
      live.delete(e.id);
      for (let k = 0; k < 60; k += 2) system.runTimeout(() => { for (let y = 0; y < 120; y += 2) fx(dim, of(y % 6 ? "tracer" : "surge"), { x: top.x, y: top.y + y, z: top.z }); }, k);
      descendCore(dim, top);
    }, 72);
  }
  const fmtTime = t => { const sec = Math.max(0, Math.round(t / 20)); return `撃破時間 ${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`; };
  // 終焉星核が空からゆっくり降りてくる
  function descendCore(dim, top) {
    let ground = top.y - 6;
    try { const h = dim.getTopmostBlock({ x: top.x, z: top.z }); if (h) ground = h.location.y + 1.2; } catch { }
    const start = ground + 40, steps = 120;
    for (let k = 0; k <= steps; k++) system.runTimeout(() => {
      const y = start + (ground - start) * (1 - Math.pow(1 - k / steps, 2)), at = { x: top.x, y, z: top.z };
      fx(dim, of("surge"), at); fx(dim, "orbital_foundry:sw_ember", at);
      if (k % 3 === 0) for (let a = 0; a < 360; a += 45) { const t = (a + k * 8) * Math.PI / 180; fx(dim, of("tracer"), { x: at.x + Math.cos(t) * 1.2, y: at.y, z: at.z + Math.sin(t) * 1.2 }); }
      if (k % 20 === 0) snd(dim, "beacon.ambient", at, 2, 1.2 + k / steps);
      if (k === steps) {
        try { dim.spawnItem(new ItemStack(CORE, 1), at); } catch { }
        try { dim.spawnItem(new ItemStack(id("star_wither_seed"), 1), at); } catch { }
        fx(dim, "orbital_foundry:overseer_core_burst", at); snd(dim, "beacon.power", at, 2, .8);
        for (const p of dim.getPlayers({ location: at, maxDistance: 110 })) toast(p, "§d終焉星核と星炉の幼核が降りてきた · 終焉星核は作業台で天蓋執行機構〈アストライア〉になる");
      }
    }, k);
  }
  function strafeMobs(e, max = 3) {
    let mobs = [];
    try {
      mobs = e.dimension.getEntities({ location: e.location, maxDistance: 48, excludeTypes: ["minecraft:player", "minecraft:item", "minecraft:xp_orb", "minecraft:arrow", BOSS, "orbital_foundry:mini_star_wither"], excludeFamilies: ["inanimate", "orbital_foundry_slots", "orbital_foundry_boss"] })
        .filter(m => m.getComponent("minecraft:health") && !String(m.typeId).startsWith("orbital_foundry:quarry") && !String(m.typeId).includes("_slots"));
    } catch { }
    mobs.sort(() => Math.random() - .5);
    const from = plus(e.location, { x: 0, y: 6, z: 0 });
    for (const m of mobs.slice(0, max)) {
      try {
        const to = m.location, d = dist(from, to), n = Math.max(2, Math.floor(d / 1.5));
        for (let k = 1; k <= n; k++) { const f = k / n; fx(e.dimension, k === n ? "orbital_foundry:sw_spark" : "orbital_foundry:sw_skull", { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: from.z + (to.z - from.z) * f }); }
        m.applyDamage(40, { cause: "entityAttack", damagingEntity: e });
      } catch { }
    }
    if (mobs.length) snd(e.dimension, "mob.wither.shoot", from, 1.5, .8);
  }
  function leave(e, s) {
    const dim = e.dimension, at = { ...e.location };
    for (const q of dim.getPlayers({ location: at, maxDistance: 200 })) { try { q.onScreenDisplay.setTitle("§5§l星炉ウィザーは去った", { subtitle: "§710分間で倒しきれなかった · 頭部を揃えれば再び呼び出せる", fadeInDuration: 5, stayDuration: 60, fadeOutDuration: 20 }); } catch { } }
    snd(dim, "mob.wither.death", at, 3, .5); snd(dim, "mob.endermen.portal", at, 3, .4);
    bullets.length = 0;
    for (let k = 0; k < 40; k += 2) system.runTimeout(() => { try { if (e.isValid) e.teleport({ x: e.location.x, y: e.location.y + 1.5, z: e.location.z }); fx(dim, "orbital_foundry:overseer_core_burst", plus(at, { x: 0, y: 4 + k * .75, z: 0 })); } catch { } }, k);
    system.runTimeout(() => { try { e.triggerEvent("orbital_foundry:hide_boss_bar"); } catch { } try { if (e.isValid) e.remove(); } catch { } live.delete(e.id); }, 42);
  }
  function syncBossBar(e, s) {
    const nearby = new Set(e.dimension.getPlayers({ location: e.location, maxDistance: 300 }).map(p => p.id));
    if (!s.barViewers) {
      e.triggerEvent("orbital_foundry:show_boss_bar");
    } else if (!s.barResetPending && [...nearby].some(id => !s.barViewers.has(id))) {
      e.triggerEvent("orbital_foundry:hide_boss_bar");
      s.barResetPending = true;
      system.run(() => {
        s.barResetPending = false;
        if (!e.isValid) return;
        try { e.triggerEvent("orbital_foundry:show_boss_bar"); }
        catch { s.barViewers = undefined; }
      });
    }
    s.barViewers = nearby;
  }
  function forgetBarViewer(playerId) {
    for (const s of live.values()) s.barViewers?.delete(playerId);
  }
  world.afterEvents.playerSpawn.subscribe(({ player }) => forgetBarViewer(player.id));
  world.afterEvents.playerDimensionChange?.subscribe(({ player }) => forgetBarViewer(player.id));
  world.afterEvents.entityHurt.subscribe(({ hurtEntity: e, damage, damageSource }) => {
    if (e?.typeId !== BOSS) return;
    try {
      const p = damageSource.damagingEntity;
      const type = p?.typeId === "minecraft:player" && damageSource.cause === "entityAttack" ? mainBlade(p) : undefined;
      const blade = type?.startsWith("koke_blade:") && !type.endsWith("_broken") ? {type,awakened:false,kind:"melee"} : undefined;
      hurt(e, damage, p, p?.location, undefined, undefined, blade);
    } catch { }
  });
  // 自前の武器 (星炉ガトリング等) から直接呼ぶ用
  const hurtBoss = (e, player, amount, origin, attack, lockedPart) => {
    try { return hurt(e, amount, player, origin ?? player?.location, attack, lockedPart); } catch { return false; }
  };

  function targetOf(e, ps) {
    let best, bd = 1e9;
    for (const p of ps) { const d = dist(p.location, e.location); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  const airborne = p => { try { return !p.isOnGround && !p.isInWater; } catch { return false; } };
  // ---------- 攻撃 (弾幕) ----------
  // 通常弾は当たると痛い、赤白の弾・突進・崩壊・レーザー・隕石は即死。外骨格の飛行速度で抜けられる密度と速さにしてある
  const bullets = [];
  const MAXB = 900;
  // 防具と耐性を無視して固定ダメージを与える (override)。無敵時間で連続ヒットが消えないよう直接体力も削る
  const pierce = (p, n) => { if (hasFusion(p)) n *= .2; try { const h = p.getComponent("minecraft:health"); if (!h) return; const before = h.currentValue; p.applyDamage(n, { cause: "override" }); if (h.currentValue > before - n * .9) h.setCurrentValue(Math.max(0, before - n)); } catch { } };
  // 星炉一式などで最大体力が大きく増えていても効くよう、最大体力の割合で削る
  const scaled = (p, big) => { let m = 20; try { m = p.getComponent("minecraft:health").effectiveMax; } catch { } return Math.max(big ? W.bigDamage : W.orbDamage, m * (big ? W.bigRatio : W.orbRatio)); };
  const lethal = p => { if (absorb(p)) return; try { p.applyDamage(100000, { cause: "override" }); } catch { try { p.kill(); } catch { } } };
  const mvar = o => { try { const m = new MolangVariableMap(); for (const [k, v] of Object.entries(o)) m.setFloat(`variable.${k}`, v); return m; } catch { return undefined; } };
  const fxv = (dim, name, at, vars) => { try { dim.spawnParticle(name, at, mvar(vars)); } catch { } };
  const griefing = () => { try { return world.gameRules.mobGriefing !== false; } catch { return true; } };
  // 爆発: 地形は球状に直接消し、煙と音だけ出す。プレイヤーへのダメージは固定値 (dmg) で別に与える (ゲームの爆発ダメージは使わない)
  const blastCd = new Map();
  function boom(dim, at, power, src, dmg = 0) {
    const r = Math.min(5, power * .9), c = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
    fx(dim, power >= 5 ? "minecraft:huge_explosion_emitter" : "minecraft:large_explosion", at); fx(dim, "orbital_foundry:sw_spark", at);
    snd(dim, "random.explode", at, Math.min(4, power * .6), .6 + Math.random() * .3);
    if (griefing()) {
      const rr = Math.ceil(r);
      for (let x = -rr; x <= rr; x++) for (let y = -rr; y <= rr; y++) for (let z = -rr; z <= rr; z++) {
        if (x * x + y * y + z * z > r * r * (.75 + Math.random() * .25)) continue;
        try { const b = dim.getBlock({ x: c.x + x, y: c.y + y, z: c.z + z }); if (b && !SKIP.has(b.typeId) && !b.isLiquid) b.setType("minecraft:air"); } catch { }
      }
    }
    const now = system.currentTick;
    if (dmg > 0) for (const p of players(dim, at, r + 1.5)) { if ((blastCd.get(p.id) ?? 0) > now) continue; blastCd.set(p.id, now + W.blastCooldown); pierce(p, dmg); }
  }
  function shoot(dim, pos, dir, speed, kind = "orb", extra = {}) {
    if (bullets.length >= MAXB) return;
    bullets.push({ dim, pos: { ...pos }, vel: norm(dir), speed: speed * W.bulletSpeed, kind, life: extra.life ?? 140, accel: extra.accel ?? 0, curve: extra.curve ?? 0, home: extra.home, turn: extra.turn ?? 0 , skull: !!extra.skull });
  }
  // 傾いた輪 (ax,az でリングの面を傾ける) と、球状のばらまき
  function ring(dim, at, n, speed, kind, offset = 0, tilt = 0, ax = 0, az = 0) {
    for (let i = 0; i < n; i++) { const a = offset + i * 2 * Math.PI / n, c = Math.cos(a), sn = Math.sin(a);
      shoot(dim, at, { x: c, y: tilt + c * ax + sn * az, z: sn }, speed, kind); }
  }
  function sphere(dim, at, n, speed, kind, spin = 0) {
    const g = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + .5) / n, r = Math.sqrt(1 - y * y), a = i * g + spin; shoot(dim, at, { x: Math.cos(a) * r, y, z: Math.sin(a) * r }, speed, kind); }
  }
  // 自機狙いの立体コーン
  // 相手の今の速度から、弾が届く時点の位置を予測する (速く飛んでいても置き撃ちで当てる)
  function lead(from, target, bps) {
    const v = target.getVelocity(), h = target.getHeadLocation(); let at = { x: h.x, y: h.y - .5, z: h.z };
    for (let k = 0; k < 3; k++) { const tt = Math.min(40, dist(at, from) / Math.max(.1, bps)); at = { x: h.x + v.x * tt, y: h.y - .5 + v.y * tt, z: h.z + v.z * tt }; }
    return at;
  }
  function cone(dim, from, target, n, spread, speed, kind) {
    speed *= W.aimedSpeed;
    const d = norm(sub(lead(from, target, speed * W.bulletSpeed), from)), ref = Math.abs(d.y) > .95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const rt = norm({ x: d.y * ref.z - d.z * ref.y, y: d.z * ref.x - d.x * ref.z, z: d.x * ref.y - d.y * ref.x }), up = { x: rt.y * d.z - rt.z * d.y, y: rt.z * d.x - rt.x * d.z, z: rt.x * d.y - rt.y * d.x };
    shoot(dim, from, d, speed, kind, { skull: true });
    for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; shoot(dim, from, plus(plus(d, rt, Math.cos(a) * spread), up, Math.sin(a) * spread), speed, kind, { skull: true }); }
  }
  function tickBullets() {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      try {
        b.life--;
        if (b.curve) { const c = Math.cos(b.curve), s = Math.sin(b.curve); b.vel = { x: b.vel.x * c - b.vel.z * s, y: b.vel.y, z: b.vel.x * s + b.vel.z * c }; }
        if (b.home?.isValid && b.turn) b.vel = norm(plus(b.vel, norm(sub(b.home.getHeadLocation(), b.pos)), b.turn));
        b.speed += b.accel * W.bulletSpeed;
        const prev = b.pos;
        b.pos = plus(b.pos, b.vel, b.speed);
        const big = b.kind === "lethal_big" || b.kind === "orb_big";
        fx(b.dim, b.skull ? (b.kind.startsWith("lethal") ? (big ? "orbital_foundry:sw_skull_lethal_big" : "orbital_foundry:sw_skull_lethal") : (big ? "orbital_foundry:sw_skull_big" : "orbital_foundry:sw_skull"))
          : b.kind.startsWith("lethal") ? (big ? "orbital_foundry:sw_lethal_big" : "orbital_foundry:sw_lethal") : (big ? "orbital_foundry:sw_orb_big" : "orbital_foundry:sw_orb"), b.pos);
        if (b.skull && b.life % 3 === 0) fx(b.dim, "orbital_foundry:sw_ember", b.pos);
        let hit = false;
        const r = b.kind === "lethal_big" ? 1.3 : b.kind === "lethal" ? .75 : b.kind === "orb_big" ? 2 : 1.4;   // 通常弾は当たり判定を大きめに
        // 速い弾がすり抜けないよう、前の位置からの線分で判定
        for (const p of players(b.dim, b.pos, r + 2 + b.speed)) {
          const c = plus(p.location, { x: 0, y: .9, z: 0 }), seg = sub(b.pos, prev), sl = len(seg) || 1, tt = Math.max(0, Math.min(sl, dot(sub(c, prev), seg) / sl));
          const q = plus(prev, seg, tt / sl), dx = Math.abs(c.x - q.x), dz = Math.abs(c.z - q.z), dy = Math.abs(c.y - q.y);
          if (dx < r + .3 && dz < r + .3 && dy < r + .9) {
            if (b.kind.startsWith("lethal")) lethal(p); else if (!b.missile) { pierce(p, scaled(p, b.kind === "orb_big")); try { if (!hasFusion(p)) p.addEffect("wither", b.kind === "orb_big" ? 160 : 100, { amplifier: b.kind === "orb_big" ? 2 : 1, showParticles: true }); } catch { } };
            hit = true;
          }
        }
        if (b.missile) { try { const bl = b.dim.getBlock(b.pos); if (bl && !bl.isAir && !bl.isLiquid) hit = true; } catch { } if (b.life % 2 === 0) fx(b.dim, "minecraft:basic_flame_particle", b.pos); }
        if (hit || b.life <= 0) {
          if (b.missile) { boom(b.dim, b.pos, 4, b.src, W.missileBlast); fx(b.dim, "orbital_foundry:overseer_blast", b.pos); }
          else if (hit) fx(b.dim, "orbital_foundry:sw_spark", b.pos);
          bullets.splice(i, 1);
        }
      } catch { bullets.splice(i, 1); }
    }
  }
  const SKIP = new Set(["minecraft:air", "minecraft:bedrock", "minecraft:barrier", "minecraft:end_portal_frame", "minecraft:end_portal", "minecraft:command_block", "minecraft:chain_command_block", "minecraft:repeating_command_block", "minecraft:structure_block", "minecraft:jigsaw", "minecraft:light_block", "minecraft:reinforced_deepslate", "minecraft:obsidian", "minecraft:crying_obsidian", "minecraft:respawn_anchor", "minecraft:end_gateway"]);
  // ウィザーと同じく、体に触れたブロックを壊す
  function chew(e) {
    if (!griefing()) return;
    const l = e.location, dim = e.dimension;
    let n = 0;
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -1; y <= 10; y++) {
      try {
        const b = dim.getBlock({ x: Math.floor(l.x) + x, y: Math.floor(l.y) + y, z: Math.floor(l.z) + z });
        if (!b || SKIP.has(b.typeId) || b.isLiquid) continue;
        b.setType("minecraft:air"); n++;
        if (n % 6 === 0) fx(dim, "orbital_foundry:overseer_debris", b.location);
      } catch { }
    }
    if (n) snd(dim, "random.break", l, 1, .6);
  }
  function dash(e, s, dim, from, speed, t) {
    let next = plus(e.location, s.ramDir, speed);
    try { const h = dim.getTopmostBlock({ x: next.x, z: next.z }); if (h && next.y < h.location.y + 1) next = { ...next, y: h.location.y + 1 }; } catch { }
    try { e.teleport(next, { facingLocation: plus(next, s.ramDir, 5) }); } catch { }
    chew(e); if (t % 2 === 0) boom(dim, plus(e.location, { x: 0, y: 1, z: 0 }), 4, e);
    fx(dim, "orbital_foundry:overseer_shock", from); fx(dim, "orbital_foundry:siege_shock_ring_big", from);
    for (const p of [...players(dim, from, 6), ...players(dim, e.location, 6)]) lethal(p);
  }
  const telegraph = (dim, from, dir, length, step = 1.2) => { for (let k = 2; k < length; k += step) fx(dim, "orbital_foundry:sw_warn", plus(from, dir, k)); };

  // 技一覧。第一形態は頭部ごとの技、第二形態 (星炉露出) で即死技が増える
  const SPELLS = {
    // 星炉頭部: 8本の渦巻き弾幕
    spiral: { len: 90, need: "star", run(e, s, t, target) { if (t % 2) return; const at = headWorld(e.location, e.getRotation().y, "star"); for (let k = 0; k < 6; k++) { const a = t * .11 + k * Math.PI / 3, y = Math.sin(t * .07 + k) * .6; shoot(e.dimension, at, { x: Math.cos(a), y, z: Math.sin(a) }, .32, "orb", { curve: .004 }); shoot(e.dimension, at, { x: Math.cos(-a), y: -y, z: Math.sin(-a) }, .26, "orb"); } } },
    // 追尾頭部: 自機狙いの扇 (偏差撃ち)
    fans: { len: 70, need: "tracker", run(e, s, t, target) { if (t % 10) return; const at = headWorld(e.location, e.getRotation().y, "tracker"), aim = lead(at, target, .62 * W.aimedSpeed * W.bulletSpeed), d = norm(sub(aim, at)); const n = 7; for (let k = 0; k < n; k++) { const a = (k - (n - 1) / 2) * .13, c = Math.cos(a), si = Math.sin(a); shoot(e.dimension, at, { x: d.x * c - d.z * si, y: d.y, z: d.x * si + d.z * c }, .62 * W.aimedSpeed, k === 3 ? "orb_big" : "orb", { skull: true }); } snd(e.dimension, "mob.blaze.shoot", at, 1, 1.3); } },
    // 追尾頭部: 地形を壊す誘導ミサイル。空中の相手には数と旋回が増える
    missiles: { len: 50, need: "tracker", run(e, s, t, target) { if (t % 16) return; const at = headWorld(e.location, e.getRotation().y, "tracker"), air = airborne(target); for (let k = 0; k < (air ? 3 : 2); k++) { if (bullets.length >= MAXB) break; bullets.push({ dim: e.dimension, pos: { ...at }, vel: norm({ x: Math.random() - .5, y: 1, z: Math.random() - .5 }), speed: (air ? 1.05 : .8) * W.bulletSpeed, kind: "orb_big", life: 110, accel: 0, curve: 0, home: target, turn: air ? .2 : .12, missile: true, src: e, skull: true }); } snd(e.dimension, "mob.ghast.fireball", at, 1, .7); } },
    // 本体: 輪の連打 (隙間を抜ける)
    rings: { len: 80, run(e, s, t) { if (t % 14) return; const at = plus(e.location, { x: 0, y: 5, z: 0 }); if (t % 28) ring(e.dimension, at, 40, .38, "orb", t * .07, 0, Math.sin(t) * .7, Math.cos(t * 1.3) * .7); else sphere(e.dimension, at, 90, .34, "orb_big", t); snd(e.dimension, "mob.warden.sonic_charge", at, .6, 1.6); } },
    // 重装頭部: 即死の突進。予告線のあと一直線に突っ込む
    ram: { len: 60, lethal: true, start(e, s, target) { { const d = sub(plus(target.location, { x: 0, y: 1, z: 0 }), plus(e.location, { x: 0, y: 4, z: 0 })); s.ramDir = norm({ x: d.x, y: Math.max(-Math.hypot(d.x, d.z) * .25, Math.min(d.y, Math.hypot(d.x, d.z) * .35)), z: d.z }); } snd(e.dimension, "mob.ravager.roar", e.location, 3, .6); },
      run(e, s, t) { const dim = e.dimension, from = plus(e.location, { x: 0, y: 4, z: 0 });
        if (t < 30) { if (t % 2 === 0) { telegraph(dim, from, s.ramDir, 60, 1.5); for (let k = 0; k < 60; k += 6) fxv(dim, "orbital_foundry:overseer_mark", plus(from, s.ramDir, k), { size: 7 }); } if (t % 6 === 0) snd(dim, "note.bass", from, 2, .5 + t / 40); return "hold"; }
        if (t === 30) { snd(dim, "mob.enderdragon.growl", from, 3, .9); for (const p of players(dim, from, 80)) shake(p, .3, .8); }
        let next = plus(e.location, s.ramDir, 3.2);
        try { const h = dim.getTopmostBlock({ x: next.x, z: next.z }); if (h && next.y < h.location.y + 1) next = { ...next, y: h.location.y + 1 }; } catch { } try { e.teleport(next, { facingLocation: plus(next, s.ramDir, 5) }); } catch { }
        chew(e); if (t % 2 === 0) boom(dim, plus(e.location, { x: 0, y: 1, z: 0 }), 4, e); fx(dim, "orbital_foundry:overseer_shock", from); fx(dim, "orbital_foundry:siege_shock_ring_big", from);
        for (const p of [...players(dim, from, 6), ...players(dim, e.location, 6)]) lethal(p);
        return "move"; } },
    // 星炉頭部: 予告のあと照射する即死ビーム
    beam: { len: 70, need: "star", lethal: true, start(e, s, target) { s.beamAim = target.getHeadLocation(); try { e.setProperty("orbital_foundry:attack", 1); } catch { } snd(e.dimension, "beacon.ambient", e.location, 3, .5); },
      run(e, s, t) { const dim = e.dimension, from = headWorld(e.location, e.getRotation().y, "star"), dir = norm(sub(s.beamAim, from));
        if (t < 32) { if (t % 2 === 0) telegraph(dim, from, dir, 64, 1); if (t % 6 === 0) snd(dim, "note.pling", from, 2, .5 + t / 32); return "aim"; }
        if (t === 32) { snd(dim, "mob.warden.sonic_boom", from, 3, .6); fx(dim, "minecraft:sonic_explosion", plus(from, dir, 3)); }
        for (let k = 1; k < 64; k += .7) { const at = plus(from, dir, k); fx(dim, "orbital_foundry:sw_lethal", at); if (k % 5 < .7) fx(dim, "orbital_foundry:overseer_sparks", at); }
        for (const p of players(dim, plus(from, dir, 32), 36)) { const c = plus(p.location, { x: 0, y: 1, z: 0 }), tt = Math.max(0, Math.min(64, dot(sub(c, from), dir))); if (dist(c, plus(from, dir, tt)) < 1.6) lethal(p); }
        if (t % 3 === 0) boom(dim, plus(from, dir, 8 + Math.random() * 50), 3.5, e, W.beamBlast);
        if (t >= 60) try { e.setProperty("orbital_foundry:attack", 0); } catch { }
        return "aim"; } },
    // ジグザグ突進: 短い予告で左右に折れながら突っ込む (読みにくい)。第二形態以降
    zigzag: { len: 75, exposed: true, lethal: true, start(e, s) { s.zig = 0; snd(e.dimension, "mob.ravager.roar", e.location, 3, 1.1); },
      run(e, s, t, target) { const dim = e.dimension, leg = Math.floor(t / 15), lt = t % 15;
        if (lt === 0) { const d = norm({ ...sub(target.location, e.location), y: 0 }), a = (leg % 2 ? 1 : -1) * (.6 + Math.random() * .4), c = Math.cos(a), sn = Math.sin(a);
          s.ramDir = norm({ x: d.x * c - d.z * sn, y: Math.max(-.2, Math.min(.2, (target.location.y - e.location.y) / 20)), z: d.x * sn + d.z * c }); }
        const from = plus(e.location, { x: 0, y: 4, z: 0 });
        if (lt < 5) { telegraph(dim, from, s.ramDir, 40, 2); if (lt === 0) snd(dim, "note.bass", from, 2, 1.4); return "hold"; }
        dash(e, s, dim, from, 3.6, t); return "move"; } },
    // 突進ラッシュ: 予告の短い即死突進を連続で。第二形態以降
    rampage: { len: 120, exposed: true, lethal: true, start(e, s) { snd(e.dimension, "mob.enderdragon.growl", e.location, 3, 1.2); },
      run(e, s, t, target) { const dim = e.dimension, lt = t % 30, from = plus(e.location, { x: 0, y: 4, z: 0 });
        if (lt === 0) { const d = sub(plus(target.location, plus(target.getVelocity(), { x: 0, y: 1, z: 0 }), 6), from); s.ramDir = norm({ x: d.x, y: Math.max(-Math.hypot(d.x, d.z) * .25, Math.min(d.y, Math.hypot(d.x, d.z) * .35)), z: d.z }); snd(dim, "mob.ravager.roar", from, 3, .9 + Math.random() * .3); }
        if (lt < 10) { if (lt % 2 === 0) telegraph(dim, from, s.ramDir, 60, 1.6); return "hold"; }
        dash(e, s, dim, from, 3.4, t); return "move"; } },
    // --- 第二形態 ---
    // 星炉崩壊: 半径26の即死。飛行の速さで範囲外へ逃げる
    collapse: { len: 100, exposed: true, lethal: true, start(e, s) { try { e.setProperty("orbital_foundry:attack", 2); } catch { } snd(e.dimension, "mob.wither.spawn", e.location, 3, .5);  },
      run(e, s, t) { const dim = e.dimension, at = plus(e.location, { x: 0, y: 4, z: 0 });
        if (t < 72) { if (t % 4 === 0) { fxv(dim, "orbital_foundry:overseer_mark", { x: at.x, y: e.location.y + .1, z: at.z }, { size: 52 }); for (let a = 0; a < 360; a += 10) { const r = a * Math.PI / 180; fx(dim, "orbital_foundry:sw_warn", { x: at.x + Math.cos(r) * 26, y: at.y, z: at.z + Math.sin(r) * 26 }); } }
          if (t % 3 === 0) for (let k = 0; k < 6; k++) { const a = Math.random() * 6.28, r = 26 * Math.random(); fx(dim, "orbital_foundry:sw_orb_big", { x: at.x + Math.cos(a) * r, y: at.y + (Math.random() - .5) * 8, z: at.z + Math.sin(a) * r }); }
          if (t % 12 === 0) snd(dim, "mob.warden.heartbeat", at, 3, .6 + t / 100); return "hold"; }
        if (t === 72) { fx(dim, "minecraft:huge_explosion_emitter", at); fx(dim, "orbital_foundry:overseer_core_burst", at); snd(dim, "ambient.weather.thunder", at, 3, .5); snd(dim, "random.explode", at, 3, .4);
          for (const p of players(dim, at, 26)) lethal(p); for (const p of players(dim, at, 120)) shake(p, .5, 1.5);
          for (let k = 0; k < 18; k++) system.runTimeout(() => boom(dim, plus(at, { x: Math.random() * 30 - 15, y: -4 - Math.random() * 3, z: Math.random() * 30 - 15 }), 6, e), k);
          for (let r = 2; r < 30; r += 2) system.runTimeout(() => { for (let a = 0; a < 360; a += 8) { const q = a * Math.PI / 180; fx(dim, "orbital_foundry:sw_lethal", { x: at.x + Math.cos(q) * r, y: at.y, z: at.z + Math.sin(q) * r }); } }, r / 2);
          try { e.setProperty("orbital_foundry:attack", 0); } catch { } }
        return "hold"; } },
    // 回転する即死レーザー4本。上下に避ける
    lasers: { len: 120, exposed: true, lethal: true, start(e, s) { s.laserBase = Math.random() * 6.28; snd(e.dimension, "beacon.activate", e.location, 3, .5); },
      run(e, s, t) { const dim = e.dimension, at = headWorld(e.location, e.getRotation().y, "star");
        const ang = s.laserBase + (t < 24 ? 0 : (t - 24) * .04);
        for (let k = 0; k < 4; k++) { const a = ang + k * Math.PI / 2, d = { x: Math.cos(a), y: 0, z: Math.sin(a) };
          if (t < 24) { if (t % 2 === 0) telegraph(dim, at, d, 42, 1.4); continue; }
          for (let r = 1; r < 42; r += 1) fx(dim, "orbital_foundry:sw_lethal", plus(at, d, r));
          for (const p of players(dim, at, 43)) { const c = plus(p.location, { x: 0, y: 1, z: 0 }), v = sub(c, at), tt = dot(v, d); if (tt > 0 && tt < 42 && dist(c, plus(at, d, tt)) < 1.5) lethal(p); } }
        if (t >= 24 && t % 6 === 0) sphere(dim, at, 40, .3, "orb", t);
        if (t % 10 === 0) snd(dim, "beacon.ambient", at, 2, 1.8);
        return "hold"; } },
    // 隕石: 相手の周りに即死の着弾点。真上から光の柱
    meteors: { len: 80, exposed: true, lethal: true, start(e, s, target) { const c = target.location; s.marks = []; for (let k = 0; k < 14; k++) { const a = Math.random() * 6.28, r = k === 0 ? 0 : 3 + Math.random() * 14; s.marks.push({ x: c.x + Math.cos(a) * r, y: c.y, z: c.z + Math.sin(a) * r, at: 30 + k * 3 }); } },
      run(e, s, t) { const dim = e.dimension;
        for (const m of s.marks) { if (t < m.at) { if (t % 4 === 0) { fxv(dim, "orbital_foundry:overseer_mark", { x: m.x, y: m.y + .1, z: m.z }, { size: 7 }); fxv(dim, "orbital_foundry:sw_laser", { x: m.x, y: m.y + 20, z: m.z }, { len: 40 }); } }
          else if (t === m.at) { fxv(dim, "orbital_foundry:sky_bolt", { x: m.x, y: m.y + 30, z: m.z }, { len: 60 }); fx(dim, "orbital_foundry:overseer_blast", m); boom(dim, m, 5, e); snd(dim, "ambient.weather.thunder", m, 2, 1.2);
            for (const p of players(dim, m, 3.5)) lethal(p); } }
        if (t % 8 === 0) sphere(dim, headWorld(e.location, e.getRotation().y, "star"), 48, .34, "orb", t);
        return undefined; } },
    // 絶望の天蓋 (最終形態): 相手を包む即死弾の球が3重に迫ってくる。抜け穴は1か所だけ、しかも少しずつ回る
    despair: { len: 150, final: true, lethal: true, start(e, s, target) { s.dC = target.getHeadLocation(); const a = Math.random() * 6.28; s.dHole = { x: Math.cos(a), y: .15, z: Math.sin(a) };
        snd(e.dimension, "mob.wither.spawn", s.dC, 3, .4); snd(e.dimension, "ambient.weather.thunder", s.dC, 3, .4);
        for (const q of players(e.dimension, s.dC, 80)) { shake(q, .25, 2); try { q.onScreenDisplay.setTitle("§4§l×", { subtitle: "§c逃げ場は一つ", fadeInDuration: 2, stayDuration: 30, fadeOutDuration: 10 }); } catch { } } },
      run(e, s, t) { const dim = e.dimension, c = s.dC, hole = s.dHole;
        if (t % 40 === 0 && t < 120) { const R = 34, g = Math.PI * (3 - Math.sqrt(5)), n = 260;
          const rot = t * .02, hh = norm({ x: hole.x * Math.cos(rot) - hole.z * Math.sin(rot), y: hole.y, z: hole.x * Math.sin(rot) + hole.z * Math.cos(rot) });
          for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + .5) / n, r = Math.sqrt(1 - y * y), a = i * g, d = { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
            if (dot(d, hh) > .9) continue;   // 抜け穴
            shoot(dim, plus(c, d, R), { x: -d.x, y: -d.y, z: -d.z }, .2, "lethal", { life: 160 }); }
          for (let k = 2; k < R; k += 2) fx(dim, "orbital_foundry:sw_warn", plus(c, hh, k));
          snd(dim, "mob.warden.sonic_charge", c, 3, .4); }
        if (t % 4 === 0) fx(dim, "orbital_foundry:sw_lethal_big", plus(c, { x: (Math.random() - .5) * 60, y: 30, z: (Math.random() - .5) * 60 }));
        return "hold"; } },
    // 弾幕の花: 加速弾と減速弾を混ぜた密集弾幕
    bloom: { len: 100, exposed: true, run(e, s, t, target) { const at = headWorld(e.location, e.getRotation().y, "star");
        if (t % 3 === 0) for (let k = 0; k < 5; k++) { const a = t * .17 + k * 1.2566; shoot(e.dimension, at, { x: Math.cos(a), y: Math.sin(t * .05) * .2, z: Math.sin(a) }, .18, "orb", { accel: .006, curve: (k % 2 ? 1 : -1) * .01 }); }
        if (t % 20 === 0) { const d = norm(sub(target.getHeadLocation(), at)); for (let k = -2; k <= 2; k++) shoot(e.dimension, at, plus(d, { x: -d.z * k * .15, y: 0, z: d.x * k * .15 }), .9, "lethal", { life: 80 }); } } },
  };
  function chooseSpell(s, exposed) {
    const pool = Object.entries(SPELLS).filter(([k, v]) => (!v.need || s.hp[v.need] > 0) && (!v.exposed || exposed) && (!v.final || s.final) && k !== s.last);
    const lethalPool = pool.filter(([, v]) => v.lethal);
    // 即死技を3回に1回は混ぜる
    const pick = (s.count % 2 === 1 && lethalPool.length) ? lethalPool : pool;
    return pick[Math.floor(Math.random() * pick.length)]?.[0];
  }
  // 常時エフェクト: 歯車の火花、紫の残り火、蒸気、影
  function aura(e, s, exposed) {
    const dim = e.dimension, l = e.location, stage = s.final ? 3 : exposed ? 2 : 1;
    const ground = { x: l.x, y: (s.groundY ?? l.y - 2) + .1, z: l.z };
    // 地面を走る衝撃波リング (形態が進むほど大きく・頻繁に・赤く)
    if (s.t % [0, 50, 30, 18][stage] === 0) { fxv(dim, "orbital_foundry:sw_shock_ring", ground, { size: [0, 24, 34, 46][stage], hot: stage >= 3 ? 1 : 0 }); if (stage >= 2) snd(dim, "mob.warden.sonic_charge", ground, 1.2, .5); }
    // 空から降り注ぐ光の柱
    if (s.t % [0, 24, 10, 5][stage] === 0) { const a = Math.random() * 6.28, rr = 6 + Math.random() * 26; fxv(dim, "orbital_foundry:sw_pillar", { x: l.x + Math.cos(a) * rr, y: ground.y + 30, z: l.z + Math.sin(a) * rr }, { len: 60 }); }
    // 第二形態から: 紫の落雷と地割れ
    if (stage >= 2 && s.t % (stage === 3 ? 22 : 40) === 0) {
      const a = Math.random() * 6.28, rr = 8 + Math.random() * 22, g = { x: l.x + Math.cos(a) * rr, y: ground.y, z: l.z + Math.sin(a) * rr };
      fxv(dim, "orbital_foundry:sky_bolt", { x: g.x, y: g.y + 35, z: g.z }, { len: 70 }); fxv(dim, "orbital_foundry:sky_flash", g, { size: 20 });
      fxv(dim, "orbital_foundry:sw_shock_ring", g, { size: 10, hot: stage >= 3 ? 1 : 0 }); fx(dim, "orbital_foundry:sw_spark", g); fx(dim, "orbital_foundry:overseer_sparks", g);
      snd(dim, "ambient.weather.thunder", g, 2.5, .7 + Math.random() * .3);
      for (let k = 0; k < 10; k++) { const t = a + (Math.random() - .5) * .6; fx(dim, "orbital_foundry:sw_warn", { x: l.x + Math.cos(t) * (rr - k * 1.5), y: ground.y + .1, z: l.z + Math.sin(t) * (rr - k * 1.5) }); }
      for (const p of players(dim, g, 30)) shake(p, .06, .3);
    }
    // 最終形態: 残骸が降り続け、近くは常に揺れる
    if (stage >= 3) { if (s.t % 3 === 0) fx(dim, "orbital_foundry:sw_debris", { x: l.x + (Math.random() - .5) * 40, y: ground.y + 25, z: l.z + (Math.random() - .5) * 40 }); if (s.t % 20 === 0) for (const p of players(dim, l, 50)) shake(p, .04, 1.1); }
    if (s.t % 2 === 0) fx(dim, "orbital_foundry:sw_ember", plus(l, { x: (Math.random() - .5) * 5, y: 3 + Math.random() * 6, z: (Math.random() - .5) * 5 }));
    if (s.t % 7 === 0) fx(dim, "orbital_foundry:sw_spark", plus(l, { x: (Math.random() - .5) * 4, y: 5 + Math.random() * 2, z: (Math.random() - .5) * 2 }));
    if (s.t % 9 === 0) fx(dim, "orbital_foundry:siege_steam", plus(l, { x: (Math.random() - .5) * 6, y: 6.5, z: 1 }));
    if (s.t % 40 === 0) { snd(dim, "block.grindstone.use", l, 1.5, .4); snd(dim, "mob.warden.heartbeat", l, 2, exposed ? 1.3 : .8); }
    if (exposed && s.t % 3 === 0) { fx(dim, "orbital_foundry:core_flare", headWorld(l, e.getRotation().y, "star")); fx(dim, "orbital_foundry:sw_spark", headWorld(l, e.getRotation().y, "star")); }
    if (s.t % 4 === 0) for (let k = 0; k < 3; k++) { const a = s.t * .08 + k * 2.094, r = 6; fx(dim, "orbital_foundry:starforge_tracer", { x: l.x + Math.cos(a) * r, y: l.y + 6 + Math.sin(s.t * .05 + k), z: l.z + Math.sin(a) * r }); }
  }
  // 危険警告: 技ごとに「どちらへ逃げるか」を計算する
  const ARROWS = ["前", "右前", "右", "右後ろ", "後ろ", "左後ろ", "左", "左前"];   // 矢印記号はマイクラのフォントにないので文字で
  function arrowFor(p, d) {
    const r = p.getRotation().y * Math.PI / 180, f = { x: -Math.sin(r), z: Math.cos(r) }, rt = { x: -Math.cos(r), z: -Math.sin(r) };
    const a = Math.atan2(d.x * rt.x + d.z * rt.z, d.x * f.x + d.z * f.z);
    return ARROWS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
  }
  const warns = new Map();
  function warnFor(e, s, p) {
    const sp = s.spell, t = s.spellT ?? 0, c = plus(p.location, { x: 0, y: 1, z: 0 });
    if (!sp) return undefined;
    const away = (from, line) => { const v = sub(c, from), tt = dot(v, line), q = sub(v, { x: line.x * tt, y: line.y * tt, z: line.z * tt }); const h = norm({ x: q.x || .01, y: 0, z: q.z }); return { h, d: len(q) }; };
    if (sp === "collapse" && t < 72) { const v = { ...sub(c, e.location), y: 0 }, d = len(v); if (d >= 28) return undefined;
      return `§c§l!!§r §f退避 ${arrowFor(p, norm(v))} §eあと${Math.ceil(28 - d)}m §7(${((72 - t) / 20).toFixed(1)}秒)`; }
    if (sp === "ram" && t < 40 && s.ramDir) { const { h, d } = away(plus(e.location, { x: 0, y: 4, z: 0 }), s.ramDir); if (d > 9) return undefined;
      return `§c§l!!§r §f横へ ${arrowFor(p, h)} §eあと${Math.ceil(8 - d)}m`; }
    if ((sp === "zigzag" || sp === "rampage") && s.ramDir) { const { h, d } = away(plus(e.location, { x: 0, y: 4, z: 0 }), s.ramDir); if (d > 9) return undefined;
      return `§c§l!!§r §f突進の線から外れろ ${arrowFor(p, h)}`; }
    if (sp === "despair" && s.dC && s.dHole) { const rot = t * .02, hh = norm({ x: s.dHole.x * Math.cos(rot) - s.dHole.z * Math.sin(rot), y: s.dHole.y, z: s.dHole.x * Math.sin(rot) + s.dHole.z * Math.cos(rot) });
      return `§4§l×§r §f抜け穴へ ${arrowFor(p, hh)} §7(${hh.y > .3 ? "上" : hh.y < -.3 ? "下" : "水平"})`; }
    if (sp === "beam" && t < 60 && s.beamAim) { const from = headWorld(e.location, e.getRotation().y, "star"), { h, d } = away(from, norm(sub(s.beamAim, from))); if (d > 4) return undefined;
      return `§c§l!!§r §f射線から外れろ ${arrowFor(p, h)}`; }
    if (sp === "lasers") { const hy = headWorld(e.location, e.getRotation().y, "star").y; if (Math.abs(c.y - hy) > 3 || dist(c, e.location) > 44) return undefined;
      return `§c§l!!§r §f${c.y > hy ? "上へ昇れ" : "下へ降りろ"}`; }
    if (sp === "meteors" && s.marks) { let best, bd = 1e9; for (const m of s.marks) if (t < m.at) { const d = dist({ ...c, y: m.y }, m); if (d < bd) { bd = d; best = m; } }
      if (!best || bd > 4.5) return undefined; return `§c§l!!§r §f着弾点から離れろ ${arrowFor(p, norm({ ...sub(c, best), y: 0 }))}`; }
    if (s.final) return undefined;
    return undefined;
  }
  function tickWarnings() {
    const now = system.currentTick;
    for (const dim of ["overworld", "nether", "the_end"]) {
      let list = []; try { list = world.getDimension(dim).getEntities({ type: BOSS }); } catch { }
      for (const e of list) { const s = live.get(e.id); if (!s || s.dead) continue;
        for (const p of players(e.dimension, e.location, 110)) { const w = warnFor(e, s, p); if (w) warns.set(p.id, { text: hasFusion(p) ? "§b星炉超越 · 即死攻撃無効" : w, until: now + 4 }); } }
    }
    for (const [id, w] of warns) if (w.until < now) warns.delete(id);
    for (const p of world.getPlayers()) { const w = warns.get(p.id); if (w && now % 2 === 0 && !(SW_INFO.hudOwner?.(p))) try { p.onScreenDisplay.setActionBar(w.text); } catch { } }
  }
  SW_INFO.warn = p => warns.get(p.id)?.text;
  SW_INFO.targetPart = (p, e) => {
    if (e.typeId !== BOSS) return undefined;
    const s = stateOf(e);
    if (s.dead || s.hp.star <= 0) return undefined;
    return pickPart(e, s, p, p.location);
  };
  SW_INFO.partLocation = (e, part) => {
    if (e.typeId !== BOSS || !part) return undefined;
    const s = stateOf(e);
    if (s.dead || s.hp.star <= 0 || !(s.hp[part] > 0)) return undefined;
    return headWorld(e.location, e.getRotation().y, part);
  };
  SW_INFO.lock = (p, e, lockedPart) => {
    if (e?.typeId !== BOSS) return undefined;
    const s = live.get(e.id); if (!s) return undefined;
    const part = s.hp[lockedPart] > 0 ? lockedPart : pickPart(e, s, p, p.location), names = { tracker: "追尾頭部", heavy: "重装頭部", star: "星炉頭部" };
    const guard = part === "star" && (s.hp.tracker > 0 || s.hp.heavy > 0) ? " §7(装甲で9割減)" : "";
    const recovery = (s.regenBlockedUntil ?? 0) > s.t ? ` §b回復停止 ${((s.regenBlockedUntil-s.t)/20).toFixed(1)}秒` : "";
    return `§d* ${names[part]} §f${Math.max(0, Math.ceil(s.hp[part]))}/${W.hp[part]}${guard}${recovery}`;
  };
  // 空の色: 第一形態=紫 / 第二形態=赤紫 / 最終形態=深紅。遠雷
  const skyOf = new Map();
  function tickSky() {
    const want = new Map();
    for (const dim of ["overworld", "nether", "the_end"]) {
      let list = []; try { list = world.getDimension(dim).getEntities({ type: BOSS }); } catch { }
      for (const e of list) { const s = live.get(e.id); if (!s) continue;
        const stage = s.dead ? 0 : s.final ? 3 : (s.hp.tracker <= 0 && s.hp.heavy <= 0) ? 2 : 1;
        for (const p of e.dimension.getPlayers({ location: e.location, maxDistance: 120 })) want.set(p.id, Math.max(want.get(p.id) ?? 0, stage));
        if (stage && Math.random() < .5) { const a = Math.random() * 6.28, rr = 50 + Math.random() * 40, at = { x: e.location.x + Math.cos(a) * rr, y: e.location.y + 30, z: e.location.z + Math.sin(a) * rr };
          fxv(e.dimension, "orbital_foundry:sky_bolt", at, { len: 70 }); fxv(e.dimension, "orbital_foundry:sky_flash", at, { size: 30 }); snd(e.dimension, "ambient.weather.thunder", at, 1.5, .6 + Math.random() * .3); }
      }
    }
    for (const p of world.getPlayers()) {
      const cur = skyOf.get(p.id) ?? 0, st = want.get(p.id) ?? 0;
      if (cur === st) continue;
      try { if (cur) p.runCommand("fog @s remove of_sw_sky"); } catch { }
      try { if (st) p.runCommand(`fog @s push orbital_foundry:sw_sky_${st} of_sw_sky`); } catch { }
      skyOf.set(p.id, st);
    }
  }
  world.afterEvents.playerSpawn.subscribe(({ player }) => { try { player.runCommand("fog @s remove of_sw_sky"); } catch { } skyOf.delete(player.id); });
  system.runInterval(() => { try { tickSky(); } catch { } }, 20);
  system.runInterval(() => { try { tickWarnings(); } catch { } }, 1);
  function warpTo(e, s, target) {
    const dim = e.dimension, from = plus(e.location, { x: 0, y: 5, z: 0 });
    for (let k = 0; k < 6; k++) system.runTimeout(() => { fxv(dim, "orbital_foundry:portal_shock", from, { size: 10 + k * 3 }); fx(dim, "orbital_foundry:sw_spark", from); }, k * 2);
    snd(dim, "mob.endermen.portal", from, 3, .5); snd(dim, "mob.wither.shoot", from, 2, .5);
    const a = Math.random() * 6.28, rr = 12 + Math.random() * 4, tl = target.location;
    let gy = tl.y + 2; try { const h = dim.getTopmostBlock({ x: tl.x + Math.cos(a) * rr, z: tl.z + Math.sin(a) * rr }); if (h) gy = Math.max(h.location.y + 2, Math.min(h.location.y + 14, tl.y)); } catch { }
    const to = { x: tl.x + Math.cos(a) * rr, y: gy, z: tl.z + Math.sin(a) * rr };
    try { e.teleport(to, { facingLocation: target.getHeadLocation() }); } catch { }
    const at = plus(to, { x: 0, y: 5, z: 0 });
    fx(dim, "orbital_foundry:overseer_core_burst", at); fxv(dim, "orbital_foundry:portal_shock", at, { size: 24 });
    snd(dim, "mob.endermen.portal", at, 3, .7); snd(dim, "mob.enderdragon.growl", at, 3, 1.1);
    for (const p of players(dim, at, 60)) shake(p, .25, .6);
    s.warpCd = s.t + W.warpCooldown;
    const exposed = s.hp.tracker <= 0 && s.hp.heavy <= 0;
    s.spell = exposed ? "rampage" : "ram"; s.spellT = 0; s.count++;
    SPELLS[s.spell].start?.(e, s, target);
  }
  function tickRiftLaser(e, s, exposed, combatants) {
    const phase = s.final ? "final" : exposed ? "exposed" : "armored";
    if (s.t - (s.lastRiftLaser ?? 0) < W.riftLaserInterval[phase]) return;
    const dim = e.dimension;
    const targets = combatants.filter(p => dist(p.location, e.location) > W.riftLaserMinRange);
    if (!targets.length) return;
    s.lastRiftLaser = s.t;
    for (const p of targets) {
      const hit = p.getHeadLocation();
      const angle = Math.random() * Math.PI * 2;
      const portal = { x: hit.x + Math.cos(angle) * 7, y: hit.y + 4, z: hit.z + Math.sin(angle) * 7 };
      const ray = sub(hit, portal);
      fxv(dim, "orbital_foundry:portal_shock", portal, { size: 10 });
      for (let step = 0; step < 14; step++) {
        fx(dim, of(step % 2 ? "tracer" : "surge"), plus(portal, ray, step / 14));
      }
      fx(dim, "orbital_foundry:sw_spark", hit);
      snd(dim, "mob.endermen.portal", portal, 1.2, .8);
      snd(dim, "mob.warden.sonic_boom", hit, 1.1, 1.25);
      // 体力を直接引き、防具・耐性・吸収や通常の被弾間隔を経由させない。
      if (absorb(p)) continue;
      const health = p.getComponent("minecraft:health");
      if (health && health.currentValue > 0) {
        const remaining = health.currentValue - W.riftLaserDamage[phase];
        if (remaining <= 0) p.kill();
        else health.setCurrentValue(remaining);
      }
      shake(p, .12, .25);
    }
  }
  function consumeBladeHits(e) {
    for (const tag of e.getTags()) {
      if (!tag.startsWith("kb_sw_hit|")) continue;
      if (!e.removeTag(tag)) continue;
      const [,pid,type,raw,kind,awake,when] = tag.split("|");
      const amount = Number(raw), age = system.currentTick-Number(when);
      if (!Number.isFinite(amount) || amount<=0 || !Number.isFinite(age) || age<0 || age>10 || !type?.startsWith("koke_blade:") || type.endsWith("_broken") || !["iai","sa","ultimate","finale"].includes(kind)) continue;
      const p = world.getAllPlayers().find(q=>q.id===pid);
      if (!p?.isValid || p.dimension.id!==e.dimension.id || mainBlade(p)!==type) continue;
      // 巨大なモデルの頭部から距離を判定するため、座標原点の余裕を含む。
      if (dist(p.location,e.location) > 48) continue;
      hurt(e,amount,p,p.location,undefined,undefined,{type,awakened:awake==="1",kind});
    }
  }
  function tickBoss(e) {
    consumeBladeHits(e);
    const s = stateOf(e);
    if (s.dead) return;
    s.t++; s.count ??= 0;
    // 10分経っても倒せなければ虚空へ去る (詰み防止)
    if (s.t >= W.despawnTicks && !s.leaving) { s.leaving = true; leave(e, s); return; }
    if (s.leaving) return;
    const transforming = (s.transformUntil ?? 0) > s.t;
    const exposed = s.hp.tracker <= 0 && s.hp.heavy <= 0;
    if (!transforming && s.t % 20 === 0 && s.hp.star > 0 && s.t >= (s.regenBlockedUntil ?? 0)) {
      const rate = s.final ? W.regenPerSecond.final : exposed ? W.regenPerSecond.exposed : W.regenPerSecond.armored;
      let recovered = false;
      for (const part of Object.keys(W.hp)) {
        if (s.hp[part] <= 0 || s.hp[part] >= W.hp[part]) continue;
        s.hp[part] = Math.min(W.hp[part], s.hp[part] + rate);
        recovered = true;
      }
      if (recovered) save(e, s);
    }
    mirror(e, s);
    if (!s.barViewers || s.t % 20 === 0) {
      try { syncBossBar(e, s); } catch { }
    }
    const tick = system.currentTick;
    if ((s.awakenUntil ?? 0) > tick) { if (s.t % 2 === 0) { fx(e.dimension, of("surge"), plus(e.location, { x: 0, y: 6, z: 0 })); fx(e.dimension, "orbital_foundry:sw_ember", e.location); } return; }
    try { if (e.getProperty("orbital_foundry:awaken") === 1) e.setProperty("orbital_foundry:awaken", 0); } catch { }
    // 組み上げ途中で再読み込みされた等で見た目が欠けたままにならないように
    try { if (e.getProperty("orbital_foundry:build") < 9) e.setProperty("orbital_foundry:build", 9); if (e.getProperty("orbital_foundry:dying") === 1) e.setProperty("orbital_foundry:dying", 0); } catch { }
    // 地中に潜らない: 真下の地面より下に入ったら地上へ戻す
    if (s.t % 5 === 0) {
      try {
        const h = e.dimension.getTopmostBlock({ x: e.location.x, z: e.location.z });
        if (h && e.location.y < h.location.y + 1) { s.ram = undefined; if (s.spell === "ram") { s.spell = undefined; s.gap = s.t + 20; } e.teleport({ x: e.location.x, y: h.location.y + 3, z: e.location.z }); }
      } catch { }
    }
    aura(e, s, exposed);
    const combatants = players(e.dimension, e.location, 180);
    const target = targetOf(e, combatants);
    // プレイヤーがいなければ周りのモブを無差別に撃つ。プレイヤーを見つけたらそちらを優先する
    if (!target) { if (s.t % 12 === 0) strafeMobs(e); return; }
    if (s.t % 40 === 20) strafeMobs(e, 1);
    // 形態変化中は静止して演出だけ
    if (transforming) { try { e.teleport(e.location, { facingLocation: target.getHeadLocation() }); } catch { } return; }
    tickRiftLaser(e, s, exposed, combatants);
    // 第二形態以降: 周囲の地面から光の柱が立ち続ける
    if (exposed && s.t % 6 === 0) { const a = Math.random() * 6.28, rr = 8 + Math.random() * 30, g = { x: e.location.x + Math.cos(a) * rr, y: target.location.y, z: e.location.z + Math.sin(a) * rr };
      fxv(e.dimension, "orbital_foundry:sw_laser", plus(g, { x: 0, y: 20, z: 0 }), { len: 40 }); fx(e.dimension, "orbital_foundry:sw_ember", g); }
    // 最終形態: 即死の輪がゆっくり広がり続ける (隙間あり)
    if (s.final && s.t % 70 === 0) { const at = plus(e.location, { x: 0, y: 4, z: 0 }), gap = Math.floor(Math.random() * 64);
      for (let i = 0; i < 64; i++) { if (Math.abs(i - gap) < 4) continue; const a = i * Math.PI / 32; shoot(e.dimension, at, { x: Math.cos(a), y: 0, z: Math.sin(a) }, .22, "lethal_big", { life: 200 }); }
      snd(e.dimension, "mob.warden.sonic_charge", at, 2, .5); }
    // 遠くから戦う相手には、空間を裂いて詰めてくる (直後に即死の突進)
    { const d = dist(target.location, e.location), cur = SPELLS[s.spell];
      if (d > W.warpDist && s.t >= (s.warpCd ?? 0) && !(cur && cur.lethal)) { warpTo(e, s, target); return; } }
    // 技の進行
    if (!s.spell && s.t >= (s.gap ?? 0)) {
      s.spell = chooseSpell(s, exposed); s.spellT = 0; s.count++;
      if (SPELLS[s.spell]?.lethal) {
        const g = { x: e.location.x, y: (s.groundY ?? e.location.y - 2) + .1, z: e.location.z };
        snd(e.dimension, "mob.enderdragon.growl", e.location, 3, .7 + Math.random() * .2);
        fxv(e.dimension, "orbital_foundry:sw_shock_ring", g, { size: 30, hot: 1 }); fxv(e.dimension, "orbital_foundry:sw_shock_ring", plus(e.location, { x: 0, y: 6, z: 0 }), { size: 18, hot: 1 });
        fx(e.dimension, "orbital_foundry:overseer_core_burst", plus(e.location, { x: 0, y: 6, z: 0 }));
        for (const p of players(e.dimension, e.location, 80)) shake(p, .18, .6);
      }
      const sp = SPELLS[s.spell]; sp?.start?.(e, s, target);

    }
    let mode;
    if (s.spell) {
      const sp = SPELLS[s.spell];
      if (!sp || (sp.need && s.hp[sp.need] <= 0)) { s.spell = undefined; }
      else {
        mode = sp.run(e, s, s.spellT, target);
        if (++s.spellT >= sp.len) { s.last = s.spell; s.spell = undefined; s.gap = s.t + (exposed ? 12 : 26); try { e.setProperty("orbital_foundry:attack", 0); } catch { } }
      }
    }
    // 技と並行して、常に自機狙いの立体コーンを撃つ
    if (s.t % (exposed ? 16 : 24) === 0) {
      const heads = ["tracker", "heavy", "star"].filter(k => s.hp[k] > 0), h = heads[s.t % heads.length];
      cone(e.dimension, headWorld(e.location, e.getRotation().y, h), target, exposed ? 12 : 8, .22, exposed ? .7 : .55, s.t % 3 === 0 ? "lethal" : "orb");
      snd(e.dimension, "mob.blaze.shoot", e.location, 1.2, .8);
    }
    // 移動: 相手の上空を周回。技によっては停止・照準固定
    if (mode !== "move") {
      const tl = target.location, ang = s.t * (s.final ? .03 : exposed ? .022 : .015), radius = exposed ? 14 : 18, up = airborne(target) ? 4 : 8;
      // 高さは地面基準で低めに保つ (相手が高く飛んでも地面+14まで)
      const gx = tl.x + Math.cos(ang) * radius, gz = tl.z + Math.sin(ang) * radius;
      if (s.t % 10 === 0 || s.groundY === undefined) { try { const h = e.dimension.getTopmostBlock({ x: gx, z: gz }); s.groundY = h ? h.location.y + 1 : tl.y; } catch { s.groundY = tl.y; } }
      const gy = Math.max(s.groundY + 2, Math.min(s.groundY + 14, tl.y + up - 4));
      let goal = { x: gx, y: gy, z: gz };
      if (mode === "hold" || mode === "aim") goal = e.location;
      const v = sub(goal, e.location), d = len(v), sp = Math.min(d, (s.final ? .7 : exposed ? .5 : .35) * W.moveSpeed);
      const next = d > .01 ? plus(e.location, norm(v), sp) : e.location;
      const look = mode === "aim" && s.beamAim ? s.beamAim : target.getHeadLocation();
      try { e.teleport(next, { facingLocation: look }); } catch { }
      if (s.t % 3 === 0) chew(e);
      // 定期的な地面への叩きつけ
      if (s.t % 90 === 45) { const g = { x: e.location.x, y: (s.groundY ?? e.location.y - 3), z: e.location.z }; boom(e.dimension, g, 6, e); fx(e.dimension, "orbital_foundry:siege_shock_ring_big", g); for (const q of players(e.dimension, g, 40)) shake(q, .2, .5); }
    }
  }
  system.runInterval(() => {
    for (const dim of ["overworld", "nether", "the_end"]) {
      let list = [];
      try { list = world.getDimension(dim).getEntities({ type: BOSS }); } catch { }
      for (const e of list) try { tickBoss(e); } catch { }
    }
    tickBullets();
  }, 1);

  // デバッグ: /scriptevent orbital_foundry:debug_wither  (クリエイティブ、目の前に出現)
  system.afterEvents.scriptEventReceive.subscribe(ev => {
    if (ev.id !== "orbital_foundry:debug_wither") return;
    const p = ev.sourceEntity;
    if (p?.typeId !== "minecraft:player") return;
    try {
      const at = plus(p.location, norm({ ...p.getViewDirection(), y: 0 }), 10);
      const e = p.dimension.spawnEntity(BOSS, at);
      const s = fresh(); live.set(e.id, s); save(e, s);
      assemble(e, s);
      toast(p, "§d[debug] 星炉ウィザーを召喚");
    } catch (err) { toast(p, "debug_wither: " + err); }
  });

  return { hurtBoss, isBoss: e => e?.typeId === BOSS, _test: { SPELLS, tickBoss, bullets, tickBullets, stateOf, hurt, warnFor, tickSky, lethal, pierce, absorb, consumeBladeHits, tickRiftLaser } };
}
