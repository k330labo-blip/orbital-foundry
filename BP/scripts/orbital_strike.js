// 天蓋執行機構〈アストライア〉 — 終焉星核から作る軌道打撃 (自作アドオン Orbital Strike Cannon v1.7 を統合)
// 右クリック: 照準先の地上座標を受理 → もう一度右クリックで執行 / 左クリック: 破棄 / しゃがみ右クリック: 数値で指定
import { world, system, GameMode } from "@minecraft/server";
import { ModalFormData, MessageFormData } from "@minecraft/server-ui";
const CANNON_ID = "orbital_foundry:orbital_strike_designator";
export function installAstraea({ damageTarget, hurtBoss, isBoss }) {
const COOLDOWN_TICKS = 20 * 180; // 3分（クリエイティブは無効）
const LOCKON_TICKS = 100;        // 発射後の最終カウントダウン 5秒（座標は左クリで指定済み）
const DROP_ZONE = 0.70;          // 投下は選択半径の内側70%
const SALVO_TARGET = 950;        // 一斉投下の目標総数
const DEFAULT_RADIUS = 100;

const activeStrikes = [];
const guidedTNT = [];            // { e, x, z } 飛散防止ガード
const fireballs = [];            // { e, born } 後片付け用
const locks = new Map();         // playerId -> { x,y,z, dimId, radius, fx }
// 初回起動シーケンス（最後の一行は初回だけ）
function ensureBoot(player) {
  let booted = null;
  tryRun(() => { booted = player.getDynamicProperty("of_ast:booted"); });
  if (booted) return;
  tryRun(() => player.setDynamicProperty("of_ast:booted", true));
  sound(player, "random.orb", player.location, 0.8, 1.1);
  actionbar(player, "§6第七地上局を認証");
  system.runTimeout(() => {
    sound(player, "random.orb", player.location, 0.8, 1.5);
    actionbar(player, "§6軌道局 AST-07 応答");
  }, 24);
  system.runTimeout(() => {
    sound(player, "beacon.activate", player.location, 0.6, 1.2);
    player.sendMessage("§o§6「……お帰りなさい、管制官。」");
  }, 48);
}
let tickCounter = 0;

/* ---------- 小物 ---------- */
function tryRun(fn) { try { fn(); } catch (e) { } }
function dist(a, b) { const dx = a.x - b.x, dz = a.z - b.z, dy = (a.y ?? 0) - (b.y ?? 0); return Math.sqrt(dx * dx + dy * dy + dz * dz); }
function playersNear(dim, loc, r) {
  return world.getAllPlayers().filter(p => p.dimension.id === dim.id && dist(p.location, loc) <= r);
}
function particle(dim, id, loc) { tryRun(() => dim.spawnParticle(id, loc)); }
function vanillaFx(dim, loc) {
  // バニラパーティクルで厚みを足す（存在しないIDは tryRun で握りつぶす）
  particle(dim, "minecraft:basic_flame_particle", loc);
  particle(dim, "minecraft:electric_spark_particle", loc);
}
function sound(player, id, loc, vol = 1, pitch = 1) {
  tryRun(() => player.playSound(id, { location: loc, volume: vol, pitch: pitch }));
}
function actionbar(player, text) { tryRun(() => player.onScreenDisplay.setActionBar(text)); }
function shake(player, intensity, seconds) {
  tryRun(() => player.runCommand(`camerashake add @s ${intensity} ${seconds} positional`));
}
function circlePoints(cx, cz, r, count, rot = 0) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = rot + (i / count) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return pts;
}
function gauss() { return (Math.random() + Math.random() + Math.random()) / 1.5 - 1; }
const wait = ticks => new Promise(r => system.runTimeout(r, ticks));

function groundY(dim, x, z, fallbackY) {
  if (dim.id === "minecraft:nether") {
    for (let y = 120; y > 5; y--) {
      try {
        const b = dim.getBlock({ x: Math.floor(x), y: y, z: Math.floor(z) });
        if (b && b.typeId !== "minecraft:air" && b.typeId !== "minecraft:bedrock" && b.typeId !== "minecraft:lava" && b.typeId !== "minecraft:flowing_lava") return y + 1;
      } catch (e) { break; }
    }
    return fallbackY ?? 64;
  }
  try {
    const top = dim.getTopmostBlock({ x: Math.floor(x), z: Math.floor(z) });
    if (top) return top.location.y + 1;
  } catch (e) { }
  return fallbackY ?? 64;
}
function heldItem(player, evItem) {
  if (evItem && evItem.typeId) return evItem;
  let it = null;
  tryRun(() => {
    const eq = player.getComponent("minecraft:equippable");
    if (eq) it = eq.getEquipment("Mainhand");
  });
  return it;
}
function isCannon(item) { return !!item && item.typeId === CANNON_ID; }

/* ---------- 未読込チャンク対策（tickingarea） ---------- */
const areaMap = new Map(); // key -> { dim, names[] }
function areaKey(player) {
  let k = (player.id || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!k) { k = "p"; for (const ch of (player.name || "x")) k += ch.charCodeAt(0) % 10; }
  return "ast_" + k.slice(-10);
}
function removeTickingAreas(key) {
  const rec = areaMap.get(key);
  if (!rec) return;
  for (const n of rec.names) tryRun(() => rec.dim.runCommand(`tickingarea remove ${n}`));
  areaMap.delete(key);
}
function setupTickingAreas(player, dim, cx, cz, cy, radius) {
  const key = areaKey(player);
  removeTickingAreas(key);
  // 常時読み込み枠はワールド全体で10個まで。工場が9個使うので、着弾点は中心の10×10チャンク (160ブロック四方) を1枠だけ読み込む
  const ccx = Math.floor(cx / 16), ccz = Math.floor(cz / 16);
  const names = [];
  const name = `${key}_0_0`;
  tryRun(() => dim.runCommand(`tickingarea add ${(ccx - 5) * 16} ${cy} ${(ccz - 5) * 16} ${(ccx + 4) * 16 + 15} ${cy} ${(ccz + 4) * 16 + 15} ${name} true`));
  names.push(name);
  areaMap.set(key, { dim: dim, names: names });
  return key;
}

/* ---------- 座標ロック（左クリック） ---------- */
function setLock(player, loc, radius, fx) {
  locks.set(player.id, { x: loc.x, y: loc.y, z: loc.z, dimId: player.dimension.id, radius: radius, fx: fx });
  setupTickingAreas(player, player.dimension, loc.x, loc.z, loc.y, radius); // ロックした時点で対象空域を先読み
  tryRun(() => {
    player.setDynamicProperty("of_ast:tx", loc.x);
    player.setDynamicProperty("of_ast:ty", loc.y);
    player.setDynamicProperty("of_ast:tz", loc.z);
    player.setDynamicProperty("of_ast:tr", radius);
  });
  const dim = player.dimension;
  const gy = groundY(dim, loc.x, loc.z, loc.y);
  // ロック確定の実演出: 目標に光柱＋リングを一発出す
  for (let dy = 0; dy <= 50; dy += 4) particle(dim, "orbital_foundry:ast_beam_glow", { x: loc.x, y: gy + dy, z: loc.z });
  for (const pt of circlePoints(loc.x, loc.z, 6, 20)) particle(dim, "orbital_foundry:ast_shock_glow", { x: pt.x, y: gy + 1.2, z: pt.z });
  for (const pt of circlePoints(loc.x, loc.z, radius * DROP_ZONE, 40)) particle(dim, "orbital_foundry:ast_lock_spark", { x: pt.x, y: gy + 1.2, z: pt.z });
  sound(player, "beacon.activate", { x: loc.x, y: gy, z: loc.z }, 0.8, 1.4);
  sound(player, "random.orb", player.location, 0.7, 1.2);
  actionbar(player, `§6地上座標を受理 §f${loc.x}, ${loc.y}, ${loc.z} §7半径 ${radius} ― 右クリックで執行`);
  player.sendMessage(`§7軌道局 AST-07 応答 ― 地上座標 §f${loc.x}, ${loc.y}, ${loc.z}§7 を登録。もう一度右クリックで執行、左クリックで破棄。`);
}
function getLock(player) {
  const l = locks.get(player.id);
  if (l) return l;
  // 再入室などでメモリが飛んでたら DynamicProperty から復元
  try {
    const x = player.getDynamicProperty("of_ast:tx"), y = player.getDynamicProperty("of_ast:ty"),
          z = player.getDynamicProperty("of_ast:tz"), r = player.getDynamicProperty("of_ast:tr");
    if (typeof x === "number" && typeof z === "number") {
      const restored = { x: x, y: typeof y === "number" ? y : 64, z: z, dimId: player.dimension.id, radius: typeof r === "number" ? r : DEFAULT_RADIUS, fx: true };
      locks.set(player.id, restored);
      return restored;
    }
  } catch (e) { }
  return null;
}
function clearLock(player) {
  locks.delete(player.id);
  removeTickingAreas(areaKey(player));
  tryRun(() => { player.setDynamicProperty("of_ast:tx", undefined); });
}

// ロック中のマーカー（細いビーム＋投下域リング）を描き続ける
function drawMarkers() {
  for (const p of world.getAllPlayers()) {
    // スニーク中は「照準モード」: 見ている先をそのままロックし続ける（左クリが届かない遠距離用の確実な指定方法）
    if (p.isSneaking && isCannon(heldItem(p, null))) {
      let hit = null;
      tryRun(() => { hit = p.getBlockFromViewDirection({ maxDistance: 300 }); });
      if (hit && hit.block) {
        const l = hit.block.location;
        const cur = locks.get(p.id);
        if (!cur || cur.x !== l.x || cur.y !== l.y || cur.z !== l.z) {
          locks.set(p.id, { x: l.x, y: l.y, z: l.z, dimId: p.dimension.id, radius: cur ? cur.radius : DEFAULT_RADIUS, fx: cur ? cur.fx : true });
          actionbar(p, `§6地上座標を受理中 §f${l.x}, ${l.y}, ${l.z} §7― スニークを離して右クリックで執行`);
        }
      }
    }
    const l = locks.get(p.id);
    if (!l || l.dimId !== p.dimension.id) continue;
    const dim = p.dimension;
    const gy = groundY(dim, l.x, l.z, l.y);
    const rot = tickCounter * 0.06;
    for (let dy = 0; dy <= 42; dy += 7) particle(dim, "orbital_foundry:ast_beam_glow", { x: l.x, y: gy + dy, z: l.z });
    for (const pt of circlePoints(l.x, l.z, 5, 14, rot)) particle(dim, "orbital_foundry:ast_shock_glow", { x: pt.x, y: gy + 1.2, z: pt.z });
    for (const pt of circlePoints(l.x, l.z, l.radius * DROP_ZONE, 36, -rot * 0.6)) particle(dim, "orbital_foundry:ast_lock_spark", { x: pt.x, y: gy + 1.2, z: pt.z });
  }
}

/* ---------- TNT（飛散防止ガード付き） ---------- */
function spawnTNT(s, x, z, heightBonus = 0) {
  const dim = s.dim;
  const gy = groundY(dim, x, z, s.center.y);
  const y = gy + 30 + heightBonus + Math.random() * 6;
  tryRun(() => {
    const tnt = dim.spawnEntity("minecraft:tnt", { x: x, y: y, z: z });
    tryRun(() => tnt.applyImpulse({ x: 0, y: -0.4, z: 0 }));
    guidedTNT.push({ e: tnt, x: x, z: z });
    s.tntCount++;
  });
  particle(dim, "orbital_foundry:ast_beam_glow", { x: x, y: y + 1, z: z });
}
function spawnFireball(s, x, z) {
  const dim = s.dim;
  const gy = groundY(dim, x, z, s.center.y);
  const kind = Math.random() < 0.3 ? "minecraft:dragon_fireball" : "minecraft:fireball";
  tryRun(() => {
    const fb = dim.spawnEntity(kind, { x: x, y: gy + 52, z: z });
    tryRun(() => fb.applyImpulse({ x: 0, y: -1.6, z: 0 }));
    fireballs.push({ e: fb, born: system.currentTick });
    s.tntCount += 0; // 発数表示はTNTのみ
  });
}
function guardTNT() {
  for (let i = guidedTNT.length - 1; i >= 0; i--) {
    const g = guidedTNT[i];
    let valid = false;
    tryRun(() => { valid = g.e.isValid; });
    if (!valid) { guidedTNT.splice(i, 1); continue; }
    tryRun(() => {
      const loc = g.e.location;
      const dx = loc.x - g.x, dz = loc.z - g.z;
      const dh = Math.sqrt(dx * dx + dz * dz);
      if (dh > 7) {
        g.e.teleport({ x: g.x, y: loc.y, z: g.z });
        g.e.clearVelocity();
        g.e.applyImpulse({ x: 0, y: -0.5, z: 0 });
      } else {
        const v = g.e.getVelocity();
        if (Math.abs(v.x) > 0.05 || Math.abs(v.z) > 0.05) {
          g.e.clearVelocity();
          g.e.applyImpulse({ x: 0, y: Math.min(v.y, -0.2), z: 0 });
        }
        if (i % 3 === 0) {
          particle(g.e.dimension, "minecraft:basic_flame_particle", loc);
          particle(g.e.dimension, "orbital_foundry:ast_beam_glow", { x: loc.x, y: loc.y + 0.5, z: loc.z });
        }
      }
    });
  }
  // 火球の後片付け（残留したら消す）
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const f = fireballs[i];
    let valid = false;
    tryRun(() => { valid = f.e.isValid; });
    if (!valid || system.currentTick - f.born > 160) {
      if (valid) tryRun(() => f.e.remove());
      fireballs.splice(i, 1);
    }
  }
}

/* ---------- 発射シーケンス ---------- */
function launchStrike(shooter, target, radius, fx) {
  const dim = shooter.dimension;
  const gy = groundY(dim, target.x, target.z, target.y);
  const center = { x: target.x, y: gy, z: target.z };
  tryRun(() => shooter.setDynamicProperty("of_ast:lastUse", system.currentTick));

  world.sendMessage(`§6§l《天蓋執行機構》執行予告 §e${shooter.name} ＞ §f${center.x}, ${center.z}§e 半径 ${radius} ― 地表の者は退避せよ。`);
  const Rdz = radius * DROP_ZONE;
  const salvoSpacing = Math.max(3.5, Math.min(9, Rdz * Math.sqrt(Math.PI / SALVO_TARGET)));
  // サテライトビームの着弾点（中心周囲6か所）
  const beams = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.4;
    beams.push({ at: 10 + k * 10, x: center.x + Math.cos(a) * radius * 0.35, z: center.z + Math.sin(a) * radius * 0.35, done: false });
  }
  const aKey = setupTickingAreas(shooter, dim, center.x, center.z, center.y, radius);
  activeStrikes.push({
    shooter: shooter, dim: dim, center: center, radius: radius, fx: fx, areaKey: aKey,
    phase: "lockon", elapsed: 0, tntCount: 0, finaleBooms: 0,
    salvoRing: -1, bombardElapsed: 0,
    salvoSpacing: salvoSpacing, salvoRings: Math.max(6, Math.ceil(Rdz / salvoSpacing)),
    beams: beams
  });
  for (const p of playersNear(dim, center, 600)) {
    sound(p, "mob.wither.spawn", center, 0.8, 0.6);
    sound(p, "mob.enderdragon.growl", center, 0.5, 0.7);
  }
}

function processLockon(s) {
  const c = s.center, dim = s.dim;
  const rot = s.elapsed * 0.03, rotR = -s.elapsed * 0.045;
  for (const pt of circlePoints(c.x, c.z, s.radius * DROP_ZONE, 56, rot * 0.3)) particle(dim, "orbital_foundry:ast_beam_glow", { x: pt.x, y: c.y + 1.2, z: pt.z });
  for (const pt of circlePoints(c.x, c.z, s.radius, 56, rot)) particle(dim, "orbital_foundry:ast_lock_spark", { x: pt.x, y: c.y + 1.2, z: pt.z });
  for (const pt of circlePoints(c.x, c.z, s.radius * 0.55, 40, rotR)) particle(dim, "orbital_foundry:ast_lock_spark", { x: pt.x, y: c.y + 1.6, z: pt.z });
  // 中心光柱＋螺旋
  for (let dy = 0; dy <= 90; dy += 6) {
    particle(dim, "orbital_foundry:ast_lock_spark", { x: c.x, y: c.y + dy, z: c.z });
    const a = dy * 0.25 + rot * 3;
    particle(dim, "orbital_foundry:ast_beam_glow", { x: c.x + Math.cos(a) * 3, y: c.y + dy, z: c.z + Math.sin(a) * 3 });
  }
  // 上空のチャージ球体（衛星が溜めてるイメージ）: 時間とともに膨らむ
  const orbR = 2 + (s.elapsed / LOCKON_TICKS) * 10;
  const orbY = c.y + 68;
  for (let i = 0; i < 26; i++) {
    const ga = i * 2.39996 + rot;
    const yf = -1 + (2 * i) / 25;
    const hr = orbR * Math.sqrt(Math.max(0, 1 - yf * yf));
    particle(dim, i % 2 ? "orbital_foundry:ast_shock_glow" : "orbital_foundry:ast_beam_glow",
      { x: c.x + Math.cos(ga) * hr, y: orbY + yf * orbR, z: c.z + Math.sin(ga) * hr });
  }
  // 回転サテライト光柱×4
  for (let k = 0; k < 4; k++) {
    const a = rot * 1.4 + (k * Math.PI) / 2;
    const px = c.x + Math.cos(a) * s.radius * 0.8, pz = c.z + Math.sin(a) * s.radius * 0.8;
    for (let dy = 0; dy <= 50; dy += 8) particle(dim, "orbital_foundry:ast_beam_glow", { x: px, y: c.y + dy, z: pz });
  }
  // 実演出: 周囲のプレイヤーを徐々に暗転させる
  if (s.elapsed === 0) {
    for (const p of playersNear(dim, c, 600)) actionbar(p, "§6照射経路を確保");
  }
  if (s.elapsed === LOCKON_TICKS - 20) {
    // 着弾直前: 音を一瞬引く
    for (const p of playersNear(dim, c, 600)) sound(p, "beacon.deactivate", c, 0.7, 0.5);
  }
  if (s.elapsed % 20 === 0 && s.elapsed < LOCKON_TICKS - 20) {
    const left = Math.ceil((LOCKON_TICKS - s.elapsed) / 20);
    for (const p of playersNear(dim, c, 300)) {
      if (s.fx) tryRun(() => p.addEffect("darkness", 45, { amplifier: 0, showParticles: false }));
      actionbar(p, `§c§l執行まで ${left}`);
      sound(p, "random.click", c, 0.9, 1.2);
    }
  }
  if (s.elapsed >= LOCKON_TICKS) {
    s.phase = "bombard"; s.salvoRing = 0; s.bombardElapsed = 0;
    mainBeam(s);
  }
}

function beamColumn(dim, x, yBase, z, height, width, glowId) {
  for (let dy = 0; dy <= height; dy += 2) {
    for (let k = 0; k < 3; k++) particle(dim, glowId, { x: x + (Math.random() - 0.5) * width, y: yBase + dy, z: z + (Math.random() - 0.5) * width });
    if (dy % 6 === 0) vanillaFx(dim, { x: x, y: yBase + dy, z: z });
  }
}
function mainBeam(s) {
  const c = s.center, dim = s.dim;
  for (const p of playersNear(dim, c, 700)) {
    actionbar(p, "§l§6執行承認");
    sound(p, "random.explode", c, 1, 0.35);
  }
  beamColumn(dim, c.x, c.y, c.z, 130, 7, "orbital_foundry:ast_beam_glow");
  beamColumn(dim, c.x, c.y, c.z, 130, 4, "orbital_foundry:ast_shock_glow");
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2, r = 4 + (i % 3) * 4;
    tryRun(() => dim.spawnEntity("minecraft:lightning_bolt", { x: c.x + Math.cos(a) * r, y: c.y, z: c.z + Math.sin(a) * r }));
  }
  tryRun(() => dim.spawnEntity("minecraft:lightning_bolt", c));
  tryRun(() => dim.createExplosion(c, 10, { breaksBlocks: true, causesFire: false }));
  strikeEnemies(s, c, 24, 5000);
  particle(dim, "minecraft:huge_explosion_emitter", c);
  for (const p of playersNear(dim, c, 600)) {
    sound(p, "ambient.weather.thunder", c, 1, 0.7);
    sound(p, "random.explode", c, 1, 0.6);
    if (s.fx) shake(p, 1.2, 3);
  }
}
function satelliteBeam(s, b) {
  const dim = s.dim;
  const gy = groundY(dim, b.x, b.z, s.center.y);
  const loc = { x: b.x, y: gy, z: b.z };
  beamColumn(dim, b.x, gy, b.z, 110, 3, "orbital_foundry:ast_beam_glow");
  for (let i = 0; i < 3; i++) tryRun(() => dim.spawnEntity("minecraft:lightning_bolt", loc));
  tryRun(() => dim.createExplosion(loc, 6, { breaksBlocks: true, causesFire: false }));
  strikeEnemies(s, loc, 12, 2500);
  particle(dim, "minecraft:huge_explosion_emitter", loc);
  for (const p of playersNear(dim, loc, 300)) {
    sound(p, "random.explode", loc, 0.8, 0.8);
    if (s.fx) shake(p, 0.6, 2);
  }
}

/* ----- 放射状・一斉投下（同心円リング） ----- */
function dropSalvoRing(s) {
  const c = s.center;
  const R = s.radius * DROP_ZONE;
  const ring = s.salvoRing;
  if (ring === 0) {
    for (let i = 0; i < 26; i++) spawnTNT(s, c.x + gauss() * 5, c.z + gauss() * 5, 22);
    return;
  }
  const r = (ring / s.salvoRings) * R;
  const count = Math.max(10, Math.min(170, Math.round((2 * Math.PI * r) / s.salvoSpacing)));
  const rot = ring * 0.22;
  for (const pt of circlePoints(c.x, c.z, r, count, rot)) spawnTNT(s, pt.x, pt.z, 22);
  // リング1層ごとに火球を4発混ぜる（炎の筋＋着弾爆発）
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2;
    spawnFireball(s, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r);
  }
}

function processFinale(s) {
  const c = s.center, dim = s.dim;
  // 衝撃波リング×3＋上半分のドーム
  for (let ring = 0; ring < 3; ring++) {
    const local = s.elapsed - ring * 20;
    if (local < 0) continue;
    const r = Math.min(s.radius, local * 3.2);
    for (const pt of circlePoints(c.x, c.z, r, 64, ring * 0.4)) {
      particle(dim, "orbital_foundry:ast_shock_glow", { x: pt.x, y: c.y + 2 + ring, z: pt.z });
      particle(dim, "orbital_foundry:ast_beam_glow", { x: pt.x, y: c.y + 1, z: pt.z });
      particle(dim, "minecraft:basic_flame_particle", { x: pt.x, y: c.y + 1.5, z: pt.z });
    }
    for (const phi of [0.35, 0.7, 1.05]) {
      const ringR = r * Math.cos(phi), hy = c.y + r * Math.sin(phi) * 0.55;
      for (const pt of circlePoints(c.x, c.z, ringR, 28, ring * 0.3)) particle(dim, "orbital_foundry:ast_shock_glow", { x: pt.x, y: hy, z: pt.z });
    }
  }
  if ((s.elapsed === 0 || s.elapsed === 15 || s.elapsed === 30) && s.finaleBooms < 3) {
    s.finaleBooms++;
    tryRun(() => dim.createExplosion(c, 12, { breaksBlocks: true, causesFire: s.finaleBooms === 3 }));
    particle(dim, "minecraft:huge_explosion_emitter", c);
    beamColumn(dim, c.x, c.y, c.z, 80, 3, "orbital_foundry:ast_shock_glow");
    // 実演出: 衝撃波で周囲のエンティティを吹き飛ばす
    tryRun(() => {
      const ents = dim.getEntities({ location: c, maxDistance: s.radius });
      for (const e of ents) {
        if (e.typeId === "minecraft:tnt" || e.typeId === "minecraft:fireball" || e.typeId === "minecraft:dragon_fireball") continue;
        const dx = e.location.x - c.x, dz = e.location.z - c.z;
        const d = Math.max(4, Math.sqrt(dx * dx + dz * dz));
        tryRun(() => e.applyImpulse({ x: (dx / d) * 1.6, y: 0.9, z: (dz / d) * 1.6 }));
      }
    });
    for (const p of playersNear(dim, c, 700)) {
      sound(p, "random.explode", c, 1, 0.5);
      sound(p, "mob.enderdragon.growl", c, 0.6, 0.6);
      if (s.fx) shake(p, 1.4, 4);
    }
  }
  if (s.elapsed === 20 || s.elapsed === 40) {
    for (let i = 0; i < 12; i++) {
      tryRun(() => dim.spawnEntity("minecraft:fireworks_rocket", { x: c.x + (Math.random() - 0.5) * 24, y: c.y + 2, z: c.z + (Math.random() - 0.5) * 24 }));
    }
    for (const p of playersNear(dim, c, 700)) sound(p, "firework.launch", c, 0.8, 1);
  }
  if (s.elapsed >= 110) {
    world.sendMessage(`§6§l《天蓋執行機構》執行完了 §7― ${c.x}, ${c.z} / 投下TNT ${s.tntCount} 発\n§7地表応答なし`);
    return false;
  }
  return true;
}

system.runInterval(() => {
  tickCounter++;
  guardTNT();
  if (tickCounter % 2 === 0) drawMarkers();
  for (let i = activeStrikes.length - 1; i >= 0; i--) {
    const s = activeStrikes[i];
    try {
      if (s.phase === "lockon") {
        processLockon(s);
        s.elapsed += 5;
      } else if (s.phase === "bombard") {
        s.bombardElapsed += 5;
        for (let dy = 0; dy <= 80; dy += 8) particle(s.dim, "orbital_foundry:ast_beam_glow", { x: s.center.x, y: s.center.y + dy, z: s.center.z });
        // サテライトビーム（時間差で6連）
        for (const b of s.beams) {
          if (!b.done && s.bombardElapsed >= b.at) { b.done = true; satelliteBeam(s, b); }
        }
        // 雷嵐: 投下中ずっと投下域内に落雷
        if (s.bombardElapsed % 20 === 0) {
          for (let k = 0; k < 3; k++) {
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * s.radius * DROP_ZONE;
            tryRun(() => s.dim.spawnEntity("minecraft:lightning_bolt", { x: s.center.x + Math.cos(a) * r, y: s.center.y, z: s.center.z + Math.sin(a) * r }));
          }
        }
        // 同心円リングを3層ずつ展開（約1.5秒で全層が揃う）
        if (s.salvoRing <= s.salvoRings) {
          for (let k = 0; k < 3 && s.salvoRing <= s.salvoRings; k++) {
            dropSalvoRing(s);
            s.salvoRing++;
          }
        } else if (s.bombardElapsed >= 150) {
          s.phase = "finale"; s.elapsed = 0;
        }
      } else if (s.phase === "finale") {
        if (!processFinale(s)) {
          activeStrikes.splice(i, 1);
          const key = s.areaKey;
          if (key) system.runTimeout(() => removeTickingAreas(key), 20 * 30);
        }
        s.elapsed += 5;
      }
    } catch (e) {
      activeStrikes.splice(i, 1);
    }
  }
}, 5);

/* ---------- フォーム（数値で座標ロックしたい時用） ---------- */
function buildForm(def, style) {
  const f = new ModalFormData();
  f.title("§l§6第七地上局 ― 地上座標の登録");
  if (style === "new") {
    f.textField("§e目標 X 座標", "例: 100", { defaultValue: String(def.x) });
    f.textField("§e目標 Y 座標", "例: 64", { defaultValue: String(def.y) });
    f.textField("§e目標 Z 座標", "例: -200", { defaultValue: String(def.z) });
    f.slider("§c最大半径（ブロック）", 50, 200, { valueStep: 10, defaultValue: def.radius });
    f.toggle("§6演出MAX（暗転・画面シェイク・衝撃波）", { defaultValue: true });
  } else {
    f.textField("§e目標 X 座標", "例: 100", String(def.x));
    f.textField("§e目標 Y 座標", "例: 64", String(def.y));
    f.textField("§e目標 Z 座標", "例: -200", String(def.z));
    f.slider("§c最大半径（ブロック）", 50, 200, 10, def.radius);
    f.toggle("§6演出MAX（暗転・画面シェイク・衝撃波）", true);
  }
  return f;
}
async function showLockForm(player) {
  const cur = getLock(player);
  let dx = Math.floor(player.location.x), dy = Math.floor(player.location.y), dz = Math.floor(player.location.z);
  tryRun(() => {
    const hit = player.getBlockFromViewDirection({ maxDistance: 300 });
    if (hit && hit.block) { dx = hit.block.location.x; dy = hit.block.location.y; dz = hit.block.location.z; }
  });
  if (cur) { dx = cur.x; dy = cur.y; dz = cur.z; }
  const def = { x: dx, y: dy, z: dz, radius: cur ? cur.radius : DEFAULT_RADIUS };
  let lastErr = null;
  for (const style of ["new", "legacy"]) {
    try {
      const form = buildForm(def, style);
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await form.show(player);
        if (res.canceled) {
          if (res.cancelationReason === "userBusy") { await wait(20); continue; }
          return;
        }
        const [xs, ys, zs, radius, fx] = res.formValues;
        const x = parseInt(xs, 10), y = parseInt(ys, 10), z = parseInt(zs, 10);
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z) || Math.abs(x) > 30000 || Math.abs(z) > 30000 || y < -64 || y > 400) {
          player.sendMessage("§c座標が不正です。X/Z は ±30000 以内、Y は -64〜400 で入力してください。");
          return;
        }
        setLock(player, { x: x, y: y, z: z }, radius, !!fx);
        return;
      }
      return;
    } catch (e) { lastErr = e; }
  }
  player.sendMessage(`§c[Orbital] フォーム表示に失敗: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

/* ---------- トリガー ---------- */
function checkCooldown(player) {
  try {
    const last = player.getDynamicProperty("of_ast:lastUse");
    if (typeof last === "number" && player.getGameMode() !== GameMode.Creative) {
      const remain = COOLDOWN_TICKS - (system.currentTick - last);
      if (remain > 0) {
        player.sendMessage(`§7衛星の再通過を待機中 ― あと ${Math.ceil(remain / 20)} 秒`);
        actionbar(player, `§7再交信まで ${Math.ceil(remain / 20)} 秒`);
        return false;
      }
    }
  } catch (e) { }
  return true;
}

const lastClick = new Map();
function clickDebounced(player, ms) {
  const now = system.currentTick;
  if (lastClick.has(player.id) && now - lastClick.get(player.id) < ms) return true;
  lastClick.set(player.id, now);
  return false;
}
// 照準で座標指定（右クリック1回目）
function designateByAim(player) {
  let hit = null;
  tryRun(() => { hit = player.getBlockFromViewDirection({ maxDistance: 300 }); });
  if (hit && hit.block) {
    const l = hit.block.location;
    const cur = getLock(player);
    setLock(player, { x: l.x, y: l.y, z: l.z }, cur ? cur.radius : DEFAULT_RADIUS, cur ? cur.fx : true);
  } else {
    player.sendMessage("§c照準の先300ブロック以内に地表がありません。標的を見てから右クリックしてね。数値指定は Shift+右クリック か §f!orbital§c。");
  }
}
// ロック座標へ発射
function fireLocked(player) {
  const lock = getLock(player);
  if (!lock) { designateByAim(player); return; }
  if (lock.dimId !== player.dimension.id) {
    player.sendMessage("§c登録座標は別ディメンションのものです。その場所で執行するか、座標を取り直してください。");
    return;
  }
  if (!checkCooldown(player)) return;
  // 初回だけ: 広範囲が跡形もなく吹き飛ぶことを確認してから撃つ
  let agreed = false; tryRun(() => { agreed = !!player.getDynamicProperty("of_ast:agreed"); });
  if (!agreed) {
    const form = new MessageFormData().title("§l§c天蓋執行機構 · 初回執行の確認")
      .body(`§c警告§r\n\n執行すると、登録座標の周囲 §e半径 ${lock.radius} ブロック§r が TNT の一斉投下・主砲・衛星ビームで§c跡形もなく吹き飛びます§r。\n地形も建物も、拠点や機械も区別しません。\n\n登録座標 §f${lock.x}, ${lock.y}, ${lock.z}§r\nあなたの位置からの距離 §f${Math.round(dist(player.location, lock))}§r ブロック\n\n拠点の近くでないことを確認してください。\n(この確認は最初の1回だけ表示されます)`)
      .button1("§l§c理解した · 執行する").button2("やめる");
    form.show(player).then(res => {
      if (res.canceled || res.selection !== 0) { player.sendMessage("§7執行を取りやめました。座標は登録されたままです。"); return; }
      tryRun(() => player.setDynamicProperty("of_ast:agreed", true));
      fireLocked(player);
    }).catch(() => { });
    return;
  }
  clearLock(player);
  launchStrike(player, { x: lock.x, y: lock.y, z: lock.z }, lock.radius, lock.fx);
}
// 右クリック: 座標指定 → もう一度で発射（Shift+右クリは数値フォーム）
function handleRightClick(player) {
  ensureBoot(player);
  if (clickDebounced(player, 15)) return;
  if (player.isSneaking) {
    system.runTimeout(() => { showLockForm(player).catch(() => {}); }, 10);
    return;
  }
  if (getLock(player)) fireLocked(player);
  else designateByAim(player);
}
// 左クリック: 座標破棄
function handleDiscard(player) {
  ensureBoot(player);
  if (clickDebounced(player, 8)) return;
  if (getLock(player)) {
    clearLock(player);
    player.sendMessage("§7登録座標を破棄しました。");
    actionbar(player, "§7登録座標を破棄");
    sound(player, "beacon.deactivate", player.location, 0.6, 0.9);
  }
}

// 左クリック系（ブロックを殴る／エンティティを殴る／スイングイベントがあればそれも）
tryRun(() => {
  const evs = world.afterEvents;
  if (evs.entityHitBlock) {
    evs.entityHitBlock.subscribe(ev => {
      const p = ev.damagingEntity;
      if (!p || p.typeId !== "minecraft:player") return;
      if (!isCannon(heldItem(p, ev.itemStack))) return;
      handleDiscard(p);
    });
  }
  if (evs.entityHitEntity) {
    evs.entityHitEntity.subscribe(ev => {
      const p = ev.damagingEntity;
      if (!p || p.typeId !== "minecraft:player") return;
      if (!isCannon(heldItem(p, ev.itemStack))) return;
      handleDiscard(p);
    });
  }
  if (evs.playerSwingArm && typeof evs.playerSwingArm.subscribe === "function") {
    evs.playerSwingArm.subscribe(ev => {
      const p = ev.player ?? ev.entity ?? null;
      if (!p || p.typeId !== "minecraft:player") return;
      if (!isCannon(heldItem(p, null))) return;
      handleDiscard(p);
    });
  }
});


// 主砲の直撃: 中心付近の敵対モブに装甲無視の大ダメージ (星炉ウィザーにも通る)
function strikeEnemies(s, center, r, dmg) {
  try {
    for (const e of s.dim.getEntities({ location: center, maxDistance: r, excludeTypes: ["minecraft:player", "minecraft:item", "minecraft:xp_orb", "minecraft:tnt"] })) {
      try {
        if (e.getComponent("minecraft:tameable")?.isTamed || !e.getComponent("minecraft:health") || e.matches({ families: ["orbital_foundry_pet"] })) continue;
        if (!e.matches({ families: ["monster"] }) && !e.matches({ families: ["orbital_foundry_boss"] })) continue;
        if (isBoss(e)) hurtBoss(e, s.shooter, dmg, center); else damageTarget(e, s.shooter, dmg, center);
      } catch (err) { }
    }
  } catch (err) { }
}
try {
  system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
    itemComponentRegistry.registerCustomComponent("orbital_foundry:strike_designator", { onUse: ({ source: p }) => { if (p?.typeId === "minecraft:player") system.run(() => handleRightClick(p)); } });
  });
} catch (e) { }
tryRun(() => {
  const evs = world.afterEvents;
  evs.entityHitBlock?.subscribe(ev => { const p = ev.damagingEntity; if (p?.typeId === "minecraft:player" && isCannon(heldItem(p, null))) handleDiscard(p); });
  evs.entityHitEntity?.subscribe(ev => { const p = ev.damagingEntity; if (p?.typeId === "minecraft:player" && isCannon(heldItem(p, null))) handleDiscard(p); });
});
return {};
}
