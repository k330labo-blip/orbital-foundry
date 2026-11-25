// 電力パネル (ファクトリオ風) と食料の説明文。
// ・しゃがみを素早く2回で開閉 (統合版のアドオンはジャンプとしゃがみ以外のキーを読めないため)
// ・数値は「そのプレイヤーが置いた機械」だけで集計する (サーバー全体では合算しない)
// ・画面への受け渡しはタイトル文字列 ("ofh" で始まる) を使い、RP/ui/hud_screen.json が右端のパネルに描く。
//   バニラのタイトル表示は "ofh" を含む間だけ隠すので、ボスゲージや他の通知とは重ならない。
import * as mc from "@minecraft/server";
import { cleanInventory, heldFoodText } from "./food_info.js";
import { ActionFormData } from "@minecraft/server-ui";

// このアドオンが通常のタイトル (ボス警報など) を出している間は、パネル更新を止めて上書きしない
let pausedUntil = 0, tickNow = 0;
try {
  const SD = mc.ScreenDisplay, orig = SD.prototype.setTitle;
  SD.prototype.setTitle = function (text, opt) {
    if (typeof text !== "string" || !text.startsWith("ofh")) {
      const d = opt ? (opt.fadeInDuration ?? 10) + (opt.stayDuration ?? 70) + (opt.fadeOutDuration ?? 20) : 100;
      pausedUntil = Math.max(pausedUntil, tickNow + d);
    }
    return orig.call(this, text, opt);
  };
} catch {}

const SAMPLE = 20;          // 1秒ごとに集計
const POINT_SAMPLES = 4;    // グラフは4秒ごとに1点 (直近8秒の平均)
const POINTS = 30;          // 30点 = 2分
const AVG = 30;             // 数値は直近30秒平均 (石炭発電機は燃え終わりにまとめて発電するため、短いと0とその他を行き来する)

const shortNow = new Map();   // 機械キー → この2秒で足りなかった電力 (最大値)
export function noteShort(key, amount) {
  if (key === undefined || !(amount > 0)) return;
  if ((shortNow.get(key) ?? 0) < amount) shortNow.set(key, amount);
}
export function checkShort(key, need, have) { if (have < need) noteShort(key, need - have); }
const useNow = new Map();     // 機械キー → この1秒で使った電力 (内訳用)
export function noteUse(key, amount) { if (key !== undefined && amount > 0) useNow.set(key, (useNow.get(key) ?? 0) + amount); }

const fmt = n => {
  n = Math.max(0, n);
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k";
  return String(Math.round(n));
};
const r1 = n => (Math.round(n * 10) / 10).toFixed(1);

export function installHud({ world, system, registry, generatorRecord, generatorCapacity, GENERATOR_TYPES, BATTERIES, machineName = () => undefined }) {
  const stat = new Map();   // owner → {prevGen:Map, prevStored:Map, samples:[{gen,use,lack,cnt}], acc:[], points:[], stored, cap}
  const S = o => { let s = stat.get(o); if (!s) stat.set(o, s = { prevGen: new Map(), prevStored: new Map(), samples: [], acc: [], points: [], stored: 0, cap: 0, buf: 0, bats: 0, types: new Map() }); return s; };

  function sample() {
    const byOwner = new Map(), keyInfo = new Map(), typeCount = new Map();
    for (const m of registry()) {
      if (!m.owner) continue;
      keyInfo.set(m.key, m);
      const tc = typeCount.get(m.owner) ?? new Map(); typeCount.set(m.owner, tc); tc.set(m.type, (tc.get(m.type) ?? 0) + 1);
      const gen = GENERATOR_TYPES.has(m.type), bat = !!BATTERIES[m.type];
      if (!gen && !bat) continue;
      let o = byOwner.get(m.owner); if (!o) byOwner.set(m.owner, o = []);
      o.push({ m, gen });
    }
    const lackBy = new Map(), cntBy = new Map(), useType = new Map();
    for (const [key, n] of shortNow) { const o = keyInfo.get(key)?.owner; if (!o) continue; lackBy.set(o, (lackBy.get(o) ?? 0) + n); cntBy.set(o, (cntBy.get(o) ?? 0) + 1); }
    for (const [key, n] of useNow) { const m = keyInfo.get(key); if (!m) continue; const t = useType.get(m.owner) ?? new Map(); useType.set(m.owner, t); t.set(m.type, (t.get(m.type) ?? 0) + n); }
    shortNow.clear(); useNow.clear();
    const owners = new Set([...byOwner.keys(), ...lackBy.keys(), ...world.getAllPlayers().map(p => p.id)]);
    const sec = SAMPLE / 20;
    for (const owner of owners) {
      const s = S(owner), list = byOwner.get(owner) ?? [];
      let gen = 0, dStored = 0, stored = 0, cap = 0, buf = 0;
      const nextGen = new Map(), nextStored = new Map(), genType = new Map();
      for (const { m, gen: isGen } of list) {
        const rec = generatorRecord(m.key);
        const st = Math.max(0, rec.stored ?? 0);
        // 蓄電の表示は蓄電池だけ。発電機の中にたまっている分は消費の計算にだけ使い、別に「発電機内」として出す
        if (isGen) buf += st; else { stored += st; cap += BATTERIES[m.type]?.capacity ?? 0; }
        nextStored.set(m.key, st);
        if (s.prevStored.has(m.key)) dStored += st - s.prevStored.get(m.key);
        if (isGen) {
          const g = rec.generated ?? 0; nextGen.set(m.key, g);
          if (s.prevGen.has(m.key)) { const d = Math.max(0, g - s.prevGen.get(m.key)); gen += d; genType.set(m.type, (genType.get(m.type) ?? 0) + d); }
        }
      }
      s.prevGen = nextGen; s.prevStored = nextStored; s.stored = stored; s.cap = cap; s.buf = buf; s.bats = list.filter(x => !x.gen).length; s.types = typeCount.get(owner) ?? new Map();
      const use = Math.max(0, gen - dStored);   // 発電した分 − 増えた蓄電 = 使った分
      const smp = { gen: gen / sec, use: use / sec, lack: (lackBy.get(owner) ?? 0) / sec, cnt: cntBy.get(owner) ?? 0, pct: cap ? stored / cap : 0,
        genType, useType: useType.get(owner) ?? new Map() };
      s.samples.push(smp); if (s.samples.length > AVG) s.samples.shift();
      s.acc.push(smp);
      if (s.acc.length >= POINT_SAMPLES) {
        const recent = s.samples.slice(-8);
        const avg = k => recent.reduce((t, x) => t + x[k], 0) / recent.length;
        s.points.push({ gen: avg("gen"), use: avg("use") }); if (s.points.length > POINTS) s.points.shift();
        s.acc = [];
      }
    }
  }

  // ---- 画面に出す文字 ----
  // パネル全体を1つの文字列 ("ofh1:" + 本文) にしてタイトルで送り、RP 側は "ofh1:" を取り除いて1つの文字欄に表示する。
  // グラフは文字のブロック (▁〜█) を色付きで並べる。空きは黒い█でグラフの背景にする
  const nameOf = t => machineName(t) ?? t.split(":").pop();
  const short = (t, n = 9) => t.length > n ? t.slice(0, n - 1) + ".." : t;   // パネルからはみ出さないよう機械名を切る
  function totals(s, key) {
    const sum = new Map();
    for (const x of s.samples) for (const [t, n] of x[key]) sum.set(t, (sum.get(t) ?? 0) + n / s.samples.length);
    return [...sum].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }
  function breakdownLines(s, key, color) {
    const all = totals(s, key), top = all.slice(0, 3);
    if (!top.length) return ["  §8なし"];
    const max = top[0][1];
    const lines = top.map(([t, n]) => `  §f${short(nameOf(t))} §7x${s.types.get(t) ?? 0} §f${fmt(n)}/秒 ${color}${"|".repeat(Math.max(1, Math.round(n / max * 6)))}`);
    if (all.length > 3) lines.push(`  §8ほか ${all.length - 3}種類`);
    return lines;
  }
  function summary(s) {
    const avg = k => s.samples.length ? s.samples.reduce((t, x) => t + x[k], 0) / s.samples.length : 0;
    const cnt = s.samples.length ? Math.max(...s.samples.slice(-5).map(x => x.cnt)) : 0;
    const store = s.bats ? `§f${Math.min(100, Math.round(s.stored / Math.max(1, s.cap) * 100))}％ §7${fmt(s.stored)}/${fmt(s.cap)}` : "§8なし";
    return { gen: avg("gen"), use: avg("use"), lack: avg("lack"), cnt, store };
  }
  function text(p) {
    const s = S(p.id), v = summary(s);
    return [
      "§l§e電力網§r §7自分の機械 · 30秒平均",
      `§a発電 §f${fmt(v.gen)}/秒  §6消費 §f${fmt(v.use)}/秒`,
      `§c不足 §f${fmt(v.lack)}/秒${v.cnt ? ` §c(${v.cnt}台停止)` : ""}`,
      `§9蓄電池 ${v.store} §8発電機内 ${fmt(s.buf ?? 0)}`,
      "§a発電の内訳", ...breakdownLines(s, "genType", "§a"),
      "§6消費の内訳", ...breakdownLines(s, "useType", "§6"),
      "§8しゃがみ2回:閉じる / しゃがみ+ジャンプ:一覧",
    ].join("\n");
  }
  // 全部の内訳はスクロールできるフォーム画面で見る (HUD はスクロールできないため)
  async function showAll(p) {
    const s = S(p.id), v = summary(s);
    const sec = (title, list, total, color) => [`§l${color}${title}§r`, ...(list.length ? list.map(([t, n]) =>
      `${color}|§r ${nameOf(t)} §7x${s.types.get(t) ?? 0}§r  ${fmt(n)}/秒 §7(${total ? Math.round(n / total * 100) : 0}％)`) : ["§8なし"])];
    const body = [
      `§a発電 §f${fmt(v.gen)}/秒   §6消費 §f${fmt(v.use)}/秒   §c不足 §f${fmt(v.lack)}/秒${v.cnt ? ` (${v.cnt}台停止)` : ""}`,
      `§9蓄電池 ${v.store}   §7発電機内 ${fmt(s.buf ?? 0)}`, "§7(直近30秒の平均 · 自分の置いた機械だけ)", "",
      ...sec("発電の内訳", totals(s, "genType"), v.gen, "§a"), "",
      ...sec("消費の内訳", totals(s, "useType"), v.use, "§6"),
    ].join("\n");
    try {
      const r = await new ActionFormData().title("電力網の内訳").body(body).button("更新").button("閉じる").show(p);
      if (r.selection === 0) system.run(() => showAll(p));
    } catch {}
  }

  // 開閉: しゃがみを短く2回 (どちらも 0.5 秒未満、間隔 0.8 秒以内)
  const sneak = new Map();   // id → {down, downAt, lastTap}
  const isOpen = p => { try { return p.getDynamicProperty("of:hud_open") === true; } catch { return false; } };
  const lastSent = new Map();   // id → {text, at}
  function send(p, open) {
    tickNow = system.currentTick;
    if (open && tickNow < pausedUntil) return;   // このアドオンの警報などを表示中は上書きしない
    const body = open ? "ofh1:" + text(p) : "ofh0:";
    const last = lastSent.get(p.id);
    if (open && last && last.text === body && tickNow - last.at < 100) return;   // 変化がなければ 5 秒ごとに送り直すだけ
    lastSent.set(p.id, { text: body, at: tickNow });
    try { p.onScreenDisplay.setTitle(body, { fadeInDuration: 0, stayDuration: open ? 600 : 1, fadeOutDuration: 0 }); } catch {}
  }
  function setOpen(p, open) {
    try { p.setDynamicProperty("of:hud_open", open); } catch {}
    if (open) pausedUntil = 0;
    send(p, open);
    try { p.playSound(open ? "random.click" : "random.pop", { volume: .4, pitch: open ? 1.4 : .8 }); } catch {}
    try { p.sendMessage(open ? "§b電力パネルを開きました§7 (しゃがみ2回で閉じる)" : "§7電力パネルを閉じました"); } catch {}
  }
  // 食料を手に持ったら、その回復量を画面下に表示する (持ち替えたときに1回)
  const heldFood = new Map();
  system.runInterval(() => {
    for (const p of world.getAllPlayers()) {
      let id = ""; try { id = p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex)?.typeId ?? ""; } catch {}
      if (heldFood.get(p.id) === id) continue;
      heldFood.set(p.id, id);
      const text = heldFoodText(p);
      if (text) try { p.onScreenDisplay.setActionBar(text); } catch {}
    }
  }, 5);
  system.runInterval(() => {
    const t = system.currentTick; tickNow = t;
    for (const p of world.getAllPlayers()) {
      let s = sneak.get(p.id); if (!s) sneak.set(p.id, s = { down: false, downAt: 0, lastTap: -99 });
      let now = false; try { now = p.isSneaking; } catch {}
      let jump = false; try { jump = now && p.isJumping; } catch {}
      if (jump && !s.jump && isOpen(p)) system.run(() => showAll(p));
      s.jump = jump;
      if (now && !s.down) { s.down = true; s.downAt = t; }
      else if (!now && s.down) {
        s.down = false;
        if (t - s.downAt <= 10) {
          if (t - s.lastTap <= 16) { s.lastTap = -99; setOpen(p, !isOpen(p)); }
          else s.lastTap = t;
        }
      }
    }
  }, 1);
  system.runInterval(() => {
    try { sample(); } catch (e) { console.warn("[Orbital Foundry] 電力集計: " + e); }
    for (const p of world.getAllPlayers()) {
      if (isOpen(p)) try { send(p, true); } catch (e) { console.warn("[Orbital Foundry] 電力パネル: " + e); }
      try { cleanInventory(p); } catch {}
    }
  }, SAMPLE);
  world.afterEvents.playerSpawn.subscribe(ev => { if (ev.initialSpawn) lastSent.delete(ev.player.id); });
  world.afterEvents.playerLeave?.subscribe(ev => { sneak.delete(ev.playerId); lastSent.delete(ev.playerId); });

  return { toggle(p) { setOpen(p, !isOpen(p)); }, isOpen, showAll };
}
