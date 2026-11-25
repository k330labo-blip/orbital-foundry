// 「オーバーシア降下迎撃」作戦
// 起動核 → 迎撃地点に赤い光と30秒の準備 → ワープホールからオーバーシア出現 (高度60) → 一定の速さで3分かけて地上30の敗北ラインへ降下。
// 翼を片方壊すごとに8秒降下が止まる。炉心は 閉 (高空) → 砲撃後に開く (中盤) → 開きっぱなし+ビーム (終盤)。
import { EntityDamageCause, MolangVariableMap, ItemStack } from "@minecraft/server";
const gunHud = { lines: new Map() };   // 旧・自前銃の HUD (削除済み)
import { NS } from "./config.js";

const id = n => `${NS}:${n}`;
export const RAID = {
  prepSec: 30, startAlt: 60, failAlt: 30,   // 本体の中心が地上30に達したら迎撃失敗 (垂れた触手がちょうど地面に届く高さ)
 
  portalAlt: 74, portalOpenAt: 14, emergeSec: 6, portalLinger: 7,   // 準備の残り14秒でワープホールが開き、そこから6秒かけて本体がくぐり出る
  descentSec: 180, wingPauseSec: 5,   // 翼1枚ごとに5秒停止 (6枚で最大30秒)
  phase2At: 120, phase3At: 45,                 // 衝突までの残り秒
  baseHp: 9000, perExtraPlayerPct: 0, perRankPct: .12,   // 人数によらず同じHP
  wingHpPct: .07,                              // 翼1枚の耐久 = 本体HPの7% (左右3段ずつ、計6枚)
  closedPass: .15,                             // 閉じた炉心・装甲環に当てたときの通り
  // 攻撃は降下が進むほど激しくなる (高空 → 地上寸前で 間隔が縮み、数が増える)。防具なしなら一撃で倒れる威力
  barrageEvery: [14, 5], barrageWarnSec: 2.2, barrageRadius: 5, barrageDamage: 24, openSec: 6,
  beamEvery: [9, 3.5], beamWarnSec: 1.4, beamSweepSec: 2.2, beamHalfWidth: 2.4, beamDamage: 22,
  impactKillRadius: 50,                        // 地上到達時、半径50ブロックのプレイヤーは即死
  range: 140,
};
// 降下は時間で決める: 最初は速く、地上に近づくほどゆっくり (ちょうど3分で敗北ライン)
// 遠近の見せかけ: 本体は描画距離に収まる高さ (VIS_MAX) までしか上げず、本当の高度との比で縮めて表示する。
// 真下から見た見かけの大きさは、本当の高さにある実寸の要塞と同じになる。降りてきて VIS_MAX を切ると実寸。
const VIS_MAX = 1e9;   // 縮小表示はやめた (常に実寸)
const visK = s => { const a = Math.max(1, s.alt ?? RAID.startAlt); return Math.min(1, VIS_MAX / a); };
const ease = u => Math.max(0, Math.min(1, u));   // 降下は一定の速さ: ちょうど3分で敗北ラインへ
// 当たり判定の形 (ブロック単位、本体中心が原点。モデル1px=0.25ブロック)
// モデルは 6倍表示 (1px = 0.375ブロック)。翼端まで片側約75ブロック
// 翼は左右に3段 (下段・中段・上段)。下から撃つと下段から順に当たり、壊すと上の段が狙える
const WINGS = ["e0", "e1", "e2", "w0", "w1", "w2"];
const TIER = [{ y: -4, out: 58, depth: 9 }, { y: 0, out: 70, depth: 12 }, { y: 4, out: 76, depth: 14 }];
const SHAPE = { coreY: -3, coreR: 9, ringR: 16.5, ringHalf: 3, wingIn: 16, wingDepth: (x, tier) => 3 + TIER[tier].depth * Math.sin(Math.PI * Math.min(1, Math.max(0, (x - 16) / (TIER[tier].out - 16)))) };
const lerp = ([a, b], k) => a + (b - a) * Math.max(0, Math.min(1, k));

export function installOverseerRaid(ctx) {
  const { world, system, read, write, giveItems, countItem, removeItems, toast, pSet, rank, research, rocketStage, C } = ctx;
  const KEY = "of:boss";
  const now = () => Date.now() / 1000;
  const particle = (dim, name, at, vars) => { try { dim.spawnParticle(name.includes(":") ? name : id(name), at, vars); } catch {} };
  const sound = (dim, name, at, volume = 1, pitch = 1) => { try { dim.playSound(name, at, { volume, pitch }); } catch {} };
  const mv = o => { const m = new MolangVariableMap(); for (const [k, v] of Object.entries(o)) m.setFloat(`variable.${k}`, v); return m; };
  const groundY = (dim, x, z, fallback) => { try { const b = dim.getTopmostBlock({ x, z }); if (b) return b.location.y + 1; } catch {} return fallback; };
  const playersNear = (dim, at, r = RAID.range) => { try { return dim.getPlayers({ location: at, maxDistance: r }); } catch { return []; } };
  const setProp = (e, k, v) => { try { if (e.getProperty(id(k)) !== v) e.setProperty(id(k), v); } catch {} };
  const remaining = s => Math.max(0, RAID.descentSec - (s.elapsed ?? 0));
  const phaseOf = s => { const t = remaining(s); return t > RAID.phase2At ? 1 : t > RAID.phase3At ? 2 : 3; };
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  // ---------------- 開始 ----------------
  function hpFor(dim, at, p) {
    const players = Math.max(1, Math.min(4, playersNear(dim, at, 64).length));
    return Math.floor(RAID.baseHp * (1 + RAID.perExtraPlayerPct * (players - 1)) * (1 + RAID.perRankPct * rank(p)));
  }
  function begin(p, at, debugEntity, term, prepOverride) {
    const dim = p.dimension, gy = groundY(dim, at.x, at.z, Math.floor(at.y));
    const point = { x: Math.floor(at.x) + .5, y: gy, z: Math.floor(at.z) + .5 };
    const max = hpFor(dim, point, p);
    const s = { status: "prep", dim: dim.id, at: point, owner: p.id, rank: rank(p), hp: max, max, wingMax: Math.floor(max * RAID.wingHpPct),
      wings: Object.fromEntries(WINGS.map(w => [w, Math.floor(max * RAID.wingHpPct)])), startAlt: Math.max(RAID.failAlt + 20, Math.min(RAID.startAlt, 290 - gy - 25)), alt: Math.max(RAID.failAlt + 20, Math.min(RAID.startAlt, 290 - gy - 25)), elapsed: 0,
      prepUntil: now() + (prepOverride ?? (debugEntity ? 3 : RAID.prepSec)), pauseUntil: 0, openUntil: 0, nextBarrage: 0, nextBeam: 0, marks: [], beam: undefined,
      contributors: {}, entity: undefined, term };
    if (debugEntity) { try { debugEntity.remove(); } catch {} }
    write(KEY, s);
    sound(dim, "beacon.activate", point, 1.4, .6);
    sound(dim, "mob.wither.spawn", point, .5, .55);
    for (const pl of playersNear(dim, point)) pl.onScreenDisplay.setTitle("§c§l降下警報", { subtitle: "§fオーバーシア接近 · 迎撃準備 30秒", fadeInDuration: 5, stayDuration: 50, fadeOutDuration: 10 });
    return true;
  }
  // fromTerminal: 防衛端末の「オーバーシア戦」。起動核があれば端末の真上を迎撃地点にして始める
  function summon(p, at0, fromTerminal = false, terminal, debug = false) {
    if (debug) {   // デバッグ: 起動核・研究なしで、準備8秒からすぐ始める
      clearStale(p);
      if (read(KEY)) return toast(p, "すでにオーバーシア迎撃作戦が進行中");
      if (terminal && defense) { const err = defense.startOverseerOp(terminal, p); if (err) return toast(p, err); }
      begin(p, at0, undefined, terminal?.key, 8);
      return toast(p, "§e[デバッグ] オーバーシア戦を開始 · 8秒後に出現");
    }
    if (!fromTerminal && rocketStage(p) < 4) return toast(p, "自分の軌道便の貨物を回収してください");
    if (!fromTerminal && research && !research.isUnlocked("orbital_industry", p)) return toast(p, "軌道産業の研究が必要です");
    clearStale(p);
    if (read(KEY)) return toast(p, "すでにオーバーシア迎撃作戦が進行中");
    if (!countItem(p, id("activation_core"))) return toast(p, "起動核が必要です");
    const v = p.getViewDirection(), h = Math.hypot(v.x, v.z) || 1;
    const at = at0 ?? { x: p.location.x + v.x / h * 8, y: p.location.y, z: p.location.z + v.z / h * 8 };
    // 端末から始めると、その端末で地上部隊の作戦も動かす (入口や出現地点の条件は防衛作戦と同じ)
    if (terminal && defense) { const err = defense.startOverseerOp(terminal, p); if (err) return toast(p, err); }
    if (!removeItems(p, id("activation_core"), 1)) { if (terminal && defense) defense.stopOverseerOp(terminal.key); return; }
    begin(p, at, undefined, terminal?.key);
    if (!terminal) toast(p, "§7防衛端末から始めると、地上部隊も押し寄せる本番の迎撃戦になります");
  }
  // デバッグ用スポーンエッグ: 卵を使った位置で作戦を始める (準備は3秒)
  function adopt(e, p) {
    clearStale(p);
    if (read(KEY)) { try { e.remove(); } catch {} toast(p, "すでにオーバーシア迎撃作戦が進行中"); return false; }
    return begin(p, e.location, e);
  }
  function abort(p) {
    const s = read(KEY);
    if (!s || (s.owner && s.owner !== p.id)) return false;
    bgmStop(); removeBody(s); clearWave(s); write(KEY, undefined);
    giveItems(p, id("activation_core"), 1);
    toast(p, "迎撃作戦を中止し、起動核を返却しました");
    return true;
  }
  function clearStale(p) {
    const s = read(KEY);
    if (!s || s.status === "prep") return false;
    let e; try { e = s.entity && world.getEntity(s.entity); } catch {}
    if (e) return false;
    // 本体のチャンクが読み込まれているのに本体がいない → 記録だけ残っている
    try { if (!world.getDimension(s.dim).getBlock(s.at)) return false; } catch { return false; }
    write(KEY, undefined);
    if (!s.owner || s.owner === p.id) { giveItems(p, id("activation_core"), 1); toast(p, "オーバーシアが見つからないため作戦記録を消去し、起動核を返却しました"); }
    return true;
  }
  function removeBody(s) { try { const e = s.entity && world.getEntity(s.entity); e?.remove(); } catch {} removePortal(s); }

  // ---------------- 当たり判定 (銃から呼ぶ) ----------------
  // 光線とオーバーシアの各部位の交差。最も近い部位を返す: core / armor / wing_e / wing_w
  function rayTest(dim, point, dir, max) {
    const s = read(KEY);
    if (!s || s.status !== "fight" || s.dim !== dim.id) return undefined;
    let e; try { e = world.getEntity(s.entity); } catch {}
    if (!e) return undefined;
    const k = visK(s), c = e.location;
    // 縮めて表示している分、光線を本体の縮尺に直して判定する (距離は実寸に戻して返す)
    const o = { x: (point.x - c.x) / k, y: (point.y - c.y) / k - SHAPE.coreY, z: (point.z - c.z) / k };
    max = max / k;
    let best;
    const take = (t, part) => { if (t >= 0 && t <= max && (!best || t * k < best.distance)) best = { entity: e, distance: t * k, part }; };
    // 球 (炉心)
    const sphere = r => { const b = o.x * dir.x + o.y * dir.y + o.z * dir.z, cc = o.x * o.x + o.y * o.y + o.z * o.z - r * r, D = b * b - cc; return D < 0 ? -1 : -b - Math.sqrt(D) >= 0 ? -b - Math.sqrt(D) : -b + Math.sqrt(D); };
    const open = isOpen(s);
    const tc = sphere(SHAPE.coreR); if (tc >= 0) take(tc, open ? "core" : "armor");
    // 水平の板 (装甲環と翼) は y=0 面との交点で判定
    if (Math.abs(dir.y) > 1e-4) {
      for (const plane of [-SHAPE.ringHalf, 0, SHAPE.ringHalf]) {
        const t = (plane - o.y) / dir.y; if (t < 0 || t > max) continue;
        const x = o.x + dir.x * t, z = o.z + dir.z * t, r = Math.hypot(x, z);
        if (r <= SHAPE.ringR && !s.ringOff) take(t, open && r < SHAPE.coreR ? "core" : "armor");
      }
      TIER.forEach((tier, i) => {
        const t = (tier.y - SHAPE.coreY - o.y) / dir.y; if (t < 0 || t > max) return;
        const x = o.x + dir.x * t, z = o.z + dir.z * t, ax = Math.abs(x);
        const w = (x > 0 ? "e" : "w") + i;
        if (ax >= SHAPE.wingIn && ax <= tier.out && Math.abs(z) <= SHAPE.wingDepth(ax, i) && s.wings[w] > 0) take(t, "wing_" + w);
      });
    }
    return best;
  }
  const isOpen = s => s.ringOff || now() < (s.openUntil ?? 0);

  // ---------------- ダメージ ----------------
  function hurt(entity, player, amount, part = "armor") {
    if (entity?.typeId !== id("overseer") || player?.typeId !== "minecraft:player") return;
    const s = read(KEY);
    if (!s || s.status !== "fight" || s.entity !== entity.id) return;
    const dim = entity.dimension, c = entity.location;
    s.contributors[player.id] = (s.contributors[player.id] ?? 0) + amount;
    flashHurt(entity, player);
    if (part?.startsWith("wing_")) {
      const k = part.slice(5);
      if (!(s.wings[k] > 0)) return;
      s.wings[k] = Math.max(0, s.wings[k] - amount);
      const vk = visK(s); particle(dim, "overseer_sparks", { x: c.x + (k[0] === "e" ? 30 : -30) * vk, y: c.y + TIER[+k[1]].y * vk, z: c.z });
      if (s.wings[k] <= 0) breakWing(s, entity, k);
      write(KEY, s); return;
    }
    const pass = part === "pierce" || (part === "core" && isOpen(s)) ? 1 : RAID.closedPass;   // pierce: 装甲を無視する武器 (四連自律砲など)
    s.hp = Math.max(0, s.hp - amount * pass);
    const vk = visK(s);
    if (pass < 1) particle(dim, "armor_ping", { x: c.x, y: c.y - 9 * vk, z: c.z });
    else particle(dim, "overseer_flare", { x: c.x, y: c.y - 11 * vk, z: c.z }, mv({ size: 5 * vk }));
    if (s.hp <= 0) { victory(s, entity); return; }
    write(KEY, s);
  }
  // ゲリラアドオン等の武器による被弾: 体力を戻してから作戦HPへ反映 (炉心が開いていれば炉心扱い)
  world.afterEvents.entityHurt.subscribe(({ hurtEntity: e, damage, damageSource }) => {
    if (e?.typeId !== id("overseer")) return;
    try {
      const s = read(KEY); if (!s || s.entity !== e.id) return;
      let p = damageSource.damagingEntity;
      if (p?.typeId !== "minecraft:player") { try { p = e.dimension.getPlayers({ location: e.location, maxDistance: 400, closest: 1 })[0]; } catch {} }
      e.getComponent("minecraft:health")?.setCurrentValue(Math.max(1, Math.round(100000 * s.hp / s.max)));
      if (p) hurt(e, p, damage, isOpen(s) ? "core" : "armor");
    } catch {}
  });
  // 被弾表示: バニラのモブと同じく赤く光り、エンダードラゴンの被弾音を鳴らす
  let hurtUntil = 0;
  function flashHurt(e, player) {
    setProp(e, "hurt", true);
    try { const c = e.location; particle(e.dimension, "aura_flash", { x: c.x, y: c.y + 8.5, z: c.z }, mv({ size: 20 + Math.random() * 60, hot: 1 })); } catch {}
    hurtUntil = system.currentTick + 6;
    system.runTimeout(() => { try { if (system.currentTick >= hurtUntil && e.isValid) setProp(e, "hurt", false); } catch {} }, 7);
    try { player.playSound("mob.enderdragon.hit", { volume: 1, pitch: .9 + Math.random() * .2 }); } catch {}
    sound(e.dimension, "mob.enderdragon.hit", e.location, 4, .8);
  }
  function breakWing(s, e, w) {
    const dim = e.dimension, c = e.location, sx = w[0] === "e" ? 1 : -1;
    setProp(e, `w_${w}`, true);
    for (let k = 0; k < 8; k++) {
      const vk = visK(s), at = { x: c.x + sx * (18 + k * 7) * vk, y: c.y + TIER[+w[1]].y * vk, z: c.z + (Math.random() - .5) * 20 * vk };
      system.runTimeout(() => { particle(dim, "overseer_wing_burst", at); particle(dim, "overseer_debris", at); sound(dim, "random.explode", at, 2.2, .6 + k * .05); }, k * 3);
    }
    sound(dim, "mob.enderdragon.growl", c, 3, .5);
    // 傾いて姿勢を立て直す間、降下が8秒止まる (2枚で最大16秒)
    s.pauseUntil = Math.max(now(), s.pauseUntil ?? 0) + RAID.wingPauseSec;
    s.rollTarget = sx * 22; s.rollUntil = now() + RAID.wingPauseSec * .6;
    for (const pl of playersNear(dim, s.at)) pl.onScreenDisplay.setTitle(" ", { subtitle: `§6制動翼を破壊！ §f(残り${WINGS.filter(x => s.wings[x] > 0).length}/6) 機体が傾いた · 降下停止 +${RAID.wingPauseSec}秒`, fadeInDuration: 2, stayDuration: 40, fadeOutDuration: 8 });
  }

  // ---------------- 勝敗 ----------------
  function victory(s, e) {
    s.status = "dying"; s.dyingAt = now(); write(KEY, s);
    const dim = e.dimension;
    setProp(e, "dying", true); setProp(e, "core_open", true);
    sound(dim, "mob.wither.death", e.location, 4, .5);
    for (const pl of playersNear(dim, s.at)) pl.onScreenDisplay.setTitle("§d§l炉心破壊", { subtitle: "§f巨体が崩れ落ちる...", fadeInDuration: 2, stayDuration: 50, fadeOutDuration: 10 });
    // 内側から割れる炉心
    for (let i = 0; i < 6; i++) system.runTimeout(() => { try { const c = e.location; particle(dim, "overseer_core_burst", { x: c.x, y: c.y - 6, z: c.z }); particle(dim, "overseer_flare", { x: c.x, y: c.y - 8, z: c.z }, mv({ size: 12 + i * 4 })); sound(dim, "random.glass", c, 2, .4 + i * .08); } catch {} }, i * 5);
  }
  function finishVictory(s, e) {
    bgmFadeOut();
    for (const pl of world.getAllPlayers()) try { if (pl.dimension.id === s.dim) pl.playSound("mob.enderdragon.death", { volume: 1 }); } catch {}
    const dim = world.getDimension(s.dim), g = { x: s.at.x, y: s.at.y + 1, z: s.at.z };
    removeBody(s); write(KEY, undefined);
    for (let i = 0; i < 10; i++) {
      const at = { x: g.x + (Math.random() - .5) * 90, y: g.y + Math.random() * 6, z: g.z + (Math.random() - .5) * 40 };
      system.runTimeout(() => { particle(dim, "overseer_debris", at); particle(dim, "overseer_blast", at); particle(dim, "minecraft:huge_explosion_emitter", at); sound(dim, "random.explode", at, 3, .55); }, i * 2);
    }
    particle(dim, "overseer_shock", g);
    sound(dim, "random.totem", g, 1, .7);
    // 報酬は地面に残る: 特異炉心 (特異点コア) と強化コア
    try { dim.spawnItem(new ItemStack(id("singularity_core"), 1), g); dim.spawnItem(new ItemStack(id("enhancement_core"), C.bossReward), g); } catch {}
    try { world.setDynamicProperty("of:design_overseer", true); } catch {}   // 銃の専用改造の設計
    const ids = new Set(Object.keys(s.contributors ?? {})); if (s.owner) ids.add(s.owner);
    for (const pl of world.getAllPlayers()) if (ids.has(pl.id)) { pSet(pl, "of:boss_rank", rank(pl) + 1); pl.onScreenDisplay.setTitle("§a§l迎撃成功", { subtitle: "§f特異点コアと強化コアを回収せよ", fadeInDuration: 5, stayDuration: 60, fadeOutDuration: 15 }); }
  }
  // 防衛端末が地上部隊に落とされた: その場で迎撃失敗
  function terminalLost(s, e) {
    bgmStop();
    const dim = e.dimension;
    write(KEY, undefined);
    try { e.remove(); } catch {} removePortal(s);
    sound(dim, "mob.wither.death", s.at, 3, .4);
    for (const pl of playersNear(dim, s.at)) pl.onScreenDisplay.setTitle("§c§l迎撃失敗", { subtitle: "§f防衛端末が地上部隊に落とされた · 起動核で再挑戦できる", fadeInDuration: 3, stayDuration: 70, fadeOutDuration: 20 });
  }
  function defeat(s, e) {
    bgmStop();
    s.status = "impact"; s.impactAt = now(); write(KEY, s);
    const dim = e.dimension, g = { x: s.at.x, y: s.at.y + 1, z: s.at.z };
    // 地面すれすれで白い閃光 → 一瞬の無音 → 衝撃波 → 迎撃失敗
    for (const pl of playersNear(dim, g, 160)) {
      try { pl.runCommand("camera @s fade time 0.15 0.7 1.2 color 255 255 255"); } catch {}
      try { pl.runCommand("stopsound @s"); } catch {}
    }
    system.runTimeout(() => {
      removeBody(s);
      particle(dim, "overseer_shock", g); particle(dim, "overseer_blast", g); particle(dim, "minecraft:huge_explosion_emitter", g);
      for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, r = 10 + (i % 3) * 14; particle(dim, "overseer_debris", { x: g.x + Math.cos(a) * r, y: g.y + 1, z: g.z + Math.sin(a) * r }); particle(dim, "overseer_blast", { x: g.x + Math.cos(a) * r, y: g.y + 1, z: g.z + Math.sin(a) * r }); }
      clearWave(s);
      sound(dim, "random.explode", g, 6, .35); sound(dim, "ambient.weather.thunder", g, 4, .5);
      for (const pl of playersNear(dim, g, 160)) {
        const d = Math.hypot(pl.location.x - g.x, pl.location.z - g.z);
        try { pl.applyKnockback({ x: (pl.location.x - g.x) / (d || 1) * 2.2, z: (pl.location.z - g.z) / (d || 1) * 2.2 }, .6); } catch {}
        if (Math.hypot(d, pl.location.y - g.y) <= RAID.impactKillRadius) try { pl.kill(); } catch {}
        pl.onScreenDisplay.setTitle("§c§l迎撃失敗", { subtitle: "§fオーバーシアが地上に到達した · 工場は無事。起動核で再挑戦できる", fadeInDuration: 3, stayDuration: 80, fadeOutDuration: 20 });
      }
      write(KEY, undefined);
    }, 18);
  }


  // ---------------- BGM ----------------
  // 最初からいる人: 1曲まるごと再生 (継ぎ目なし)
  // 途中から来た人: 1秒刻みの切れ端で位置を合わせてフェードイン → 10秒刻みの切れ端に乗り換え
  // クリア時: 次の1秒の区切りで1秒刻みに切り替えてフェードアウト
  const BGM = { range: 260, fadeIn: 6, fadeOut: 8, volume: .7, fine: 200, coarse: 20 };
  let bgm;
  const SND = n => `orbital_foundry.overseer_bgm.${n}`;
  function bgmStart(players) {
    bgm = { start: system.currentTick, ending: false, who: new Map() };
    for (const p of players) {
      bgm.who.set(p.id, { vol: 1, initial: true, mode: "full", playing: "full" });
      try { p.playSound(SND("full"), { volume: BGM.volume }); } catch {}
    }
  }
  function bgmFadeOut() { if (bgm) bgm.ending = true; }
  function stopFor(p, w) { if (w.playing) try { p.runCommand(`stopsound @s ${SND(w.playing)}`); } catch {} w.playing = undefined; }
  function bgmStop() {
    if (!bgm) return;
    for (const p of world.getAllPlayers()) { const w = bgm.who.get(p.id); if (w) stopFor(p, w); }
    bgm = undefined;
  }
  function bgmTick() {
    if (!bgm) return;
    const t = system.currentTick - bgm.start;
    if (t % 20 !== 0) return;
    const sec = t / 20;
    if (sec >= BGM.fine) { bgm = undefined; return; }
    const s = read(KEY);
    if (!s && !bgm.ending) { bgmStop(); return; }
    let center;
    try { const e = s?.entity && world.getEntity(s.entity); center = e?.location; } catch {}
    if (!center && s?.at) center = s.at;
    let any = false;
    for (const p of world.getAllPlayers()) {
      let w = bgm.who.get(p.id);
      const near = center && p.dimension.id === (s?.dim ?? p.dimension.id) && Math.hypot(p.location.x - center.x, p.location.y - center.y, p.location.z - center.z) <= BGM.range;
      if (!w && !near) continue;
      if (!w) { w = { vol: 0, initial: false, mode: "fine" }; bgm.who.set(p.id, w); }
      const leaving = bgm.ending || (!w.initial && !near);
      // フェードアウトが必要になったら、1曲再生・10秒刻みから1秒刻みへ切り替える
      if (leaving && w.mode !== "fine") { stopFor(p, w); w.mode = "fine"; }
      if (w.mode === "fine") {
        w.vol = leaving ? Math.max(0, w.vol - 1 / BGM.fadeOut) : Math.min(1, w.vol + 1 / BGM.fadeIn);
        if (!leaving && w.vol >= 1 && sec % 10 === 0 && sec / 10 < BGM.coarse) {
          w.mode = "coarse"; w.playing = "c" + sec / 10;
          try { p.playSound(SND(w.playing), { volume: BGM.volume }); } catch {}
        } else if (w.vol > .01) {
          w.playing = "f" + sec;
          try { p.playSound(SND(w.playing), { volume: w.vol * BGM.volume }); } catch {}
        } else w.playing = undefined;
      } else if (w.mode === "coarse" && sec % 10 === 0 && sec / 10 < BGM.coarse) {
        w.playing = "c" + sec / 10;
        try { p.playSound(SND(w.playing), { volume: BGM.volume }); } catch {}
      }
      if (w.vol > .01 || w.mode !== "fine") any = true;
    }
    if (bgm.ending && !any) bgm = undefined;
  }
  // ---------------- 毎ティック ----------------
  system.runInterval(() => { try { bgmTick(); } catch {} try { tick(); } catch (err) { console.warn(`[Orbital Foundry] overseer raid: ${err}`); } }, 1);
  let hudTick = 0;
  function tick() {
    const s = read(KEY);
    if (!s || !s.status) return;
    let dim; try { dim = world.getDimension(s.dim); } catch { return; }
    const t = now(), players = playersNear(dim, s.at);
    if (!players.length) { if (!s.frozenAt) { s.frozenAt = t; write(KEY, s); } return; }   // 誰もいない間は止める
    if (s.frozenAt) { const dt = t - s.frozenAt; for (const k of ["prepUntil", "pauseUntil", "openUntil", "nextBarrage", "nextBeam", "rollUntil"]) if (s[k]) s[k] += dt; s.frozenAt = undefined; }
    if (s.status === "prep") return tickPrep(s, dim, t, players);
    let e; try { e = s.entity && world.getEntity(s.entity); } catch {}
    if (!e) {
      if (s.status === "fight" || s.status === "dying") {
        // 本体を (再) 出現させる
        try { e = dim.spawnEntity(id("overseer"), { x: s.at.x, y: s.at.y + Math.min(s.alt, VIS_MAX), z: s.at.z }); s.entity = e.id; e.nameTag = ""; } catch { return; }
      } else return;
    }
    if (s.status === "impact") return;
    if (s.status === "fight" && s.term && defense && !defense.overseerOpState(s.term).active) { terminalLost(s, e); return; }
    if (s.status === "dying") {
      // 落ちてきた巨体が地上寸前で崩れる
      const k = Math.min(1, (t - s.dyingAt) / 3), a0 = Math.min(s.alt, VIS_MAX), y = s.at.y + a0 - (a0 - 6) * k * k;
      try { e.teleport({ x: s.at.x, y, z: s.at.z }, { rotation: { x: 0, y: 0 } }); } catch {}
      if (system.currentTick % 3 === 0) particle(dim, "overseer_debris", { x: s.at.x + (Math.random() - .5) * 30, y: y, z: s.at.z + (Math.random() - .5) * 10 });
      if (k >= 1) { clearWave(s); finishVictory(s, e); }
      return;
    }
    // 降下 (翼破壊の立て直し中は止まる)
    const paused = t < (s.pauseUntil ?? 0);
    if (!paused) s.elapsed = Math.min(RAID.descentSec, (s.elapsed ?? 0) + .05);
    const u = (s.elapsed ?? 0) / RAID.descentSec;
    s.alt = (s.startAlt ?? RAID.startAlt) - ((s.startAlt ?? RAID.startAlt) - RAID.failAlt) * ease(u);
    const phase = phaseOf(s);
    // 傾き: 翼を壊した側へ傾いて、立て直す
    const target = t < (s.rollUntil ?? 0) ? s.rollTarget : 0;
    s.roll = (s.roll ?? 0) + (target - (s.roll ?? 0)) * .06;
    const bob = Math.sin(t * 1.3) * .25;
    const vk = visK(s);
    let y = s.at.y + Math.min(s.alt, VIS_MAX) + bob * vk;
    if (t < (s.emergeUntil ?? 0)) {   // ワープホールをくぐり抜ける
      const k = 1 - (s.emergeUntil - t) / RAID.emergeSec, lift = RAID.portalAlt - RAID.startAlt;
      y = s.at.y + s.alt + lift * (1 - (1 - Math.pow(1 - k, 3)));
      if (system.currentTick % 5 === 0) { particle(dim, "overseer_debris", { x: s.at.x + (Math.random() - .5) * 60, y: y + 6, z: s.at.z + (Math.random() - .5) * 30 }); particle(dim, "portal_rain", { x: s.at.x, y: y + 10, z: s.at.z }, mv({ size: 60 })); }
    }
    try { e.teleport({ x: s.at.x, y, z: s.at.z }, { rotation: { x: 0, y: 0 } }); } catch {}
    tickPortal(s, dim);
    if (system.currentTick % 2 === 0) setProp(e, "vscale", Math.round(vk * 1000) / 1000);
    if (system.currentTick % 2 === 0) setProp(e, "roll", Math.round(s.roll * 10) / 10);
    const frac = u;   // 攻撃の激しさ・赤熱は経過時間で上がる
    setProp(e, "heat", frac > .72 ? 2 : frac > .38 ? 1 : 0);
    for (const w of WINGS) setProp(e, `w_${w}`, !(s.wings[w] > 0));
    // 画面上のボスゲージ: 本体の体力 (1000) を作戦のHPの割合に合わせる
    if (system.currentTick % 4 === 0) try {
      e.getComponent("minecraft:health")?.setCurrentValue(Math.max(1, Math.round(100000 * s.hp / s.max)));
      if (e.nameTag !== "§5オーバーシア") e.nameTag = "§5オーバーシア";
    } catch {}
    if (phase === 3 && !s.ringOff) peelRing(s, e);
    setProp(e, "core_open", isOpen(s));
    setProp(e, "ring_off", !!s.ringOff);
    effects(s, e, dim, frac, t);
    skyFx(s, dim, frac);
    s.frac = frac;
    if (phase >= 2 && t >= (s.nextBarrage ?? 0) && !s.marks?.length) startBarrage(s, dim, players, t);
    tickBarrage(s, e, dim, t);
    if (phase === 3 && t >= (s.nextBeam ?? 0) && !s.beam) startBeam(s, dim, players, t);
    tickBeam(s, e, dim, t);
    spawnWave(s, dim, players, t);
    if (++hudTick % 4 === 0) hud(s, players, paused, phase);
    if ((s.elapsed ?? 0) >= RAID.descentSec) { defeat(s, e); return; }
    write(KEY, s);
  }
  function tickPrep(s, dim, t, players) {
    if (system.currentTick % 20 === 0) { particle(dim, "overseer_beacon", s.at); sound(dim, "note.bass", s.at, 1.2, .5); }
    if (system.currentTick % 4 === 0) {
      const left = Math.ceil(s.prepUntil - t);
      for (const pl of players) pl.onScreenDisplay.setActionBar(`§c迎撃準備 ${left}秒§r · 弾を込めて空を見上げろ`);
    }
    const left = s.prepUntil - t, portalY = s.at.y + s.alt + (RAID.portalAlt - RAID.startAlt);
    const sky = { x: s.at.x, y: portalY, z: s.at.z };
    if (left <= RAID.portalOpenAt && !s.portal) openPortal(s, dim, sky, players);
    if (s.portal) { portalFx(s, dim, sky, left); skyFx(s, dim, 0); }
    if (t < s.prepUntil) { if (s.portal) write(KEY, s); return; }
    // ワープホールの中から本体が現れる (6秒かけてくぐり抜け、そこから降下が始まる)
    const e = dim.spawnEntity(id("overseer"), sky);
    s.entity = e.id; s.status = "fight"; s.nextBarrage = 0;
    s.emergeUntil = t + RAID.emergeSec; s.pauseUntil = s.emergeUntil; s.portalCloseAt = s.emergeUntil + RAID.portalLinger;
    write(KEY, s);
    bgmStart(playersNear(dim, s.at, BGM.range));
    particle(dim, "portal_shock", sky, mv({ size: 260 })); particle(dim, "overseer_flare", sky, mv({ size: 60 }));
    sound(dim, "mob.enderdragon.growl", s.at, 6, .35); sound(dim, "ambient.weather.thunder", s.at, 5, .5); sound(dim, "mob.wither.spawn", s.at, 3, .4);
    for (const pl of players) try { pl.runCommand("camera @s shake add 0.6 4 positional"); } catch {}
    for (const pl of players) pl.onScreenDisplay.setTitle("§5§lオーバーシア 出現", { subtitle: "§f制動翼を撃てば降下を遅らせられる", fadeInDuration: 5, stayDuration: 50, fadeOutDuration: 15 });
  }
  // ---- ワープホール ----
  function openPortal(s, dim, sky, players) {
    try { const p = dim.spawnEntity(id("overseer_portal"), sky); s.portal = p.id; p.setProperty(id("phase"), 1); } catch { s.portal = "none"; }
    sound(dim, "mob.endermen.portal", s.at, 6, .3); sound(dim, "beacon.activate", s.at, 4, .35); sound(dim, "ambient.weather.thunder", s.at, 4, .7);
    particle(dim, "portal_shock", sky, mv({ size: 200 }));
    for (const pl of players) {
      pl.onScreenDisplay.setTitle("§d§l空間歪曲", { subtitle: "§f上空にワープホール · 何かが来る", fadeInDuration: 4, stayDuration: 50, fadeOutDuration: 10 });
      try { pl.runCommand("camera @s shake add 0.25 6 positional"); } catch {}
    }
    system.runTimeout(() => { try { world.getEntity(s.portal)?.setProperty(id("phase"), 2); } catch {} }, 100);
  }
  function portalFx(s, dim, sky, left) {
    const k = system.currentTick;
    if (k % 6 === 0) particle(dim, "portal_inflow", sky, mv({ size: 70 + Math.random() * 25 }));
    if (k % 10 === 0) particle(dim, "portal_rain", { x: sky.x, y: sky.y - 2, z: sky.z }, mv({ size: 45 }));
    if (k % 3 === 0) {   // 縁を走る稲妻
      const a = Math.random() * Math.PI * 2, r = 80 + Math.random() * 18;
      particle(dim, "portal_arc", { x: sky.x + Math.cos(a) * r, y: sky.y, z: sky.z + Math.sin(a) * r }, mv({ len: 6 + Math.random() * 10 }));
    }
    if (k % 30 === 0) { sound(dim, "ambient.weather.thunder", sky, 3, .6 + Math.random() * .3); particle(dim, "portal_shock", sky, mv({ size: 120 })); }
    if (k % 40 === 0) sound(dim, "portal.portal", s.at, 4, .4);
    // 最後の5秒: 中心が白く膨らみ、地鳴りが強まる
    if (left !== undefined && left < 5 && k % 4 === 0) { particle(dim, "overseer_flare", sky, mv({ size: 20 + (5 - left) * 10 })); sound(dim, "random.fizz", s.at, 3, .3); }
  }
  function tickPortal(s, dim) {
    if (!s.portal || s.portal === "none") return;
    let p; try { p = world.getEntity(s.portal); } catch {}
    const t = now(), sky = p?.location;
    if (sky && t < (s.portalCloseAt ?? 0)) portalFx(s, dim, sky);
    if (p && t >= (s.portalCloseAt ?? Infinity) && !s.portalClosing) {
      s.portalClosing = true; setPortalPhase(p, 3);
      sound(dim, "beacon.deactivate", s.at, 5, .4); sound(dim, "mob.endermen.portal", s.at, 5, .5);
      system.runTimeout(() => { try { particle(dim, "portal_shock", p.location, mv({ size: 180 })); p.remove(); } catch {} }, 52);
    }
  }
  const setPortalPhase = (p, v) => { try { p.setProperty(id("phase"), v); } catch {} };
  function removePortal(s) { try { if (s.portal && s.portal !== "none") world.getEntity(s.portal)?.remove(); } catch {} }

  function effects(s, e, dim, frac, t) {
    const c = e.location, gy = s.at.y, vk = visK(s);
    // 背後の干渉紋: 同心円の波紋が絶えず広がり、光の粒が立ちのぼる。露出中・終盤ほど速く強く
    const hot = isOpen(s) ? 1 : 0, top = { x: c.x, y: c.y + 8.5, z: c.z };
    const every = hot ? 10 : Math.round(30 - 14 * frac);
    if (system.currentTick % every === 0) particle(dim, "aura_ripple", top, mv({ size: 175 + 30 * Math.random(), hot }));
    if (system.currentTick % 7 === 0) particle(dim, "aura_motes", top, mv({ size: 30 + Math.random() * 55, hot }));
    if (system.currentTick % (hot ? 3 : 9) === 0) particle(dim, "aura_flash", top, mv({ size: [20, 29, 39, 50, 61, 74, 87][Math.floor(Math.random() * 7)], hot }));
    // 地面の影: 降りてくるほど濃く広がる
    if (system.currentTick % 8 === 0) {
      const size = 40 + 120 * frac;
      for (const [dx, dz] of [[0, 0], [-size * .35, 0], [size * .35, 0]]) particle(dim, "overseer_shadow", { x: s.at.x + dx, y: gy + .05, z: s.at.z + dz }, mv({ size: dx ? size * .55 : size * .7 }));
    }
    // 赤熱した継ぎ目から火花が落ちる
    if (frac > .38 && system.currentTick % (frac > .72 ? 3 : 6) === 0) {
      const sx = Math.random() < .5 ? 1 : -1;
      if (WINGS.some(w => w[0] === (sx > 0 ? "e" : "w") && s.wings[w] > 0)) particle(dim, "overseer_sparks", { x: c.x + sx * (18 + Math.random() * 55) * vk, y: c.y - .5, z: c.z + (Math.random() - .5) * 30 * vk });
    }
    // 降下の風切り音 (近づくほど大きい)
    if (system.currentTick % 40 === 0) sound(dim, "elytra.loop", { x: c.x, y: c.y - 10, z: c.z }, .6 + frac * 1.6, .5);
    if (system.currentTick % 100 === 0) sound(dim, "beacon.ambient", c, 2 + frac * 3, .5);
    if (isOpen(s) && system.currentTick % 4 === 0) particle(dim, "overseer_flare", { x: c.x, y: c.y - 11 * vk, z: c.z }, mv({ size: (6 + Math.random() * 4) * vk }));
  }
  function peelRing(s, e) {
    s.ringOff = true;
    const dim = e.dimension, c = e.location;
    for (let i = 0; i < 16; i++) {
      const vk = visK(s), a = i / 16 * Math.PI * 2, at = { x: c.x + Math.sin(a) * 13 * vk, y: c.y - 1, z: c.z + Math.cos(a) * 13 * vk };
      system.runTimeout(() => { particle(dim, "overseer_debris", at); particle(dim, "overseer_sparks", at); if (i % 4 === 0) sound(dim, "random.anvil_break", at, 2.5, .5); }, i);
    }
    for (const pl of playersNear(dim, s.at)) pl.onScreenDisplay.setTitle("§c§l装甲環 剥離", { subtitle: "§f炉心が開きっぱなし · 薙ぎ払いビームに注意", fadeInDuration: 2, stayDuration: 40, fadeOutDuration: 10 });
  }
  // 砲撃: 地上に予告円 → 着弾 → 炉心が開く
  function startBarrage(s, dim, players, t) {
    const marks = [];
    for (const pl of players.slice(0, 4)) marks.push({ x: pl.location.x, z: pl.location.z });
    for (let i = 0; i < 2 + players.length + Math.floor((s.frac ?? 0) * 8); i++) { const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 16; marks.push({ x: s.at.x + Math.cos(a) * r, z: s.at.z + Math.sin(a) * r }); }
    s.marks = marks.map(m => ({ ...m, y: groundY(dim, m.x, m.z, s.at.y) }));
    s.barrageAt = t + RAID.barrageWarnSec;
    for (const m of s.marks) { particle(dim, "overseer_mark", { x: m.x, y: m.y + .06, z: m.z }, mv({ size: RAID.barrageRadius * 2 })); particle(dim, "overseer_mark_fill", { x: m.x, y: m.y + .05, z: m.z }, mv({ size: RAID.barrageRadius * 2 })); }
    sound(dim, "block.bell.hit", s.at, 3, .5);
  }
  function tickBarrage(s, e, dim, t) {
    if (!s.marks?.length) return;
    const c = e.location;
    if (t < s.barrageAt) {
      if (system.currentTick % 6 === 0) for (const m of s.marks) particle(dim, "overseer_beam_warn", { x: m.x, y: m.y + .1, z: m.z });
      return;
    }
    for (const m of s.marks) {
      const at = { x: m.x, y: m.y + .2, z: m.z };
      particle(dim, "overseer_blast", at); particle(dim, "minecraft:large_explosion", at);
      const len = c.y - at.y; particle(dim, "overseer_beam", { x: at.x, y: at.y + len / 2, z: at.z }, mv({ len }));
      sound(dim, "random.explode", at, 2, .7);
      // 予告円の縁を踏んでいても当たる: 見た目の円 (膨らむ分を含む) + 体の幅。高さは±4ブロックまで
      const hitR = RAID.barrageRadius * 1.15 + .6;
      for (const pl of playersNear(dim, at, hitR + 4)) {
        if (Math.hypot(pl.location.x - at.x, pl.location.z - at.z) > hitR || Math.abs(pl.location.y - at.y) > 4) continue;
        try { pl.applyDamage(RAID.barrageDamage, { cause: EntityDamageCause.entityExplosion }); } catch {}
      }
    }
    s.marks = []; s.openUntil = t + RAID.openSec; s.nextBarrage = t + lerp(RAID.barrageEvery, (s.frac - .33) / .67);
    sound(dim, "random.door_open", c, 4, .3); sound(dim, "mob.wither.ambient", c, 3, .6);
    for (const pl of playersNear(dim, s.at)) pl.onScreenDisplay.setTitle(" ", { subtitle: `§d炉心が開いた！ §f${RAID.openSec}秒間 等倍ダメージ`, fadeInDuration: 0, stayDuration: 30, fadeOutDuration: 6 });
  }
  // 薙ぎ払いビーム: 地上に赤い線の予告 → 線に沿って光線が地面を掃く
  function startBeam(s, dim, players, t) {
    const target = players[Math.floor(Math.random() * players.length)].location;
    const a = Math.random() * Math.PI, half = 22;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    s.beam = { from: { x: target.x - dir.x * half, z: target.z - dir.z * half }, to: { x: target.x + dir.x * half, z: target.z + dir.z * half }, startAt: t + RAID.beamWarnSec, hit: {} };
    sound(dim, "beacon.power", s.at, 4, .5);
  }
  function tickBeam(s, e, dim, t) {
    const b = s.beam; if (!b) return;
    const lerp = k => ({ x: b.from.x + (b.to.x - b.from.x) * k, z: b.from.z + (b.to.z - b.from.z) * k });
    if (t < b.startAt) {
      // 予告線: 当たり判定と同じ幅で、中央線と両側の縁を描く
      if (system.currentTick % 3 === 0) {
        const L = Math.hypot(b.to.x - b.from.x, b.to.z - b.from.z) || 1, nx = -(b.to.z - b.from.z) / L, nz = (b.to.x - b.from.x) / L;
        for (let k = 0; k <= 1; k += 1 / 22) for (const o of [-RAID.beamHalfWidth, 0, RAID.beamHalfWidth]) {
          const p = lerp(k), x = p.x + nx * o, z = p.z + nz * o;
          particle(dim, "overseer_beam_warn", { x, y: groundY(dim, x, z, s.at.y) + .1, z });
        }
      }
      return;
    }
    const k = (t - b.startAt) / RAID.beamSweepSec;
    if (k > 1) { s.beam = undefined; s.nextBeam = t + lerp(RAID.beamEvery, (s.frac - .75) / .25); return; }
    const p = lerp(k), gy = groundY(dim, p.x, p.z, s.at.y), c = e.location;
    const mid = { x: (p.x + c.x) / 2, y: (gy + c.y - 3) / 2, z: (p.z + c.z) / 2 };
    if (system.currentTick % 2 === 0) {
      // 本体から地面へ。斜めの光線を縦の光条を並べて描く
      const oy = 11 * visK(s); for (let i = 0; i <= 10; i++) { const f = i / 10; particle(dim, "overseer_beam", { x: c.x + (p.x - c.x) * f, y: c.y - oy + (gy - c.y + oy) * f, z: c.z + (p.z - c.z) * f }, mv({ len: 6 })); }
      particle(dim, "overseer_blast", { x: p.x, y: gy + .2, z: p.z });
      void mid;
    }
    if (system.currentTick % 5 === 0) sound(dim, "random.fizz", { x: p.x, y: gy, z: p.z }, 2, .5);
    // 予告線の上にいれば当たる: 掃き始めから光線の現在地までの線分のどこかに立っていたら命中 (線の太さ + 体の幅)
    const ax = b.from.x, az = b.from.z, bx = p.x, bz = p.z, L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
    for (const pl of playersNear(dim, { x: (ax + bx) / 2, y: gy, z: (az + bz) / 2 }, Math.sqrt(L2) / 2 + RAID.beamHalfWidth + 6)) {
      if (b.hit[pl.id]) continue;
      const q = pl.location, u = Math.max(0, Math.min(1, ((q.x - ax) * (bx - ax) + (q.z - az) * (bz - az)) / L2));
      const d = Math.hypot(q.x - (ax + (bx - ax) * u), q.z - (az + (bz - az) * u));
      if (d > RAID.beamHalfWidth + .6 || Math.abs(q.y - groundY(dim, q.x, q.z, gy)) > 4) continue;
      b.hit[pl.id] = true;
      try { pl.applyDamage(RAID.beamDamage, { cause: EntityDamageCause.fire }); pl.setOnFire(3, true); } catch {}
    }
  }
  function hud(s, players, paused, phase) {
    const pct = s.hp / s.max, bars = 20, n = Math.ceil(pct * bars);
    const bar = "§d" + "|".repeat(n) + "§8" + "|".repeat(bars - n);
    const wing = side => [0, 1, 2].map(i => s.wings[side + i] > 0 ? "§7O" : "§cX").join("");
    const state = paused ? "§6降下停止中" : isOpen(s) ? "§d炉心露出" : "§7装甲閉鎖";
    const line = `§5オーバーシア§r ${bar} §f${Math.ceil(pct * 100)}%  §f残り高度 §e${Math.ceil(s.alt - RAID.failAlt)}m  §f衝突まで §c${mmss(remaining(s) + Math.max(0, (s.pauseUntil ?? 0) - now()))}  ${state}  §7翼 西${wing("w")} 東${wing("e")}`;
    for (const pl of players) { const g = gunHud.lines.get(pl.id); pl.onScreenDisplay.setActionBar(g ? `${line}\n${g}` : line); }
    void phase;
  }
  // 地上部隊: 防衛端末から始めた戦いでは、その端末に工場の敵 (スクラッパー等) が波で押し寄せる
  let defense;
  // 波の中身は人数によらず一定。通常の防衛作戦の3波を強化したもの (4波目以降は最後の波をさらに強化)
  const WAVES = [
    { scrapper: 18, jammer: 3, gnawer: 2 },
    { scrapper: 30, jammer: 6, gnawer: 4, mender: 1 },
    { scrapper: 44, jammer: 10, gnawer: 6, mender: 3 },
  ];
  function spawnWave(s, dim, players, t) {
    if (!s.term || !defense) return;
    const st = defense.overseerOpState(s.term);
    if (st.left > 0) { s.clearAt = undefined; return; }            // まだ前の波が残っている
    s.clearAt ??= t;
    if (t - s.clearAt < (s.wave ? 15 : 6)) return;                  // 倒しきってから15秒 (最初は出現6秒後)
    s.wave = (s.wave ?? 0) + 1; s.clearAt = undefined;
    const base = WAVES[Math.min(s.wave, WAVES.length) - 1], boost = 1 + .15 * Math.max(0, s.wave - WAVES.length);
    const counts = Object.fromEntries(Object.entries(base).map(([k, n]) => [k, Math.round(n * boost)]));
    try { defense.overseerWave(s.term, counts); } catch (err) { console.warn(`[Orbital Foundry] overseer wave: ${err}`); }
  }
  function clearWave(s) { if (s.term && defense) try { defense.stopOverseerOp(s.term); } catch {} }

  // ---------------- 空の色 ----------------
  // 作戦中は迎撃地点の周りにいるプレイヤーの空を赤紫に染める (霧の設定を重ねる)。降下が進むほど濃く赤く。
  // 遠くの雲の向こうで雷光が明滅し、ワープホールのかけらが灰のように降り続ける。
  const skyStage = new Map();   // playerId -> 付けている段階 (1〜3)
  function setSky(pl, stage) {
    const cur = skyStage.get(pl.id) ?? 0;
    if (cur === stage) return;
    try { if (cur) pl.runCommand("fog @s remove of_overseer_sky"); } catch {}
    try { if (stage) pl.runCommand(`fog @s push orbital_foundry:overseer_sky_${stage} of_overseer_sky`); } catch {}
    if (stage) skyStage.set(pl.id, stage); else skyStage.delete(pl.id);
  }
  system.runInterval(() => {
    const s = read(KEY);
    let dim; try { dim = s && world.getDimension(s.dim); } catch {}
    const near = new Set();
    if (s && dim && s.status !== "impact") {
      const frac = s.status === "prep" ? 0 : (s.elapsed ?? 0) / RAID.descentSec;
      const stage = s.status === "prep" ? (s.portal ? 1 : 0) : frac > .66 ? 3 : frac > .33 ? 2 : 1;
      for (const pl of playersNear(dim, s.at, RAID.range + 20)) { near.add(pl.id); setSky(pl, stage); }
    }
    for (const pl of world.getAllPlayers()) if (!near.has(pl.id) && skyStage.has(pl.id)) setSky(pl, 0);
  }, 20);
  world.afterEvents.playerLeave?.subscribe(({ playerId }) => skyStage.delete(playerId));
  function skyFx(s, dim, frac) {
    const k = system.currentTick;
    // 遠くの雷光 (終盤ほど頻繁に)
    if (k % Math.max(12, Math.round(50 - 34 * frac)) === 0) {
      const a = Math.random() * Math.PI * 2, r = 90 + Math.random() * 50;
      const at = { x: s.at.x + Math.cos(a) * r, y: s.at.y + 45 + Math.random() * 30, z: s.at.z + Math.sin(a) * r };
      particle(dim, "sky_flash", at, mv({ size: 60 + Math.random() * 60 }));
      if (Math.random() < .55) particle(dim, "sky_bolt", { x: at.x, y: at.y - 20, z: at.z }, mv({ len: 30 + Math.random() * 25 }));
      system.runTimeout(() => sound(dim, "ambient.weather.thunder", { x: s.at.x + Math.cos(a) * 40, y: s.at.y + 20, z: s.at.z + Math.sin(a) * 40 }, 1.2 + frac, .5 + Math.random() * .3), 10 + Math.floor(Math.random() * 20));
    }
    // ワープホールのかけらが灰のように降る
    if (k % 10 === 0) for (const pl of playersNear(dim, s.at)) particle(dim, "sky_ash", { x: pl.location.x, y: pl.location.y + 22, z: pl.location.z }, mv({ size: 18 }));
  }

  // 記録と結びつかないオーバーシアは除去
  world.afterEvents.entityLoad?.subscribe(ev => {
    try { const e = ev.entity; if (e?.typeId === id("orbital_cannon_gun")) { const ok = cannons().some(m => readCannon(m.key).gun === e.id); if (!ok) e.remove(); return; } if (e?.typeId === id("overseer_portal")) { if (read(KEY)?.portal !== e.id) e.remove(); return; } if (e?.typeId !== id("overseer")) return; if (read(KEY)?.entity !== e.id) e.remove(); } catch {}
  });
  gunHud.override = pl => { const s = read(KEY); if (!s || s.dim !== pl.dimension.id) return false; return Math.hypot(pl.location.x - s.at.x, pl.location.z - s.at.z) < RAID.range; };
  gunHud.rayTest = rayTest;
  // ================= 軌道迎撃砲 =================
  // 1発 360,000 SE。工場の電力網から充電 (最大 40,000 SE/秒)。充電済みの1発は戦闘前から溜めておける。
  // オーバーシアだけを狙い、炉心の開閉に関係なく 2250 ダメージ。発射後 15 秒冷却してから次弾を充電。
  const CANNON = { type: id("orbital_cannon"), gun: id("orbital_cannon_gun"), cost: 360000, rate: 40000, damage: 2250, coolSec: 15, range: 220, stunSec: 3 };
  const cKey = key => `of:cannon:${key}`;
  const readCannon = key => read(cKey(key)) ?? { charge: 0, coolUntil: 0 };
  const writeCannon = (key, c) => write(cKey(key), c);
  const cannons = () => (ctx.registry?.() ?? []).filter(m => m.type === CANNON.type);
  const gunAt = m => ({ x: m.x + .5, y: m.y + 1, z: m.z + .5 });
  function gunEntity(m, dim) {
    const c = readCannon(m.key);
    let g; try { g = c.gun && world.getEntity(c.gun); } catch {}
    if (g?.isValid) return g;
    try { g = dim.spawnEntity(CANNON.gun, gunAt(m)); c.gun = g.id; writeCannon(m.key, c); return g; } catch { return undefined; }
  }
  function bossTarget(m) {
    const s = read(KEY);
    if (!s || s.status !== "fight" || s.dim !== m.dim) return undefined;
    let e; try { e = world.getEntity(s.entity); } catch {}
    if (!e?.isValid) return undefined;
    const c = e.location, d = Math.hypot(c.x - m.x, c.y - m.y, c.z - m.z);
    return d <= CANNON.range ? { s, e, aim: { x: c.x, y: c.y + SHAPE.coreY - 2, z: c.z } } : undefined;
  }
  // Short charging cycles let the charge display follow faster operating speeds.
  const chargeTicks=5, chargeUpdatesPerSecond=20/chargeTicks;
  system.runInterval(() => {
    for (const m of cannons()) {
      try {
        let dim; try { dim = world.getDimension(m.dim); if (dim.getBlock(m)?.typeId !== CANNON.type) continue; } catch { continue; }
        const c = readCannon(m.key), t = now();
        if (c.firing || t < (c.coolUntil ?? 0) || c.charge >= CANNON.cost) { c.rateNow=0;c.energyNow=0;writeCannon(m.key, c); continue; }
        const avail = ctx.availablePower?.(m.key) ?? 0, speed=ctx.speedLimit(m.key);
        const take = Math.floor(Math.min(avail/speed, CANNON.cost - c.charge, CANNON.rate*speed/chargeUpdatesPerSecond));
        if (take > 0 && ctx.spend?.(m.key, take*speed)) { c.charge += take; c.rateNow = take*chargeUpdatesPerSecond; c.energyNow=c.rateNow*speed; } else {c.rateNow=0;c.energyNow=0;}
        if (c.charge >= CANNON.cost) { sound(dim, "beacon.activate", gunAt(m), 1.4, 1.6); particle(dim, "cannon_ready", { ...gunAt(m), y: m.y + 3 }); }
        writeCannon(m.key, c);
      } catch {}
    }
  }, chargeTicks);
  const humNext = new Map();
  // 照準と待機演出 (2ティックごと)
  system.runInterval(() => {
    for (const m of cannons()) {
      try {
        const dim = world.getDimension(m.dim); if (dim.getBlock(m)?.typeId !== CANNON.type) continue;
        const g = gunEntity(m, dim); if (!g) continue;
        const c = readCannon(m.key), tgt = bossTarget(m), base = gunAt(m);
        let yaw = g.getRotation?.().y ?? 0, tilt = 0;
        if (tgt) {
          const dx = tgt.aim.x - base.x, dy = tgt.aim.y - base.y - 2, dz = tgt.aim.z - base.z, h = Math.hypot(dx, dz);
          yaw = Math.atan2(-dx, dz) * 180 / Math.PI; tilt = Math.min(80, Math.atan2(h, Math.max(.1, dy)) * 180 / Math.PI);
        }
        try { g.teleport(base, { rotation: { x: 0, y: yaw } }); } catch {}
        setProp(g, "tilt", Math.round(tilt * 10) / 10);
        setProp(g, "charge", Math.min(6, Math.floor(c.charge / CANNON.cost * 6 + 1e-6)));
        if (!c.firing) setProp(g, "stage", now() < (c.coolUntil ?? 0) ? 4 : 0);
        const k = system.currentTick;
        // 充電完了の待機音: 20秒の素材 (前後0.4秒フェード) を 19.6秒ごとに重ねて途切れず鳴らす
        if (c.charge >= CANNON.cost && !c.firing) {
          if (system.currentTick >= (humNext.get(m.key) ?? 0)) { humNext.set(m.key, system.currentTick + 392); sound(dim, `${NS}.cannon_idle`, base, 1, 1); }
        } else humNext.delete(m.key);
        if (c.charge >= CANNON.cost && k % 8 === 0) particle(dim, "cannon_arc", { x: base.x, y: base.y + 1.5 + Math.random() * 2.5, z: base.z }, mv({ len: 1 + Math.random() * 2 }));
        if (now() < (c.coolUntil ?? 0) && k % 6 === 0) particle(dim, "gun_steam", { x: base.x + (Math.random() - .5), y: base.y + 1, z: base.z + (Math.random() - .5) });
      } catch {}
    }
  }, 2);
  // 発射シーケンス: 送電ケーブルが順に光る → 砲身が空を向く → コイル発光 → 放電の柱が空を貫く
  function fireCannon(p, m) {
    const c = readCannon(m.key), dim = world.getDimension(m.dim), base = gunAt(m);
    if (c.firing) return;
    if (c.charge < CANNON.cost) return toast(p, `充電中 ${Math.floor(c.charge / CANNON.cost * 100)}%`);
    if (!bossTarget(m)) return toast(p, "射程内にオーバーシアがいません (砲はオーバーシアだけを狙います)");
    c.firing = true; writeCannon(m.key, c);
    const g = gunEntity(m, dim);
    setProp(g, "stage", 1);
    // 1) 送電ケーブルが砲に向かって順に光る
    const cables = (ctx.registry?.() ?? []).filter(x => x.type === id("power_cable") && x.dim === m.dim)
      .map(x => ({ x, d: Math.hypot(x.x - m.x, x.y - m.y, x.z - m.z) })).filter(o => o.d < 40).sort((a, b) => b.d - a.d);
    const far = cables[0]?.d ?? 1;
    for (const { x, d } of cables) system.runTimeout(() => { particle(dim, "cable_glow", { x: x.x + .5, y: x.y + .5, z: x.z + .5 }); if (Math.random() < .25) sound(dim, "random.fizz", x, .4, 1.8); }, Math.round((1 - d / far) * 24));
    sound(dim, "beacon.power", base, 2, .5);
    sound(dim, `${NS}.cannon_aim`, base, 1.6, 1);   // 砲身が空を向く駆動音
    sound(dim, `${NS}.cannon_charge`, base, 2, 1);   // チャージ音: 約3秒で最高潮 > そこで発射
    // 2) 砲身が空を向き、コイルが下から順に発光
    system.runTimeout(() => { setProp(g, "stage", 2); sound(dim, "beacon.activate", base, 3, .5); for (let i = 0; i < 6; i++) system.runTimeout(() => { particle(dim, "cannon_coil", { x: base.x, y: base.y + 1.2 + i * .55, z: base.z }); sound(dim, "note.bit", base, 1.5, .5 + i * .2); }, i * 4); }, 24);
    // 3) 放電の柱が空を貫く
    system.runTimeout(() => {
      const tgt = bossTarget(m), cc = readCannon(m.key);
      cc.firing = false;
      setProp(g, "stage", 3);
      system.runTimeout(() => setProp(g, "stage", 4), 20);
      if (!tgt) { writeCannon(m.key, cc); toast(p, "オーバーシアを見失った · 充電は保持されています"); return; }
      cc.charge = 0; cc.coolUntil = now() + CANNON.coolSec; writeCannon(m.key, cc);
      // 冷却の排気: 反動のあと一気に吹き出し、冷却の後半にもう一度
      for (const [delay, vol] of [[22, 2.2], [200, 1.3]]) system.runTimeout(() => {
        sound(dim, `${NS}.cannon_vent`, base, vol, 1);
        for (let i = 0; i < 6; i++) particle(dim, "gun_steam", { x: base.x + (Math.random() - .5) * 1.4, y: base.y + .6 + Math.random() * 2, z: base.z + (Math.random() - .5) * 1.4 });
      }, delay);
      const from = { x: base.x, y: base.y + 4.2, z: base.z }, to = tgt.aim;
      const L = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), steps = Math.ceil(L / 2.5);
      for (let i = 0; i <= steps; i++) { const f = i / steps; particle(dim, "cannon_beam", { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: from.z + (to.z - from.z) * f }, mv({ len: 4 })); }
      for (let k = 1; k <= 6; k++) system.runTimeout(() => { for (let i = 0; i <= steps; i += 2) { const f = i / steps; particle(dim, "cannon_beam", { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: from.z + (to.z - from.z) * f }, mv({ len: 3 })); } }, k * 2);
      particle(dim, "cannon_muzzle", from); particle(dim, "portal_shock", { x: base.x, y: base.y, z: base.z }, mv({ size: 40 }));
      particle(dim, "overseer_flare", to, mv({ size: 30 })); particle(dim, "overseer_wing_burst", to); particle(dim, "overseer_core_burst", to);
      sound(dim, `${NS}.cannon_fire`, base, 4, 1);
      system.runTimeout(() => { sound(dim, `${NS}.cannon_thunder`, base, 4, 1); for (const pl of playersNear(dim, base, 160)) try { pl.playSound(`${NS}.cannon_thunder`, { volume: .6 }); } catch {} }, 3);   // 発射直後の雷鳴 sound(dim, "random.explode", to, 6, .5);
      for (const pl of playersNear(dim, base, 96)) try { pl.playSound(`${NS}.cannon_fire`, { volume: .7, pitch: 1 }); } catch {}   // 遠くの仲間にも届くように
      for (const pl of playersNear(dim, base, 48)) try { pl.runCommand("camera @s shake add 0.5 1.2 positional"); } catch {}
      cannonHit(tgt.s, tgt.e, p);
    }, 60);   // チャージ音の盛り上がり (3秒) に合わせて発射
  }
  // 命中: 炉心の開閉に関係なく 2250。大きく傾いて火花を散らし、降下が数秒止まる
  function cannonHit(s, e, p) {
    s.hp = Math.max(0, s.hp - CANNON.damage);
    s.contributors[p.id] = (s.contributors[p.id] ?? 0) + CANNON.damage;
    s.pauseUntil = Math.max(now(), s.pauseUntil ?? 0) + CANNON.stunSec;
    s.rollTarget = (Math.random() < .5 ? -1 : 1) * 28; s.rollUntil = now() + CANNON.stunSec;
    flashHurt(e, p);
    const dim = e.dimension, c = e.location;
    for (let i = 0; i < 10; i++) system.runTimeout(() => { try { particle(dim, "overseer_sparks", { x: c.x + (Math.random() - .5) * 40, y: c.y + (Math.random() - .5) * 8, z: c.z + (Math.random() - .5) * 20 }); particle(dim, "overseer_debris", { x: c.x + (Math.random() - .5) * 30, y: c.y, z: c.z + (Math.random() - .5) * 15 }); } catch {} }, i * 2);
    sound(dim, "mob.enderdragon.growl", c, 6, .6);
    for (const pl of playersNear(dim, s.at)) pl.onScreenDisplay.setTitle("§b§l軌道迎撃砲 直撃", { subtitle: `§f-${CANNON.damage} · 機体が傾いた · 降下停止 +${CANNON.stunSec}秒`, fadeInDuration: 0, stayDuration: 30, fadeOutDuration: 8 });
    if (s.hp <= 0) { victory(s, e); return; }
    write(KEY, s);
  }
  async function cannonUi(p, block, key) {
    const m = (ctx.registry?.() ?? []).find(x => x.key === key) ?? { key, dim: block.dimension.id, ...block.location };
    const c = readCannon(key), t = now(), tgt = bossTarget(m);
    const pct = Math.floor(c.charge / CANNON.cost * 100), ready = c.charge >= CANNON.cost;
    const bar = "§b" + "|".repeat(Math.round(pct / 5)) + "§8" + "|".repeat(20 - Math.round(pct / 5));
    const state = c.firing ? "§e発射シーケンス中" : t < (c.coolUntil ?? 0) ? `§7砲身冷却中 あと${Math.ceil(c.coolUntil - t)}秒` : ready ? "§a充電完了 · 発射可能" : `§e充電中 ${(c.rateNow ?? 0).toLocaleString()} SE/秒（消費 ${(c.energyNow??0).toLocaleString()} SE/秒）`;
    const aim = tgt ? (isOpen(tgt.s) ? "§d§l照準: オーバーシア · 炉心露出中！" : "§f照準: オーバーシア 追尾中") : "§7照準: 目標なし (オーバーシアのみ攻撃)";
    const form = ctx.createForm().title("軌道迎撃砲").body(
      `${bar} §f${pct}%  §7(${c.charge.toLocaleString()} / ${CANNON.cost.toLocaleString()} SE)\n状態  ${state}\n${aim}\n\n` +
      `§7威力 ${CANNON.damage} (炉心の開閉に関係なし) · 命中で${CANNON.stunSec}秒降下停止 · 発射後${CANNON.coolSec}秒冷却\n最大充電 ${(CANNON.rate*ctx.speedLimit(key)).toLocaleString()} SE/秒 · 最大消費 ${(CANNON.rate*ctx.speedLimit(key)**2).toLocaleString()} SE/秒（速度 ${ctx.speedLimit(key)}倍）`);
    const acts = [];
    if (ready && tgt && !c.firing) { form.button("§c§l発射", "textures/items/orbital_crystal"); acts.push("fire"); }
    form.button("表示を更新"); acts.push("refresh");
    form.button("閉じる"); acts.push("close");
    const r = await form.show(p); if (r.canceled) return;
    const a = acts[r.selection];
    if (a === "fire") fireCannon(p, m);
    else if (a === "refresh") return cannonUi(p, block, key);
  }
  world.afterEvents.playerBreakBlock?.subscribe(ev => {
    try { if (ev.brokenBlockPermutation?.type?.id !== CANNON.type) return;
      const key = ctx.keyOf?.(ev.dimension.id, ev.block.location); const c = key && readCannon(key);
      try { if (c?.gun) world.getEntity(c.gun)?.remove(); } catch {} if (key) write(cKey(key), undefined); } catch {}
  });

  const attachDefense = d => { defense = d; };
  return { cannonUi, attachDefense, summon, adopt, abort, hurt, rayTest, clearStale, active: () => !!read(KEY) };
}
