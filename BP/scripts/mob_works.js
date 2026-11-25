// 廃棄物焼却炉 / 全自動モブスポナー / 全自動モブクラッシャー / 経験値カプセル
import { noteShort } from "./hud.js";
import { ItemStack } from "@minecraft/server";
import { ModalFormData, ActionFormData } from "@minecraft/server-ui";
import { NS } from "./config.js";
import { DEFENSE } from "./defense.js";
import { isNear, nearMachine } from "./lod.js";

const id = n => NS + ":" + n;
export const INCINERATOR = id("incinerator"), SPAWNER = id("mob_spawner"), MOB_CRUSHER = id("mob_crusher"), XP_CAPSULE = id("xp_capsule");
export const MOBWORKS_TYPES = [INCINERATOR, SPAWNER, MOB_CRUSHER];

export const MOBWORKS = {
  incinerator: { perSecond: 2, sePerItem: 5, capacity: 2000, queue: 256 },
  crusher: { sePerHp: 50, zone: { r: 4, up: 6 }, buffer: 1024, linkRange: 24, baseSec: .5, hpPerSec: 40 },
  spawner: { baseCount: 1, maxCount: 8, intervals: [10, 5, 3, 2, 1], baseInterval: 10, maxAlive: 64, zone: 2 },
  xpPerCapsule: 100,
};

// 召喚できるモブ: [id, 名前, 最大HP, 経験値, 種類]  種類: land / water / flying / big / boss
const V = (n, name, hp, xp, kind = "land") => ({ id: "minecraft:" + n, name, hp, xp, kind });
export const MOBS = [
  V("zombie", "ゾンビ", 20, 5), V("husk", "ハスク", 20, 5), V("drowned", "ドラウンド", 20, 5, "water"), V("zombie_villager_v2", "村人ゾンビ", 20, 5),
  V("skeleton", "スケルトン", 20, 5), V("stray", "ストレイ", 20, 5), V("bogged", "ボグド", 16, 5), V("wither_skeleton", "ウィザースケルトン", 20, 5),
  V("creeper", "クリーパー", 20, 5), V("spider", "クモ", 16, 5), V("cave_spider", "洞窟グモ", 12, 5), V("enderman", "エンダーマン", 40, 5),
  V("witch", "ウィッチ", 26, 5), V("slime", "スライム", 16, 4), V("magma_cube", "マグマキューブ", 16, 4), V("blaze", "ブレイズ", 20, 10, "flying"),
  V("ghast", "ガスト", 10, 5, "big"), V("phantom", "ファントム", 20, 5, "flying"), V("guardian", "ガーディアン", 30, 10, "water"), V("elder_guardian", "エルダーガーディアン", 80, 10, "water"),
  V("pillager", "ピリジャー", 24, 5), V("vindicator", "ヴィンディケーター", 24, 5), V("evocation_illager", "エヴォーカー", 24, 10), V("ravager", "ラヴェジャー", 100, 20, "big"),
  V("piglin", "ピグリン", 16, 5), V("piglin_brute", "ピグリンブルート", 50, 20), V("zombie_pigman", "ゾンビピグリン", 20, 5), V("hoglin", "ホグリン", 40, 5),
  V("zoglin", "ゾグリン", 40, 5), V("silverfish", "シルバーフィッシュ", 8, 5), V("endermite", "エンダーマイト", 8, 3), V("shulker", "シュルカー", 30, 5),
  V("vex", "ヴェックス", 14, 3, "flying"), V("breeze", "ブリーズ", 30, 10, "flying"), V("warden", "ウォーデン", 500, 5, "big"),
  V("iron_golem", "アイアンゴーレム", 100, 0, "big"), V("snow_golem", "スノーゴーレム", 4, 0),
  V("cow", "ウシ", 10, 2), V("mooshroom", "ムーシュルーム", 10, 2), V("pig", "ブタ", 10, 2), V("sheep", "ヒツジ", 8, 2), V("chicken", "ニワトリ", 4, 2),
  V("rabbit", "ウサギ", 3, 2), V("goat", "ヤギ", 10, 2), V("horse", "ウマ", 22, 2), V("llama", "ラマ", 22, 2), V("turtle", "カメ", 30, 2, "water"),
  V("bee", "ミツバチ", 10, 2, "flying"), V("fox", "キツネ", 10, 2), V("frog", "カエル", 10, 2), V("armadillo", "アルマジロ", 12, 2),
  V("villager_v2", "村人", 20, 0), V("wandering_trader", "行商人", 20, 0),
  V("cod", "タラ", 6, 2, "water"), V("salmon", "サケ", 6, 2, "water"), V("tropicalfish", "熱帯魚", 6, 2, "water"), V("pufferfish", "フグ", 6, 2, "water"),
  V("squid", "イカ", 10, 2, "water"), V("glow_squid", "発光イカ", 10, 2, "water"), V("dolphin", "イルカ", 10, 2, "water"), V("axolotl", "ウーパールーパー", 14, 2, "water"),
  V("ender_dragon", "エンダードラゴン", 200, 500, "boss"), V("wither", "ウィザー", 600, 50, "boss"),
  ...Object.entries(DEFENSE.enemy).filter(([k]) => k !== id("siege_engine")).map(([k, v]) => ({ id: k, name: v.name, hp: v.hp, xp: 10, kind: k === id("mender") ? "flying" : "land", addon: true })),
];
const MOB = Object.fromEntries(MOBS.map(m => [m.id, m]));
const KIND = { land: "地上", water: "水中 (区画に水が必要)", flying: "飛行", big: "大型", boss: "ボス (ワールドで初回討伐後に解放)" };

// 1回の消費 = ceil(最大HP × 100 × 同時出現数^1.5 × max(1, 10 ÷ 実効間隔))
export const spawnCost = (hp, count, interval) => Math.ceil(hp * 100 * Math.pow(count, 1.5) * Math.max(1, 10 / interval));
// 経験値カプセル: 100ごとに1個、余りは持ち越し
export const capsulesFrom = xp => ({ capsules: Math.floor(xp / MOBWORKS.xpPerCapsule), rest: xp % MOBWORKS.xpPerCapsule });

export function installMobWorks(core) {
  const { world, system, registry, expansion, speedLimit, research, generatorRecord, saveGeneratorRecord, generatorCapacity, setBlockActive, createForm, sameMachine, toast, nameOf, dpGet, dpSet } = core;
  const read = (k, d) => { try { return { ...d, ...JSON.parse(dpGet("of_mw:" + k, "{}")) }; } catch { return { ...d }; } };
  const write = (k, v) => dpSet("of_mw:" + k, JSON.stringify(v));
  const tagOf = key => "ofsp_" + key.replace(/[^A-Za-z0-9_-]/g, "_");
  const center = m => ({ x: m.x + .5, y: m.y, z: m.z + .5 });
  const fx = (dim, n, at) => { try { if (isNear(dim.id, at.x, at.z, 96)) dim.spawnParticle(n, at); } catch { } };   // 見える人がいるときだけ
  const snd = (dim, k, at, v = 1, p = 1) => { try { dim.playSound(k, at, { volume: v, pitch: p }); } catch { } };
  const label = it => ({"koke_blade:seimetsu":"超越刀・星滅","koke_blade:tenmetsu":"天滅","koke_blade:seirou":"星炉刀"}[it] ?? nameOf?.(it) ?? it.replace(/^.*:/, ""));
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  const add = (o, k, n) => { o[k] = (o[k] ?? 0) + n; if (o[k] <= 0) delete o[k]; };
  const blockOf = m => { try { return world.getDimension(m.dim).getBlock(m); } catch { return undefined; } };
  const nowSec = () => system.currentTick / 20;

  // ================= 廃棄物焼却炉 =================
  const incDefault = { queue: {}, burned: 0, rate: 0, reason: "投入待ち", carry: 0 };
  // 登録全体を毎tickコピーしないよう、モブ工場の機械だけを1秒ごとに抜き出しておく
  let mwList = [], mwTick = -100;
  const mw = () => { if (system.currentTick - mwTick >= 20) { mwTick = system.currentTick; mwList = registry().filter(m => m.type === INCINERATOR || m.type === SPAWNER || m.type === MOB_CRUSHER); } return mwList; };
  function tickIncinerators() {
    for (const m of mw()) {
      if (m.type !== INCINERATOR || !research.allowsMachine(m.type, m)) continue;
      const block = blockOf(m); if (block?.typeId !== INCINERATOR) continue;
      const s = read(m.key, incDefault), rec = generatorRecord(m.key), cap = generatorCapacity(m.key);
      const speed = speedLimit(m.key), spec = MOBWORKS.incinerator;
      s.carry = (s.carry ?? 0) + spec.perSecond * speed;   // 1秒あたりの燃焼数 (倍速)
      let burned = 0;
      while (s.carry >= 1 && sum(s.queue) > 0) {
        if (rec.stored + spec.sePerItem > cap) { s.reason = "蓄電満杯 · 燃焼停止"; break; }
        const it = Object.keys(s.queue)[0];
        add(s.queue, it, -1); rec.stored += spec.sePerItem; rec.generated = (rec.generated ?? 0) + spec.sePerItem;
        s.carry--; burned++;
      }
      if (!sum(s.queue)) { s.carry = 0; s.reason = "投入待ち"; }
      else if (burned) s.reason = "燃焼中";
      s.carry = Math.min(s.carry, spec.perSecond * speed);
      s.rate = burned * spec.sePerItem; s.burned = (s.burned ?? 0) + burned;
      if (burned) { saveGeneratorRecord(m.key, rec); const c = center(m); fx(block.dimension, "minecraft:campfire_smoke_particle", { x: c.x + .28, y: c.y + 1.15, z: c.z + .28 }); fx(block.dimension, "minecraft:basic_flame_particle", { x: c.x, y: c.y + .5, z: c.z - .5 }); }
      setBlockActive(block, m.type, m.key, burned > 0);
      write(m.key, s);
    }
  }
  function incineratorInsert(key, item) {
    const s = read(key, incDefault), room = MOBWORKS.incinerator.queue - sum(s.queue), n = Math.min(room, item.amount);
    if (n <= 0) return 0;
    add(s.queue, item.typeId, n); write(key, s); return n;
  }
  async function showIncinerator(p, block, key) {
    const s = read(key, incDefault), rec = generatorRecord(key), cap = generatorCapacity(key), speed = speedLimit(key), spec = MOBWORKS.incinerator;
    const q = Object.entries(s.queue).sort((a, b) => b[1] - a[1]);
    const lines = q.slice(0, 8).map(([it, n]) => `  ${label(it)} ×${n}`).join("\n") || "  (空)";
    const held = p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex);
    const form = createForm().title("廃棄物焼却炉").body(
      `§l状態§r  ${s.reason}\n` +
      `§l蓄電§r  ${rec.stored.toLocaleString()} / ${cap.toLocaleString()} SE  ${bar(rec.stored, cap)}\n` +
      `§l発電§r  いま ${s.rate} SE/秒 · 最大 ${spec.perSecond * speed * spec.sePerItem} SE/秒 (1個 ${spec.sePerItem} SE · 毎秒 ${spec.perSecond * speed}個 · ${speed}倍速)\n` +
      `§l投入口§r  ${sum(s.queue)} / ${spec.queue}個\n${lines}\n\n§7ベルトから搬入するか、下のボタンで手持ちを入れます。燃やす前なら取り出せます。蓄電が満杯の間は燃やしません。`);
    const acts = [];
    if (held) { form.button(`手に持っている「${label(held.typeId)}」×${held.amount}を入れる`); acts.push("held"); form.button(`持ち物の「${label(held.typeId)}」をすべて入れる`); acts.push("all"); }
    if (sum(s.queue)) { form.button("投入口の中身をすべて取り出す"); acts.push("take"); }
    form.button("表示を更新"); acts.push("refresh"); form.button("閉じる"); acts.push("close");
    const r = await form.show(p); if (r.canceled || !sameMachine(block, INCINERATOR)) return;
    const a = acts[r.selection], inv = p.getComponent("minecraft:inventory")?.container;
    if (a === "held" && inv) { const it = inv.getItem(p.selectedSlotIndex); if (it) { const n = incineratorInsert(key, it); it.amount -= n; inv.setItem(p.selectedSlotIndex, it.amount > 0 ? it : undefined); } }
    else if (a === "all" && inv && held) { for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (it?.typeId !== held.typeId) continue; const n = incineratorInsert(key, it); if (!n) break; it.amount -= n; inv.setItem(i, it.amount > 0 ? it : undefined); } }
    else if (a === "take" && inv) { const st = read(key, incDefault); for (const [it, n] of Object.entries(st.queue)) { let left = n; while (left > 0) { const max = new ItemStack(it).maxAmount, k = Math.min(max, left), rest = inv.addItem(new ItemStack(it, k)); const got = k - (rest?.amount ?? 0); left -= got; if (rest) break; } if (left) st.queue[it] = left; else delete st.queue[it]; } write(key, st); }
    else if (a !== "refresh") return;
    return showIncinerator(p, block, key);
  }
  const bar = (v, max) => { const n = Math.round(10 * Math.min(1, v / Math.max(1, max))); return "§a" + "|".repeat(n * 2) + "§8" + "|".repeat(20 - n * 2) + "§r"; };

  // ================= 全自動モブスポナー =================
  const spDefault = { mob: "minecraft:zombie", count: 1, interval: 10, cap: 16, paused: false, next: 0, reason: "設定待ち", spawned: 0, lastCost: 0 };
  const bossUnlocked = mobId => !!world.getDynamicProperty("of:boss_kill:" + mobId);
  const mobAllowed = mob => mob && (mob.kind !== "boss" || bossUnlocked(mob.id));
  const maxCount = who => research.isUnlocked("nuclear_power", who) ? MOBWORKS.spawner.maxCount : 1;
  const intervals = who => research.isUnlocked("nuclear_power", who) ? MOBWORKS.spawner.intervals : [MOBWORKS.spawner.baseInterval];
  const aliveOf = (dim, key) => { try { return dim.getEntities({ tags: [tagOf(key)] }).length; } catch { return 0; } };
  // 出現位置: スポナーの真上 5×5 (大型・ボスは 7×7)。空間は確認しない。水中モブだけ水が必要
  function zoneCheck(block, mob) {
    const dim = block.dimension, { x, y, z } = block.location;
    const at = (dx, dy, dz) => { try { return dim.getBlock({ x: x + dx, y: y + dy, z: z + dz }); } catch { return undefined; } };
    if (mob.kind === "water") {
      const spots = [];
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 1; dy <= 4; dy++) { const b = at(dx, dy, dz); if (b?.typeId === "minecraft:water") spots.push({ x: x + dx + .5, y: y + dy, z: z + dz + .5 }); }
      return spots.length ? { ok: true, spots } : { ok: false, reason: "水槽が必要: スポナーの真上5×5×4に水を入れてください" };
    }
    // 空間の確認はしない (ブロックがあっても真上に出す)。大型は少し広めの範囲に散らす
    const big = mob.kind === "big" || mob.kind === "boss", r = big ? 3 : 2, spots = [];
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) spots.push({ x: x + dx + .5, y: y + 1, z: z + dz + .5 });
    return { ok: true, spots };
  }
  function tickSpawners() {
    for (const m of mw()) {
      if (m.type !== SPAWNER || !research.allowsMachine(m.type, m)) continue;
      const block = blockOf(m); if (block?.typeId !== SPAWNER) continue;
      const s = read(m.key, spDefault), mob = MOB[s.mob], speed = speedLimit(m.key), now = nowSec();
      const interval = s.interval / speed, cost = mob ? spawnCost(mob.hp, s.count, interval) : 0;
      let active = false;
      if (s.paused) s.reason = "一時停止中";
      else if (!mobAllowed(mob)) s.reason = mob?.kind === "boss" ? "未解放: このボスをワールドで一度正規に討伐してください" : "モブ未設定";
      else if (now < (s.next ?? 0)) { s.reason = `次の召喚まで ${Math.ceil(s.next - now)}秒`; active = true; }
      else {
        const alive = aliveOf(block.dimension, m.key), room = Math.min(s.count, s.cap - alive);
        const zone = zoneCheck(block, mob);
        if (room < s.count) s.reason = `生存上限 (${alive}/${s.cap}) · ${s.cap - s.count}体以下になるまで待機`;
        else if (!zone.ok) s.reason = zone.reason;
        else if (expansion.availablePower(m.key) < cost && (noteShort(m.key, cost - expansion.availablePower(m.key)), true)) s.reason = `電力不足 · 1回 ${cost.toLocaleString()} SE 必要`;
        else {
          let made = 0;
          for (let i = 0; i < s.count; i++) {
            const at = zone.spots[Math.floor(Math.random() * zone.spots.length)];
            try {
              const e = block.dimension.spawnEntity(mob.id, at);
              e.addTag(tagOf(m.key)); e.setDynamicProperty("of:spawner", m.key); made++;

            } catch { }
          }
          // 実際に出た数だけ請求 (一部だけ出た場合も個体数と請求を合わせる)
          const charge = made ? Math.ceil(cost * made / s.count) : 0;
          if (made && !expansion.spend(m.key, charge)) { /* 直前に電力が減った場合は次回に回す */ }
          s.lastCost = charge; s.spawned = (s.spawned ?? 0) + made; s.next = now + interval; active = made > 0;
          s.reason = made ? `召喚 ${made}体 · ${charge.toLocaleString()} SE` : "召喚に失敗 (場所を確認してください)";
          if (made) { snd(block.dimension, "mob.evocation_illager.prepare_summon", center(m), .6, 1.3);  }
        }
      }
      setBlockActive(block, m.type, m.key, active && !s.paused);
      write(m.key, s);
    }
  }
  async function showSpawner(p, block, key) {
    const s = read(key, spDefault), mob = MOB[s.mob], speed = speedLimit(key), interval = s.interval / speed;
    const cost = mob ? spawnCost(mob.hp, s.count, interval) : 0, alive = aliveOf(block.dimension, key);
    const form = createForm().title("全自動モブスポナー").body(
      `§l状態§r  ${s.paused ? "§7一時停止§r" : s.reason}\n` +
      `§l召喚§r  ${mob ? mob.name : "-"} (最大HP ${mob?.hp ?? "-"} · ${KIND[mob?.kind] ?? ""})\n` +
      `§l設定§r  1回 ${s.count}体 · ${s.interval}秒ごと · ${speed}倍速 ＞ 実効 ${interval.toFixed(2)}秒 · 生存上限 ${s.cap}体\n` +
      `§l電力§r  1回 §e${cost.toLocaleString()} SE§r · 平均 §e${Math.ceil(cost / interval).toLocaleString()} SE/秒§r · 接続電力 ${expansion.availablePower(key).toLocaleString()} SE\n` +
      `§l出現§r  毎分 ${(60 / interval * s.count).toFixed(1)}体 · 現在の生存 ${alive} / ${s.cap}体 · 累計 ${s.spawned ?? 0}体\n\n` +
      `§7消費 = 最大HP×100×同時数^1.5×max(1, 10÷実効間隔)\n出現位置: 真上5×5 (大型・ボスは7×7、空間の確認なし)。水中モブだけは水槽が必要。同時数と短い間隔は原子力で解放。`);
    const acts = ["settings", s.paused ? "resume" : "pause", "refresh", "close"];
    form.button("召喚の設定を変える").button(s.paused ? "再開する" : "一時停止する").button("表示を更新").button("閉じる");
    const r = await form.show(p); if (r.canceled || !sameMachine(block, SPAWNER)) return;
    const a = acts[r.selection];
    if (a === "settings") await spawnerSettings(p, block, key);
    else if (a === "pause" || a === "resume") { const st = read(key, spDefault); st.paused = a === "pause"; write(key, st); }
    else if (a !== "refresh") return;
    return showSpawner(p, block, key);
  }
  async function spawnerSettings(p, block, key) {
    const s = read(key, spDefault), list = MOBS.filter(mobAllowed), ivs = intervals(p), mc = maxCount(p);
    const names = list.map(m => `${m.name}  HP${m.hp}${m.kind === "water" ? " 水" : m.kind === "big" ? " 大" : m.kind === "boss" ? " ボス" : ""}`);
    // モブはボタン一覧の別画面で選ぶ (設定画面の中のドロップダウンだと、リストと画面が一緒にスクロールして見づらいため)
    const cur = Math.max(0, list.findIndex(m => m.id === s.mob));
    const pick = new ActionFormData().title("召喚するモブ").body(`今: §e${names[cur]}§r\n§7ボスはワールドで初回討伐後に追加されます`);
    names.forEach((n, i) => pick.button(i === cur ? `§2> ${n}` : n));
    let pr; try { pr = await pick.show(p); } catch { return; }
    if (pr.canceled || !sameMachine(block, SPAWNER)) return;
    const mi = pr.selection;
    const form = new ModalFormData().title(`召喚の設定 · ${list[mi]?.name ?? ""}`)
      .slider(`1回の同時出現数 (最大 ${mc}${mc === 1 ? " · 原子力で解放" : ""})`, 1, Math.max(1, mc), { valueStep: 1, defaultValue: Math.min(s.count, mc) })
      .dropdown(`出現間隔${ivs.length === 1 ? " (短い間隔は原子力で解放)" : ""}`, ivs.map(v => v + "秒"), { defaultValueIndex: Math.max(0, ivs.indexOf(s.interval)) })
      .slider("生存上限 (これを超えるなら召喚を保留)", 1, MOBWORKS.spawner.maxAlive, { valueStep: 1, defaultValue: s.cap });
    let r; try { r = await form.show(p); } catch { return; }
    if (r.canceled || !sameMachine(block, SPAWNER)) return;
    const [count, ii, cap] = r.formValues;
    const st = read(key, spDefault);
    st.mob = list[mi]?.id ?? st.mob; st.count = Math.max(1, Math.min(mc, Math.round(count))); st.interval = ivs[ii] ?? MOBWORKS.spawner.baseInterval;
    st.cap = Math.max(st.count, Math.round(cap)); st.next = 0; write(key, st);
    const mob = MOB[st.mob]; toast(p, `${mob.name} · 1回 ${st.count}体 · ${st.interval}秒 · 1回 ${spawnCost(mob.hp, st.count, st.interval / speedLimit(key)).toLocaleString()} SE`);
  }
  // ボスの初回正規討伐 (スポナー製でない個体) で召喚リストに追加
  world.afterEvents.entityDie.subscribe(({ deadEntity: e }) => {
    try {
      if (!["minecraft:ender_dragon", "minecraft:wither"].includes(e.typeId)) return;
      if (e.getDynamicProperty("of:spawner") !== undefined) return;
      if (!world.getDynamicProperty("of:boss_kill:" + e.typeId)) { world.setDynamicProperty("of:boss_kill:" + e.typeId, true); for (const p of world.getPlayers()) toast(p, `§d${MOB[e.typeId]?.name}を討伐 · 全自動モブスポナーで召喚できるようになりました`); }
    } catch { }
  });

  // ================= 全自動モブクラッシャー =================
  const crDefault = { out: {}, xp: 0, weapon: null, looting: 0, owner: undefined, job: undefined, reason: "待機中", kills: 0, links: [] };
  function linkedSpawners(m, s) {
    const list = mw().filter(x => x.type === SPAWNER && x.dim === m.dim && Math.max(Math.abs(x.x - m.x), Math.abs(x.z - m.z)) <= MOBWORKS.crusher.linkRange && Math.abs(x.y - m.y) <= 12);
    return s.links?.length ? list.filter(x => s.links.includes(x.key)) : list;
  }
  const inZone = (m, e) => { const z = MOBWORKS.crusher.zone, l = e.location; return Math.abs(l.x - (m.x + .5)) <= z.r + .5 && Math.abs(l.z - (m.z + .5)) <= z.r + .5 && l.y >= m.y - 1 && l.y <= m.y + 1 + z.up; };
  // 機械側のレアドロップ (プレイヤー討伐でしか出ないもの) と、ドロップ増加の上乗せ
  const RARE = {
    "minecraft:wither_skeleton": [["minecraft:wither_skeleton_skull", .025, .02]],
    "minecraft:zombie": [["minecraft:iron_ingot", .025 / 3, .01 / 3], ["minecraft:carrot", .025 / 3, .01 / 3], ["minecraft:potato", .025 / 3, .01 / 3]],
    "minecraft:husk": [["minecraft:iron_ingot", .025 / 3, .01 / 3], ["minecraft:carrot", .025 / 3, .01 / 3], ["minecraft:potato", .025 / 3, .01 / 3]],
    "minecraft:drowned": [["minecraft:copper_ingot", .11, .02]],
  };
  function tickCrushers() {
    for (const m of mw()) {
      if (m.type !== MOB_CRUSHER || !research.allowsMachine(m.type, m)) continue;
      if (system.currentTick % 5 && !nearMachine(m)) continue;   // 遠くのクラッシャーは0.25秒おき
      const block = blockOf(m); if (block?.typeId !== MOB_CRUSHER) continue;
      const s = read(m.key, crDefault), speed = speedLimit(m.key), dim = block.dimension, spec = MOBWORKS.crusher;
      let active = false;
      if (sum(s.out) >= spec.buffer) s.reason = "出力が満杯 · 取り出すかベルトで搬出してください";
      else if (s.job) {
        const e = world.getEntity(s.job.id);
        if (!e?.isValid) s.job = undefined;
        else if (nowSec() >= s.job.until) { finish(m, s, e, dim); active = true; }
        else { active = true; s.reason = `処理中 · ${MOB[e.typeId]?.name ?? label(e.typeId)} · 残り ${Math.max(0, s.job.until - nowSec()).toFixed(1)}秒`; if (system.currentTick % 4 === 0) fx(dim, "orbital_foundry:sw_spark", e.location); }
      } else {
        // 出現した瞬間にまとめて処理する
        const tags = linkedSpawners(m, s).map(x => tagOf(x.key));
        let targets = [];
        for (const t of tags) { try { targets.push(...dim.getEntities({ tags: [t], location: center(m), maxDistance: 12 }).filter(e => inZone(m, e) && !e.getDynamicProperty("of:crushing"))); } catch { } }
        if (!tags.length) s.reason = `リンクできるスポナーがありません (${spec.linkRange}ブロック以内に置く)`;
        else if (!targets.length) s.reason = "処理区画にリンク済みスポナーのモブなし";
        else for (const target of targets.slice(0, 32)) {
          if (sum(s.out) >= spec.buffer) break;
          const hp = MOB[target.typeId]?.hp ?? 20, cost = Math.ceil(hp * spec.sePerHp * (s.weapon === "koke_blade:seimetsu" ? .25 : s.weapon === "koke_blade:kikou" ? .8 : s.weapon === "koke_blade:seirou" ? .65 : s.weapon === "koke_blade:tenmetsu" ? .5 : 1));
          if (expansion.availablePower(m.key) < cost) { noteShort(m.key, cost - expansion.availablePower(m.key)); s.reason = `電力不足 · ${MOB[target.typeId]?.name ?? ""} 1体 ${cost.toLocaleString()} SE`; break; }
          target.setDynamicProperty("of:crushing", m.key);
          expansion.spend(m.key, cost);
          finish(m, s, target, dim); active = true; s.reason = "稼働中 · 出現と同時に処理";
        }
      }
      setBlockActive(block, m.type, m.key, active);
      write(m.key, s);
    }
  }
  function finish(m, s, e, dim) {
    const mob = MOB[e.typeId], at = { ...e.location };
    if (e.getDynamicProperty("of:crushed")) { s.job = undefined; return; }
    e.setDynamicProperty("of:crushed", m.key);   // 1体につき報酬1回
    if (s.owner && s.weapon?.startsWith("koke_blade:") && !s.weapon.endsWith("_broken")) e.addTag(`kb_factory|${s.owner}|${s.weapon}`);
    try { if (mob?.addon) e.kill(); else e.applyDamage(1e6, { cause: "override" }); } catch { try { e.kill(); } catch { } }
    s.kills = (s.kills ?? 0) + 1; s.job = undefined;
    s.xp = (s.xp ?? 0) + (mob?.xp ?? 5);
    for (const [item, base, per] of RARE[e.typeId] ?? []) if (Math.random() < base + per * (s.looting ?? 0)) add(s.out, item, 1);
    const { capsules, rest } = capsulesFrom(s.xp); if (capsules) { add(s.out, XP_CAPSULE, capsules); s.xp = rest; }
    snd(dim, "random.anvil_land", center(m), .4, 1.6); fx(dim, "minecraft:critical_hit_emitter", at);
    // 死亡時に落ちたアイテムを回収、経験値オーブは機械側で数えたので消す (二重取り防止)
    for (const t of [22, 30, 45, 220]) system.runTimeout(() => {
      try {
        for (const it of dim.getEntities({ location: at, maxDistance: t > 100 ? 8 : 3.5 })) {
          if (it.typeId === "minecraft:xp_orb") { it.remove(); continue; }
          if (it.typeId !== "minecraft:item") continue;
          const st = it.getComponent("minecraft:item")?.itemStack; if (!st) continue;
          const st2 = read(m.key, crDefault);
          let n = st.amount; if (st2.looting) n += Math.floor(Math.random() * (st2.looting + 1));
          add(st2.out, st.typeId, n); write(m.key, st2); it.remove();
        }
      } catch { }
    }, t);
  }
  // 出力バッファ: ベルト・コンテナへの搬出用
  function crusherView(block, key, output) {
    if (!output) return null;
    const ids = Object.keys(read(key, crDefault).out);
    const storage = {
      size: ids.length,
      getItem(slot) { const it = ids[slot], n = it && read(key, crDefault).out[it]; return n ? new ItemStack(it, Math.min(n, new ItemStack(it).maxAmount)) : undefined; },
      setItem(slot, stack) { const it = ids[slot]; if (!it) return; const s = read(key, crDefault), n = s.out[it] ?? 0; if (!n || (stack && stack.typeId !== it)) return; add(s.out, it, (stack?.amount ?? 0) - Math.min(n, new ItemStack(it).maxAmount)); write(key, s); },
    };
    return { block, storage, slots: ids.map((_, i) => i) };
  }
  async function showCrusher(p, block, key) {
    const m = registry().find(x => x.key === key) ?? { key, dim: block.dimension.id, ...block.location };
    const s = read(key, crDefault), links = linkedSpawners(m, s), speed = speedLimit(key), z = MOBWORKS.crusher.zone;
    const out = Object.entries(s.out).sort((a, b) => b[1] - a[1]);
    const form = createForm().title("全自動モブクラッシャー").body(
      `§l状態§r  ${s.reason}\n` +
      `§lリンク§r  スポナー ${links.length}台${s.links?.length ? " (指定)" : " (周囲を自動)"} · 処理区画: 半径${z.r} · 高さ${z.up} (この機械の上)\n` +
      `§l処理費§r  最大HP 1につき ${MOBWORKS.crusher.sePerHp} SE · ${speed}倍速 · 累計 ${s.kills ?? 0}体\n` +
      `§l武器§r  ${s.weapon ? `${label(s.weapon)} (ドロップ増加 ${s.looting})` : "なし (ドロップ増加なし)"}\n` +
      `§l抜刀剣連携§r  ${s.weapon?.startsWith("koke_blade:") ? (s.owner ? "登録者に撃破+1 / 熟練+1" : "再登録が必要") : "未使用"}\n` +
      `§l経験値§r  ${s.xp ?? 0} / ${MOBWORKS.xpPerCapsule} ＞ 100ごとに経験値カプセル1個\n` +
      `§l出力§r  ${sum(s.out)} / ${MOBWORKS.crusher.buffer}個\n` + (out.slice(0, 8).map(([it, n]) => `  ${label(it)} ×${n}`).join("\n") || "  (空)") +
      `\n\n§7プレイヤー・ペット・自然湧き・別スポナーのモブには反応しません。出力はベルトでも搬出できます。`);
    const held = p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex);
    const acts = [];
    if (sum(s.out)) { form.button("出力をすべて受け取る"); acts.push("take"); }
    if (held && !s.weapon) { form.button(`手に持っている「${label(held.typeId)}」を武器として登録`); acts.push("weapon"); }
    if (s.weapon) { form.button("登録した武器を返してもらう"); acts.push("unweapon"); }
    form.button("処理区画を表示"); acts.push("show");
    form.button("表示を更新"); acts.push("refresh"); form.button("閉じる"); acts.push("close");
    const r = await form.show(p); if (r.canceled || !sameMachine(block, MOB_CRUSHER)) return;
    const a = acts[r.selection], inv = p.getComponent("minecraft:inventory")?.container, st = read(key, crDefault);
    if (a === "take" && inv) { for (const [it, n] of Object.entries(st.out)) { let left = n; while (left > 0) { const k = Math.min(new ItemStack(it).maxAmount, left), rest = inv.addItem(new ItemStack(it, k)); left -= k - (rest?.amount ?? 0); if (rest) break; } if (left) st.out[it] = left; else delete st.out[it]; } write(key, st); }
    else if (a === "weapon" && inv) {
      const it = inv.getItem(p.selectedSlotIndex); if (it && !st.weapon && !it.typeId.endsWith("_broken")) {
        let lv = 0; try { lv = it.getComponent("minecraft:enchantable")?.getEnchantment("looting")?.level ?? 0; } catch { }
        st.owner = p.id; st.weapon = it.typeId; st.looting = lv; st.weaponData = { id: it.typeId, looting: lv, name: it.nameTag, damage: it.getComponent("minecraft:durability")?.damage, props: Object.fromEntries(it.getDynamicPropertyIds().map(k => [k,it.getDynamicProperty(k)])), lore: it.getLore() }; inv.setItem(p.selectedSlotIndex, undefined); write(key, st);
        toast(p, `武器を登録 · ドロップ増加 ${lv}`);
      }
    } else if (a === "unweapon" && inv && st.weapon && (!st.owner || st.owner === p.id)) {
      const it = new ItemStack(st.weapon, 1);
      try { if (st.looting) it.getComponent("minecraft:enchantable")?.addEnchantment({ type: "looting", level: st.looting }); } catch { }
      try { if (st.weaponData?.name) it.nameTag = st.weaponData.name; } catch { }
      try { for (const [k,v] of Object.entries(st.weaponData?.props ?? {})) it.setDynamicProperty(k,v); const d = it.getComponent("minecraft:durability"); if (d && st.weaponData?.damage !== undefined) d.damage = st.weaponData.damage; if (st.weaponData?.lore) it.setLore(st.weaponData.lore); } catch {}
      if (!inv.addItem(it)) { st.owner = undefined; st.weaponData = undefined; st.weapon = null; st.looting = 0; write(key, st); }
    } else if (a === "show") {
      const dim = block.dimension, z2 = MOBWORKS.crusher.zone;
      // 処理区画を立体の枠で10秒表示 (縦の柱4本・上下の四角)
      const x0 = m.x - z2.r, x1 = m.x + z2.r + 1, z0 = m.z - z2.r, z1 = m.z + z2.r + 1, y0 = m.y + 1, y1 = m.y + 1 + z2.up;
      const edge = (a, b) => { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / .5); for (let i = 0; i <= n; i++) fx(dim, "orbital_foundry:sw_warn", { x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n, z: a.z + (b.z - a.z) * i / n }); };
      const P = (x, y, z) => ({ x, y, z });
      for (let k = 0; k < 10; k++) system.runTimeout(() => {
        for (const y of [y0, y1]) { edge(P(x0, y, z0), P(x1, y, z0)); edge(P(x1, y, z0), P(x1, y, z1)); edge(P(x1, y, z1), P(x0, y, z1)); edge(P(x0, y, z1), P(x0, y, z0)); }
        for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) edge(P(x, y0, z), P(x, y1, z));
      }, k * 20);
      return;
    } else if (a !== "refresh") return;
    return showCrusher(p, block, key);
  }

  // ================= 経験値カプセル =================
  try {
    system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
      itemComponentRegistry.registerCustomComponent(id("xp_capsule"), {
        onUse: ({ source: p, itemStack }) => {
          if (p?.typeId !== "minecraft:player") return;
          system.run(() => {
            const inv = p.getComponent("minecraft:inventory")?.container, slot = p.selectedSlotIndex, it = inv?.getItem(slot);
            if (it?.typeId !== XP_CAPSULE) return;
            const n = p.isSneaking ? it.amount : 1;
            p.addExperience(n * MOBWORKS.xpPerCapsule);
            if (n >= it.amount) inv.setItem(slot, undefined); else { it.amount -= n; inv.setItem(slot, it); }
            try { p.playSound("random.orb", { volume: 1, pitch: .8 + Math.random() * .4 }); } catch { }
            toast(p, `経験値 +${n * MOBWORKS.xpPerCapsule}`);
          });
        },
      });
    });
  } catch { }

  system.runInterval(() => { try { tickIncinerators(); } catch (e) { console.warn("[mobworks] incinerator " + e); } }, 20);
  system.runInterval(() => { try { tickSpawners(); } catch (e) { console.warn("[mobworks] spawner " + e); } } , 5);
  system.runInterval(() => { try { tickCrushers(); } catch (e) { console.warn("[mobworks] crusher " + e); } }, 1);

  function view(block, key, output) {
    if (block.typeId === INCINERATOR) return output ? null : { block, storage: { size: 0, getItem() { }, setItem() { } }, slots: [], virtualRoom: item => Math.max(0, Math.min(item.amount, MOBWORKS.incinerator.queue - sum(read(key, incDefault).queue))), virtualInsert: item => incineratorInsert(key, item) };
    if (block.typeId === MOB_CRUSHER) return crusherView(block, key, output);
    if (block.typeId === SPAWNER) return null;
    return undefined;
  }
  function show(p, block, key) {
    if (block.typeId === INCINERATOR) return showIncinerator(p, block, key);
    if (block.typeId === SPAWNER) return showSpawner(p, block, key);
    if (block.typeId === MOB_CRUSHER) return showCrusher(p, block, key);
  }
  return { view, show, incineratorInsert, _test: { tickIncinerators, tickSpawners, tickCrushers, read } };
}
