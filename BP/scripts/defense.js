// 工場防衛: 防衛端末・機関砲塔 Mk I・敵2種 (スクラッパー / ジャマー)・3ウェーブの作戦
// ・時間はワールド内時計で、端末が読込済みかつ近くにプレイヤーがいるときだけ進む
// ・敵はブロックを壊さない。端末への攻撃はスクリプトで耐久を減らす
import { checkShort } from "./hud.js";
import { affordableSpeed, scheduledStart, visualStepTicks } from "./machine-speed.js";
import { GameMode, ItemStack, MolangVariableMap } from "@minecraft/server";
import { NS } from "./config.js";

export const DEF = {
  terminal: `${NS}:defense_terminal`, turret: `${NS}:turret_mk1`,
  scrapper: `${NS}:scrapper`, jammer: `${NS}:jammer`, ammo: `${NS}:industrial_ammo`, kit: `${NS}:repair_kit`,
  core: `${NS}:military_control_core`, marker: `${NS}:defense_objective`,
  siege: `${NS}:siege_engine`, mender: `${NS}:mender`, gnawer: `${NS}:gnawer`, siegeCore: `${NS}:siege_control_core`,
};
export const DEFENSE = {
  maxHp: 100, countdown: 30, breakSec: 20, squadSec: 2, squadSize: 8, cooldownSec: 120, reward: 2,
  spawnMin: 36, spawnMax: 48, presenceRange: 64, overlapRange: 96, turretLink: 24,
  repair: 25, repairCooldown: 15,
  turret: { range: 16, damage: 18, energy: 60, maxAmmo: 128, interval: 1 },
  enemy: {
    [`${NS}:scrapper`]: { hp: 160, aimHeight: .45, hitTerminal: 7, hitEvery: 2, name: "スクラッパー" },
    [`${NS}:jammer`]: { hp: 180, aimHeight: 1.05, hitTerminal: 4, hitEvery: 2, name: "ジャマー", jamRange: 8, warn: 3, jam: 4, cooldown: 12, immune: 6 },
    // 修理ドローン: 群れの後ろに浮かび、傷ついた味方を緑のビームで直す (攻城機の冷却器も)
    [`${NS}:mender`]: { hp: 120, aimHeight: 1.5, hitTerminal: 2, hitEvery: 3, name: "修理ドローン", heal: 30, healEvery: 4, healRange: 9 },
    // ボルトラット: 砲塔へ走って弾薬をかじる。弾が尽きた砲塔からは端末へ向かう
    [`${NS}:gnawer`]: { hp: 90, aimHeight: .35, hitTerminal: 3, hitEvery: 1, name: "ボルトラット", chew: 3, chewRange: 1.9, seek: 24 },
    // 攻城機: 正面装甲は25%だけ通す。左右の冷却器を両方壊すと12秒間装甲が開く。半径16で予告付きの衝撃波
    [`${NS}:siege_engine`]: { hp: 2400, aimHeight: 3.9, contactRange: 5.4, meleeRange: 9.7, meleeDamage: 16, hitTerminal: 10, hitEvery: 2, name: "攻城機", cooler: 210, frontPass: .25, rearPass: .5,
      openSec: 12, shockRange: 16, shockWarn: 4, shockDamage: 12, shockEvery: 14, shockEveryEnraged: 8 },
  },
  // 装甲: ゲリラアドオン等、他アドオンの武器もそのまま通す (体力はゲリラの兵器を基準に約3倍)
  armor: { otherAddon: 1, realHealth: 1000 },
  waves: [
    { scrapper: 14, jammer: 2 },
    { scrapper: 24, jammer: 5, gnawer: 3 },
    { scrapper: 36, jammer: 8, gnawer: 4, mender: 2 },
  ],
  // 攻城機迎撃: 通常防衛を一度クリアしたワールドで選べる別モード
  siegeWaves: [
    { scrapper: 12, jammer: 2, gnawer: 3 },
    { siege: 1, scrapper: 8, jammer: 2, mender: 2 },
  ],
  siegeReward: 2,
};
export const ENEMY_TYPES = Object.keys(DEFENSE.enemy);
export const wavesOf = op => op?.mode === "siege" ? DEFENSE.siegeWaves : DEFENSE.waves;
const waveCount = w => (w.scrapper ?? 0) + (w.jammer ?? 0) + (w.gnawer ?? 0) + (w.mender ?? 0) + (w.siege ?? 0);
export const TURRET_PROFILES = {
  [DEF.turret]: { ...DEFENSE.turret, name: "機関砲塔 Mk I", ammo: DEF.ammo, muzzleY: .48, muzzleLength: .584, sound: "orbital_foundry.turret_fire", pitch: 1, volume: .8, tracer: "tracer" },
  [`${NS}:turret_railgun`]: { name: "レールガン砲塔", ammo: `${NS}:railgun_round`, range: 30, damage: 84, energy: 480, maxAmmo: 64, interval: 3, muzzleY: .51, muzzleLength: .58, sound: "orbital_foundry.railgun_fire", pitch: 1, volume: 1, tracer: "rail_tracer" },
  [`${NS}:turret_shotgun`]: { name: "ショットガン砲塔", ammo: `${NS}:shotgun_shell`, range: 9, damage: 48, energy: 140, maxAmmo: 96, interval: 2, spread: true, muzzleY: .48, muzzleLength: .56, sound: "orbital_foundry.shotgun_fire", pitch: 1, volume: .9, tracer: "shotgun_tracer" },
};
export const TURRET_TYPES = new Set(Object.keys(TURRET_PROFILES));

// ダメージの出どころの判定 (テストでも使う)。返り値は通す割合 0〜1
const VANILLA_CAUSES = new Set(["entityAttack", "projectile", "fire", "fireTick", "lava", "drowning", "fall", "suffocation", "magic", "wither",
  "freezing", "lightning", "anvil", "fallingBlock", "blockExplosion", "entityExplosion", "contact", "stalactite", "stalagmite", "thorns",
  "flyIntoWall", "magma", "sonicBoom", "campfire", "soulCampfire", "void", "starve", "ramAttack", "maceSmash", "piston", "temperature"]);
const vanillaId = id => !id || id === "minecraft:player" || id.startsWith("minecraft:");
// addonHit: 直前に他アドオンの弾が当たった (GVC などは、弾の命中をスクリプトで受けて「プレイヤーの攻撃」としてダメージを入れるため)
// riding: 攻撃者が他アドオンの乗り物 (戦車など) に乗っている
export function armorMultiplier(source, turretHit, addonHit = false, riding) {
  if (turretHit) return 1;
  if (addonHit) return DEFENSE.armor.otherAddon;
  if (riding && !vanillaId(riding)) return DEFENSE.armor.otherAddon;
  const cause = source?.cause, attacker = source?.damagingEntity?.typeId, projectile = source?.damagingProjectile?.typeId;
  if (projectile) return vanillaId(projectile) && vanillaId(attacker) ? 1 : DEFENSE.armor.otherAddon;   // 他アドオンの弾
  if (!VANILLA_CAUSES.has(cause)) return DEFENSE.armor.otherAddon;                                     // 独自・スクリプトの原因
  if (cause === "projectile") return DEFENSE.armor.otherAddon;                                         // 弾なしの「射撃」はスクリプトの銃
  return vanillaId(attacker) ? 1 : DEFENSE.armor.otherAddon;
}
// The head_0 model points north (-Z), while the Minecraft yaw origin is south.
export const turretYaw = (dx, dz) => (Math.round(Math.atan2(-dx, dz) / (Math.PI / 4)) + 12) % 8;
export function defenseHud(op, t = 0) {
  const waves = wavesOf(op), title = op.mode === "siege" ? "攻城機迎撃" : "工場防衛";
  if (op.status === "countdown" || op.status === "break") {
    const next = op.wave + 1;
    const duration = op.status === "countdown" ? DEFENSE.countdown : DEFENSE.breakSec;
    return { text: `${title} · 第${next}/${waves.length}波まで ${op.timer}秒`, ratio: op.timer / duration };
  }
  if (op.mode === "overseer") {
    if (op.status !== "wave") return;
    const left = (op.queue?.length ?? 0) + (op.enemies?.length ?? 0);
    return { text: `オーバーシア戦 · 端末耐久 ${op.hp}/${DEFENSE.maxHp} · 地上部隊 第${op.wave}波 · 残り${left}体`, ratio: op.hp / DEFENSE.maxHp };
  }
  const wave = waves[op.wave - 1];
  if (op.status !== "wave" || !wave) return;
  const remaining = (op.queue?.length ?? 0) + (op.enemies?.length ?? 0);
  const b = op.siege;
  if (b?.id && b.hp > 0) {   // 攻城機が出ている間は、ボスの状態を主役にする
    const spec = DEFENSE.enemy[DEF.siege];
    const cool = (side, hp) => hp > 0 ? `${side}${Math.ceil(hp)}` : `${side}×`;
    const state = (b.openUntil ?? 0) > t ? `§a装甲開放 ${Math.ceil(b.openUntil - t)}秒§r` : (b.shockAt ?? 0) > t ? `§c衝撃波 ${Math.ceil(b.shockAt - t)}秒§r` : "装甲閉鎖";
    return { text: `攻城機 ${Math.ceil(b.hp)}/${spec.hp} · 冷却器 ${cool("左", b.l)} ${cool("右", b.r)} · ${state} · 残り${remaining}体`, ratio: b.hp / spec.hp };
  }
  return { text: `${title} · 第${op.wave}/${waves.length}波 · 残り ${remaining}体`, ratio: remaining / (op.waveTotal ?? waveCount(wave)) };
}
const COMPASS = ["東", "南東", "南", "南西", "西", "北西", "北", "北東"];
export const compassOf = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8];
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:short_grass", "minecraft:tall_grass", "minecraft:snow_layer"]);
const isSolid = t => !!t && !AIR.has(t) && !t.includes("water") && !t.includes("lava") && !t.endsWith("_flower") && t !== "minecraft:fern";

export function installDefense(core) {
  const { world, system, registry, keyOf, dpGet, dpSet, createForm, toast, nameOf, expansion, gameClock, countItem, removeItems } = core;
  const now = () => gameClock.now() / 1000;
  const opKey = key => "of_def:" + key, turretKey = key => "of_tur:" + key;
  const fresh = () => ({ status: "idle", mode: "normal", hp: DEFENSE.maxHp, wave: 0, reward: 0, rewardSiege: 0, turrets: [], enemies: [] });
  const siegeUnlocked = player => !!player?.getDynamicProperty("of:defense_cleared");
  const canControl = (player,op) => op.ownerId ? op.ownerId===player.id : !op.startedBy || op.startedBy===player.name;
  const read = key => { try { return { ...fresh(), ...JSON.parse(dpGet(opKey(key), "{}")) }; } catch { return fresh(); } };
  const write = (key, op) => dpSet(opKey(key), JSON.stringify(op));
  const readTurret = key => { try { return { ammo: 0, ...JSON.parse(dpGet(turretKey(key), "{}")) }; } catch { return { ammo: 0 }; } };
  const writeTurret = (key, t) => dpSet(turretKey(key), JSON.stringify(t));
  const active = op => ["countdown", "wave", "break"].includes(op.status);
  const center = m => ({ x: m.x + .5, y: m.y + .5, z: m.z + .5 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const terminals = () => registry().filter(m => m.type === DEF.terminal);
  const turrets = () => registry().filter(m => TURRET_TYPES.has(m.type));
  const letter = i => String.fromCharCode(65 + (i % 26));

  function objectiveOf(op) {
    try { return op.objectiveId ? world.getEntity(op.objectiveId) : undefined; } catch { return undefined; }
  }
  function removeObjective(op) {
    const objective = objectiveOf(op);
    try { if (objective?.isValid) objective.remove(); } catch {}
    delete op.objectiveId;
  }
  function updateObjective(m, op, dim) {
    const hud = defenseHud(op, now());
    if (!hud) return;
    // The action bar carries the dynamic values on clients that hide the boss HUD.
    const filled = Math.max(0, Math.min(10, Math.ceil(hud.ratio * 10)));
    for (const player of dim.getPlayers({ location: center(m), maxDistance: DEFENSE.presenceRange })) {
      try { player.onScreenDisplay?.setActionBar(`§6${hud.text} §e${"#".repeat(filled)}§8${"-".repeat(10 - filled)}§r`); } catch {}
    }
    let objective = objectiveOf(op);
    if (!objective?.isValid) {
      // Put the AI target on a walkable side, rather than inside the solid terminal.
      const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let at = { x: m.x + .5, y: m.y + 1, z: m.z + .5 };
      for (const [dx, dz] of offsets) {
        const feet = { x: m.x + dx, y: m.y, z: m.z + dz };
        const below = dim.getBlock({ ...feet, y: feet.y - 1 });
        const space = dim.getBlock(feet);
        if (isSolid(below?.typeId) && AIR.has(space?.typeId)) {
          at = { x: feet.x + .5, y: feet.y, z: feet.z + .5 };
          break;
        }
      }
      objective = dim.spawnEntity(DEF.marker, at);
      objective.setDynamicProperty("of:terminal", m.key);
      objective.setDynamicProperty("of:op", op.opId);
      op.objectiveId = objective.id;
    }
    if (objective.nameTag !== hud.text) objective.nameTag = hud.text;
    objective.getComponent("minecraft:health")?.setCurrentValue(Math.max(1, Math.min(100, Math.round(100 * hud.ratio))));
  }

  function broadcast(m, text) {
    try { for (const p of world.getDimension(m.dim).getPlayers({ location: center(m), maxDistance: 48 })) p.onScreenDisplay?.setActionBar(text); } catch {}
  }
  function particle(dim, id, pos, color) {
    let vars; if (color) try { vars = new MolangVariableMap(); vars.setColorRGBA("variable.color", color); } catch { vars = undefined; }
    try { dim.spawnParticle(id, pos, vars); } catch {}
  }
  function sound(dim, id, pos, pitch = 1, volume = .8) { try { dim.playSound(id, pos, { pitch, volume }); } catch {} }

  // ---- 出現地点: 端末から36〜48ブロック、地面があり頭上2マスが空いている場所 ----
  function groundAt(dim, x, z, aroundY) {
    for (let y = aroundY + 12; y >= aroundY - 12; y--) {
      let below, feet, head;
      try { below = dim.getBlock({ x, y: y - 1, z }); feet = dim.getBlock({ x, y, z }); head = dim.getBlock({ x, y: y + 1, z }); } catch { return; }
      if (!below || !feet || !head) return;
      if (isSolid(below.typeId) && !isSolid(feet.typeId) && !isSolid(head.typeId) && !feet.typeId.includes("water") && !below.typeId.includes("lava")) return { x: x + .5, y, z: z + .5 };
    }
  }
  function findSpawn(dim, m, angleDeg) {
    for (const spread of [0, 10, -10, 20, -20]) for (const r of [42, DEFENSE.spawnMin, DEFENSE.spawnMax, 39, 45]) {
      const a = (angleDeg + spread) * Math.PI / 180;
      const p = groundAt(dim, Math.round(m.x + Math.cos(a) * r), Math.round(m.z + Math.sin(a) * r), m.y);
      if (p) return p;
    }
  }
  function planSpawns(dim, m) {
    const base = Math.floor(Math.random() * 4) * 90, points = [];
    for (let i = 0; i < 4; i++) {
      const p = findSpawn(dim, m, base + i * 90);
      if (p && points.every(q => flat(q, p) > 16)) points.push(p);
    }
    return points;
  }

  // ---- 作戦の開始・中止・決着 ----
  // Match the 8.4 x 8.4 x 8 block collision box on a block-centered spawn.
  function siegeGroundAt(dim, cx, cz, aroundY) {
    const g = groundAt(dim, cx, cz, aroundY);
    if (!g) return;
    try {
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        if (!isSolid(dim.getBlock({ x: cx + dx, y: g.y - 1, z: cz + dz })?.typeId)) return;
        for (let dy = 0; dy < 8; dy++) {
          const block = dim.getBlock({ x: cx + dx, y: g.y + dy, z: cz + dz });
          if (!block || isSolid(block.typeId)) return;
        }
      }
      return g;
    } catch {}
  }
  function bigGround(dim, p) {
    for (const [ox, oz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [4, 4], [-4, -4], [4, -4], [-4, 4]]) {
      const g = siegeGroundAt(dim, Math.floor(p.x) + ox, Math.floor(p.z) + oz, Math.floor(p.y));
      if (g) return g;
    }
  }
  function startOp(m, player, mode = "normal", debugBoss = false) {
    if (debugBoss && (mode !== "siege" || player?.getGameMode() !== GameMode.Creative)) return "このコマンドはクリエイティブ専用です。";
    const op = read(m.key);
    if (mode === "siege" && !debugBoss && !siegeUnlocked(player)) return "自分の通常防衛をクリアし、報酬を受け取ると攻城機迎撃を選べます";
    if (active(op)) return "作戦はすでに進行中です";
    if (op.reward > 0 || op.rewardSiege > 0) return "報酬を受け取ってから次の作戦を開始してください";
    if ((op.cooldownUntil ?? 0) > now()) return `再挑戦まであと${Math.ceil(op.cooldownUntil - now())}秒`;
    if (m.dim !== "minecraft:overworld") return "標準防衛はオーバーワールドの地上が対象です";
    for (const other of terminals()) {
      if (other.key === m.key || other.dim !== m.dim || flat(other, m) > DEFENSE.overlapRange) continue;
      if (active(read(other.key))) return "近くで別の防衛作戦が進行中です。終わるまで待ってください";
    }
    const dim = world.getDimension(m.dim);
    const points = planSpawns(dim, m);
    if (!points.length) return "敵が出現できる地面が見つかりません（端末から36〜48ブロックに、頭上の空いた地面が必要）";
    let siegeAt;
    if (mode === "siege") {
      for (const [i, p] of points.entries()) { const g = bigGround(dim, p); if (g) { siegeAt = { ...g, point: i }; break; } }
      if (!siegeAt) return "攻城機が出現できる広い地面がありません（出現方向に、幅9×奥行9・高さ8が空いた平らな地面が必要）";
    }
    if (!analyzeAccess(dim, m).open) return "侵入口がありません（周囲の地面から端末の横まで、敵が歩ける通路を1本以上開けてください）";
    registerTurrets(m);
    Object.assign(op, { breach: undefined, sealed: false, blockedFor: 0, accessNext: 0, mode, debugBoss, siegeAt, siege: undefined, gnaw: undefined, heal: undefined,
      turrets: read(m.key).turrets,
      status: "countdown", timer: DEFENSE.countdown, wave: debugBoss ? DEFENSE.siegeWaves.length - 1 : 0, hp: DEFENSE.maxHp, points, queue: [], enemies: [], killed: 0,
      opId: `${m.key}#${Math.floor(gameClock.now())}`, ownerId: player?.id, startedBy: player?.name, notice: "", spawnTimer: 0,
    });
    try { updateObjective(m, op, dim); } catch (error) { console.warn("[Orbital Foundry] defense HUD: " + error); }
    write(m.key, op);
    const directions = points.map(p => compassOf(p.x - m.x, p.z - m.z)).join("・");
    broadcast(m, `${mode === "siege" ? "攻城機迎撃" : "防衛作戦"}開始 · 30秒後に第${op.wave + 1}波 · ${directions}から接近`);
  }
  system.afterEvents.scriptEventReceive.subscribe(event => {
    if (event.id !== "orbital_foundry:debug_boss" || event.message.trim() !== "start") return;
    const player = event.sourceEntity;
    if (event.sourceBlock || player?.typeId !== "minecraft:player") return;
    if (player.getGameMode() !== GameMode.Creative) {
      toast(player, "このコマンドはクリエイティブ専用です。");
      return;
    }
    const dim = player.dimension;
    const terminal = terminals()
      .filter(m => m.dim === dim.id && dist(center(m), player.location) <= 8)
      .sort((a, b) => dist(center(a), player.location) - dist(center(b), player.location))
      .find(m => dim.getBlock(m)?.typeId === DEF.terminal);
    if (!terminal) {
      toast(player, "防衛端末から8ブロック以内で実行してください。");
      return;
    }
    const error = startOp(terminal, player, "siege", true);
    if (error) toast(player, error);
  });
  // デバッグ: /scriptevent orbital_foundry:debug_overseer start  (防衛端末の8ブロック以内・クリエイティブ専用)
  system.afterEvents.scriptEventReceive.subscribe(event => {
    if (event.id !== "orbital_foundry:debug_overseer" || event.message.trim() !== "start") return;
    const player = event.sourceEntity;
    if (event.sourceBlock || player?.typeId !== "minecraft:player") return;
    if (player.getGameMode() !== GameMode.Creative) { toast(player, "このコマンドはクリエイティブ専用です。"); return; }
    const dim = player.dimension;
    const terminal = terminals()
      .filter(m => m.dim === dim.id && dist(center(m), player.location) <= 8)
      .sort((a, b) => dist(center(a), player.location) - dist(center(b), player.location))
      .find(m => dim.getBlock(m)?.typeId === DEF.terminal);
    if (!terminal) { toast(player, "防衛端末から8ブロック以内で実行してください。"); return; }
    if (active(read(terminal.key))) { toast(player, "この端末は作戦中です。"); return; }
    expansion.overseerRaid?.(player, { x: terminal.x + .5, y: terminal.y, z: terminal.z + .5 }, terminal, true);
  });
  function enemiesOf(op) {
    const list = [];
    for (const id of op.enemies ?? []) { let e; try { e = world.getEntity(id); } catch {} if (e?.isValid) list.push(e); }
    return list;
  }
  function clearEnemies(op) { for (const e of enemiesOf(op)) try { e.remove(); } catch {} op.enemies = []; }
  function endOp(m, op, won, reason) {
    clearEnemies(op);
    removeObjective(op);
    for (const t of op.turrets ?? []) { const s = readTurret(t); s.jammedUntil = 0; s.warnUntil = 0; writeTurret(t, s); }
    // 予告中の衝撃波・突破・かじり・回復はここで全部消す (次の戦闘に持ち越さない)
    Object.assign(op, { status: won ? "won" : "lost", reason, timer: 0, queue: [], cooldownUntil: now() + DEFENSE.cooldownSec,
      siege: undefined, breach: undefined, gnaw: undefined, heal: undefined, jam: undefined });
    const siege = op.mode === "siege";
    if (won && !op.debugBoss) {
      op.reward = (op.reward ?? 0) + DEFENSE.reward;
      if (siege) { op.rewardSiege = (op.rewardSiege ?? 0) + DEFENSE.siegeReward; world.setDynamicProperty("of:design_siege", true); }   // 銃の専用改造の設計を解放
    }
    write(m.key, op);
    const dim = world.getDimension(m.dim);
    if (won && op.debugBoss) { sound(dim, "random.levelup", center(m), 1.1); broadcast(m, "攻城機撃破！ デバッグ戦のため端末報酬はありません。"); }
    else if (won && siege) { sound(dim, "random.totem", center(m), 1, .8); sound(dim, "random.levelup", center(m), .8); broadcast(m, "攻城機を撃破！ 端末から攻城制御核2個と軍用制御核2個を受け取れます"); }
    else if (won) { sound(dim, "random.levelup", center(m), 1.1); broadcast(m, "防衛成功！ 端末から軍用制御核2個を受け取れます"); }
    else { sound(dim, "random.anvil_land", center(m), .6, .5); broadcast(m, "防衛失敗 · " + (reason ?? "端末が停止しました")); }
  }
  // ---- オーバーシア戦の地上部隊: この端末で「波が終わらない」特別な作戦を動かし、このアドオンの敵を送り込む ----
  function startOverseerOp(m, player) {
    const op = read(m.key);
    if (active(op)) return "作戦はすでに進行中です";
    if (m.dim !== "minecraft:overworld") return "オーバーシア戦はオーバーワールドの地上が対象です";
    const dim = world.getDimension(m.dim);
    const points = planSpawns(dim, m);
    if (!points.length) return "地上部隊が出現できる地面が見つかりません（端末から36〜48ブロックに、頭上の空いた地面が必要）";
    if (!analyzeAccess(dim, m).open) return "侵入口がありません（周囲の地面から端末の横まで、敵が歩ける通路を1本以上開けてください）";
    registerTurrets(m);
    Object.assign(op, { breach: undefined, sealed: false, blockedFor: 0, accessNext: 0, mode: "overseer", debugBoss: false, siegeAt: undefined, siege: undefined,
      gnaw: undefined, heal: undefined, turrets: read(m.key).turrets, status: "wave", timer: 0, wave: 0, hp: DEFENSE.maxHp, points, queue: [], enemies: [], killed: 0,
      opId: `${m.key}#ov${Math.floor(gameClock.now())}`, ownerId: player?.id, startedBy: player?.name, notice: "", spawnTimer: 0, waveTotal: 0 });
    write(m.key, op);
    return undefined;
  }
  // 地上部隊の1波 (counts: {scrapper, jammer, gnawer, mender})
  function overseerWave(key, counts) {
    const m = terminals().find(x => x.key === key), op = read(key);
    if (!m || op.mode !== "overseer" || !active(op)) return 0;
    op.wave += 1;
    const q = [];
    for (const [k, n] of Object.entries(counts)) for (let i = 0; i < n; i++) q.splice(Math.floor(Math.random() * (q.length + 1)), 0, { type: DEF[k] });
    const dir = Math.floor(Math.random() * op.points.length);
    q.forEach((entry, i) => { entry.point = (dir + (i % 2)) % op.points.length; });
    op.queue.push(...q); op.waveTotal = (op.waveTotal ?? 0) + q.length;
    write(key, op);
    const p = op.points[dir];
    broadcast(m, `§c地上部隊 第${op.wave}波§r · ${compassOf(p.x - m.x, p.z - m.z)}から ${q.length}体`);
    return q.length;
  }
  function stopOverseerOp(key) {
    const op = read(key);
    if (op.mode !== "overseer" || !active(op)) return;
    clearEnemies(op); removeObjective(op);
    Object.assign(op, { status: "idle", mode: "normal", queue: [], enemies: [], siege: undefined, breach: undefined, gnaw: undefined, heal: undefined, jam: undefined });
    write(key, op);
  }
  const overseerOpState = key => { const op = read(key); return { active: op.mode === "overseer" && active(op), hp: op.hp, status: op.status, reason: op.reason, mode: op.mode, left: (op.queue?.length ?? 0) + enemiesOf(op).length }; };
  function queueWave(op) {
    const w = wavesOf(op)[op.wave - 1], q = [];
    for (let i = 0; i < (w.scrapper ?? 0); i++) q.push({ type: DEF.scrapper });
    for (let i = 0; i < (w.jammer ?? 0); i++) q.splice(Math.min(q.length, 3 + i * 4), 0, { type: DEF.jammer });
    for (let i = 0; i < (w.gnawer ?? 0); i++) q.splice(Math.min(q.length, 1 + i * 3), 0, { type: DEF.gnawer });   // 先頭寄り: 砲塔へ先に走る
    for (let i = 0; i < (w.mender ?? 0); i++) q.splice(Math.min(q.length, 6 + i * 6), 0, { type: DEF.mender });   // 後方: 群れの後ろに付く
    q.forEach((entry, index) => { entry.point = (index + op.wave - 1) % op.points.length; });
    if (w.siege) q.splice(Math.min(q.length, 4), 0, { type: DEF.siege, point: op.siegeAt?.point ?? 0, big: true });
    op.queue = q; op.waveTotal = q.length; op.spawnTimer = 0;
  }
  function spawnSquad(m, op) {
    const dim = world.getDimension(m.dim);
    for (let n = 0; n < DEFENSE.squadSize && op.queue.length; n++) {
      const next = op.queue[0], p = op.points[next.point] ?? op.points[0];
      const at = next.big ? bigGround(dim, op.siegeAt ?? p)
        : groundAt(dim, Math.floor(p.x + (Math.random() * 4 - 2)), Math.floor(p.z + (Math.random() * 4 - 2)), Math.floor(p.y)) ?? p;
      if (!at) { op.notice = "攻城機の出現場所が塞がれています。周囲を空けてください。"; return; }
      let e;
      try { if (!dim.getBlock(at)) return; e = dim.spawnEntity(next.type, at); } catch { return; }
      op.queue.shift();
      e.addTag("ofd_op"); e.setDynamicProperty("of:op", op.opId); e.setDynamicProperty("of:terminal", m.key);
      op.enemies.push(e.id);
      if (next.type === DEF.siege) {
        const spec = DEFENSE.enemy[DEF.siege];
        op.siege = { id: e.id, hp: spec.hp, l: spec.cooler, r: spec.cooler, openUntil: 0, shockAt: 0, nextShock: now() + 10 };
        e.setDynamicProperty("of:hp", spec.hp);
        for (let k = 0; k < 6; k++) particle(dim, `${NS}:spawn_column`, { x: at.x + Math.cos(k) * 1.4, y: at.y + .1, z: at.z + Math.sin(k) * 1.4 });
        sound(dim, "mob.wither.spawn", at, .5, 1); sound(dim, "mob.ravager.roar", at, .6, 1);
        broadcast(m, `§c攻城機 接近！§r ${compassOf(at.x - m.x, at.z - m.z)}から · 左右の冷却器を壊すと正面装甲が開く`);
      }
      particle(dim, `${NS}:enemy_warp`, { x: at.x, y: at.y + .6, z: at.z });
      particle(dim, `${NS}:spawn_column`, { x: at.x, y: at.y + .1, z: at.z });
      sound(dim, "mob.endermen.portal", at, .7, .6);
    }
  }

  // デバッグ用スポーンエッグ: 出した個体を、近くで進行中の防衛作戦に「波で出た敵」と全く同じ形で登録する
  function enlist(e, maxDist = 128, dryRun = false) {
    const loc = e.location;
    let best, bestD = maxDist;
    for (const m of terminals()) {
      if (m.dim !== e.dimension.id) continue;
      const op = read(m.key); if (!active(op)) continue;
      const d = dist(m, loc); if (d < bestD) { best = { m, op }; bestD = d; }
    }
    if (!best) return false;
    if (dryRun) return true;
    const { m, op } = best;
    e.addTag("ofd_op"); e.setDynamicProperty("of:op", op.opId); e.setDynamicProperty("of:terminal", m.key);
    (op.enemies ??= []).push(e.id);
    op.waveTotal = (op.waveTotal ?? 0) + 1;
    if (e.typeId === DEF.siege) {
      if (op.siege && enemiesOf(op).some(x => x.id === op.siege.id)) { e.remove(); return "siege_busy"; }
      const spec = DEFENSE.enemy[DEF.siege];
      op.siege = { id: e.id, hp: spec.hp, l: spec.cooler, r: spec.cooler, openUntil: 0, shockAt: 0, nextShock: now() + 10 };
      e.setDynamicProperty("of:hp", spec.hp);
      broadcast(m, `§c攻城機 接近！§r ${compassOf(e.location.x - m.x, e.location.z - m.z)}から · 左右の冷却器を壊すと正面装甲が開く`);
    }
    write(m.key, op);
    return true;
  }

  // ---- 砲塔 ----
  function registerTurrets(m) {
    const op = read(m.key), list = [];
    for (const t of turrets()) {
      if (t.dim !== m.dim || dist(t, m) > DEFENSE.turretLink) continue;
      const s = readTurret(t.key);
      if (s.terminal && s.terminal !== m.key && active(read(s.terminal))) continue;   // 進行中の別作戦の砲塔は奪わない
      s.terminal = m.key; writeTurret(t.key, s); list.push(t.key);
    }
    op.turrets = list; write(m.key, op);
    return list.length;
  }
  function lineOfSight(dim, from, to, ignoredBlock) {
    const d = dist(from, to), steps = Math.ceil(d / .4);
    for (let i = 1; i < steps; i++) {
      const k = i / steps, pos = { x: Math.floor(from.x + (to.x - from.x) * k), y: Math.floor(from.y + (to.y - from.y) * k), z: Math.floor(from.z + (to.z - from.z) * k) };
      if (ignoredBlock && pos.x === ignoredBlock.x && pos.y === ignoredBlock.y && pos.z === ignoredBlock.z) continue;
      let b; try { b = dim.getBlock(pos); } catch { return false; }
      if (!b || isSolid(b.typeId)) return false;
    }
    return true;
  }
  function turretStatus(t, s, profile) {
    if ((s.jammedUntil ?? 0) > now()) return "妨害中";
    if (s.ammo <= 0) return "弾切れ";
    if (expansion.hasPower && !expansion.hasPower(t.key)) return "電力不足（ケーブル未接続）";
    if (expansion.availablePower(t.key) < profile.energy) return "電力不足";
    return s.engaged ? "交戦中" : "待機";
  }
  function setTurretPose(block, patch) {
    try {
      let perm = block.permutation;
      for (const [name, value] of Object.entries(patch)) if (perm.getState(`${NS}:${name}`) !== undefined && perm.getState(`${NS}:${name}`) !== value) perm = perm.withState(`${NS}:${name}`, value);
      if (perm !== block.permutation) block.setPermutation(perm);
    } catch {}
  }
  function turretKnockback(enemy, from, aim) {
    if (enemy.typeId === DEF.siege || !enemy.isValid) return;
    const dx = aim.x - from.x, dz = aim.z - from.z, length = Math.hypot(dx, dz);
    if (length < .001) return;
    try { enemy.applyImpulse({ x: dx / length * .48, y: .12, z: dz / length * .48 }); } catch {}
  }
  const turretReady=new Map();
  function tickTurret(t) {
    const dim = world.getDimension(t.dim);
    let block; try { block = dim.getBlock(t); } catch { return; }
    const profile = TURRET_PROFILES[block?.typeId];
    if (!profile || t.type !== block.typeId) return;
    const s = readTurret(t.key), op = s.terminal ? read(s.terminal) : undefined;
    const due=turretReady.get(t.key);
    if(due!==undefined ? due>system.currentTick : (s.nextShotAt??0)>now())return;
    turretReady.set(t.key,system.currentTick+10);
    const speed=affordableSpeed(core.speedLimit(t.key),expansion.availablePower(t.key),value=>profile.energy*value);
    if(!speed&&s.engaged)checkShort(t.key,profile.energy,expansion.availablePower(t.key));
    const cost=profile.energy*speed;
    const jammed = (s.jammedUntil ?? 0) > now();
    setTurretPose(block, { lamp: jammed ? 2 : s.ammo > 0 ? 1 : 0, fire: false });
    if (jammed) {
      particle(dim, `${NS}:jam_spark`, { x: t.x + .5, y: t.y + 1.1, z: t.z + .5 });
      particle(dim, `${NS}:turret_zap`, { x: t.x + .5, y: t.y + .7, z: t.z + .5 });
      sound(dim, "random.fizz", { x: t.x + .5, y: t.y + 1, z: t.z + .5 }, 1.6 + Math.random() * .3, .35);
      return;
    }
    s.engaged = false;
    const terminal = s.terminal ? terminals().find(m => m.key === s.terminal) : undefined;
    if (s.ammo <= 0 || !speed) {
      writeTurret(t.key, s);
      return;
    }
    const muzzle = { x: t.x + .5, y: t.y + profile.muzzleY, z: t.z + .5 };
    const defending = op?.status === "wave" && terminal && dim.getPlayers({
      location: center(terminal), maxDistance: DEFENSE.presenceRange
    }).length;
    const waveEnemies = defending ? enemiesOf(op) : [];
    const monsters = dim.getEntities?.({ location: muzzle, maxDistance: profile.range + 2, families: ["monster"], excludeTypes: ["minecraft:enderman"] }) ?? [];
    const candidates = [...waveEnemies, ...monsters.filter(e => e.typeId.startsWith("minecraft:"))].flatMap(e => {
      const spec = DEFENSE.enemy[e.typeId];
      if (!e.isValid || e.dimension.id !== t.dim || (spec && e.getDynamicProperty("of:dead"))) return [];
      const feet = e.location;
      const head = spec ? undefined : e.getHeadLocation();
      const aim = { x: feet.x, y: spec ? feet.y + spec.aimHeight : (feet.y + head.y) / 2, z: feet.z };
      const d = dist(aim, muzzle);
      if (d > profile.range || !lineOfSight(dim, muzzle, aim, t)) return [];
      const priority = e.typeId === DEF.jammer || e.typeId === DEF.mender ? 0 : e.typeId === DEF.gnawer && d < 8 ? 0 : spec ? 1 : 2;
      return [{ e, d, aim, priority }];
    }).sort((a, b) => a.priority - b.priority || a.d - b.d);
    const target = candidates[0];
    if (!target) { writeTurret(t.key, s); return; }
    if (!expansion.spend(t.key, cost)) { writeTurret(t.key, s); return; }
    const forwardX = target.aim.x - muzzle.x, forwardZ = target.aim.z - muzzle.z;
    const forwardLength = Math.hypot(forwardX, forwardZ);
    const hits = [target];
    if (profile.spread && forwardLength > .001) {
      const cosine = Math.cos(35 * Math.PI / 180);
      for (const candidate of candidates.slice(1)) {
        const x = candidate.aim.x - muzzle.x, z = candidate.aim.z - muzzle.z;
        const length = Math.hypot(x, z);
        if (length > .001 && (x * forwardX + z * forwardZ) / (length * forwardLength) >= cosine) hits.push(candidate);
        if (hits.length === 5) break;
      }
    }
    for (const hit of hits) {
      const enemy = hit.e;
      let landed = false;
      if (DEFENSE.enemy[enemy.typeId]) landed = hurtEnemy(enemy, profile.damage, undefined, true, muzzle) > 0;
      else try { landed = enemy.applyDamage(profile.damage); } catch {}
      if (landed) turretKnockback(enemy, muzzle, hit.aim);
    }
    turretReady.set(t.key,scheduledStart(due,system.currentTick,1)+20*profile.interval/speed);
    s.nextShotAt = now() + profile.interval/speed;
    s.ammo--; s.engaged = true; s.shots = (s.shots ?? 0) + 1;
    writeTurret(t.key, s);
    const dx = target.aim.x - muzzle.x, dz = target.aim.z - muzzle.z;
    setTurretPose(block, { yaw: turretYaw(dx, dz), fire: true, lamp: s.ammo > 0 ? 1 : 0 });
    system.runTimeout(() => { try { if (block.typeId === t.type) setTurretPose(block, { fire: false }); } catch {} }, Math.max(1,visualStepTicks(speed)/2));
    // 演出: 銅色のマズルフラッシュ・曳光・着弾の火花。当たり判定はここで完結
    const angle = turretYaw(dx, dz) * Math.PI / 4;
    const tip = { x: muzzle.x + profile.muzzleLength * Math.sin(angle), y: muzzle.y, z: muzzle.z - profile.muzzleLength * Math.cos(angle) };
    particle(dim, `${NS}:muzzle_flash`, tip);
    particle(dim, `${NS}:muzzle_smoke`, tip);
    const rail = profile.tracer === "rail_tracer";
    if (rail) {   // レールガン: 砲口の衝撃リング+着弾の青白い閃光
      particle(dim, `${NS}:rail_ring`, tip); particle(dim, `${NS}:turret_zap`, { x: muzzle.x, y: muzzle.y + .2, z: muzzle.z });
    } else {      // 実弾系: 薬莢が横へ跳ねる（ショットガンは2発）
      for (let i = 0; i < (profile.spread ? 2 : 1); i++) particle(dim, `${NS}:shell_casing`, { x: muzzle.x + Math.cos(angle) * .3, y: muzzle.y + .1, z: muzzle.z + Math.sin(angle) * .3 });
    }
    for (const hit of hits) {
      for (let k = .12; k < 1; k += profile.spread ? .24 : .12) {
        particle(dim, `${NS}:${profile.tracer}`, {
          x: tip.x + (hit.aim.x - tip.x) * k,
          y: tip.y + (hit.aim.y - tip.y) * k,
          z: tip.z + (hit.aim.z - tip.z) * k,
        });
      }
      particle(dim, `${NS}:bullet_hit`, hit.aim);
      if (rail) particle(dim, `${NS}:rail_impact`, hit.aim);
    }
    sound(dim, profile.sound, muzzle, profile.pitch, profile.volume ?? .55);
  }
  function loadAmmo(key, amount, profile = TURRET_PROFILES[DEF.turret]) {
    const s = readTurret(key);
    const n = Math.max(0, Math.min(profile.maxAmmo - s.ammo, amount));
    s.ammo += n; writeTurret(key, s); return n;
  }
  function view(block, key, output) {
    const profile = TURRET_PROFILES[block.typeId];
    if (!profile) return undefined;
    if (output) return null;
    const accepts = item => item.typeId === profile.ammo;
    return { block, storage: { size: 0, getItem() {}, setItem() {} }, slots: [], itemFilter: accepts,
      virtualRoom: item => accepts(item) ? Math.max(0, Math.min(item.amount, profile.maxAmmo - readTurret(key).ammo)) : 0,
      virtualInsert: item => accepts(item) ? loadAmmo(key, item.amount, profile) : 0 };
  }

  // ---- 敵の行動 ----
  function tickEnemies(m, op) {
    const dim = world.getDimension(m.dim), c = center(m), t = now();
    op.hits ??= {}; op.stuck ??= {};
    for (const e of enemiesOf(op)) {
      const spec = DEFENSE.enemy[e.typeId]; if (!spec) continue;
      const d = flat(e.location, c);
      // 端末への攻撃 (1.5ブロック以内・2秒ごと)
      if (d <= (spec.contactRange ?? 2.1) && Math.abs(e.location.y - m.y) < 2.5 && (op.hits[e.id] ?? 0) <= t) {
        op.hits[e.id] = t + spec.hitEvery;
        op.hp = Math.max(0, op.hp - spec.hitTerminal);
        particle(dim, `${NS}:terminal_hit`, { x: c.x, y: c.y + .4, z: c.z });
        particle(dim, `${NS}:terminal_shock`, { x: c.x, y: c.y + .1, z: c.z });
        sound(dim, "random.anvil_land", c, 1.8, .35);
      }
      // 経路復帰: 4秒進まなければ端末方向へ押し出し＋ジャンプ、12秒で端末寄りの地面へ再配置。
      // (旧版は出現点[0]へ戻していたため、遠い/同じ詰まり場所へ戻り AI が目標を見失うことがあった)
      if (e.typeId === DEF.siege) {
        tickSiege(m, op, e, spec, t, d);
        continue;
      }
      const st = op.stuck[e.id] ?? { d, t };
      if (d < st.d - 1) op.stuck[e.id] = { d, t };
      else {
        const idle = t - st.t;
        if (d > 3 && idle > 12) { relocateToward(dim, e, c, m); op.stuck[e.id] = { d: flat(e.location, c), t }; }
        else { if (d > 3 && idle > 4 && !(e.typeId === DEF.jammer && op.jam?.[e.id]?.target)) steer(e, c, 1.2, 4); op.stuck[e.id] = st; }
      }
      if (e.typeId === DEF.scrapper) tickScrapper(op, e, d, c, t);
      if (e.typeId === DEF.jammer) tickJammer(m, op, e, spec);
      if (e.typeId === DEF.mender) tickMender(op, e, spec, t);
      if (e.typeId === DEF.gnawer) tickGnawer(m, op, e, spec, t);
    }
  }
  // 統合版のモブは AI の歩行制御が applyImpulse の水平速度をすぐ打ち消すため、
  // 突進・横ステップ・押し出しは「数 tick に分けた短いテレポート」で動かす (地形に沿って1段の昇降まで)。
  function passable(dim, x, y, z) {
    try { return !isSolid(dim.getBlock({ x, y, z })?.typeId) && !isSolid(dim.getBlock({ x, y: y + 1, z })?.typeId); } catch { return false; }
  }
  function glide(e, dirX, dirZ, distance, ticks, trail) {
    const l = Math.hypot(dirX, dirZ) || 1, step = distance / ticks, ux = dirX / l, uz = dirZ / l;
    for (let i = 1; i <= ticks; i++) system.runTimeout(() => {
      try {
        if (!e.isValid) return;
        const dim = e.dimension, p = e.location, nx = p.x + ux * step, nz = p.z + uz * step, bx = Math.floor(nx), bz = Math.floor(nz), by = Math.floor(p.y + .01);
        let y;
        for (const dy of [0, 1, -1]) if (passable(dim, bx, by + dy, bz) && isSolid(dim.getBlock({ x: bx, y: by + dy - 1, z: bz })?.typeId)) { y = by + dy; break; }
        if (y === undefined) return;
        e.teleport({ x: nx, y, z: nz }, { facingLocation: { x: nx + ux, y: y + 1, z: nz + uz } });
        if (trail) particle(dim, `${NS}:${trail}`, { x: nx, y: y + .2, z: nz });
      } catch {}
    }, i);
  }
  function steer(e, c, distance, ticks = 4, trail) {
    glide(e, c.x - e.location.x, c.z - e.location.z, distance, ticks, trail);
  }
  function relocateToward(dim, e, c, m) {
    const d = flat(e.location, c);
    for (const f of [.45, .6, .75, .3]) {
      const x = Math.floor(e.location.x + (c.x - e.location.x) * f), z = Math.floor(e.location.z + (c.z - e.location.z) * f);
      if (Math.hypot(x - c.x, z - c.z) < 5 || d * (1 - f) < 4) continue;
      const g = groundAt(dim, x, z, Math.floor(m.y));
      if (!g) continue;
      particle(dim, `${NS}:jam_burst`, { x: e.location.x, y: e.location.y + .8, z: e.location.z });
      try { e.teleport({ x: x + .5, y: g.y, z: z + .5 }, { facingLocation: c }); } catch { continue; }
      sound(dim, "mob.shulker.teleport", { x: x + .5, y: g.y, z: z + .5 }, 1.3, .5);
      return true;
    }
    steer(e, c, 1.5, 5); return false;
  }
  // スクラッパー: 中距離で「ギュイン」と溜めてから直線突進
  function tickScrapper(op, e, d, c, t) {
    op.dash ??= {};
    const k = op.dash[e.id] ?? { next: t + 4 + Math.random() * 4 };
    if (k.windup && t >= k.windup) {
      steer(e, c, Math.min(6, d - 2), 8, "enemy_dash"); k.windup = 0; k.next = t + 7 + Math.random() * 4;
      particle(e.dimension, `${NS}:enemy_dash`, { x: e.location.x, y: e.location.y + .4, z: e.location.z });
      sound(e.dimension, "mob.ravager.roar", e.location, 2.2, .35);
    } else if (!k.windup && t >= k.next && d > 5 && d < 24) {
      k.windup = t + 1;
      particle(e.dimension, `${NS}:enemy_dash`, { x: e.location.x, y: e.location.y + 1.2, z: e.location.z });
      sound(e.dimension, "random.click", e.location, 2, .7);
    }
    op.dash[e.id] = k;
  }
  // ジャマー → 砲塔へ電撃ビーム（予告=細い紫の点線 / 妨害中=ギザギザの稲妻）
  function zapBeam(dim, from, to, strong) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, len = Math.hypot(dx, dy, dz);
    const n = Math.max(3, Math.ceil(len / (strong ? .35 : .6)));
    for (let i = 0; i <= n; i++) {
      const f = i / n, j = strong && i > 0 && i < n ? .28 : 0;
      particle(dim, `${NS}:jam_beam${strong ? "" : "_warn"}`, { x: from.x + dx * f + (Math.random() - .5) * j, y: from.y + dy * f + (Math.random() - .5) * j, z: from.z + dz * f + (Math.random() - .5) * j });
    }
    if (strong) particle(dim, `${NS}:jam_spark`, to);
  }
  function drawJamBeams(m, op) {
    const t = now(), dim = world.getDimension(m.dim);
    for (const [id, j] of Object.entries(op.jam ?? {})) {
      const key = j.target ?? (j.zapUntil > t ? j.zapTarget : undefined); if (!key) continue;
      let e; try { e = world.getEntity(id); } catch {} if (!e?.isValid) continue;
      const tm = turrets().find(x => x.key === key); if (!tm) continue;
      zapBeam(dim, { x: e.location.x, y: e.location.y + 1.7, z: e.location.z }, { x: tm.x + .5, y: tm.y + 1.05, z: tm.z + .5 }, !j.target);
    }
  }

  // ---- 修理ドローン: 群れの後ろに浮かび、一番傷ついた味方へ緑のビーム ----
  function maxHpOf(e) { return DEFENSE.enemy[e.typeId]?.hp ?? 20; }
  function beam(dim, from, to, id, step = .45) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, n = Math.max(2, Math.ceil(Math.hypot(dx, dy, dz) / step));
    for (let i = 0; i <= n; i++) particle(dim, `${NS}:${id}`, { x: from.x + dx * i / n, y: from.y + dy * i / n, z: from.z + dz * i / n });
  }
  function tickMender(op, e, spec, t) {
    const dim = e.dimension, allies = enemiesOf(op).filter(a => a.id !== e.id);
    op.heal ??= {};
    const h = op.heal[e.id] ?? { next: t + 2 };
    // 位置取り: 味方の重心から少し後ろ (端末と反対側) に付く。味方がいなければその場で旋回
    if (allies.length) {
      const cx = allies.reduce((a, b) => a + b.location.x, 0) / allies.length, cz = allies.reduce((a, b) => a + b.location.z, 0) / allies.length;
      const dx = cx - e.location.x, dz = cz - e.location.z, d = Math.hypot(dx, dz);
      if (d > 4) glide(e, dx, dz, Math.min(2.2, d - 3), 5);
      else glide(e, -dz, dx, .8, 4);   // 横に漂う (ホバリング)
    }
    if (t >= h.next) {
      h.next = t + spec.healEvery;
      // 治療対象: 攻城機の冷却器 > 一番HP割合の低い味方
      let target, kind = "hp";
      const b = op.siege, boss = b?.id && allies.find(a => a.id === b.id);
      const coolSpec = DEFENSE.enemy[DEF.siege];
      if (boss && dist(boss.location, e.location) <= spec.healRange && (b.openUntil ?? 0) <= t && ((b.l > 0 && b.l < coolSpec.cooler) || (b.r > 0 && b.r < coolSpec.cooler))) { target = boss; kind = "cooler"; }
      if (!target) target = allies.filter(a => dist(a.location, e.location) <= spec.healRange && !a.getDynamicProperty("of:dead") && hpOf(a) < maxHpOf(a))
        .sort((a, b2) => hpOf(a) / maxHpOf(a) - hpOf(b2) / maxHpOf(b2))[0];
      if (target) {
        if (kind === "cooler") {
          if (b.l > 0) b.l = Math.min(coolSpec.cooler, b.l + spec.heal); if (b.r > 0) b.r = Math.min(coolSpec.cooler, b.r + spec.heal);
        } else {
          const hp = Math.min(maxHpOf(target), hpOf(target) + spec.heal); target.setDynamicProperty("of:hp", hp);
          if (target.id === b?.id) b.hp = hp;
        }
        const from = { x: e.location.x, y: e.location.y + 1.1, z: e.location.z }, to = { x: target.location.x, y: target.location.y + (DEFENSE.enemy[target.typeId]?.aimHeight ?? 1), z: target.location.z };
        for (const delay of [0, 4, 8]) system.runTimeout(() => { try { beam(dim, from, to, "mender_beam"); } catch {} }, delay);
        particle(dim, `${NS}:heal_spark`, to);
        sound(dim, "beacon.activate", from, 2, .35);
        try { e.setProperty(`${NS}:charging`, true); system.runTimeout(() => { try { e.setProperty(`${NS}:charging`, false); } catch {} }, 16); } catch {}
      }
    }
    op.heal[e.id] = h;
  }
  // ---- ボルトラット: 一番近い装填済みの砲塔へ走り、隣に着いたら弾薬をかじる ----
  function tickGnawer(m, op, e, spec, t) {
    const dim = e.dimension;
    op.gnaw ??= {};
    let best, bd = Infinity;
    for (const [i, tk] of (op.turrets ?? []).entries()) {
      const tm = turrets().find(x => x.key === tk); if (!tm || tm.dim !== e.dimension.id) continue;
      if (readTurret(tk).ammo <= 0) continue;
      const d = flat(e.location, { x: tm.x + .5, z: tm.z + .5 }); if (d < bd && d <= spec.seek) { bd = d; best = { tm, tk, i }; }
    }
    let gnawing = false;
    if (best) {
      const tc = { x: best.tm.x + .5, y: best.tm.y, z: best.tm.z + .5 };
      if (bd <= spec.chewRange) {
        gnawing = true;
        const s = readTurret(best.tk), took = Math.min(s.ammo, spec.chew);
        s.ammo -= took; writeTurret(best.tk, s);
        try { e.teleport(e.location, { facingLocation: { x: tc.x, y: tc.y + .5, z: tc.z } }); } catch {}
        particle(dim, `${NS}:gnaw_chips`, { x: (e.location.x + tc.x) / 2, y: tc.y + .5, z: (e.location.z + tc.z) / 2 });
        sound(dim, "random.eat", e.location, 1.8 + Math.random() * .3, .55);
        if (!op.gnaw[e.id]?.warned) { op.notice = `砲塔${letter(best.i)}の弾薬がかじられている！`; broadcast(m, op.notice); }
        op.gnaw[e.id] = { warned: true };
      } else if (bd < 10) glide(e, tc.x - e.location.x, tc.z - e.location.z, Math.min(2.4, bd - 1.2), 4, "enemy_dash");   // 近くまで来たら駆け込む
    }
    try { if (e.getProperty(`${NS}:charging`) !== gnawing) e.setProperty(`${NS}:charging`, gnawing); } catch {}
  }
  // ---- 攻城機 ----
  const debugSiegeKey = "of:siege_preview";
  function readDebugSiege(e, spec) {
    const saved = e.getDynamicProperty(debugSiegeKey);
    if (typeof saved === "string") return JSON.parse(saved);
    return { hp: hpOf(e), l: spec.cooler, r: spec.cooler, openUntil: 0 };
  }
  function stopSiege(e) {
    try { e.triggerEvent(`${NS}:channel`); } catch {}
    try { e.clearVelocity(); } catch {}
  }
  function restoreSiege(e, b, spec, t) {
    if (!(b.openUntil > 0 && b.openUntil <= t)) return false;
    b.openUntil = 0;
    b.l = spec.cooler;
    b.r = spec.cooler;
    try { e.triggerEvent(`${NS}:move`); } catch {}
    return true;
  }
  function scheduleDebugSiegeReset(e, deadline) {
    system.runTimeout(() => {
      try {
        if (!e.isValid || e.getDynamicProperty("of:dead")) return;
        const t = now(), spec = DEFENSE.enemy[DEF.siege], b = readDebugSiege(e, spec);
        if (b.openUntil !== deadline) return;
        if (t < deadline) { scheduleDebugSiegeReset(e, deadline); return; }
        if (restoreSiege(e, b, spec, t)) {
          e.setDynamicProperty(debugSiegeKey, JSON.stringify(b));
          siegeVisual(e, b, t);
        }
      } catch {}
    }, Math.max(1, Math.ceil((deadline - now()) * 20)));
  }
  function rayBoxDistance(origin, direction, minimum, maximum) {
    let near = 0, far = 7.5;   // 近接の照準確認。攻撃イベントが発生したときだけ使う
    for (let axis = 0; axis < 3; axis++) {
      const d = direction[axis], p = origin[axis];
      if (Math.abs(d) < 1e-6) {
        if (p < minimum[axis] || p > maximum[axis]) return Infinity;
        continue;
      }
      const a = (minimum[axis] - p) / d, b = (maximum[axis] - p) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (far < near) return Infinity;
    }
    return near;
  }
  function siegeSide(e, from, aim) {
    if (!from) return "front";
    const { fx, fz } = siegeFrame(e);
    const local = (x, y, z) => [x * -fz + z * fx, y, x * fx + z * fz];
    if (aim) {
      const p = local(aim.eye.x - e.location.x, aim.eye.y - e.location.y, aim.eye.z - e.location.z);
      const d = local(aim.direction.x, aim.direction.y, aim.direction.z);
      // モデルの側面にある冷却器。照準が先に装甲を通る場合は従来の向き判定へ戻す。
      const left = rayBoxDistance(p, d, [-3.85, 2.1, -2.15], [-2.30, 4.25, 1.4]);
      const right = rayBoxDistance(p, d, [2.30, 2.1, -2.15], [3.85, 4.25, 1.4]);
      const armor = rayBoxDistance(p, d, [-2.44, 1.5, -3.75], [2.44, 4.88, 4.32]);
      if (Math.min(left, right) < armor) return left < right ? "left" : "right";
    }
    const [right, , forward] = local(from.x - e.location.x, 0, from.z - e.location.z);
    const length = Math.hypot(right, forward);
    if (!length || forward / length >= Math.SQRT1_2) return "front";
    if (forward / length <= -Math.SQRT1_2) return "rear";
    return right > 0 ? "right" : "left";
  }
  const SIEGE_DOOR_OPEN = 3.2, SIEGE_DOOR_CLOSE = 3.2;   // 扉アニメの長さ (秒)。RP の armor_open / armor_closing と合わせる
  function scheduleDoorClose(e, deadline) {
    system.runTimeout(() => {
      try {
        if (!e.isValid || e.getDynamicProperty("of:dead") || !e.getProperty(`${NS}:open`)) return;
        e.setProperty(`${NS}:closing`, true);
        const p = siegeFrame(e).core;
        e.dimension.playSound("random.door_close", p, { pitch: .45, volume: 1 }); e.dimension.playSound("mob.irongolem.walk", p, { pitch: .5, volume: 1 });
        particle(e.dimension, `${NS}:siege_steam`, p);
      } catch {}
    }, Math.max(1, Math.round((deadline - now() - SIEGE_DOOR_CLOSE) * 20)));
  }
  function siegeVisual(e, b, t) {
    const set = (k, v) => { try { if (e.getProperty(`${NS}:${k}`) !== v) e.setProperty(`${NS}:${k}`, v); } catch {} };
    const open = (b.openUntil ?? 0) > t;
    set("cool_l", b.l > 0); set("cool_r", b.r > 0); set("open", open); set("charging", (b.shockAt ?? 0) > t);
    set("closing", open && b.openUntil - t <= SIEGE_DOOR_CLOSE);   // 開放の最後 3.2 秒で扉がゆっくり閉まる
  }
  function siegeHit(e, damage, from, mult, aim, attacker, pierce = 0) {
    const key = e.getDynamicProperty("of:terminal"), op = key && read(key);
    const raid = op?.siege?.id === e.id;
    const debug = !raid && e.getDynamicProperty("of:debug");
    if (!raid && !debug) return undefined;
    const spec = DEFENSE.enemy[DEF.siege], t = now(), dim = e.dimension;
    const b = raid ? op.siege : readDebugSiege(e, spec);
    if (debug) restoreSiege(e, b, spec, t);
    const open = (b.openUntil ?? 0) > t;
    const side = siegeSide(e, from, aim), dealt = damage * mult;
    const frame = siegeFrame(e);
    let notice;
    let body = 0;
    if (open) body = dealt;
    else if ((side === "left" || side === "right") && b[side[0]] > 0) {
      const k = side[0]; b[k] = Math.max(0, b[k] - dealt);
      const p = side === "left" ? frame.coolL : frame.coolR;
      particle(dim, `${NS}:bullet_hit`, p);
      if (b[k] <= 0) {
        particle(dim, `${NS}:cooler_burst`, p); particle(dim, `${NS}:enemy_wreck`, p); particle(dim, `${NS}:armor_open_flash`, p);
        if (side === "left") { particle(dim, `${NS}:frost_mist`, p); particle(dim, `${NS}:coolant_leak`, p); sound(dim, "random.glass", p, .6, 1.2); sound(dim, "block.turtle_egg.crack", p, .5, 1); }
        else { particle(dim, `${NS}:cooler_fire`, p); try { dim.spawnParticle("minecraft:large_explosion", p); } catch {} sound(dim, "random.explode", p, 1.1, .9); }
        sound(dim, "random.fizz", p, .6, .9); shake(dim, p, 16, .3, .4);
        notice = `${side === "left" ? "左" : "右"}の冷却器を破壊！` + (b.l <= 0 && b.r <= 0 ? "" : " もう片方も壊せ");
      }
      if (b.l <= 0 && b.r <= 0 && !open) {
        b.openUntil = t + spec.openSec; b.shockAt = 0;   // 予告中の衝撃波は中断
        stopSiege(e); scheduleDoorClose(e, b.openUntil);
        if (debug) scheduleDebugSiegeReset(e, b.openUntil);
        notice = `§a正面装甲が開いた！ ${spec.openSec}秒間 本体に等倍ダメージ§r`;
        sound(dim, "random.anvil_break", e.location, .6, 1); sound(dim, "mob.irongolem.death", e.location, .6, .8);
        const fr = siegeFrame(e);
        particle(dim, `${NS}:armor_open_flash`, fr.core); particle(dim, `${NS}:core_flare`, fr.core); particle(dim, `${NS}:siege_column`, fr.core);
        for (const s2 of [-3.4, 3.4]) { particle(dim, `${NS}:siege_steam`, fr.at(2.6, s2, 4.2)); particle(dim, `${NS}:siege_steam`, fr.at(1, s2, 6)); }
        system.runTimeout(() => {
          try {
            if (!e.isValid || e.getDynamicProperty("of:dead") || !e.getProperty(`${NS}:open`)) return;
            sound(e.dimension, "random.anvil_land", siegeFrame(e).core, .55, 1.2);
            shake(e.dimension, e.location, 20, .32, .4);
          } catch {}
        }, Math.round(SIEGE_DOOR_OPEN * 20));   // 装甲扉がレールの端に達したとき
        try { for (const pl of dim.getPlayers({ location: e.location, maxDistance: 48 })) pl.onScreenDisplay?.setTitle("§l§6弱点露出！", { subtitle: `§e正面の炉心を撃て · ${spec.openSec}秒`, fadeInDuration: 2, stayDuration: 30, fadeOutDuration: 8 }); } catch {}
        if (raid) broadcast(m0(key), notice);
      }
    } else if (side === "rear") body = dealt * (spec.rearPass + (1 - spec.rearPass) * pierce);   // 貫通射撃は軽減の一部を無視
    else { body = dealt * (spec.frontPass + (1 - spec.frontPass) * pierce); particle(dim, `${NS}:armor_ping`, { x: e.location.x, y: e.location.y + 4.2, z: e.location.z }); }
    b.hp = Math.max(0, b.hp - body);
    siegeVisual(e, b, t);
    if (raid) {
      if (notice) op.notice = notice;
      write(key, op);
    } else {
      e.setDynamicProperty(debugSiegeKey, JSON.stringify(b));
      if (attacker?.typeId === "minecraft:player") {
        const armor = b.openUntil > t ? "§a装甲開放§r" : "装甲閉鎖";
        try { attacker.onScreenDisplay.setActionBar(`攻城機 ${Math.ceil(b.hp)}/${spec.hp} · 冷却器 左${Math.ceil(b.l)} 右${Math.ceil(b.r)} · ${armor}`); } catch {}
      }
    }
    return b.hp;
  }
  const m0 = key => terminals().find(x => x.key === key) ?? { key, dim: "minecraft:overworld", x: 0, y: 0, z: 0 };
  // ---- 攻城機の演出ヘルパー (モデルは3倍: 1px = 3/16 ブロック、正面 -Z・右手 +X) ----
  function shake(dim, at, r, intensity, sec) {
    try { dim.runCommand(`camerashake add @a[x=${at.x.toFixed(1)},y=${at.y.toFixed(1)},z=${at.z.toFixed(1)},r=${r}] ${intensity} ${sec} positional`); } catch {}
  }
  function siegeFrame(e) {
    let yaw = 0; try { yaw = e.getRotation().y; } catch {}
    const a = yaw * Math.PI / 180, fx = -Math.sin(a), fz = Math.cos(a);
    const at = (fwd, right, up) => ({ x: e.location.x + fx * fwd - fz * right, y: e.location.y + up, z: e.location.z + fz * fwd + fx * right });
    return { fx, fz, at, core: at(3.9, 0, 3), coolL: at(.4, -3.1, 3.2), coolR: at(.4, 3.1, 3.2), emitter: at(-.4, 0, 7.4), treadL: at(-2.5, -3.2, .3), treadR: at(-2.5, 3.2, .3) };
  }
  function siegeStrikePlayer(e, state, t) {
    if ((state.nextPlayerStrike ?? 0) > t) return;
    const origin = e.location, dim = e.dimension;
    let target, nearest = Infinity;
    for (const player of dim.getPlayers({ location: origin, maxDistance: 12 })) {
      const mode = player.getGameMode();
      if (mode !== GameMode.Survival && mode !== GameMode.Adventure) continue;
      const p = player.location;
      const distance = flat(origin, p);
      if (distance > (DEFENSE.enemy[DEF.siege].meleeRange ?? 5.4) || distance >= nearest || p.y < origin.y - 1.5 || p.y > origin.y + 9) continue;
      const head = player.getHeadLocation();
      const strike = { x: origin.x, y: Math.min(origin.y + 7.5, Math.max(origin.y + .5, head.y)), z: origin.z };
      if (!lineOfSight(dim, strike, head)) continue;
      target = player; nearest = distance;
    }
    if (!target) return;
    state.nextPlayerStrike = t + 3;
    try { target.applyDamage(DEFENSE.enemy[DEF.siege].meleeDamage ?? 16, { cause: "entityAttack", damagingEntity: e }); } catch {}
    // 叩きつけ: 着弾点の砂塵リング・火花・地鳴り
    const p = target.location, f = siegeFrame(e);
    particle(dim, `${NS}:siege_slam`, { x: p.x, y: p.y + .1, z: p.z }); particle(dim, `${NS}:siege_slam_sparks`, { x: p.x, y: p.y + .3, z: p.z });
    particle(dim, `${NS}:terminal_shock`, { x: p.x, y: p.y + .1, z: p.z });
    beam(dim, f.at(3.6, 0, 4.5), { x: p.x, y: p.y + 1, z: p.z }, "siege_wave", .5);
    sound(dim, "random.anvil_land", p, .5, 1); sound(dim, "random.explode", p, 1.2, .7); sound(dim, "mob.ravager.stun", e.location, .6, .9);
    shake(dim, p, 10, .35, .45);
  }
  function tickSiege(m, op, e, spec, t, d) {
    const b = op.siege; if (!b || b.id !== e.id) return;
    siegeStrikePlayer(e, b, t);
    const dim = e.dimension, c = center(m);
    // 復旧: 12秒で装甲が閉じ、冷却器が再起動
    if (restoreSiege(e, b, spec, t)) {
      b.nextShock = Math.max(b.nextShock ?? 0, t + 4);
      op.notice = "攻城機の装甲が閉じた · 冷却器が再起動"; broadcast(m, op.notice);
      sound(dim, "random.door_close", e.location, .5, 1);
    }
    // 排気・履帯の砂煙・破損した冷却器・弱点露出の演出 (毎秒)
    const f = siegeFrame(e), open = (b.openUntil ?? 0) > t;
    for (const side of [-1.4, 1.4]) particle(dim, `${NS}:siege_exhaust`, f.at(-2.9, side, 6.6));
    const moved = flat(e.location, b.lastPos ?? e.location) > .2; b.lastPos = { x: e.location.x, z: e.location.z };
    // 進行の保険: 装甲閉鎖中・充填していないのに3秒動かなければ移動を戻し、6秒で端末方向へ押し出す
    if (!open && !b.shockAt && d > (spec.contactRange ?? 5.4) + .5) {
      b.stillFor = moved ? 0 : (b.stillFor ?? 0) + 1;
      if (b.stillFor === 3 || b.stillFor % 6 === 0 && b.stillFor > 0) { try { e.triggerEvent(`${NS}:move`); } catch {} }
      if (b.stillFor >= 6) steer(e, c, 1.2, 6);
    } else b.stillFor = 0;
    if (moved) { particle(dim, `${NS}:tread_dust`, f.treadL); particle(dim, `${NS}:tread_dust`, f.treadR); if (Math.random() < .4) particle(dim, `${NS}:siege_slam_sparks`, Math.random() < .5 ? f.treadL : f.treadR); }
    if (b.l <= 0) { particle(dim, `${NS}:coolant_leak`, f.coolL); particle(dim, `${NS}:frost_mist`, f.coolL); }
    if (b.r <= 0) { particle(dim, `${NS}:cooler_fire`, f.coolR); particle(dim, `${NS}:jam_spark`, f.coolR); if (Math.random() < .35) sound(dim, "random.fizz", f.coolR, .7, .5); }
    if (open) {
      particle(dim, `${NS}:core_flare`, f.core); particle(dim, `${NS}:siege_steam`, f.at(2.6, -3.4, 4.2)); particle(dim, `${NS}:siege_steam`, f.at(2.6, 3.4, 4.2));
      if (Math.floor(t) % 2 === 0) sound(dim, "note.pling", f.core, 2, .5);
    }
    if (b.hp <= spec.hp / 2 && Math.random() < .6) { particle(dim, `${NS}:wreck_smoke`, f.at(0, 0, 5.4)); if (Math.random() < .4) particle(dim, `${NS}:cooler_fire`, f.at(-1.5, (Math.random() - .5) * 4, 4.5)); }
    // 予告付きの衝撃波: 発射時刻は戦闘データに保存し、ここで条件を再確認してから撃つ
    if (b.shockAt) {
      if ((b.openUntil ?? 0) > t || d > spec.shockRange + 2) { b.shockAt = 0; op.notice = "衝撃波を阻止！"; }
      else if (t >= b.shockAt) {
        b.shockAt = 0; b.nextShock = t + (b.hp <= spec.hp / 2 ? spec.shockEveryEnraged : spec.shockEvery);
        op.hp = Math.max(0, op.hp - spec.shockDamage);
        const ground = { x: e.location.x, y: e.location.y + .3, z: e.location.z };
        // 3重の衝撃リング・砂塵・光柱、端末まで螺旋の衝撃線、両側で地鳴り
        for (const [k, delay] of [[0, 0], [1, 4], [2, 8]]) system.runTimeout(() => { try {
          particle(dim, `${NS}:${k === 1 ? "siege_shock_ring" : "siege_shock_ring_big"}`, { ...ground, y: ground.y + k * .4 });
          if (k === 0) { particle(dim, `${NS}:siege_dust_ring`, ground); particle(dim, `${NS}:siege_column`, f.emitter); particle(dim, `${NS}:armor_open_flash`, f.emitter); }
        } catch {} }, delay);
        const from = f.emitter, to = { x: c.x, y: c.y + .4, z: c.z };
        for (const delay of [0, 2, 4]) system.runTimeout(() => { try {
          const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, n = Math.ceil(Math.hypot(dx, dy, dz) / .45), l = Math.hypot(dx, dz) || 1;
          for (let i = 0; i <= n; i++) {
            const k = i / n, a = k * Math.PI * 6 + delay, r = .7 * Math.sin(k * Math.PI);
            particle(dim, `${NS}:siege_wave`, { x: from.x + dx * k - dz / l * Math.cos(a) * r, y: from.y + dy * k + Math.sin(a) * r, z: from.z + dz * k + dx / l * Math.cos(a) * r });
          }
        } catch {} }, delay);
        system.runTimeout(() => { try {
          particle(dim, `${NS}:terminal_shock`, { x: c.x, y: c.y + .1, z: c.z }); particle(dim, `${NS}:terminal_hit`, { x: c.x, y: c.y + .4, z: c.z });
          particle(dim, `${NS}:siege_slam`, { x: c.x, y: c.y - .4, z: c.z }); particle(dim, `${NS}:siege_slam_sparks`, { x: c.x, y: c.y + .4, z: c.z });
          dim.spawnParticle("minecraft:huge_explosion_emitter", { x: c.x, y: c.y + .6, z: c.z });
          shake(dim, c, 14, .5, .6);
          sound(dim, `${NS}.siege_impact`, c, 1, 1.4);   // 着弾の瞬間 (衝撃線が届いたとき) に鳴らす
        } catch {} }, 6);
        sound(dim, `${NS}.siege_shockwave`, e.location, 1, 1.6);
        sound(dim, "mob.warden.sonic_boom", e.location, .7, .9);
        shake(dim, e.location, 28, .65, .9);
        op.notice = `衝撃波！ 端末 -${spec.shockDamage}`; broadcast(m, op.notice);
        try { e.triggerEvent(`${NS}:move`); } catch {}
      } else {
        particle(dim, `${NS}:siege_charge`, f.emitter); particle(dim, `${NS}:siege_column`, f.emitter); particle(dim, `${NS}:core_flare`, f.emitter);
        particle(dim, `${NS}:jam_spark`, { x: c.x, y: c.y + 1, z: c.z });
        // 射程(半径16)を地面に赤い点線で示す
        const ph = (t * 2) % 1;
        for (let i = 0; i < 40; i++) {
          const a = (i + ph) / 40 * Math.PI * 2, x = e.location.x + Math.cos(a) * spec.shockRange, z = e.location.z + Math.sin(a) * spec.shockRange;
          const g = groundAt(dim, Math.floor(x), Math.floor(z), Math.floor(e.location.y)); particle(dim, `${NS}:siege_range_mark`, { x, y: (g?.y ?? e.location.y) + .15, z });
        }
        shake(dim, e.location, 20, .12, 1);
        sound(dim, "note.bass", c, .5, 1); sound(dim, "beacon.power", e.location, .6 + (spec.shockWarn - (b.shockAt - t)) * .15, .6);
      }
    } else if (d <= spec.shockRange && (b.openUntil ?? 0) <= t && t >= (b.nextShock ?? 0)) {
      b.shockAt = t + spec.shockWarn;
      op.notice = `§c攻城機が衝撃波を充填中！ ${spec.shockWarn}秒 · 冷却器を両方壊すか撃破で中断§r`; broadcast(m, op.notice);
      sound(dim, "mob.wither.ambient", e.location, .5, 1); sound(dim, "beacon.activate", e.location, .5, 1.2);
      try { e.triggerEvent(`${NS}:channel`); } catch {}   // 止まって構える
    }
    siegeVisual(e, b, t);
  }
  function tickJammer(m, op, e, spec) {
    const t = now(), dim = e.dimension;
    op.jam ??= {};
    const j = op.jam[e.id] ?? { ready: 0 };
    if (j.target) {
      // 予告中: 移動を止め、紫の3回点滅
      if (t < j.until) {
        particle(dim, `${NS}:jam_warn`, { x: e.location.x, y: e.location.y + 2.3, z: e.location.z });
        sound(dim, "note.bit", e.location, 2, .5);
      } else {
        const s = readTurret(j.target);
        s.jammedUntil = t + spec.jam; s.immuneUntil = t + spec.jam + spec.immune; s.warnUntil = 0; writeTurret(j.target, s);
        const tm = turrets().find(x => x.key === j.target);
        if (tm) { particle(dim, `${NS}:jam_burst`, { x: tm.x + .5, y: tm.y + 1, z: tm.z + .5 }); sound(dim, "random.fizz", center(tm), .7, .8); }
        try { e.triggerEvent(`${NS}:move`); e.setProperty(`${NS}:charging`, false); } catch {}
        op.notice = `砲塔${letter(Math.max(0, (op.turrets ?? []).indexOf(j.target)))}が妨害で${spec.jam}秒停止`;
        j.zapTarget = j.target; j.zapUntil = t + spec.jam;
        j.target = undefined; j.ready = t + spec.cooldown;
      }
      op.jam[e.id] = j; return;
    }
    if (j.ready > t) { op.jam[e.id] = j; return; }
    for (const [i, tk] of (op.turrets ?? []).entries()) {
      const tm = turrets().find(x => x.key === tk); if (!tm) continue;
      const s = readTurret(tk);
      if ((s.jammedUntil ?? 0) > t || (s.immuneUntil ?? 0) > t || (s.warnUntil ?? 0) > t) continue;
      const tc = { x: tm.x + .5, y: tm.y + 1.1, z: tm.z + .5 };
      if (dist(e.location, tc) > spec.jamRange || !lineOfSight(dim, { x: e.location.x, y: e.location.y + 1.6, z: e.location.z }, tc)) continue;
      j.target = tk; j.until = t + spec.warn; s.warnUntil = j.until; writeTurret(tk, s);
      try { e.triggerEvent(`${NS}:channel`); e.setProperty(`${NS}:charging`, true); } catch {}
      op.notice = `砲塔${letter(i)}に妨害予告！ ジャマーを倒すと止められます`;
      broadcast(m, op.notice);
      break;
    }
    op.jam[e.id] = j;
  }

  // ---- 侵入口チェック / 壁の突破 ----
  // 端末の攻撃範囲(水平2マス)から外周(半径 ACCESS_R)へ、敵が歩ける通路があるかを 0-1 BFS で調べる。
  // 歩行: 足元が固体・足と頭が空き、1段の昇降まで。壁材(破壊可)のマスはコスト1、保護ブロックは通れない。
  const ACCESS_R = 16, ACCESS_DY = 8;
  const UNBREAKABLE = new Set(["minecraft:bedrock", "minecraft:barrier", "minecraft:obsidian", "minecraft:crying_obsidian", "minecraft:reinforced_deepslate",
    "minecraft:end_portal_frame", "minecraft:command_block", "minecraft:repeating_command_block", "minecraft:chain_command_block", "minecraft:structure_block",
    "minecraft:jigsaw", "minecraft:respawn_anchor", "minecraft:beacon", "minecraft:enchanting_table", "minecraft:anvil", "minecraft:lodestone"]);
  const PROTECT_WORDS = ["chest", "barrel", "shulker_box", "hopper", "furnace", "smoker", "dispenser", "dropper", "crafter", "brewing_stand", "bed", "lectern", "jukebox", "beehive", "bee_nest", "decorated_pot", "chiseled_bookshelf"];
  function blockClass(t) {   // 0=通れる 1=壁材(破壊可) 2=保護(通れない・壊さない)
    if (!isSolid(t)) return 0;
    if (t.startsWith(`${NS}:`) || UNBREAKABLE.has(t) || PROTECT_WORDS.some(w => t.includes(w))) return 2;
    return 1;
  }
  function analyzeAccess(dim, m) {
    const cache = new Map();
    const cls = (x, y, z) => {
      const k = x + "," + y + "," + z; let v = cache.get(k);
      if (v === undefined) { let t; try { t = dim.getBlock({ x, y, z })?.typeId; } catch {} v = t === undefined ? 2 : blockClass(t); cache.set(k, v); }
      return v;
    };
    const ground = (x, y, z) => cls(x, y - 1, z) !== 0;
    const cx = m.x + .5, cz = m.z + .5, minY = m.y - ACCESS_DY, maxY = m.y + ACCESS_DY;
    // 起点: 攻撃範囲(水平2.1・高さ±2)の歩けるマス
    const dist = new Map(), prev = new Map(), dq = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
      const x = m.x + dx, y = m.y + dy, z = m.z + dz;
      if (Math.hypot(x + .5 - cx, z + .5 - cz) > 2.1 || (dx === 0 && dz === 0)) continue;
      if (cls(x, y, z) === 0 && cls(x, y + 1, z) === 0 && ground(x, y, z)) { const k = `${x},${y},${z}`; dist.set(k, 0); dq.push([x, y, z]); }
    }
    let best;
    // 0-1 BFS: コストごとのバケツを順に処理するので、最初に外周へ着いたものが最少の壁枚数
    const buckets = [dq];
    search: for (let c = 0; c < buckets.length; c++) for (let qi = 0; qi < buckets[c].length; qi++) {
      const [x, y, z] = buckets[c][qi];
      const k0 = `${x},${y},${z}`; if (dist.get(k0) < c) continue;
      if (Math.max(Math.abs(x - m.x), Math.abs(z - m.z)) >= ACCESS_R) { best = { k: k0, c }; break search; }
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ax, nz = z + az;
        for (const dy of [0, 1, -1]) {
          const ny = y + dy; if (ny < minY || ny > maxY) continue;
          if (dy === 1 && cls(x, y + 2, z) !== 0) continue;              // 頭上が塞がっていると登れない
          const f = cls(nx, ny, nz), h = cls(nx, ny + 1, nz);
          if (f === 2 || h === 2 || !ground(nx, ny, nz)) continue;
          const step = (f === 1 || h === 1) ? 1 : 0;
          if (step && dy !== 0) continue;                                 // 壊すのは同じ高さの壁だけ
          const nc = c + step, nk = `${nx},${ny},${nz}`;
          if (dist.has(nk) && dist.get(nk) <= nc) continue;
          dist.set(nk, nc); prev.set(nk, k0); (buckets[nc] ??= []).push([nx, ny, nz]);
        }
      }
    }
    if (!best) return { open: false, sealed: true };
    if (best.c === 0) return { open: true };
    // 外周側から辿って、最初にぶつかる壁(=敵から見て一番手前の壁)を突破対象にする
    let k = best.k, outside = best.k;
    while (k && prev.has(k)) {
      const [x, y, z] = k.split(",").map(Number);
      const wall = [y, y + 1].filter(yy => cls(x, yy, z) === 1).map(yy => ({ x, y: yy, z }));
      if (wall.length) {
        const [sx, sy, sz] = outside.split(",").map(Number);
        return { open: false, sealed: false, walls: best.c, breach: { cells: wall, stand: { x: sx + .5, y: sy, z: sz + .5 }, at: { x: x + .5, y: y + .5, z: z + .5 } } };
      }
      outside = k; k = prev.get(k);
    }
    return { open: false, sealed: true };
  }
  function tickAccess(m, op, dim) {
    const t = now();
    if (t < (op.accessNext ?? 0) && !op.breach) return;
    // 突破中: 火花と警告音 → 時間が来たら壁を1枚壊す。取り付いたスクラッパーが倒されたら中止
    if (op.breach) {
      const b = op.breach; let e; try { e = world.getEntity(b.enemy); } catch {}
      if (!e?.isValid) { op.breach = undefined; op.notice = "突破を阻止！"; broadcast(m, op.notice); op.accessNext = t + 2; return; }
      if (flat(e.location, b.stand) > 1.5) { try { e.teleport(b.stand, { facingLocation: b.at }); } catch {} }
      particle(dim, `${NS}:jam_spark`, b.at); particle(dim, `${NS}:turret_zap`, b.at);
      sound(dim, "random.anvil_use", b.at, 1.6 + Math.random() * .3, .55);
      if (Math.floor(t) % 2 === 0) sound(dim, "note.bass", center(m), .6, .9);
      if (t < b.until) return;
      for (const c of b.cells) {
        try { const blk = dim.getBlock(c); if (blk && blockClass(blk.typeId) === 1) { blk.setType("minecraft:air"); particle(dim, `${NS}:enemy_wreck`, { x: c.x + .5, y: c.y + .5, z: c.z + .5 }); } } catch {}
      }
      sound(dim, "random.explode", b.at, 1.4, .7);
      op.notice = "壁が突破された！"; broadcast(m, op.notice);
      op.breach = undefined; op.accessNext = t + 2; return;
    }
    op.accessNext = t + 3;
    const a = analyzeAccess(dim, m);
    if (a.open) { op.blockedFor = 0; if (op.sealed) { op.sealed = false; op.notice = "侵入口が開いた"; } return; }
    op.blockedFor = (op.blockedFor ?? 0) + 3;
    if (op.blockedFor < 6) return;                     // 一瞬の工事中は見逃す (2回連続で塞がっていたら確定)
    if (a.sealed) {
      if (!op.sealed) { op.sealed = true; op.notice = "壊せないブロックで密閉 · 入口が開くまでウェーブ判定を保留"; broadcast(m, op.notice); }
      return;
    }
    op.sealed = false;
    // 突破役: 立ち位置に一番近いスクラッパー (いなければジャマー)
    const list = enemiesOf(op).filter(x => x.typeId !== DEF.siege && x.typeId !== DEF.mender).sort((p, q) => (p.typeId === DEF.scrapper ? 0 : 1) - (q.typeId === DEF.scrapper ? 0 : 1) || flat(p.location, a.breach.stand) - flat(q.location, a.breach.stand));
    const e = list[0]; if (!e) return;
    particle(dim, `${NS}:jam_burst`, { x: e.location.x, y: e.location.y + .8, z: e.location.z });
    try { e.teleport(a.breach.stand, { facingLocation: a.breach.at }); } catch { return; }
    op.breach = { ...a.breach, enemy: e.id, until: t + 4 };
    op.notice = `通路が塞がれている · スクラッパーが壁を破壊中（あと${a.walls}枚）`; broadcast(m, op.notice);
  }

  // ---- 作戦の進行 (1秒ごと) ----
  function tickOp(m) {
    const op = read(m.key);
    if (!active(op)) return;
    const dim = world.getDimension(m.dim);
    let block; try { block = dim.getBlock(m); } catch {}
    if (block?.typeId !== DEF.terminal) return;                       // 未読込: 進めない
    if (!dim.getPlayers({ location: center(m), maxDistance: DEFENSE.presenceRange }).length) return;   // プレイヤー不在: 進めない
    op.enemies = (op.enemies ?? []).filter(id => { try { return world.getEntity(id)?.isValid; } catch { return false; } });
    if (op.status === "countdown" || op.status === "break") {
      op.timer -= 1;
      if (op.timer <= 5 && op.timer > 0) sound(dim, "note.pling", center(m), 1.4, .6);
      if (op.timer <= 0) { op.wave += 1; op.status = "wave"; queueWave(op); broadcast(m, `第${op.wave}波 接近！`); sound(dim, "mob.wither.spawn", center(m), 1.6, .25); }
    } else if (op.status === "wave") {
      op.spawnTimer -= 1;
      if (op.queue.length && op.spawnTimer <= 0) { spawnSquad(m, op); op.spawnTimer = DEFENSE.squadSec; }
      tickEnemies(m, op);
      try { tickAccess(m, op, dim); } catch (error) { console.warn("[Orbital Foundry] defense access: " + error); }
      for (const delay of [0, 5, 10, 15]) system.runTimeout(() => { try { drawJamBeams(m, read(m.key)); } catch {} }, delay);
      // 相打ちは敗北: 端末の耐久0を、ウェーブ完了・報酬より先に判定する
      if (op.hp <= 0) { write(m.key, op); return endOp(m, read(m.key), false, "端末の耐久が0になりました"); }
      if (op.mode === "overseer") { /* オーバーシア戦: 波の終わりは空の本体が決める */ }
      else if (!op.queue.length && !op.enemies.length && op.sealed) op.notice = "壊せないブロックで密閉 · 入口が開くまでウェーブ判定を保留";
      else if (!op.queue.length && !op.enemies.length) {
        if (op.wave >= wavesOf(op).length) { write(m.key, op); return endOp(m, read(m.key), true); }
        op.status = "break"; op.timer = DEFENSE.breakSec;
        broadcast(m, `第${op.wave}波 撃退 · 20秒後に第${op.wave + 1}波`);
      }
    }
    if (op.hp <= 0) { write(m.key, op); return endOp(m, read(m.key), false, "端末の耐久が0になりました"); }
    try { updateObjective(m, op, dim); } catch (error) { console.warn("[Orbital Foundry] defense HUD: " + error); }
    write(m.key, op);
    // 端末の見た目: 待機=静止、予告=アンバー点滅、襲撃=赤点滅、勝利=緑
    try {
      const phase = Math.floor(system.currentTick / 10) % 4;
      const lamp = op.status === "wave" ? (phase % 2 ? 2 : 0) : (phase % 2 ? 1 : 0);
      block.setPermutation(block.permutation.withState(`${NS}:lamp`, lamp).withState(`${NS}:sweep`, phase));
    } catch {}
  }
  let tick = 0;
  system.runInterval(() => {
    tick++;
    for (const m of terminals()) { try { tickOp(m); } catch (e) { console.warn("[Orbital Foundry] defense: " + e); } }
  }, 20);
  let activeTurrets=[];
  system.runInterval(()=>{
    activeTurrets=turrets();
    const keys=new Set(activeTurrets.map(t=>t.key));
    for(const key of turretReady.keys())if(!keys.has(key))turretReady.delete(key);
  },20);
  system.runInterval(()=>{
    for(const turret of activeTurrets){try{tickTurret(turret);}catch{}}
  },1);
  // 攻城機の走行音: 6.5秒の素材(前後0.25秒フェード)を 6.25秒ごとに重ねて鳴らし、継ぎ目なくループさせる
  const engineNext = new Map();
  system.runInterval(() => {
    const tickNow = system.currentTick, alive = new Set();
    for (const m of terminals()) {
      try {
        const op = read(m.key); if (!active(op) || !op.siege?.id) continue;
        const e = world.getEntity(op.siege.id); if (!e?.isValid) continue;
        alive.add(e.id);
        if ((engineNext.get(e.id) ?? 0) > tickNow) continue;
        engineNext.set(e.id, tickNow + 125);
        e.dimension.playSound(`${NS}.siege_engine`, e.location, { volume: 1.4, pitch: op.siege.hp <= DEFENSE.enemy[DEF.siege].hp / 2 ? .92 : 1 });
      } catch {}
    }
    for (const id of engineNext.keys()) if (!alive.has(id)) engineNext.delete(id);
  }, 5);
  // 待機中の端末と、勝利した端末の見た目
  system.runInterval(() => {
    for (const m of terminals()) {
      try {
        const op = read(m.key); if (active(op)) continue;
        const block = world.getDimension(m.dim).getBlock(m); if (block?.typeId !== DEF.terminal) continue;
        const sweep = (block.permutation.getState(`${NS}:sweep`) + 1) % 4;
        block.setPermutation(block.permutation.withState(`${NS}:lamp`, op.status === "won" && (op.reward || op.rewardSiege) ? 3 : 0).withState(`${NS}:sweep`, sweep));
      } catch {}
    }
  }, 30);
  // ---- 装甲: 本当の体力は大きくしておき、通した分だけ HP (of:hp) を減らす。0 で撃破 ----
  const hpOf = e => { const v = e.getDynamicProperty("of:hp"); return typeof v === "number" ? v : DEFENSE.enemy[e.typeId]?.hp ?? 20; };
  // 被弾時の回避: ジャマーは短距離ブリンク、スクラッパーは横ステップ
  function evade(e, hp) {
    const t = now(), last = e.getDynamicProperty("of:evade") ?? 0;
    if (e.typeId === DEF.siege || e.typeId === DEF.mender) return;
    if (hp <= 0 || t - last < (e.typeId === DEF.jammer ? 6 : 3) || Math.random() > (e.typeId === DEF.jammer ? .55 : .45)) return;
    e.setDynamicProperty("of:evade", t);
    const a = Math.random() * Math.PI * 2, dim = e.dimension;
    if (e.typeId === DEF.jammer) {
      if (e.getProperty?.(`${NS}:charging`)) return;   // 妨害の溜め中は逃げない（倒すチャンス）
      const x = Math.floor(e.location.x + Math.cos(a) * 3), z = Math.floor(e.location.z + Math.sin(a) * 3);
      const g = groundAt(dim, x, z, Math.floor(e.location.y)); if (!g) return;
      particle(dim, `${NS}:jam_burst`, { x: e.location.x, y: e.location.y + 1, z: e.location.z });
      try { e.teleport({ x: x + .5, y: g.y, z: z + .5 }); } catch {}
      sound(dim, "mob.endermen.portal", e.location, 1.8, .5);
    } else {
      glide(e, Math.cos(a), Math.sin(a), 1.6, 3, "enemy_dash");
      sound(dim, "random.click", e.location, 1.5, .5);
    }
  }
  function hurtEnemy(e, damage, source, turretHit = false, from, shotAim) {
    if (!DEFENSE.enemy[e.typeId] || e.getDynamicProperty("of:dead")) return;
    // Clear a stale marker from 0.8.92 without applying its delayed shot.
    if (e.getDynamicProperty("of:turret_hit") !== undefined) e.setDynamicProperty("of:turret_hit", undefined);
    const addonHit = Math.abs(system.currentTick - (e.getDynamicProperty("of:addon_hit") ?? -99)) <= 2;
    let riding; try { riding = source?.damagingEntity?.getComponent?.("minecraft:riding")?.entityRidingOn?.typeId; } catch {}
    const mult = armorMultiplier(source, turretHit, addonHit, riding);
    const dealt = damage * mult;
    let hp;
    if (e.typeId === DEF.siege) {
      const attacker = source?.damagingEntity;
      let origin = from, aim = shotAim;
      // 着弾した弾の現在地は本体の内側に入りうるため、射手の側を優先する。
      try { origin ??= attacker?.location; } catch {}
      if (!origin) {
        try {
          const projectile = source?.damagingProjectile;
          const p = projectile?.location, v = projectile?.getVelocity();
          const speed = v && Math.hypot(v.x, v.z);
          origin = p && speed > 1e-6
            ? { x: p.x - 8 * v.x / speed, y: p.y, z: p.z - 8 * v.z / speed }
            : p;
        } catch {}
      }
      if (!aim && source?.cause === "entityAttack" && attacker?.typeId === "minecraft:player") {
        try { aim = { eye: attacker.getHeadLocation(), direction: attacker.getViewDirection() }; } catch {}
      }
      hp = siegeHit(e, damage, origin, mult, aim, attacker, source?.ofPierce ?? 0);
      if (hp === undefined) hp = Math.max(0, hpOf(e) - dealt);
    } else hp = Math.max(0, hpOf(e) - dealt);
    e.setDynamicProperty("of:hp", hp);
    try { e.getComponent("minecraft:health")?.resetToMaxValue(); } catch {}
    evade(e, hp);
    if (dealt < damage) particle(e.dimension, `${NS}:armor_ping`, { x: e.location.x, y: e.location.y + 1, z: e.location.z });   // 弾かれた火花
    if (hp <= 0) {
      e.setDynamicProperty("of:dead", true);
      try { if (!e.kill()) e.remove(); } catch { try { e.remove(); } catch {} }
    }
    return hp;
  }
  // 他アドオンの弾が敵に当たった瞬間を記録する (その直後のダメージを他アドオン由来として扱う)
  world.afterEvents.projectileHitEntity?.subscribe(ev => {
    try {
      const e = ev.getEntityHit?.()?.entity;
      if (!e || !DEFENSE.enemy[e.typeId] || vanillaId(ev.projectile?.typeId)) return;
      e.setDynamicProperty("of:addon_hit", system.currentTick);
    } catch {}
  });
  world.afterEvents.entityHurt?.subscribe(ev => { try { hurtEnemy(ev.hurtEntity, ev.damage, ev.damageSource); } catch {} },
    { entityTypes: ENEMY_TYPES });
  world.afterEvents.entityDie?.subscribe(ev => {
    const e = ev.deadEntity;
    if (!DEFENSE.enemy[e?.typeId]) return;
    try {
      const key = e.getDynamicProperty("of:terminal"); if (!key) return;
      const op = read(key); op.enemies = (op.enemies ?? []).filter(id => id !== e.id); op.killed = (op.killed ?? 0) + 1;
      if (op.jam?.[e.id]?.target) { const s = readTurret(op.jam[e.id].target); s.warnUntil = 0; writeTurret(op.jam[e.id].target, s); op.notice = "妨害を阻止！"; }
      if (op.siege?.id === e.id) {
        op.siege = undefined; op.notice = "§a攻城機を撃破！§r 残りを片付けろ";
        for (let k = 0; k < 5; k++) system.runTimeout(() => { try {
          const p = { x: e.location.x + (Math.random() - .5) * 2.5, y: e.location.y + .5 + Math.random() * 1.8, z: e.location.z + (Math.random() - .5) * 2.5 };
          e.dimension.spawnParticle("minecraft:huge_explosion_emitter", p); e.dimension.playSound("random.explode", p, { pitch: .7 + k * .1, volume: .9 });
          e.dimension.spawnParticle(`${NS}:wreck_smoke`, p);
        } catch {} }, k * 6);
      }
      write(key, op);
      particle(e.dimension, `${NS}:enemy_wreck`, { x: e.location.x, y: e.location.y + .5, z: e.location.z });
      particle(e.dimension, `${NS}:wreck_smoke`, { x: e.location.x, y: e.location.y + .6, z: e.location.z });
      try { e.dimension.playSound("random.explode", e.location, { pitch: e.typeId === DEF.jammer || e.typeId === DEF.gnawer ? 1.9 : 1.5, volume: .45 }); } catch {}
      if (e.typeId === DEF.mender) particle(e.dimension, `${NS}:heal_spark`, { x: e.location.x, y: e.location.y + 1.2, z: e.location.z });
    } catch {}
  }, { entityTypes: ENEMY_TYPES });
  // 作戦と結びつかない敵 (中止・敗北後に読み込まれた個体) は片付ける
  world.afterEvents.entityLoad?.subscribe(ev => {
    try {
      const e = ev.entity; if (!DEFENSE.enemy[e?.typeId]) return;
      if (e.getDynamicProperty("of:debug")) {
        if (e.typeId === DEF.siege) {
          const spec = DEFENSE.enemy[DEF.siege], t = now(), b = readDebugSiege(e, spec);
          if (restoreSiege(e, b, spec, t)) e.setDynamicProperty(debugSiegeKey, JSON.stringify(b));
          if (b.openUntil > t) {
            stopSiege(e); scheduleDoorClose(e, b.openUntil);
            scheduleDebugSiegeReset(e, b.openUntil);
          }
          siegeVisual(e, b, t);
        }
        return;
      }
      const key = e.getDynamicProperty("of:terminal"), op = key && read(key);
      if (!op || !active(op) || op.opId !== e.getDynamicProperty("of:op")) { e.remove(); return; }
      if (e.typeId === DEF.siege && op.siege?.id === e.id && op.siege.openUntil > now()) { stopSiege(e); scheduleDoorClose(e, op.siege.openUntil); }
    } catch {}
  });

  world.afterEvents.entityLoad?.subscribe(({ entity }) => {
    if (entity.typeId !== DEF.marker) return;
    system.run(() => {
      try {
        if (!entity.isValid) return;
        const key = entity.getDynamicProperty("of:terminal");
        const op = key ? read(key) : undefined;
        if (!op || !active(op) || op.objectiveId !== entity.id || op.opId !== entity.getDynamicProperty("of:op")) entity.remove();
      } catch {}
    });
  });

  // 砲塔を置くと、半径24ブロック内の一番近い防衛端末に自動で登録する
  world.afterEvents.playerPlaceBlock?.subscribe(ev => {
    if (!TURRET_TYPES.has(ev.block?.typeId)) return;
    const key = keyOf(ev.dimension.id, ev.block.location), at = ev.block.location;
    const near = terminals().filter(m => m.dim === ev.dimension.id && dist(m, at) <= DEFENSE.turretLink).sort((a, b) => dist(a, at) - dist(b, at))[0];
    if (!near) { try { ev.player.onScreenDisplay?.setActionBar("近くに防衛端末がありません（半径24ブロック）"); } catch {} return; }
    const op = read(near.key);
    if (!(op.turrets ?? []).includes(key)) { op.turrets = [...(op.turrets ?? []), key]; write(near.key, op); }
    const s = readTurret(key); s.terminal = near.key; writeTurret(key, s);
    try { ev.player.onScreenDisplay?.setActionBar(`防衛端末に砲塔${letter(op.turrets.indexOf(key))}として登録しました`); } catch {}
  });

  // ---- 画面 ----
  const bar = (n, max, w = 20) => "[" + "|".repeat(Math.round(n / max * w)) + ".".repeat(w - Math.round(n / max * w)) + "]";
  function terminalBody(m, op, p) {
    const lines = [], c = center(m);
    const status = { idle: "待機中", countdown: `作戦開始 · 第1波まで ${op.timer}秒`, wave: `第${op.wave}波 交戦中`, break: `第${op.wave}波 撃退 · 次の波まで ${op.timer}秒`,
      won: (op.reward || op.rewardSiege) ? (op.mode === "siege" ? "攻城機撃破！ 報酬を受け取れます" : "防衛成功！ 報酬を受け取れます") : "防衛成功", lost: "防衛失敗 · " + (op.reason ?? "") }[op.status] ?? op.status;
    lines.push("状態　" + status);
    lines.push(`耐久　${bar(op.hp, DEFENSE.maxHp)} ${op.hp} / ${DEFENSE.maxHp}`);
    if (active(op)) {
      const dirs = [...new Set((op.points ?? []).map(p => compassOf(p.x - m.x, p.z - m.z)))].join("・");
      lines.push(`${op.mode === "siege" ? "攻城機迎撃　" : ""}ウェーブ　${op.wave} / ${wavesOf(op).length}　出現方向 ${dirs}`);
      const alive = enemiesOf(op);
      if (alive.length || op.queue?.length) {
        const by = {}; for (const e of alive) { const d = compassOf(e.location.x - c.x, e.location.z - c.z); by[d] = (by[d] ?? 0) + 1; }
        lines.push(`残敵　${alive.length + (op.queue?.length ?? 0)}体　` + Object.entries(by).map(([d, n]) => `${d}${n}`).join(" "));
      }
      const hud = defenseHud(op, now());
      if (op.siege?.id && hud) lines.push(hud.text.replace(/§./g, ""));
      if (op.notice) lines.push("通知　" + op.notice);
    }
    const ts = op.turrets ?? [];
    lines.push(`登録砲塔　${ts.length}台` + (ts.length ? "" : "（未登録でも手動で戦えます）"));
    ts.forEach((k, i) => {
      const t = turrets().find(x => x.key === k); if (!t) return;
      const s = readTurret(k);
      const profile = TURRET_PROFILES[t.type];
      lines.push(`　${letter(i)} ${profile.name}　残弾 ${s.ammo} / ${profile.maxAmmo}　${turretStatus(t, s, profile)}`);
    });
    if (!active(op)) {
      if ((op.cooldownUntil ?? 0) > now() && !op.reward && !op.rewardSiege) lines.push(`再挑戦まで ${Math.ceil(op.cooldownUntil - now())}秒`);
      lines.push("\n推奨準備: 機関・レールガン・散弾砲の混成で砲塔8台以上・弾薬と補修キット、手持ちはゲリラアドオンの銃・重火器。30秒後に第1波、3波を全滅させると軍用制御核2個。");
      lines.push(siegeUnlocked(p)
        ? "§6攻城機迎撃§r: 2波。第2波に攻城機（HP2400・正面装甲）。左右の冷却器を両方壊すと12秒間だけ装甲が開く。半径16で予告付き衝撃波（端末-12）。撃破で攻城制御核2個（並列加工モジュールの材料）。"
        : "§7攻城機迎撃: 自分の通常防衛の報酬を受け取ると解禁§r");
    }
    if (op.startedBy && (active(op) || op.reward || op.rewardSiege)) lines.push(`作戦開始者 ${op.startedBy}`);
    return lines.join("\n");
  }
  async function showTerminal(p, block, key) {
    const m = { key, dim: block.dimension.id, ...block.location, type: block.typeId };
    const op = read(key);
    if (!op.ownerId && op.startedBy===p.name && op.mode==="normal" &&
        op.status==="won" && !op.debugBoss && !op.reward && !siegeUnlocked(p)) {
      p.setDynamicProperty("of:defense_cleared",true);
    }
    const form = createForm().title("防衛端末").body(terminalBody(m, op, p));
    const acts = [];
    const add = (label, icon, act) => { form.button(label, icon); acts.push(act); };
    if (active(op)) {
      if (canControl(p,op)) add("作戦を中止\n敗北扱い・残敵を片付けます", "textures/ui/of_quarry_stop", "abort");
    } else if (!op.reward && !op.rewardSiege) {
      add("防衛作戦を開始\n3ウェーブ・30秒後に第1波", "textures/ui/of_defense_start", "start");
      if (siegeUnlocked(p)) add("攻城機迎撃を開始\nボス戦・2ウェーブ", "textures/items/siege_control_core", "start_siege");
    }
    // 攻城機迎撃を一度クリアすると表示
    if (!active(op) && expansion.overseerRaid && world.getDynamicProperty("of:design_siege")) add(`オーバーシア戦\n起動核を1個消費・所持${countItem(p, `${NS}:activation_core`)}個`, "textures/items/activation_core", "overseer");
    if ((op.reward > 0 || op.rewardSiege > 0) && canControl(p,op)) add(`報酬を受け取る\n` + [op.reward > 0 ? `軍用制御核 ×${op.reward}` : "", op.rewardSiege > 0 ? `攻城制御核 ×${op.rewardSiege}` : ""].filter(Boolean).join("・"),
      op.rewardSiege > 0 ? "textures/items/siege_control_core" : "textures/items/military_control_core", "claim");
    add(`砲塔を登録\n半径${DEFENSE.turretLink}ブロック・現在${(op.turrets ?? []).length}台`, "textures/blocks/turret_mk1", "register");
    add(`補修（+${DEFENSE.repair}）\n補修キット 所持${countItem(p, DEF.kit)}個`, "textures/items/repair_kit", "repair");
    add("表示を更新", "textures/ui/of_quarry_survey", "refresh");
    add("閉じる", undefined, "close");
    const result = await form.show(p);
    if (result.canceled) return;
    try { if (block.dimension.getBlock(block.location)?.typeId !== DEF.terminal) return; } catch { return; }
    const act = acts[result.selection], now2 = read(key);
    if (act === "start") { const err = startOp(m, p); if (err) toast(p, err); }
    else if (act === "start_siege") { const err = startOp(m, p, "siege"); if (err) toast(p, err); }
    else if (act === "abort" && now2.opId===op.opId && canControl(p,now2) && active(now2)) endOp(m, now2, false, "作戦を中止しました");
    else if (act === "overseer") expansion.overseerRaid(p, { x: m.x + .5, y: m.y, z: m.z + .5 }, m);
    else if (act === "register") toast(p, `砲塔${registerTurrets(m)}台を登録しました`);
    else if (act === "repair") {
      if (now2.hp >= DEFENSE.maxHp) toast(p, "耐久は満タンです");
      else if ((now2.repairReadyAt ?? 0) > now()) toast(p, `補修の再使用まで ${Math.ceil(now2.repairReadyAt - now())}秒`);
      else if (!removeItems(p, DEF.kit, 1)) toast(p, "補修キットがありません（組立機で作れます）");
      else {
        now2.hp = Math.min(DEFENSE.maxHp, now2.hp + DEFENSE.repair); now2.repairReadyAt = now() + DEFENSE.repairCooldown; write(key, now2);
        particle(block.dimension, `${NS}:repair_spark`, { x: m.x + .5, y: m.y + 1.2, z: m.z + .5 });
        try { block.dimension.playSound("random.anvil_use", center(m), { pitch: 1.3, volume: .6 }); } catch {}
        toast(p, `耐久 ${now2.hp} / ${DEFENSE.maxHp}`);
      }
    }
    else if (act === "claim" && now2.opId===op.opId) claimReward(p, key);
    else if (act !== "refresh") return;
    return showTerminal(p, block, key);
  }
  function claimReward(p, key) {
    const inv = p.getComponent("minecraft:inventory")?.container; if (!inv) return;
    if (!canControl(p,read(key))) return toast(p,"報酬は作戦を開始したプレイヤーが受け取れます");
    for (const [field, item, label] of [["reward", DEF.core, "軍用制御核"], ["rewardSiege", DEF.siegeCore, "攻城制御核"]]) {
      const op = read(key);
      if (!(op[field] > 0)) continue;
      let room = 0;
      for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (!it) room += 64; else if (it.typeId === item) room += it.maxAmount - it.amount; }
      if (room < op[field]) { toast(p, "持ち物に空きがありません。報酬は端末に保留されています"); return; }
      const n = op[field]; op[field] = 0; write(key, op);   // 先に保留を消してから渡す (二重受取の防止)
      const rest = inv.addItem(new ItemStack(item, n));
      if (rest) { const again = read(key); again[field] = rest.amount; write(key, again); }
      const received=n-(rest?.amount??0);
      if (received && op.mode==="normal" && !siegeUnlocked(p)) {
        p.setDynamicProperty("of:defense_cleared",true);
        toast(p,`${label}を${received}個受け取りました · 攻城機迎撃が解禁されました`);
      } else toast(p,`${label}を${received}個受け取りました`);
    }
  }
  async function showTurret(p, block, key) {
    const type = block.typeId, profile = TURRET_PROFILES[type];
    if (!profile) return;
    const ammoName = nameOf(profile.ammo);
    const s = readTurret(key);
    const t = { key, dim: block.dimension.id, ...block.location };
    const term = s.terminal ? terminals().find(x => x.key === s.terminal) : undefined;
    const form = createForm().title(profile.name).body([
      `残弾　${bar(s.ammo, profile.maxAmmo)} ${s.ammo} / ${profile.maxAmmo}`,
      `状態　${turretStatus(t, s, profile)}`,
      `接続先　${term ? `防衛端末 (${term.x}, ${term.y}, ${term.z})` : "未登録（防衛端末の「砲塔を登録」）"}`,
      `射程 ${profile.range}ブロック・全周旋回・上限${core.speedLimit(key)}倍で ${profile.interval/core.speedLimit(key)}秒に1発・${profile.energy*core.speedLimit(key)} SE/発`,
      `電力　${expansion.availablePower(key)} SE`,
      `専用弾：${ammoName} · 6面から搬入可能`,
      "給電・装填済みなら、作戦外でもバニラの敵モブを迎撃",
      profile.spread ? "前方70度の敵を最大5体攻撃" : `単体に ${profile.damage} ダメージ`,
    ].join("\n"));
    form.button(`手持ちの${ammoName}を装填\n所持 ${countItem(p, profile.ammo)}発`, `textures/items/${profile.ammo.split(":")[1]}`).button("閉じる");
    const r = await form.show(p);
    if (r.canceled || r.selection !== 0) return;
    try { if (block.dimension.getBlock(block.location)?.typeId !== type) return; } catch { return; }
    const want = Math.min(countItem(p, profile.ammo), profile.maxAmmo - readTurret(key).ammo);
    if (want > 0 && removeItems(p, profile.ammo, want)) { loadAmmo(key, want, profile); toast(p, `${want}発を装填しました`); }
    else toast(p, want <= 0 && countItem(p, profile.ammo) ? "満タンです" : `${ammoName}がありません`);
    return showTurret(p, block, key);
  }

  // ---- 撤去 ----
  function canBreak(type, key) {
    if (type === DEF.terminal) {
      const op = read(key);
      if (active(op)) return "作戦中は回収できません。作戦を中止してから回収してください";
      if (op.reward > 0 || op.rewardSiege > 0) return "報酬が保留されています。受け取ってから回収してください";
    }
  }
  function forget(type, key, dim, location) {
    if (type === DEF.terminal) { const op = read(key); removeObjective(op); for (const t of op.turrets ?? []) { const s = readTurret(t); if (s.terminal === key) { s.terminal = undefined; writeTurret(t, s); } } dpSet(opKey(key), undefined); }
    if (TURRET_TYPES.has(type)) {
      const ammo = TURRET_PROFILES[type].ammo;
      const s = readTurret(key);
      if (s.ammo > 0) try { dim.spawnItem(new ItemStack(ammo, Math.min(64, s.ammo)), { x: location.x + .5, y: location.y + .5, z: location.z + .5 }); if (s.ammo > 64) dim.spawnItem(new ItemStack(ammo, s.ammo - 64), { x: location.x + .5, y: location.y + .5, z: location.z + .5 }); } catch {}
      dpSet(turretKey(key), undefined);
    }
  }
  return { enlist, startOverseerOp, overseerWave, stopOverseerOp, overseerOpState, siegeUnlocked, siegeSide, analyzeAccess, tickAccess, hurtEnemy, hpOf, showTerminal, showTurret, view, canBreak, forget, startOp, endOp, read, write, readTurret, writeTurret, loadAmmo, tickOp, tickTurret, registerTurrets, claimReward, planSpawns, lineOfSight, compassOf };
}
