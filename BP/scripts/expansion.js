import { noteShort, checkShort, noteUse } from "./hud.js";
import { ItemStack, EntityDamageCause, EnchantmentType, MolangVariableMap } from "@minecraft/server";
import { affordableSpeed, scheduledStart, visualStepTicks } from "./machine-speed.js";
import { installOverseerRaid } from "./overseer_raid.js";
import { reactorAtShell, reactorStructure, REACTOR_CASING, REACTOR_WINDOW } from "./reactor_structure.js";
import { WORLD_NEIGHBORS } from "./connections.js";
import { GENERATOR_TYPES } from "./fluids.js";
import { BATTERIES } from "./battery.js";
import { GROWER_TIERS } from "./growing_specs.js";
import { CARGO_ICONS, CARGO_ICON_BLANK } from "./cargo_icons.js";
// アイコン画像のない品目 (ほかのアドオンの物など) は、荷物エンティティに実物を持たせて表示する
function cargoLook(entity, typeId) {
  const known = CARGO_ICONS[typeId];
  if (known !== undefined) return known;
  if (!entity) return 0;   // データ貨物は実物を持てないので小包アイコンで表示する
  try {
    if (entity.getDynamicProperty("of:held") !== typeId) {
      const r = entity.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${typeId}`);
      if (!r?.successCount) return 0;
      entity.setDynamicProperty("of:held", typeId);
    }
    return CARGO_ICON_BLANK;
  } catch { return 0; }
}
import { EXPANSION as C, BOSS, NS, PROCESS_RECIPES, ORE_PROCESSING, ENERGY, MECHANICAL_SCIENCE, BELT_RESEARCH, SCIENCE_PACKS } from "./config.js";
import { isNear, nearMachine } from "./lod.js";

export function installExpansion(core) {
  const { world, system, registry, machineState, saveMachineState, legacyEnergy, generatorRecord, drawEnergy,
    keyOf, machineContainer, createForm, countItem, removeItems, giveItems, dpGet, dpSet,
    toast, sameMachine, setBlockActive, nameOf, research, rocketStage, pGet, pSet, speedLimit } = core;
  const id = name => `${NS}:${name}`;
  // 大容量コンテナ・チャンクデストロイヤーなど、実インベントリを持たない設備の物流窓口。
  // provider(block,key,output) は対象外なら undefined、その向きを閉じているなら null を返す。
  let virtualStorage=()=>undefined, virtualTypes=new Set();
  function setVirtualStorage(provider,types) { virtualStorage=provider; virtualTypes=new Set(types); }
  // 機械ごとに「レシピの素材として使えるアイテム」の集合。自動搬入・分配・ベルト搬入は
  // これに含まれる物だけを素材スロットへ入れる (完成品が素材側へ回るのを防ぐ)
  const RECIPE_INPUTS=new Map();
  for (const r of PROCESS_RECIPES) {
    const key=id(r.machine);
    if (!RECIPE_INPUTS.has(key)) RECIPE_INPUTS.set(key,new Set());
    for (const [itemId] of r.in) RECIPE_INPUTS.get(key).add(itemId);
  }
  const directions = [[1,0,"東"],[0,1,"南"],[-1,0,"西"],[0,-1,"北"]];
  const neighbors = WORLD_NEIGHBORS;
  let machineIndex = new Map();
  // reactorAtShell へ渡すためだけに [...machineIndex.values()] を毎回作ると、
  // 貨物ループのような頻繁な経路で効くので配列を使い回す。machineIndex は
  // updateNetwork で丸ごと作り直される (中身の追加・削除は無い) ので、
  // 参照が変わったときだけ作り直せば中身は常に一致する。
  let machineListSrc = null, machineListCache = [];
  function machineList() {
    if (machineListSrc !== machineIndex) { machineListSrc = machineIndex; machineListCache = [...machineIndex.values()]; }
    return machineListCache;
  }
  const isPowerSource = type => GENERATOR_TYPES.has(type) || !!BATTERIES[type];
  const canSupply = key => !BATTERIES[machineIndex.get(key)?.type] || generatorRecord(key).mode!=="charge";
  // Draw power from running generators before using stored backup power.
  const orderedSources = keys => [...keys].sort((a,b)=>
    Number(!!BATTERIES[machineIndex.get(a)?.type])-Number(!!BATTERIES[machineIndex.get(b)?.type]));
  let beltEntries = [], beltCursor = 0;
  // ---- ベルト分配機: 入ってくるベルト1本から、外へ流れるベルト最大3本へアイテム個数で均等に分ける ----
  // 新規設置の入口はプレイヤー側。旧版の設置済み分配機はベルトの向きから入口・出口を判定する。
  // 中身は 共有プール (まだ出口が決まっていない分) と 出口ごとの待ち行列 で持つ。合計がバッファ上限に達したら入口を止める。
  const SPLITTERS = { [id("splitter_1")]: { grade: 1, buffer: 64 }, [id("splitter_2")]: { grade: 2, buffer: 256 }, [id("splitter_3")]: { grade: 3, buffer: 512 },
    // 二又: 入口の正面は出口にしない (左右の2方向だけ)
    [id("splitter2_1")]: { grade: 1, buffer: 64, two: true }, [id("splitter2_2")]: { grade: 2, buffer: 256, two: true }, [id("splitter2_3")]: { grade: 3, buffer: 512, two: true } };
  const spKey = key => `of:splitter:${key}`;
  const readSplitter = key => { try { return { pool: {}, q: [{}, {}, {}, {}], filters: [null, null, null, null], rr: 0, ...JSON.parse(dpGet(spKey(key), "{}")) }; } catch { return { pool: {}, q: [{}, {}, {}, {}], filters: [null, null, null, null], rr: 0 }; } };
  const writeSplitter = (key, s) => dpSet(spKey(key), JSON.stringify(s));
  const sumOf = o => Object.values(o).reduce((a, b) => a + b, 0);
  const splitterTotal = key => { const s = readSplitter(key); return sumOf(s.pool) + s.q.reduce((a, q) => a + sumOf(q), 0); };
  const addTo = (o, item, n) => { o[item] = (o[item] ?? 0) + n; if (o[item] <= 0) delete o[item]; };
  const splitterInputState = id("splitter_input");
  const cardinalSides = ["east", "south", "west", "north"];
  // ベルトを置いたとき、プレイヤーが向いている方向を「置いた向き」として記録する
  // (流れの向きの推定の手がかりと、並走するベルト同士を誤ってつながないために使う)
  function orientBelt(block, player, key) {
    if (!isBelt(block.typeId)) return;
    const yaw = player.getRotation().y * Math.PI / 180;
    const fx = -Math.sin(yaw), fz = Math.cos(yaw);
    const d = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 0 : 2) : (fz > 0 ? 1 : 3);
    const st = machineState(key); st.placedDirection = d; if (!st.directionLocked) st.direction = d; saveMachineState(key, st);
    layoutVersion++; invalidateBeltState(key);
  }
  function orientSplitter(block, player) {
    const {x, z} = block.location;
    let dx = player.location.x - (x + .5);
    let dz = player.location.z - (z + .5);
    // When placing directly above or below the block, use the player's horizontal facing.
    if (Math.abs(dx) <= .5 && Math.abs(dz) <= .5) {
      const yaw = player.getRotation().y * Math.PI / 180;
      dx = Math.sin(yaw);
      dz = -Math.cos(yaw);
    }
    const input = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 2) : (dz > 0 ? 1 : 3);
    block.setPermutation(block.permutation.withState(splitterInputState, cardinalSides[input]));
  }
  function splitterInput(block) {
    return cardinalSides.indexOf(block.permutation.getState(splitterInputState));
  }
  // 接続済みの入口・出口だけを返す。入口が固定されている場合は反対向きのベルトを除外する。
  function splitterSides(dim, m, block) {
    const input = splitterInput(block), two = SPLITTERS[block.typeId]?.two;
    const sides = [];
    for (let side = 0; side < 4; side++) {
      let kind = null;
      if (two && input >= 0 && side === (input + 2) % 4) { sides.push(null); continue; }   // 二又: 正面は塞ぐ
      for (const dy of beltLevels) {
        const nb = machineIndex.get(keyOf(m.dim, neighborOn(m, side, dy)));
        if (!nb || !isBelt(nb.type) || !findBlock(dim, nb.key)) continue;
        const flow = beltDirection(nb.key);
        if (flow === opposite(side) && (input < 0 || side === input)) { kind = "in"; break; }
        if (flow === side && side !== input) { kind = "out"; break; }
      }
      sides.push(kind);
    }
    return sides;
  }
  // プールの中身を出口へ割り振る: 専用フィルターのある出口が最優先、なければフィルター未設定の出口へ。個数で均等、余りは順番に回す
  function distribute(s, sides) {
    const outs = [0, 1, 2, 3].filter(i => sides[i] === "out");
    for (const item of Object.keys(s.pool)) {
      const n = s.pool[item];
      const dedicated = outs.filter(i => s.filters[i] === item);
      const targets = dedicated.length ? dedicated : outs.filter(i => !s.filters[i]);
      if (!targets.length) continue;                       // 送り先なし: プールで待つ
      const base = Math.floor(n / targets.length), rem = n % targets.length;
      s.lastPull ??= [0, 0, 0, 0];
      targets.forEach((side, k) => {
        if (!sumOf(s.q[side])) s.lastPull[side] = system.currentTick;   // 空の出口に配った時点から「取られていない時間」を数える
        const extra = ((k - s.rr) % targets.length + targets.length) % targets.length < rem ? 1 : 0;
        if (base + extra) addTo(s.q[side], item, base + extra);
      });
      s.rr = (s.rr + rem) % Math.max(1, targets.length);
      delete s.pool[item];
    }
  }
  // 配り先として使える出口: 詰まり中 (blocked) の出口は外す
  const usable = (s, sides) => sides.map((k, i) => k === "out" && (s.blocked?.[i] ?? 0) <= system.currentTick ? "out" : k === "out" ? null : k);
  function splitterView(block, key, output, from) {
    const m = machineIndex.get(key) ?? { key, dim: block.dimension.id, ...block.location };
    const spec = SPLITTERS[block.typeId], dim = block.dimension;
    if (from === null) return null;                           // 機械やチェストとは直接やり取りしない (ベルト専用)
    const sides = splitterSides(dim, m, block);
    const sideOf = p => p ? directions.findIndex(([dx, dz]) => p.x === m.x + dx && p.z === m.z + dz) : -1;
    const side = sideOf(from);
    if (!output) {
      if (from !== undefined && (side < 0 || sides[side] !== "in")) return null;
      return { block, storage: { size: 0, getItem() {}, setItem() {} }, slots: [], splitter: true,
        virtualRoom: item => Math.max(0, Math.min(item.amount, spec.buffer - splitterTotal(key))),
        virtualInsert: item => {
          const s = readSplitter(key), room = Math.max(0, spec.buffer - (sumOf(s.pool) + s.q.reduce((a, q) => a + sumOf(q), 0)));
          const n = Math.min(room, item.amount); if (n <= 0) return 0;
          addTo(s.pool, item.typeId, n); distribute(s, usable(s, sides)); writeSplitter(key, s); return n;
        } };
    }
    if (side < 0 || sides[side] !== "out") return null;
    // 出口ごとの待ち行列を、品目ごとに1スロットとして見せる (ベルトが取ったぶんだけ減る)
    const ids = Object.keys(readSplitter(key).q[side]);
    const storage = {
      size: ids.length,
      getItem(slot) { const it = ids[slot], n = it && readSplitter(key).q[side][it]; return n ? new ItemStack(it, Math.min(n, new ItemStack(it).maxAmount)) : undefined; },
      setItem(slot, stack) {
        const it = ids[slot]; if (!it) return;
        const s = readSplitter(key), n = s.q[side][it] ?? 0; if (!n || (stack && stack.typeId !== it)) return;
        const shown = Math.min(n, new ItemStack(it).maxAmount);
        addTo(s.q[side], it, (stack?.amount ?? 0) - shown); s.lastPull = s.lastPull ?? [0, 0, 0, 0]; s.lastPull[side] = system.currentTick;
        if (s.blocked) s.blocked[side] = 0;   // 取ってくれた = もう詰まっていない
        writeSplitter(key, s);
      },
    };
    return { block, storage, slots: ids.map((_, i) => i), splitter: true };
  }
  // 1秒ごと: 出口の増減に追従し、詰まった出口の分を空いている出口へ回す (専用フィルターの品目は待つ)
  system.runInterval(() => {
    for (const m of machineIndex.values()) {
      if (!SPLITTERS[m.type]) continue;
      try {
        const dim = world.getDimension(m.dim), block = findBlock(dim, m.key);
        if (!block) continue;
        const s = readSplitter(m.key), sides = splitterSides(dim, m, block), t_ = system.currentTick;
        s.lastPull ??= [0, 0, 0, 0]; s.blocked ??= [0, 0, 0, 0];
        let changed = false;
        for (let i = 0; i < 4; i++) {
          const has = sumOf(s.q[i]) > 0;
          if (!has) continue;
          const gone = sides[i] !== "out";
          const stuck = !gone && t_ - s.lastPull[i] > 40;     // 2秒以上 取られていない
          if (!gone && !stuck) continue;
          if (stuck) s.blocked[i] = t_ + 100;                  // 5秒間は配り先から外す
          const others = usable(s, sides).some((k, j) => j !== i && k === "out");
          for (const item of Object.keys(s.q[i])) {
            if (!gone && s.filters[i] === item) continue;      // 専用出口の品目はその出口で待つ
            if (!gone && !others) continue;                   // ほかに出口がなければそのまま待つ
            addTo(s.pool, item, s.q[i][item]); delete s.q[i][item]; changed = true;
          }
        }
        if (changed || sumOf(s.pool)) { distribute(s, usable(s, sides)); changed = true; }
        if (changed) writeSplitter(m.key, s);
      } catch {}
    }
  }, 20);
  // 壊したら中身を全部その場に落とす
  world.afterEvents.playerBreakBlock.subscribe(ev => {
    try {
      const type = ev.brokenBlockPermutation.type.id; if (!SPLITTERS[type]) return;
      const key = keyOf(ev.dimension.id, ev.block.location), s = readSplitter(key);
      const all = {}; for (const o of [s.pool, ...s.q]) for (const [it, n] of Object.entries(o)) addTo(all, it, n);
      const at = { x: ev.block.location.x + .5, y: ev.block.location.y + .5, z: ev.block.location.z + .5 };
      for (const [it, n] of Object.entries(all)) { let left = n; const max = new ItemStack(it).maxAmount; while (left > 0) { const k = Math.min(max, left); ev.dimension.spawnItem(new ItemStack(it, k), at); left -= k; } }
      dpSet(spKey(key), undefined);
    } catch {}
  });
  async function splitterUi(p, block, key) {
    const m = machineIndex.get(key) ?? { key, dim: block.dimension.id, ...block.location };
    const type = block.typeId;
    const s = readSplitter(key), sides = splitterSides(block.dimension, m, block), spec = SPLITTERS[type];
    const fixedInput = splitterInput(block);
    const input = fixedInput < 0 ? sides.indexOf("in") : fixedInput;
    const rel = i => input < 0 ? directions[i][2] : i === opposite(input) ? "前" : i === (input + 3) % 4 ? "右" : i === (input + 1) % 4 ? "左" : "後ろ";
    const label = it => nameOf?.(it) ?? it.replace(/^.*:/, "");
    const held = p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex)?.typeId;
    const outlets = fixedInput < 0
      ? [0, 1, 2, 3].filter(i => i !== input)
      : spec.two ? [(input + 1) % 4, (input + 3) % 4] : [opposite(input), (input + 1) % 4, (input + 3) % 4];
    const lines = outlets.filter(i => fixedInput >= 0 || sides[i] === "out" || s.filters[i]).map(i =>
      `${rel(i)} (${directions[i][2]})  ${sides[i] === "out" ? "§a出口§r" : "§7未接続§r"}  フィルター: ${s.filters[i] ? label(s.filters[i]) : "なし"}  待ち ${sumOf(s.q[i])}個`);
    const entry = input < 0 ? "§c未接続 (分配機へ流れ込むベルトをつなぐ)§r"
      : directions[input][2] + (sides[input] === "in" ? " §a接続済み§r" : " §7未接続§r");
    const form = createForm().title(`${spec.two ? "二又" : ""}ベルト分配機 Mk ${["", "I", "II", "III"][spec.grade]}`).body(
      `入口: ${entry}\n` + (lines.join("\n") || "§7出口なし (分配機から外へ流れるベルトをつなぐ)§r") +
      `\n\nバッファ ${splitterTotal(key)} / ${spec.buffer}個 (未割り当て ${sumOf(s.pool)}個)\n§7アイテム個数で均等に分配 · 余りは順番に回す · 専用フィルターの品目はその出口だけへ`);
    const acts = [];
    for (const i of outlets) {
      if (held) { form.button(`${rel(i)}の出口を「${label(held)}」専用にする`); acts.push(["set", i, held]); }
      if (s.filters[i]) { form.button(`${rel(i)}のフィルターを解除`); acts.push(["clear", i]); }
    }
    form.button("閉じる"); acts.push(["close"]);
    const r = await form.show(p); if (r.canceled || !sameMachine(block, type) || !acts[r.selection]) return;
    const [a, i, item] = acts[r.selection];
    if (a === "close") return;
    const now2 = readSplitter(key);
    now2.filters[i] = a === "set" ? item : null;
    // 割り振り済みの分を配り直す
    for (let j = 0; j < 4; j++) { for (const [it, n] of Object.entries(now2.q[j])) addTo(now2.pool, it, n); now2.q[j] = {}; }
    distribute(now2, splitterSides(block.dimension, m, block)); writeSplitter(key, now2);
    return splitterUi(p, block, key);
  }

  // ---- ベルトのグレード (Mk I / II / III)。経路・レーン・保存の仕組みは共通で、速さ・間隔・積載だけが違う ----
  // 速さは 2tick ごとに進むブロック数、間隔は同じレーンの荷物どうしの最小距離。
  //   Mk I  : 0.16 (1.6ブロック/秒) / 0.32 → 1レーン毎秒5便 × 4個(研究後8個) × 2レーン = 40 (80) 個/秒
  //   Mk II : 0.24 (2.4ブロック/秒) / 0.72 → 1レーン毎秒3便 × 16個 × 2レーン = 96 個/秒
  //   Mk III: 0.32 (3.2ブロック/秒) / 0.64 → 1レーン毎秒4便 × 32個 × 2レーン = 256 個/秒
  // 発送の判定は2tickごとなので、「毎秒何便」は投入間隔の制限 (rate) で決め、間隔 (spacing) はそれより少し詰めておく
  const BELT_GRADES = {
    [id("conveyor_1")]: { grade: 1, speed: .16, spacing: .32, rate: 5, cap: () => dpGet?.(`of:research:${BELT_RESEARCH.id}`,0)>=BELT_RESEARCH.packs ? BELT_RESEARCH.capacity : C.beltItems },
    [id("conveyor_2")]: { grade: 2, speed: .24, spacing: .72, rate: 3, cap: () => 16 },
    [id("conveyor_3")]: { grade: 3, speed: .32, spacing: .64, rate: 4, cap: () => 32 },
  };
  const isBelt = type => !!BELT_GRADES[type];
  const laneBudget = new Map();
  const gradeOfKey = key => BELT_GRADES[machineIndex.get(key)?.type] ?? BELT_GRADES[id("conveyor_1")];
  let wired = new Map();
  let cableNets = new Map();   // ケーブルのキー → そのケーブルがつながっている送電網 {sources, terminals}
  let drillWiring = new Map();
  let growerWiring = new Map();
  let exported = new Set();
  // A4: updateNetwork 1回の実行内だけ有効なメモ化 (実行が終われば破棄する)。
  // machineState の読みは実行内では書き換えられない (書き込み経路 saveMachineState は
  // updateNetwork 中のどの呼び出しからも到達しないことを確認済み) ので、パース結果を共有できる。
  let netMsCache = null, netTypeCache = null;
  const msCached = key => {
    if (!netMsCache) return msTick(key);
    if (!netMsCache.has(key)) netMsCache.set(key, machineState(key));
    return netMsCache.get(key);
  };
  // ---- 対策1: ティック内共有キャッシュ ----
  // ベルト貨物・ルート検証・発射判定の各ループは同じティックで同じベルトを何度も調べ直す。
  // レイアウトと機械状態はティック内では (イベント経由の変更を除き) 変わらないので、
  // ティックが変わるまで結果を共有する。向き変更 (rotateBelt/orientBelt) では明示的に無効化する。
  let beltCacheTick = -1;
  const tickFindCache = new Map(), tickPortsCache = new Map(), tickConnCache = new Map(),
        tickStateCache = new Map(), tickContainerCache = new Map(), tickDestCache = new Map(), tickTypeCache = new Map();
  function beltCache() {
    if (beltCacheTick !== system.currentTick) {
      beltCacheTick = system.currentTick;
      for (const c of [tickFindCache, tickPortsCache, tickConnCache, tickStateCache, tickContainerCache, tickDestCache, tickTypeCache]) c.clear();
    }
  }
  function msTick(key) {
    beltCache();
    if (!tickStateCache.has(key)) tickStateCache.set(key, machineState(key));
    return tickStateCache.get(key);
  }
  function invalidateBeltState(key) {
    tickStateCache.delete(key);
    tickPortsCache.clear(); tickConnCache.clear(); tickContainerCache.clear(); tickDestCache.clear();
  }
  function tickTypeAt(dim, x, y, z) {
    beltCache();
    const k = dim.id + "|" + x + "," + y + "," + z;
    if (!tickTypeCache.has(k)) { let t; try { t = dim.getBlock({x, y, z})?.typeId; } catch { t = undefined; } tickTypeCache.set(k, t); }
    return tickTypeCache.get(k);
  }
  // ---- 対策2: レイアウト版数 (routeCheck の再検証をレイアウト変更時だけにする) ----
  let layoutVersion = 0;
  const routeValidity = new WeakMap();   // route -> {version, tick, valid}
  function updateNetwork(list) {
    netMsCache=new Map(); netTypeCache=new Map();
    // 登録 (machineIndex) を作り直すので、レイアウト依存のティックキャッシュはここで捨てる
    tickFindCache.clear(); tickPortsCache.clear(); tickConnCache.clear(); tickContainerCache.clear(); tickDestCache.clear(); tickTypeCache.clear();
    try {
    machineIndex=new Map(list.map(m=>[m.key,m]));
    const prevBeltKeys=new Set(beltEntries.map(m=>m.key));
    const prevInferred=inferredBelts, prevLoop=loopBelts;
    beltEntries=list.filter(m=>isBelt(m.type));
    if (!cargoRestored) { restoreBeltCargo(); cargoRestored=true; }
    inferBeltDirections(list);
    // レイアウト (ベルト集合・推定向き・ループ集合) が前回から変わっていたら版数を上げる。
    // routeCheck はこの版数を見て、変わっていないルートの全区間再検証を省く
    {
      let changed = prevBeltKeys.size!==beltEntries.length || beltEntries.some(m=>!prevBeltKeys.has(m.key))
        || prevInferred.size!==inferredBelts.size || prevLoop.size!==loopBelts.size;
      if (!changed) for (const [k,v] of inferredBelts) if (prevInferred.get(k)!==v) { changed=true; break; }
      if (!changed) for (const k of loopBelts) if (!prevLoop.has(k)) { changed=true; break; }
      if (changed) layoutVersion++;
    }
    distributeFurnaceFuel();
    wired=new Map(); cableNets=new Map();
    drillWiring=new Map();
    growerWiring=new Map();
    exported=new Set();
    const seen=new Set();
    const live=new Map();
    function getLive(entry) {
      if (!live.has(entry.key)) {
        let block;
        try {block=world.getDimension(entry.dim).getBlock(entry);} catch {}
        live.set(entry.key,block?.typeId===entry.type ? block : undefined);
      }
      return live.get(entry.key);
    }
    for (const m of list) {
      if (m.type!==id("power_cable") || seen.has(m.key) || !getLive(m)) continue;
      const stack=[m], terminals=new Set(), sources=new Set(), nodes=[];
      while (stack.length) {
        const node=stack.pop();
        if (seen.has(node.key)) continue;
        seen.add(node.key); nodes.push(node);
        for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const dy of [1,-1]) {
          const end=machineIndex.get(keyOf(m.dim,{x:node.x+dx,y:node.y+dy,z:node.z+dz}));
          if (end?.type===id("power_cable") && getLive(end)) stack.push(end);
        }
        for (const [dx,dy,dz] of neighbors) {
          const key=keyOf(m.dim,{x:node.x+dx,y:node.y+dy,z:node.z+dz});
          const end=machineIndex.get(key)??reactorAtShell(world,list,m.dim,{x:node.x+dx,y:node.y+dy,z:node.z+dz});
          const block=end && getLive(end);
          if (!block) continue;
          if (end.type===id("power_cable")) stack.push(end);
          else if (isPowerSource(end.type) && research.allowsMachine(end.type, end)) {
            sources.add(end.key);exported.add(end.key);
          } else terminals.add(key);
        }
      }
      for (const source of sources) terminals.add(source);
      const net={sources:[...sources],terminals:terminals.size-sources.size};
      for (const node of nodes) cableNets.set(node.key,net);
      for (const key of terminals) {
        wired.set(key,new Set(orderedSources(new Set([...(wired.get(key)??[]),...[...sources].filter(source=>source!==key)]))));
        if (GROWER_TIERS[machineIndex.get(key)?.type] && sources.size) {
          const routes = growerWiring.get(key) ?? [];
          routes.push({ cables: nodes.map(node => node.key), sources: [...sources] });
          growerWiring.set(key, routes);
        }
        if (machineIndex.get(key)?.type===id("fixed_drill")&&sources.size) {
          drillWiring.set(key,[...(drillWiring.get(key)??[]),...nodes.map(node=>node.key)]);
        }
      }
      applyCableVisuals(nodes, sources, getLive, netTypeCache);
    }
    } finally { netMsCache=null; netTypeCache=null; }
  }
  const CABLE_DIRS = [["n",0,-1],["e",1,0],["s",0,1],["w",-1,0]];
  function applyCableVisuals(nodes, sources, getLive, typeCache) {
    const powered = [...sources].some(key => canSupply(key) && (generatorRecord(key)?.stored ?? 0) > 0);
    for (const node of nodes) {
      const block = getLive(node); if (!block) continue;
      try {
        const dim = block.dimension, dimId = dim.id, {x, y, z} = block.location;
        // typeId は updateNetwork 実行中に変わらない (setType を呼ぶ経路が無い) ので、座標ごとに1回だけ取得する
        const typeAt = (dx, dy, dz) => {
          const cx = x + dx, cy = y + dy, cz = z + dz, ck = dimId + "|" + cx + "," + cy + "," + cz;
          if (typeCache && typeCache.has(ck)) return typeCache.get(ck);
          let t; try { t = dim.getBlock({x: cx, y: cy, z: cz})?.typeId; } catch { t = undefined; }
          if (typeCache) typeCache.set(ck, t);
          return t;
        };
        const regAt = (dx, dy, dz) => machineIndex.get(keyOf(dimId, {x: x + dx, y: y + dy, z: z + dz}))??reactorAtShell(world,machineList(),dimId,{x:x+dx,y:y+dy,z:z+dz});
        const perm = block.permutation;
        const want = {};
        for (const [name, dx, dz] of CABLE_DIRS) {
          let v = 0;
          if (typeAt(dx, 0, dz) === id("power_cable") || regAt(dx, 0, dz)) v = 1;
          else if (typeAt(dx, 1, dz) === id("power_cable")) v = 2;
          else if (typeAt(dx, -1, dz) === id("power_cable")) v = 3;
          want[`cable_${name}`] = v;
        }
        want.cable_u = typeAt(0, 1, 0) === id("power_cable");
        want.cable_d = typeAt(0, -1, 0) === id("power_cable");
        want.powered = powered;
        let next = perm, dirty = false;
        for (const [k, v] of Object.entries(want)) {
          if (perm.getState(`${NS}:${k}`) !== v) { next = next.withState(`${NS}:${k}`, v); dirty = true; }
        }
        if (dirty) block.setPermutation(next);
      } catch {}
    }
  }
  // 機械はケーブルで発電機とつながっているときだけ電力を使える (ケーブルなしの機械は動かない)。
  // key なしはプレイヤー操作 で、従来どおり全発電機から払う。
  const hasPower = key => key===undefined || (wired.get(key)?.size??0)>0;
  const sourceKeys = key => (key===undefined ? orderedSources(exported) : [...(wired.get(key)??[])]).filter(canSupply);
  const chargingSources = key => [...(wired.get(key)??[])].filter(source=>GENERATOR_TYPES.has(machineIndex.get(source)?.type));
  function availablePower(key,useLegacy=true) {
    if (!hasPower(key)) return 0;
    let total=useLegacy?legacyEnergy():0;
    for (const source of sourceKeys(key)) total+=generatorRecord(source).stored;
    return total;
  }
  function growerPowerRoute(key) {
    const routes = growerWiring.get(key);
    return routes && JSON.stringify(routes).length < 24000 ? routes : undefined;
  }
  function remoteGrowerPower(routes) {
    const sources = new Set();
    function intact(entry) {
      try {
        const block = world.getDimension(entry.dim).getBlock(entry);
        return !block || block.typeId === entry.type;
      } catch { return true; } // An unloaded block is still represented by its registered entry.
    }
    for (const route of routes ?? []) {
      const cables = route.cables.map(key => machineIndex.get(key));
      if (!cables.every(entry => entry?.type === id("power_cable") && intact(entry))) continue;
      for (const key of route.sources) {
        const entry = machineIndex.get(key);
        if (isPowerSource(entry?.type) && canSupply(key) && intact(entry)) sources.add(key);
      }
    }
    const available = [...sources].reduce((total, key) => total + generatorRecord(key).stored, 0);
    return { available, spend(amount) {
      if (amount > available) return false;
      drawEnergy(amount, orderedSources(sources), false);
      return true;
    } };
  }
  function powerCapacity(key){
    let total=legacyEnergy()>0?ENERGY.baseCapacity:0;
    for(const source of sourceKeys(key))total+=core.generatorCapacity?core.generatorCapacity(source):machineIndex.get(source)?.type===id("nuclear_reactor")?1000000:machineIndex.get(source)?.type===id("thermal_generator")?100000:ENERGY.baseCapacity;
    return Math.max(1,total);
  }
  function spend(key,n,useLegacy=true) {
    const have=availablePower(key,useLegacy);
    if (have<n) { noteShort(key,n-have); return false; }
    if (n) { drawEnergy(n,sourceKeys(key),useLegacy); noteUse(key,n); }
    return true;
  }
  function findBlockFresh(dim,key) {
    const m=machineIndex.get(key);
    if (!m) return;
    const block=dim.getBlock(m);
    if (block?.typeId===m.type) return block;
  }
  function findBlock(dim,key) {
    beltCache();
    const ck=dim.id+"|"+key;
    if (tickFindCache.has(ck)) return tickFindCache.get(ck);
    const block=findBlockFresh(dim,key);
    tickFindCache.set(ck,block);
    return block;
  }
  function port(dim,key) {
    const block=findBlock(dim,key);
    return block && machineContainer(block,key);
  }
  function shift(source,target,limit) {
    if (!source||!target||source===target) return 0;
    let moved=0;
    for (let i=18;i<25&&moved<limit;i++) {
      const item=source.getItem(i);
      if (!item) continue;
      for (let j=0;j<18&&moved<limit;j++) {
        const old=target.getItem(j);
        if (old && !old.isStackableWith(item)) continue;
        const n=Math.min(item.amount,limit-moved,item.maxAmount-(old?.amount??0));
        if (!n) continue;
        const next=(old??item).clone();next.amount=(old?.amount??0)+n;
        target.setItem(j,next);moved+=n;
        if (n===item.amount) {source.setItem(i,undefined);break;}
        item.amount-=n;source.setItem(i,item);
      }
    }
    return moved;
  }
  function coalCount(container) {
    const fuel=container?.getItem(1);
    return fuel && GENERATOR_FUELS.has(fuel.typeId) ? fuel.amount : 0;
  }
  function moveCoal(source,target,slots,limit) {
    if (!source||!target||source===target||limit<=0) return 0;
    let moved=0;
    for (const i of slots) {
      if (moved>=limit) break;
      const item=source.getItem(i);
      if (!item || !GENERATOR_FUELS.has(item.typeId)) continue;
      const old=target.getItem(1);
      if (old && !old.isStackableWith(item)) continue;
      const n=Math.min(item.amount,limit-moved,item.maxAmount-(old?.amount??0));
      if (n<=0) break;
      const stack=(old??item).clone();
      stack.amount=(old?.amount??0)+n;
      target.setItem(1,stack);
      if (item.amount===n) source.setItem(i,undefined);
      else {item.amount-=n;source.setItem(i,item);}
      moved+=n;
    }
    return moved;
  }
  function distributeCoal(m,block) {
    const source=machineContainer(block,m.key);
    for (const [dx,dy,dz] of neighbors) {
      const key=keyOf(m.dim,{x:m.x+dx,y:m.y+dy,z:m.z+dz});
      const target=findBlock(block.dimension,key);
      if (target?.typeId!==id("coal_generator")) continue;
      const destination=machineContainer(target,key);
      const quantity=Math.min(C.beltItems,Math.floor((coalCount(source)-coalCount(destination))/2));
      if (quantity>0) moveCoal(source,destination,[1],quantity);
    }
  }
  function moveItems(source, sourceSlots, target, limit, filter) {
    if (!source || !target || source===target) return 0;
    let moved=0;
    for (const i of sourceSlots) {
      if (moved>=limit) break;
      const item=source.getItem(i);
      if (!item) continue;
      if (filter && !filter(item)) continue;
      for (let j=0;j<18&&moved<limit;j++) {
        const old=target.getItem(j);
        if (old && !old.isStackableWith(item)) continue;
        const n=Math.min(item.amount,limit-moved,item.maxAmount-(old?.amount??0));
        if (!n) continue;
        const next=(old??item).clone();next.amount=(old?.amount??0)+n;
        target.setItem(j,next);moved+=n;
        if (n===item.amount) {source.setItem(i,undefined);break;}
        item.amount-=n;source.setItem(i,item);
      }
    }
    return moved;
  }
  function moveInputItems(source, target, itemId, limit) {
    let moved=0;
    for (let i=0;i<18&&moved<limit;i++) {
      const item=source.getItem(i);
      if (item?.typeId!==itemId) continue;
      for (let j=0;j<18&&moved<limit;j++) {
        const old=target.getItem(j);
        if (old && !old.isStackableWith(item)) continue;
        const n=Math.min(item.amount,limit-moved,item.maxAmount-(old?.amount??0));
        if (!n) continue;
        const next=(old??item).clone();next.amount=(old?.amount??0)+n;
        target.setItem(j,next);moved+=n;
        if (n===item.amount) {source.setItem(i,undefined);break;}
        item.amount-=n;source.setItem(i,item);
      }
    }
    return moved;
  }
  function distributeMaterials(m,block) {
    const own=machineContainer(block,m.key);
    if (!own) return;
    for (const [dx,dy,dz] of neighbors) {
      const key=keyOf(m.dim,{x:m.x+dx,y:m.y+dy,z:m.z+dz});
      const target=findBlock(block.dimension,key);
      if (target?.typeId!==id("crusher") || m.key>=key) continue;
    const dest=machineContainer(target,key);
    if (!dest || dest===own) continue;
    const types=new Set();
    for (const cont of [own,dest]) for (let i=0;i<18;i++) { const it=cont.getItem(i); if (it) types.add(it.typeId); }
    const countIn=(cont,itemId)=>{ let n=0; for (let i=0;i<18;i++) { const it=cont.getItem(i); if (it?.typeId===itemId) n+=it.amount; } return n; };
    let budget=C.beltItems*2;
    for (const t of types) {
      if (budget<=0) break;
      if (!RECIPE_INPUTS.get(id("crusher")).has(t)) continue;
      const diff=Math.floor((countIn(own,t)-countIn(dest,t))/2);
      if (!diff) continue;
      const n=Math.min(Math.abs(diff),budget);
      budget-= diff>0 ? moveInputItems(own,dest,t,n) : moveInputItems(dest,own,t,n);
    }
    }
  }
  // Every face uses the same recipe filter and separates ingredients from products.
  function selectedInputs(type,key) {
    const chosen=machineState(key).selectedRecipe;
    const recipes=chosen?PROCESS_RECIPES.filter(recipe=>(recipe.id===chosen||recipe.variantOf===chosen) && id(recipe.machine)===type):[];
    return recipes.length?new Set(recipes.flatMap(recipe=>recipe.in.map(([item])=>item))):RECIPE_INPUTS.get(type);
  }
  const reactorStructureOrigins=m=>{const structure=reactorStructure(world,m);return structure.valid?structure.shell:[];};
  function machineTransfers(m,block) {
    const dim=block.dimension;
    const own=machineContainer(block,m.key);
    if (!own) return;
    const inputs=m.type===id("oil_pump") ? new Set(["minecraft:coal"]) : m.type===id("nuclear_reactor") ? new Set([id("uranium_fuel")]) : m.type===id("research_lab") ? new Set(SCIENCE_PACKS) :
      m.type===id("launch_pad") ? new Set(["rocket_body_section","rocket_fuel","guidance_device"].map(id)) : selectedInputs(m.type,m.key);
    const origins=m.type===id("nuclear_reactor")?reactorStructureOrigins(m):[m];
    for(const origin of origins)for (const [dx,dy,dz] of neighbors) {
      const pos={x:origin.x+dx,y:origin.y+dy,z:origin.z+dz};
      const key=keyOf(m.dim,pos);
      const neighbor=dim.getBlock(pos);
      if (!neighbor || isBelt(neighbor.typeId)) continue;
      const source=containerAt(dim,key,pos,true);
      if (source?.storage && inputs) moveItems(source.storage,source.slots,own,C.beltItems,item=>inputs.has(item.typeId));
      const target=destinationFor(dim,key,pos,dx,dz);
      if (!target?.storage || target.storage===own) continue;
      let budget=m.type===id("fixed_drill") ? 64 : C.beltItems;
      for (const slot of outputSlots) {
        const item=own.getItem(slot);
        if (!item || budget<=0 || !roomFor(target,item)) continue;
        const count=Math.min(item.amount,budget);
        const stack=item.clone();stack.amount=count;
        const rest=insertCargo(target,stack);
        const moved=count-(rest?.amount??0);
        if (!moved) continue;
        if (moved===item.amount) own.setItem(slot,undefined);
        else {item.amount-=moved;own.setItem(slot,item);}
        budget-=moved;
      }
    }
  }
  function pullSideCoal(m,block) {
    const dim=block.dimension, own=machineContainer(block,m.key);
    if (!own) return;
    const origins=m.type===id("nuclear_reactor")?reactorStructureOrigins(m):[m];
    for(const origin of origins)for (const [dx,dy,dz] of neighbors) {
      const pos={x:origin.x+dx,y:origin.y+dy,z:origin.z+dz};
      const source=containerAt(dim,keyOf(m.dim,pos),pos,true);
      if (source?.storage && source.storage!==own) moveCoal(source.storage,own,source.slots,C.beltItems);
    }
  }
  const cargoRuns = new Set();
  let cargoRestored=false;
  const runningBelts = new Map();
  const activeRoutes = new Map();
  const confirmedBeltRoutes = new Map();
  const lastBeltSource = new Map();
  const cargoSpacing = .32;
  const cargoLanes = [0, 1];
  const cargoLaneOffset = .19;
  const outputSlots = [18,19,20,21,22,23,24];
  const FURNACE_TYPES=new Set([
    "minecraft:furnace","minecraft:blast_furnace","minecraft:smoker",
    "minecraft:lit_furnace","minecraft:lit_blast_furnace","minecraft:lit_smoker"
  ]);
  const knownFurnaces=new Map();
  const furnaceKey=(dim,pos)=>dim.id+"|"+pos.x+","+pos.y+","+pos.z;
  function noteFurnace(dim,pos) {
    try { knownFurnaces.set(furnaceKey(dim,pos),{dim,pos:{x:pos.x,y:pos.y,z:pos.z}}); } catch {}
  }
  // 隣り合うかまど系同士で、燃料スロット (1) だけを均等に分け合う
  function distributeFurnaceFuel() {
    const done=new Set();
    for (const [key,f] of [...knownFurnaces]) {
      let block; try { block=f.dim.getBlock(f.pos); } catch { continue; }
      if (!block || !FURNACE_TYPES.has(block.typeId)) { knownFurnaces.delete(key); continue; }
      const inv=block.getComponent("minecraft:inventory")?.container;
      if (!inv) continue;
      for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const pos={x:f.pos.x+dx,y:f.pos.y,z:f.pos.z+dz};
        const nKey=furnaceKey(f.dim,pos);
        const pairKey=key<nKey?key+"|"+nKey:nKey+"|"+key;
        if (done.has(pairKey)) continue;
        try {
          const nb=f.dim.getBlock(pos);
          if (!nb || !FURNACE_TYPES.has(nb.typeId)) continue;
          const nInv=nb.getComponent("minecraft:inventory")?.container;
          if (!nInv) continue;
          done.add(pairKey);
          const fa=inv.getItem(1), fb=nInv.getItem(1);
          if (fa && fb && !fa.isStackableWith(fb)) continue;
          const proto=fa??fb;
          if (!proto || !isFurnaceFuel(proto.typeId)) continue;
          const total=(fa?.amount??0)+(fb?.amount??0);
          if (total<2) continue;
          const aTarget=Math.ceil(total/2), bTarget=total-aTarget;
          if ((fa?.amount??0)===aTarget) continue;
          const sa=proto.clone(); sa.amount=aTarget;
          const sb=proto.clone(); sb.amount=bTarget;
          if (aTarget>0) inv.setItem(1,sa); else inv.setItem(1,undefined);
          try { nInv.setItem(1,sb); }
          catch (error) {
            inv.setItem(1,fa);
            throw error;
          }
        } catch {}
      }
    }
  }
  const opposite = side => (side+2)%4;
  function neighborOn(m,side,dy=0) {
    const [dx,dz]=directions[side];
    return {x:m.x+dx,y:m.y+dy,z:m.z+dz};
  }
  const beltLevels=[0,1,-1];
  let inferredBelts = new Map();
  let loopBelts = new Set();
  const beltDirection = key => inferredBelts.get(key) ?? msCached(key).direction ?? 0;
  function adjacentBelt(dim,m,side) {
    for(const dy of beltLevels) {
      const key=keyOf(m.dim,neighborOn(m,side,dy));
      const next=machineIndex.get(key);
      if(!isBelt(next?.type)||!findBlock(dim,key))continue;
      if(dy) {
        const low=dy>0?m:next;
        const ceilingType=tickTypeAt(dim,low.x,low.y+1,low.z);
        if(ceilingType&&ceilingType!=="minecraft:air")continue;
      }
      return next;
    }
  }
  function inferBeltDirections(list) {
    const previousInference=inferredBelts;
    inferredBelts=new Map();
    loopBelts=new Set();
    for (const key of confirmedBeltRoutes.keys()) {
      if (!machineIndex.has(key)) confirmedBeltRoutes.delete(key);
    }
    for (const key of lastBeltSource.keys()) {
      if (!machineIndex.has(key)) lastBeltSource.delete(key);
    }
    const graph=new Map(), seen=new Set();
    for(const m of list) {
      if(!isBelt(m.type))continue;
      try {
        const dim=world.getDimension(m.dim);
        if(!findBlock(dim,m.key))continue;
        const edges=[];
        const pd=msCached(m.key).placedDirection;
        const aligned=(d,side)=>d===side||d===opposite(side);
        for(let side=0;side<4;side++) {
          const next=adjacentBelt(dim,m,side);
          if(!next || adjacentBelt(dim,next,opposite(side))?.key!==m.key)continue;
          // 置いた向きが分かっている2本が、どちらもこの辺と直交していれば並走しているだけ (U字の隣の列など) → つながない
          const npd=msCached(next.key).placedDirection;
          if(pd!==undefined&&npd!==undefined&&!aligned(pd,side)&&!aligned(npd,side))continue;
          edges.push({side,next});
        }
        graph.set(m.key,{m,dim,edges});
      } catch {}
    }
    // 同じ推定の中で同じ (隣接位置, sink) の終端評価が繰り返されることがあるので1回化する。
    // 評価が読む中身 (かまど・コンテナ・分配機の状態) は推定の実行中には変わらない。
    const endpointCache=new Map();
    function endpoint(dim,m,side,sink) {
      const eKey=keyOf(m.dim,neighborOn(m,side))+(sink?"|sink":"|src");
      if (endpointCache.has(eKey)) return endpointCache.get(eKey);
      const value=endpointInner(dim,m,side,sink);
      endpointCache.set(eKey,value);
      return value;
    }
    function endpointInner(dim,m,side,sink) {
      const block=dim.getBlock(neighborOn(m,side));
      if(!block)return 0;
      if(block.typeId===id("coal_generator")){
        return sink ? 20 : -30;
      }
      // かまど系と自作機械もベルトの終端として数える (従来は 0 点で、反対側の
      // 中身しだいで路線の向きが決まってしまい、再起動後に搬入が止まることがあった)
      if(FURNACE_TYPES.has(block.typeId)){
        noteFurnace(dim,neighborOn(m,side));
        if(sink)return 2;
        const inv=block.getComponent("minecraft:inventory")?.container;
        return inv&&inv.getItem(2) ? 6 : 1;
      }
      const proxy=reactorAtShell(world,machineList(),m.dim,neighborOn(m,side));
      if(proxy){const storage=machineContainer(dim.getBlock(proxy),proxy.key);const stocked=storage&&outputSlots.some(slot=>!!storage.getItem(slot));return sink?(stocked?-10:2):(stocked?6:1);}
      const regKey=keyOf(m.dim,neighborOn(m,side));
      if(machineIndex.has(regKey)&&SPLITTERS[block.typeId]) {
        const input = splitterInput(block);
        if (input >= 0) return (opposite(side) === input) === sink ? 12 : -Infinity;
        return sink ? 2 : (splitterTotal(regKey) ? 6 : 1);
      }
      if(machineIndex.has(regKey)&&virtualTypes.has(block.typeId)){
        const v=virtualStorage(block,regKey,!sink);
        if(!v)return sink?-30:0;
        if(sink)return 2;
        return v.slots.some(slot=>v.storage.getItem(slot))?6:1;
      }
      if(machineIndex.has(regKey)){
        if(block.typeId===id("fixed_drill") && sink) return -30;
        const cont=machineContainer(block,regKey);
        if(cont)for(let i=18;i<25;i++)if(cont.getItem(i))return sink ? -10 : 6;
        if(sink)return 2;
        return 1;
      }
      if(!["minecraft:barrel","minecraft:chest","minecraft:trapped_chest","minecraft:hopper"].includes(block.typeId))return 0;
      if(sink)return 2;
      const inv=block.getComponent("minecraft:inventory")?.container;
      if(inv)for(let i=0;i<inv.size;i++)if(inv.getItem(i))return 6;
      return 1;
    }
    function evaluate(path,dim,closed,singleExit) {
      let score=0;
      const result=new Map();
      for(let i=0;i<path.length;i++) {
        const curr=path[i], st=msCached(curr.m.key);
        const before=path[closed?(i+path.length-1)%path.length:i-1];
        const after=path[closed?(i+1)%path.length:i+1];
        const prev=curr.edges.find(e=>e.next.key===before?.m.key)?.side;
        const next=curr.edges.find(e=>e.next.key===after?.m.key)?.side;
        let best;
        const exits=next!==undefined?[next]:prev===undefined?[singleExit]:[opposite(prev),(prev+1)%4,(prev+3)%4];
        for(const d of exits) {
          if(!closed&&st.directionLocked&&st.direction!==d)continue;
          if(!closed&&prev!==undefined&&st.inputMode&&[opposite(d),(d+1)%4,(d+3)%4][st.inputMode-1]!==prev)continue;
          const sourceSignal=i===0?endpoint(dim,curr.m,externalInput(curr.m.key,d),false):0;
          const sinkSignal=next===undefined?endpoint(dim,curr.m,d,true):0;
          const signal=closed?0:sourceSignal+sinkSignal;
          if (signal === -Infinity) continue; // Fixed splitter ports cannot run in reverse.
          if (!closed && path.length===1 && !(sourceSignal>0&&sinkSignal>0)) continue;
          const value=signal+(st.direction===d?(closed&&st.directionLocked?12:.5):0)+(d===opposite(prev)?.2:0);
          if(!best||value>best.value)best={d,value,signal};
        }
        if(!best)return;
        result.set(curr.m.key,best.d);score+=best.value;
      }
      if (!closed && path.length) {
        try {
          const first=path[0], last=path[path.length-1];
          const d0=result.get(first.m.key), dN=result.get(last.m.key);
          if (d0!==undefined && dN!==undefined) {
            const srcPos=neighborOn(first.m,externalInput(first.m.key,d0));
            const src=containerAt(dim,keyOf(first.m.dim,srcPos),srcPos,true);
            const sinkPos=neighborOn(last.m,dN);
            const [fdx,fdz]=directions[dN];
            const sink=destinationFor(dim,keyOf(last.m.dim,sinkPos),sinkPos,fdx,fdz);
            if (sink && path.some(({m})=>{
              const [vx,vz]=directions[result.get(m.key)];
              return [[-vz,vx],[vz,-vx]].some(([sx,sz])=>{
                const pos={x:m.x+sx,y:m.y,z:m.z+sz};
                const block=findBlock(dim,keyOf(m.dim,pos));
                return isOutputMachine(block);
              });
            })) score+=15;
            if (src?.storage && sink && src.storage!==sink.storage) {
              score+=15;
              const confirmed=confirmedBeltRoutes.get(last.m.key);
              if (confirmed?.source===keyOf(first.m.dim,srcPos)&&confirmed?.target===keyOf(last.m.dim,sinkPos)) score+=40;
              let has=false, ok=false;
              for (const slot of src.slots) {
                const it=src.storage.getItem(slot);
                if (it) { has=true; if (acceptsCargo(sink,it)) { ok=true; break; } }
              }
              if (has) score+= ok ? 10 : -10;
            }
          }
        } catch {}
      }
      const stable=path.every(({m})=>previousInference.get(m.key)===result.get(m.key));
      const active=[...activeRoutes.values()].some(runs=>{
        const route=runs.values().next().value?.route;
        return route?.segments.length===path.length && route.segments.every(seg=>result.get(seg.m.key)===seg.direction);
      });
      return {score:score+(stable?7:0)+(active?100:0),result};
    }
    function resolve(start,closed) {
      const path=[];
      let node=start,previous;
      while(node&&node.edges.length<=2&&!seen.has(node.m.key)) {
        seen.add(node.m.key);path.push(node);
        const next=node.edges.find(e=>e.next.key!==previous)?.next;
        previous=node.m.key;node=next&&graph.get(next.key);
      }
      if(path.length<2 || (closed ? node!==start : node!==undefined)) return;
      try {
        const candidates=[path,[...path].reverse()]
          .map(order=>evaluate(order,start.dim,closed)).filter(Boolean).sort((a,b)=>b.score-a.score);
        if(!candidates[0])return;
        for(const [key,direction] of candidates[0].result) {
          inferredBelts.set(key,direction);
          if(closed)loopBelts.add(key);
        }
      } catch {}
    }
    for(const start of graph.values()) {
      if(!start.edges.length) {
        try {
          const candidates=[0,1,2,3].map(exit=>evaluate([start],start.dim,false,exit))
            .filter(Boolean).sort((a,b)=>b.score-a.score);
          if(candidates[0]) inferredBelts.set(start.m.key,candidates[0].result.get(start.m.key));
        } catch {}
      } else if(!seen.has(start.m.key)&&start.edges.length===1) resolve(start,false);
    }
    for(const start of graph.values()) {
      if(!seen.has(start.m.key)&&start.edges.length===2)resolve(start,true);
    }
  }
  function downstreamBelt(dim,m,direction) {return adjacentBelt(dim,m,direction);}
  function externalInput(key,direction) {
    const sides=[opposite(direction),(direction+1)%4,(direction+3)%4];
    const mode=loopBelts.has(key)?0:(msCached(key).inputMode??0);
    return sides[mode-1]??sides[0];
  }
  function beltPorts(dim,m,direction) {
    beltCache();
    const ck=m.key+"|"+direction;
    if (tickPortsCache.has(ck)) return tickPortsCache.get(ck);
    const result=beltPortsInner(dim,m,direction);
    tickPortsCache.set(ck,result);
    return result;
  }
  function beltPortsInner(dim,m,direction) {
    const straight=opposite(direction);
    const mode=loopBelts.has(m.key)?0:(msCached(m.key).inputMode??0);
    const sides=[straight,(direction+1)%4,(direction+3)%4];
    const forced=mode>0 ? sides[mode-1] : undefined;
    const options=forced===undefined ? sides : [forced];
    for (const side of options) {
      for (const dy of beltLevels) {
        const key=keyOf(m.dim,neighborOn(m,side,dy));
        const previous=machineIndex.get(key);
        if (!previous || !isBelt(findBlock(dim,key)?.typeId)) continue;
        const flow=beltDirection(key);
        if (flow===opposite(side) && downstreamBelt(dim,previous,flow)?.key===m.key) {
          return {input:side,previous};
        }
      }
    }
    return {input:forced??straight};
  }
  function showBelt(block,key,direction,entry,exit,input=opposite(direction),entryRise=0,exitRise=0) {
    const shape=input===opposite(direction)?0:input===(direction+1)%4?1:2;
    const current=block.permutation;
    let next=current;
    for (const [name,value] of [["belt_direction",direction],["belt_entry_open",entry],
                                  ["belt_exit_open",exit],["belt_shape",shape],["belt_entry_rise",Math.max(0,entryRise)],["belt_exit_rise",Math.max(0,exitRise)],["active",runningBelts.has(key)]]) {
      const nameId=id(name);
      const old=current.getState(nameId);
      if (old!==undefined && old!==value) next=next.withState(nameId,value);
    }
    if (next!==current) block.setPermutation(next);
  }
  function rotateBelt(player,block,key) {
    for (const [end,route] of confirmedBeltRoutes) if (route.routeKeys.includes(key)) confirmedBeltRoutes.delete(end);
    if (!isBelt(block.typeId)) return;
    const state=machineState(key);
    if (player.isSneaking) state.inputMode=((state.inputMode??0)+1)%4;
    else {state.direction=(beltDirection(key)+1)%directions.length;state.directionLocked=true;inferredBelts.delete(key);}
    saveMachineState(key,state);
    layoutVersion++; invalidateBeltState(key);
    const direction=beltDirection(key);
    const {x,y,z}=block.location;
    const m={x,y,z,dim:block.dimension.id,key};
    const input=beltPorts(block.dimension,m,direction);
    showBelt(block,key,direction,!!input.previous,false,input.input,(input.previous?.y??y)-y,0);
    const label=state.inputMode ? directions[input.input][2] : "自動";
    toast(player,`出口: ${directions[direction][2]} / 入口: ${label}`);
  }
  // 石炭発電機が受け付ける燃料 (溶岩バケツは対象外)
  const GENERATOR_FUELS=new Set(["minecraft:coal","minecraft:charcoal","minecraft:coal_block","minecraft:blaze_rod"]);
  // バニラかまど系の燃料スロットに入れる燃料
  const FURNACE_FUEL_IDS=new Set(["minecraft:coal","minecraft:charcoal","minecraft:coal_block","minecraft:blaze_rod","minecraft:lava_bucket","minecraft:dried_kelp_block","minecraft:stick","minecraft:bamboo"]);
  const isFurnaceFuel=(typeId)=>FURNACE_FUEL_IDS.has(typeId)||typeId.endsWith("_log")||typeId.endsWith("_planks")||typeId.endsWith("_wood");
  const STORAGE_MACHINES=new Set([...RECIPE_INPUTS.keys(),...["coal_generator","fixed_drill","oil_pump","launch_pad","research_lab","nuclear_reactor"].map(id)]);
  function containerAt(dim,key,pos,output,from=null) {
    beltCache();
    const fromKey=from?.key ?? (from ? `p${from.x},${from.y},${from.z}` : "-");
    const ck=`c|${dim.id}|${pos.x},${pos.y},${pos.z}|${output?1:0}|${fromKey}`;
    if (tickContainerCache.has(ck)) { const v=tickContainerCache.get(ck); return v ? {...v} : v; }
    const result=containerAtInner(dim,key,pos,output,from);
    tickContainerCache.set(ck,result);
    return result ? {...result} : result;
  }
  function containerAtInner(dim,key,pos,output,from=null) {
    const proxy=reactorAtShell(world,machineList(),dim.id,pos);
    if(proxy)return {block:dim.getBlock(proxy),storage:machineContainer(dim.getBlock(proxy),proxy.key),slots:output?outputSlots:[0]};
    const registered=findBlock(dim,key);
    if (registered && SPLITTERS[registered.typeId]) return splitterView(registered,key,output,from)??undefined;
    if (registered && virtualTypes.has(registered.typeId)) return virtualStorage(registered,key,output)??undefined;
    if (registered && STORAGE_MACHINES.has(registered.typeId)) return {
      block:registered, storage:machineContainer(registered,key), slots:output?outputSlots:Array.from({length:18},(_,i)=>i)
    };
    const block=dim.getBlock(pos);
    if (FURNACE_TYPES.has(block?.typeId)) {
      noteFurnace(dim,pos);
      // かまど系からの搬出は完成品スロット(2)だけ。搬入は destinationFor の専用処理に任せる
      if (!output) return;
      const storage=block.getComponent("minecraft:inventory")?.container;
      if (storage) return {block,storage,slots:[2]};
      return;
    }
    if (!["minecraft:chest","minecraft:trapped_chest","minecraft:barrel","minecraft:hopper"].includes(block?.typeId)) return;
    const storage=block.getComponent("minecraft:inventory")?.container;
    if (storage) return {block,storage,slots:Array.from({length:storage.size},(_,i)=>i)};
  }
  function isOutputMachine(block) {
    return [id("crusher"),id("fixed_drill")].includes(block?.typeId);
  }
  const BLAST_FURNACES=new Set(["minecraft:blast_furnace","minecraft:lit_blast_furnace"]);
  const SMOKERS=new Set(["minecraft:smoker","minecraft:lit_smoker"]);
  const BLAST_INPUTS=new Set([
    ...["raw_iron","raw_copper","raw_gold","ancient_debris","nether_gold_ore"].map(item=>"minecraft:"+item),
    ...["iron","copper","gold","coal","diamond","emerald","lapis","redstone"].flatMap(ore=>
      ["minecraft:"+ore+"_ore","minecraft:deepslate_"+ore+"_ore"]),
    ...["iron","copper","gold","ancient_debris"].map(ore=>id("crushed_"+ore))
  ]);
  const SMOKER_INPUTS=new Set(["beef","porkchop","chicken","mutton","rabbit","cod","salmon","potato","kelp"].map(item=>"minecraft:"+item));
  function furnaceAccepts(type,item) {
    if (isFurnaceFuel(item.typeId) || type==="minecraft:furnace" || type==="minecraft:lit_furnace") return true;
    if (BLAST_FURNACES.has(type)) {
      return BLAST_INPUTS.has(item.typeId) || /^minecraft:(iron|golden|chainmail)_(axe|hoe|pickaxe|shovel|sword|helmet|chestplate|leggings|boots|horse_armor)$/.test(item.typeId);
    }
    return SMOKERS.has(type) && SMOKER_INPUTS.has(item.typeId);
  }
  function destinationFor(dim,key,pos,dx,dz) {
    beltCache();
    const ck=`d|${dim.id}|${pos.x},${pos.y},${pos.z}|${dx},${dz}`;
    if (tickDestCache.has(ck)) { const v=tickDestCache.get(ck); return v ? {...v} : v; }
    const result=destinationForInner(dim,key,pos,dx,dz);
    tickDestCache.set(ck,result);
    return result ? {...result} : result;
  }
  function destinationForInner(dim,key,pos,dx,dz) {
    const target=containerAt(dim,key,pos,false,{x:pos.x-dx,y:pos.y,z:pos.z-dz});
    if (!target?.storage) {
      // バニラのかまど/溶鉱炉/燻製器へは材料スロット(0)にだけベルト投入する (燃料・完成品スロットには入れない)
      try {
        const block=dim.getBlock(pos);
        if (FURNACE_TYPES.has(block?.typeId)) {
          noteFurnace(dim,pos);
          const storage=block.getComponent("minecraft:inventory")?.container;
          if (storage) return {block,storage,slots:[0,1],itemFilter:item=>furnaceAccepts(block.typeId,item),slotsFor:item=>isFurnaceFuel(item.typeId)?[1]:[0]};
        }
      } catch {}
      return;
    }
    if (target.block.typeId===id("fixed_drill")) return;
    if(target.block.typeId===id("oil_pump")){target.slots=[0];target.itemFilter=item=>item.typeId==="minecraft:coal";return target;}
    if(target.block.typeId===id("nuclear_reactor")){target.slots=[0];target.itemFilter=item=>item.typeId===id("uranium_fuel");return target;}
    if (target.block.typeId===id("coal_generator")) {
      target.slots=[1];
      target.generatorFuelOnly=true;
    }
    if (target.block.typeId===id("crusher")) {
      target.slots=target.slots.filter(slot=>slot!==0);
    }
    if (target.block.typeId===id("research_lab")) target.itemFilter=item=>SCIENCE_PACKS.includes(item.typeId);
    const inputs=selectedInputs(target.block.typeId,key);
    if (inputs) target.itemFilter=(item)=>inputs.has(item.typeId);
    return target;
  }
  function manualMachineInput(block,key) {
    const type=block.typeId;
    if(type===id("fixed_drill")) return;
    const storage=machineContainer(block,key);
    if(!storage) return;
    const inputs=type===id("research_lab") ? new Set(SCIENCE_PACKS)
      : type===id("launch_pad") ? new Set(["rocket_body_section","rocket_fuel","guidance_device"].map(id))
      : type===id("oil_pump") ? new Set(["minecraft:coal"])
      : type===id("nuclear_reactor") ? new Set([id("uranium_fuel")])
      : selectedInputs(type,key);
    if(type===id("coal_generator")) return {storage,slots:[1],generatorFuelOnly:true};
    if(!inputs?.size) return;
    const slots=type===id("oil_pump") || type===id("nuclear_reactor") ? [0]
      : Array.from({length:18},(_,i)=>i).filter(i=>i!==0 || type!==id("crusher"));
    return {storage,slots,itemFilter:item=>inputs.has(item.typeId)};
  }
  function acceptsCargo(target,item) {
    return (!target.itemFilter || target.itemFilter(item)) &&
      (!target.generatorFuelOnly || GENERATOR_FUELS.has(item.typeId));
  }
  function roomFor(target,item) {
    if (!acceptsCargo(target,item)) return 0;
    if (target.virtualRoom) return target.virtualRoom(item);
    let room=0;
    for (const slot of (target.slotsFor ? target.slotsFor(item) : target.slots)) {
      const current=target.storage.getItem(slot);
      if (!current||current.isStackableWith(item)) room+=item.maxAmount-(current?.amount??0);
    }
    return room;
  }
  function insertCargo(target,item,recordRemaining) {
    if (!acceptsCargo(target,item)) return item;
    if (target.virtualInsert) {
      const added=target.virtualInsert(item);
      const left=item.amount-added;
      if (added) recordRemaining?.(left);
      if (!left) return;
      const rest=item.clone();rest.amount=left;return rest;
    }
    let left=item.amount;
    for (const slot of (target.slotsFor ? target.slotsFor(item) : target.slots)) {
      const old=target.storage.getItem(slot);
      if (old&&!old.isStackableWith(item)) continue;
      const count=Math.min(left,item.maxAmount-(old?.amount??0));
      if (count<=0) continue;
      const stack=(old??item).clone();
      stack.amount=(old?.amount??0)+count;
      target.storage.setItem(slot,stack);
      try { recordRemaining?.(left-count); }
      catch (error) {
        target.storage.setItem(slot,old);
        throw error;
      }
      left-=count;
      if (!left) return;
    }
    const rest=item.clone();rest.amount=left;return rest;
  }
  function setRunActive(run,on) {
    for (const key of run.keys) {
      const before=runningBelts.get(key)??0;
      const after=before+(on?1:-1);
      if (after>0) runningBelts.set(key,after);
      else runningBelts.delete(key);
      if ((before>0)===(after>0)) continue;
      try {
        const block=findBlock(run.dim,key);
        if (block) setBlockActive(block,block.typeId,key,on);
      } catch {}
    }
  }
  // ===== 貨物のデータ化 (v0.8.324) =====
  // 貨物はエンティティを持たず、便のデータだけで保持する。アイテムの完全な状態
  // (名前・説明文・耐久・エンチャント) は直列化してデータに埋め込み、配達・
  // ドロップ時に復元する。永続化はルートごとのチェックポイント (ワールドDP) で、
  // 発射・配達・ドロップ等のアイテム増減と同ティックで書き、移動分は1秒ごとに
  // まとめて書く (クラッシュ時は最大1秒ぶん位置が巻き戻るだけで、物は増減しない)。
  function serializeItem(stack) {
    const data={t:stack.typeId,n:stack.amount};
    try { if (stack.nameTag) data.name=stack.nameTag; } catch {}
    try { const lore=stack.getLore(); if (lore.length) data.lore=lore; } catch {}
    try { const dur=stack.getComponent("minecraft:durability"); if (dur && dur.damage>0) data.dmg=dur.damage; } catch {}
    try { const list=stack.getComponent("minecraft:enchantable")?.getEnchantments();
      if (list?.length) data.ench=list.map(e=>[e.type.id,e.level]); } catch {}
    return data;
  }
  function deserializeItem(data) {
    const stack=new ItemStack(data.t,data.n);
    try { if (data.name) stack.nameTag=data.name; } catch {}
    try { if (data.lore) stack.setLore(data.lore); } catch {}
    try { if (data.dmg) { const dur=stack.getComponent("minecraft:durability"); if (dur) dur.damage=data.dmg; } } catch {}
    try { if (data.ench) { const ench=stack.getComponent("minecraft:enchantable");
      if (ench) for (const [tid,lvl] of data.ench) { try { ench.addEnchantment({type:new EnchantmentType(tid),level:lvl}); } catch {} } } } catch {}
    return stack;
  }
  function runStack(run) {
    if (!run.stackCache) run.stackCache=deserializeItem(run.item);
    return run.stackCache;
  }
  const cargoDirtyRoutes = new Set();
  function saveCargoCheckpoint(routeKey) {
    cargoDirtyRoutes.delete(routeKey);
    const metaKey="of:cargo2n:"+routeKey;
    let oldCount=0;
    try { oldCount=world.getDynamicProperty(metaKey)??0; } catch {}
    const shipments=activeRoutes.get(routeKey);
    const list=shipments?[...shipments]:[];
    list.forEach((run,i)=>{
      const {dim:_d,...routeData}=run.route;
      try { world.setDynamicProperty(`of:cargo2:${routeKey}#${i}`,JSON.stringify({
        route:routeData,dimName:run.dim.id,originIndex:run.originIndex,lane:run.lane,
        sourceKey:run.sourceKey,distance:run.distance,item:run.item})); } catch {}
    });
    for (let i=list.length;i<oldCount;i++) {
      try { world.setDynamicProperty(`of:cargo2:${routeKey}#${i}`,undefined); } catch {}
    }
    try { world.setDynamicProperty(metaKey,list.length||undefined); } catch {}
  }
  system.runInterval(()=>{ for (const routeKey of [...cargoDirtyRoutes]) saveCargoCheckpoint(routeKey); },20);
  function releaseCargoData(run) {
    if (!run.item) return;
    try { run.dim.spawnItem(deserializeItem(run.item),cargoPosition(run,run.distance)); } catch {}
  }
  function trackCargo(run) {
    cargoRuns.add(run);
    let shipments=activeRoutes.get(run.routeKey);
    if (!shipments) activeRoutes.set(run.routeKey,shipments=new Set());
    shipments.add(run);
    setRunActive(run,true);
  }
  let cargoDataRestored=false;
  function restoreCargoData() {
    // 旧形式 (貨物エンティティ) の移行: 読み込まれている分をデータ化して消す。
    // エンティティ定義自体は移行用に残してあり、新規に生成されることはない
    for (const name of ["overworld","nether","the_end"]) {
      try {
        const dim=world.getDimension(name);
        for (const entity of dim.getEntities({type:id("belt_cargo")})) {
          try {
            const raw=entity.getDynamicProperty("of:belt_route");
            const stack=entity.getComponent("minecraft:inventory")?.container?.getItem(0);
            if (!raw || !stack) {
              if (stack) { try { dim.spawnItem(stack,entity.location); } catch {} }
              entity.remove();
              continue;
            }
            const saved=JSON.parse(raw);
            const route={...saved.route,dim};
            const segments=route.segments.slice(saved.originIndex);
            const run={...route,route,segments,keys:segments.map(seg=>seg.m.key),
              originIndex:saved.originIndex,lane:saved.lane===1?1:0,
              distance:entity.getDynamicProperty("of:belt_distance")??.5,
              sourceKey:saved.sourceKey,item:serializeItem(stack),
              icon:cargoLook(null,stack.typeId),nextVisual:0,distRate:0};
            entity.remove();
            trackCargo(run);
            saveCargoCheckpoint(run.routeKey);
            if (saved.sourceKey) confirmedBeltRoutes.set(route.routeKey,{source:saved.sourceKey,target:route.targetKey,routeKeys:route.keys});
          } catch {}
        }
      } catch {}
    }
    if (cargoDataRestored) return;
    cargoDataRestored=true;
    for (const dpId of world.getDynamicPropertyIds()) {
      if (!dpId.startsWith("of:cargo2:") || dpId.startsWith("of:cargo2n:")) continue;
      try {
        const saved=JSON.parse(world.getDynamicProperty(dpId));
        if (!saved?.item) continue;
        const dim=world.getDimension(saved.dimName);
        const route=activeRoutes.get(saved.route.routeKey)?.values().next().value?.route??{...saved.route,dim};
        const segments=route.segments.slice(saved.originIndex);
        trackCargo({...route,route,segments,keys:segments.map(seg=>seg.m.key),
          originIndex:saved.originIndex,lane:saved.lane===1?1:0,distance:saved.distance??.5,
          sourceKey:saved.sourceKey,item:saved.item,icon:cargoLook(null,saved.item.t),nextVisual:0,distRate:0});
        if (saved.sourceKey) confirmedBeltRoutes.set(route.routeKey,{source:saved.sourceKey,target:route.targetKey,routeKeys:route.keys});
      } catch {}
    }
  }
  system.runInterval(restoreCargoData,100);
  function finishRun(run) {
    cargoRuns.delete(run);
    const shipments=activeRoutes.get(run.routeKey);
    if (shipments) {
      shipments.delete(run);
      if (!shipments.size) activeRoutes.delete(run.routeKey);
    }
    setRunActive(run,false);
    saveCargoCheckpoint(run.routeKey);
  }
  function cargoSegment(run,distance) {
    const index=Math.min(Math.floor(distance),run.segments.length-1);
    return run.segments[index];
  }
  function cargoPosition(run,distance) {
    const {m,input,direction,entryRise,exitRise}=cargoSegment(run,distance);
    const progress=distance-Math.floor(distance);
    const [ix,iz]=directions[input], [ox,oz]=directions[direction];
    const y=m.y+.512+(progress<.5 ? Math.max(0,entryRise)*(1-2*progress) : Math.max(0,exitRise)*(2*progress-1));
    const offset=run.lane===1 ? cargoLaneOffset : -cargoLaneOffset;
    if (input===opposite(direction)) {
      return {x:m.x+.5+ox*(progress-.5)-oz*offset,y,z:m.z+.5+oz*(progress-.5)+ox*offset};
    }
    const angle=progress*Math.PI/2;
    const sin=Math.sin(angle), cos=Math.cos(angle);
    const a=.5*(1-sin), b=.5*(1-cos);
    const tx=-ix*cos+ox*sin, tz=-iz*cos+oz*sin;
    return {x:m.x+.5+ix*a+ox*b-tz*offset,y,z:m.z+.5+iz*a+oz*b+tx*offset};
  }
  // ベルトグレードの最大値 (advanceCargo の打ち切り条件に使う安全側の上限)
  const MAX_BELT_SPEED=Math.max(...Object.values(BELT_GRADES).map(g=>g.speed));
  const MAX_BELT_SPACING=Math.max(...Object.values(BELT_GRADES).map(g=>g.spacing));
  // sortedAhead: 貨物ループの反復開始時点で、同じルート+レーンの便を位置の昇順に並べた
  // {run, pos} の配列 (pos は反復開始時点の位置)。無い場合は従来どおり全便を走査する。
  function advanceCargo(run,sortedAhead) {
    const here=gradeOfKey(cargoSegment(run,run.distance).m.key);
    let nextDistance=Math.min(run.keys.length-.06,run.distance+here.speed);
    const position=run.originIndex+run.distance;
    if (!sortedAhead) {
      const shipments=activeRoutes.get(run.routeKey);
      if (!shipments) return nextDistance;
      for (const other of shipments) {
        if (other===run || other.lane!==run.lane) continue;
        const ahead=other.originIndex+other.distance;
        if (ahead>position) {
          // 前の荷物がいるベルトの間隔を守る (速いベルトから遅いベルトへ入ると、手前で詰まって待つ)
          const gap=gradeOfKey(cargoSegment(other,other.distance).m.key).spacing;
          nextDistance=Math.min(nextDistance,ahead-run.originIndex-gap);
        }
      }
      return nextDistance;
    }
    for (const entry of sortedAhead) {
      const other=entry.run;
      if (other===run) continue;
      // 打ち切り: この便以降 (開始位置の昇順) の制限値は、現在の位置から見積もっても
      // entry.pos - originIndex - MAX_BELT_SPACING 以上にしかならない (位置は反復中に
      // 減らず、間隔は最大で MAX_BELT_SPACING)。それが現在の候補値以上なら、以降の
      // どの便も候補値を下げないので、最小値は確定している。
      if (entry.pos-run.originIndex-MAX_BELT_SPACING>=nextDistance) break;
      // 開始時点で後ろにいて、この反復中の前進 (最大 MAX_BELT_SPEED) でも追いつけない
      // 便は、元の条件 (ahead>position) でも対象外になる。
      if (entry.pos+MAX_BELT_SPEED<=position) continue;
      if (!cargoRuns.has(other)) continue;   // 反復中に配達等で終わった便は元の走査にも現れない
      const ahead=other.originIndex+other.distance;
      if (ahead>position) {
        // 前の荷物がいるベルトの間隔を守る (速いベルトから遅いベルトへ入ると、手前で詰まって待つ)
        const gap=gradeOfKey(cargoSegment(other,other.distance).m.key).spacing;
        nextDistance=Math.min(nextDistance,ahead-run.originIndex-gap);
      }
    }
    return nextDistance;
  }
  // ベルト接続のティック共有キャッシュ (対策1)。beltPorts / downstreamBelt の依存先
  // (登録・ブロック種別・推定向き・machineState の direction/inputMode) はティック内では
  // 変わらない (permutation は読まないことを確認済み)。ただし区間の実在確認だけは
  // 壊されたベルトを即座に検出するため、キャッシュを通さず毎回新鮮に確認する。
  // 対策4: 1回の貨物ループ / ルート検証の実行内だけ有効な共有キャッシュ。
  // スクリプト実行は同期的で、その間にベルトのブロックもプレイヤーの位置も
  // 外からは変わらず、貨物処理自体もベルトのブロックを書き換えない。したがって
  // 実行内では「区間のベルトがまだ在るか」の新鮮確認と「拾い上げ候補プレイヤー」の
  // 取得は、区間・次元ごとに1回だけ行えば結果は従来と一致する。実行が終わる
  // たびに捨てる (null のときは従来どおり毎回新鮮に確認する)。
  let segFreshCache = null, pickupSnap = null;
  function beltStillThere(dim,key) {
    if (!segFreshCache) return isBelt(findBlockFresh(dim,key)?.typeId);
    const ck=dim.id+"|"+key;
    let v=segFreshCache.get(ck);
    if (v===undefined) { v=isBelt(findBlockFresh(dim,key)?.typeId); segFreshCache.set(ck,v); }
    return v;
  }
  // しゃがんでベルト上に立つプレイヤー (貨物の拾い上げ判定)。従来は貨物ごとに
  // getPlayers の範囲検索を呼んでいた。候補 (しゃがみ+接地) を次元ごとに1回集め、
  // 従来と同じ条件 (対象地点から1.25以内・同じマス・高さ差0.42未満) で最初に
  // 一致したプレイヤーを返す。列挙順は次元のプレイヤー一覧の順序そのまま。
  function pickupPlayer(dim,point,tile) {
    let list=pickupSnap?.get(dim.id);
    if (!list) {
      list=[];
      try { for (const p of dim.getPlayers()) { try { if (p.isOnGround && p.isSneaking) { const l=p.location; list.push({p,x:l.x,y:l.y,z:l.z}); } } catch {} } } catch {}
      if (pickupSnap) pickupSnap.set(dim.id,list);
    }
    for (const c of list) {
      const ddx=c.x-point.x, ddy=c.y-point.y, ddz=c.z-point.z;
      if (ddx*ddx+ddy*ddy+ddz*ddz>1.25*1.25) continue;
      if (Math.floor(c.x)===tile.x && Math.floor(c.z)===tile.z && Math.abs(c.y-point.y)<.42) return c.p;
    }
  }
  function segmentStillConnected(run,distance) {
    const {m,input,direction,previousKey,nextKey}=cargoSegment(run,distance);
    if (!beltStillThere(run.dim,m.key) ||
        beltDirection(m.key)!==direction) return false;
    beltCache();
    const ck=run.dim.id+"|"+m.key+"|"+direction;
    let conn=tickConnCache.get(ck);
    if (!conn) {
      const port=beltPorts(run.dim,m,direction);
      conn={input:port.input,previousKey:port.previous?.key,nextKey:downstreamBelt(run.dim,m,direction)?.key};
      tickConnCache.set(ck,conn);
    }
    return conn.input===input && conn.previousKey===previousKey &&
      conn.nextKey===nextKey;
  }
  function filterAllows(key,item) {
    const filter=machineState(key).beltItemFilter;
    return !filter || filter===item.typeId;
  }
  // reactorAtShell が対象にするブロック種別 (reactor_structure.js の冒頭と同一)
  const REACTOR_SHELL_TYPES=new Set(["minecraft:stone_bricks","minecraft:stonebrick","minecraft:glass",REACTOR_CASING,REACTOR_WINDOW]);
  function nearbyMachine(run,tile,direction,stack) {
    const [dx,dz]=directions[direction];
    for (const [sx,sy,sz] of [[-dz,0,dx],[dz,0,-dx],[0,1,0],[0,-1,0]]) {
      const pos={x:tile.x+sx,y:tile.y+sy,z:tile.z+sz};
      const key=keyOf(tile.dim,pos);
      if (key===run.sourceKey || key===run.targetKey) continue;
      const type=run.dim.getBlock(pos)?.typeId;
      if (!FURNACE_TYPES.has(type) && !STORAGE_MACHINES.has(type) && !virtualTypes.has(type) &&
          !(REACTOR_SHELL_TYPES.has(type) && reactorAtShell(world,machineList(),tile.dim,pos))) continue;
      const target=destinationFor(run.dim,key,pos,sx,sz);
      if (target && roomFor(target,stack)>0) return target;
    }
  }
  function finishCargo(run,target) {
    const stack=runStack(run);
    const remainder=insertCargo(target,stack,left=>{
      run.item.n=left;
      run.stackCache=undefined;
    });
    if (remainder) { saveCargoCheckpoint(run.routeKey); return false; }
    return true;
  }
  // 貨物の見た目: アイコンのパーティクルをクライアント側で滑らせる。
  // 出し直しは最大6ティック (遠方は12) に1回と、次の区間の境目に着く時刻の
  // 早い方。速度は直近の実前進から決めるので、詰まっている便はその場に留まる
  function spawnCargoVisual(run,pos) {
    const now=system.currentTick;
    if (now<(run.nextVisual??0)) return;
    const rate=run.distRate??0;
    const interval=run.lodFar?12:6;
    let lifeTicks=interval;
    if (rate>0.01) {
      const toEnd=(Math.floor(run.distance)+1-run.distance)/(rate/20);
      lifeTicks=Math.max(2,Math.min(interval,Math.floor(toEnd)));
    }
    let vx=0, vy=0, vz=0;
    if (rate>0.01) {
      const ahead=cargoPosition(run,Math.min(run.distance+.05,run.keys.length-.06));
      const k=rate/.05;
      vx=(ahead.x-pos.x)*k; vy=(ahead.y-pos.y)*k; vz=(ahead.z-pos.z)*k;
    }
    try {
      const vars=new MolangVariableMap();
      vars.setFloat("of_vx",vx); vars.setFloat("of_vy",vy); vars.setFloat("of_vz",vz);
      vars.setFloat("of_lifetime",lifeTicks/20);
      run.dim.spawnParticle(id(`cargo_icon_${run.icon??0}`),pos,vars);
    } catch {}
    run.nextVisual=now+lifeTicks;
  }
  system.runInterval(()=>{
    segFreshCache=new Map(); pickupSnap=new Map();
    try {
    // A7: 反復開始時点の位置で、ルート+レーンごとに便を整列しておく (advanceCargo 用)
    const sortedShipments=new Map();
    for (const r of cargoRuns) {
      const k=r.routeKey+"|"+r.lane;
      let arr=sortedShipments.get(k); if (!arr) sortedShipments.set(k,arr=[]);
      arr.push({run:r,pos:r.originIndex+r.distance});
    }
    for (const arr of sortedShipments.values()) arr.sort((a,b)=>a.pos-b.pos);
    for (const run of cargoRuns) {
      try {
        if (!run.item) {finishRun(run);continue;}
        const segNow=cargoSegment(run,run.distance);
        const tile=segNow.m;
        // チャンクが読み込まれていない便は凍結する (旧方式で未読込の貨物
        // エンティティが止まっていたのと等価)。読み込まれたら自動で動き出す
        if (!run.dim.getBlock({x:tile.x,y:tile.y,z:tile.z})) continue;
        const stack=runStack(run);
        const point=cargoPosition(run,run.distance);
        if (!segmentStillConnected(run,run.distance)) {releaseCargoData(run);finishRun(run);continue;}
        const player=pickupPlayer(run.dim,point,tile);
        const inventory=player?.getComponent("minecraft:inventory")?.container;
        const pickup=inventory && {storage:inventory,slots:Array.from({length:inventory.size},(_,i)=>i)};
        if (pickup && roomFor(pickup,stack)>0) {
          if (finishCargo(run,pickup)) finishRun(run);
          continue;
        }
        try {
          const furnace=nearbyMachine(run,tile,segNow.direction,stack);
          if (furnace) {
            if (finishCargo(run,furnace)) finishRun(run);
            continue;
          }
        } catch {}
        if (run.distance+1e-6>=run.keys.length-.06) {
          try {
            const target=destinationFor(run.dim,run.targetKey,run.targetPos,run.dx,run.dz);
            if (target && roomFor(target,stack)>0 && finishCargo(run,target)) finishRun(run);
          } catch {}
          continue;
        }
        const nextDistance=advanceCargo(run,sortedShipments.get(run.routeKey+"|"+run.lane));
        if (nextDistance<=run.distance+1e-6) { run.distRate=0; spawnCargoVisual(run,point); continue; }
        const nextTile=cargoSegment(run,nextDistance).m;
        if (nextTile.key!==tile.key && !filterAllows(nextTile.key,stack)) { run.distRate=0; spawnCargoVisual(run,point); continue; }
        if (!segmentStillConnected(run,nextDistance)) {
          releaseCargoData(run);finishRun(run);continue;
        }
        if (system.currentTick>=(run.lodCheck??0)) { run.lodFar=!isNear(run.dim.id,point.x,point.z); run.lodCheck=system.currentTick+20; }
        run.distRate=(nextDistance-run.distance)*10;
        run.distance=nextDistance;
        cargoDirtyRoutes.add(run.routeKey);
        spawnCargoVisual(run,cargoPosition(run,run.distance));
      } catch {
        try { releaseCargoData(run); } catch {}
        finishRun(run);
      }
    }
    } finally { segFreshCache=null; pickupSnap=null; }
  },2);
  // お遊び要素: ベルトに乗ったプレイヤーを貨物と同じ速度で運ぶ。
  // 貨物は 2 tick ごとに 0.16 ブロック進む (1.6 ブロック/秒)。速度ベクトルを毎 tick
  // 0.08 に保つことで同じ速さにする。カーブでは貨物の軌道 (cargoPosition) の接線を
  // 使い、登りベルトの継ぎ目では小さく跳ねて段差を越える。しゃがむと止まれる。
  const rideHops = new Map();
  system.runInterval(()=>{
    for (const player of world.getAllPlayers()) {
      try {
        if (!player.isOnGround || player.isSneaking || player.isFlying) continue;
        const loc=player.location, dim=player.dimension;
        const below=dim.getBlock({x:Math.floor(loc.x),y:Math.floor(loc.y-.4),z:Math.floor(loc.z)});
        if (!below || !isBelt(below.typeId)) continue;
        const key=keyOf(dim.id,below.location);
        const m=machineIndex.get(key);
        if (!m) continue;
        const direction=beltDirection(key);
        const input=beltPorts(dim,m,direction).input;
        const [ox,oz]=directions[direction], [ix,iz]=directions[input];
        const rx=loc.x-(m.x+.5), rz=loc.z-(m.z+.5);
        let dx,dz;
        if (input===opposite(direction)) { dx=ox; dz=oz; }
        else {
          const a=Math.min(.5,Math.max(0,rx*ix+rz*iz));
          const theta=Math.asin(Math.min(1,Math.max(0,1-2*a)));
          dx=-Math.cos(theta)*ix+Math.sin(theta)*ox;
          dz=-Math.cos(theta)*iz+Math.sin(theta)*oz;
        }
        const vy=player.getVelocity().y;
        const sp=BELT_GRADES[below.typeId].speed/2;
        player.setVelocity({x:dx*sp,y:vy,z:dz*sp});
        const next=downstreamBelt(dim,m,direction);
        if (next && next.y===m.y+1 && rx*ox+rz*oz>.1) {
          const last=rideHops.get(player.id)??0;
          if (Date.now()-last>600) {
            rideHops.set(player.id,Date.now());
            player.setVelocity({x:dx*sp,y:.42,z:dz*sp});
          }
        }
      } catch {}
    }
  },1);
  function belt(m,block) {
    const direction=beltDirection(m.key);
    const [dx,dz]=directions[direction];
    const dim=block.dimension;
    const targetPos=neighborOn(m,direction);
    const targetKey=keyOf(m.dim,targetPos);
    const nextBelt=downstreamBelt(dim,m,direction);
    const exit=!!nextBelt && beltPorts(dim,nextBelt,beltDirection(nextBelt.key)).previous?.key===m.key;
    const startPort=beltPorts(dim,m,direction);
    showBelt(block,m.key,direction,!!startPort.previous,exit,startPort.input,
      (startPort.previous?.y??m.y)-m.y,exit ? nextBelt.y-m.y : 0);
    if (nextBelt||activeRoutes.has(m.key)||runningBelts.has(m.key)) return;
    const segments=[];
    const seen=new Set();
    let current=m, outgoing=direction, input=startPort;
    while (current) {
      if (seen.has(current.key)||runningBelts.has(current.key)||segments.length>=C.cableRange) return;
      const next=segments[0]?.m;
      segments.unshift({m:current,input:input.input,direction:outgoing,
        previousKey:input.previous?.key,nextKey:next?.key,
        entryRise:(input.previous?.y??current.y)-current.y,exitRise:(next?.y??current.y)-current.y});
      seen.add(current.key);
      if (!input.previous) break;
      current=input.previous;
      outgoing=beltDirection(current.key);
      input=beltPorts(dim,current,outgoing);
    }
    const route={dim,segments,dx,dz,keys:segments.map(segment=>segment.m.key),
      routeKey:m.key,targetKey,targetPos};
    if (!routeHasStock(route)) return;   // 搬出元に物が無いなら、どの出口からも発射できない
    if (launchShipment(route)) return;
    // A side outlet is usable even with air in front of the last belt.
    for (let index=segments.length-1;index>=0;index--) {
      const seg=segments[index];
      const [vx,vz]=directions[seg.direction];
      for (const [sx,sy,sz] of [[-vz,0,vx],[vz,0,-vx],[0,1,0],[0,-1,0]]) {
        const targetPos={x:seg.m.x+sx,y:seg.m.y+sy,z:seg.m.z+sz};
        const targetKey=keyOf(seg.m.dim,targetPos);
        if (!destinationFor(dim,targetKey,targetPos,sx,sz)) continue;
        const path=segments.slice(0,index+1);
        const candidate={...route,segments:path,keys:path.map(step=>step.m.key),targetKey,targetPos,dx:sx,dz:sz};
        if (launchShipment(candidate)) return;
      }
    }
  }
  // Check idle belts once per game second, independently of the machine batch.
  system.runInterval(()=>{
    const length=beltEntries.length;
    if (!length) return;   // ベルトは置いた時点で研究済み
    const batch=Math.ceil(length/10);
    for (let i=0;i<batch;i++) {
      const m=beltEntries[beltCursor%length];
      beltCursor=(beltCursor+1)%length;
      try {
        const block=findBlock(world.getDimension(m.dim),m.key);
        if (block?.typeId===m.type) belt(m,block);
      } catch {}
    }
  },2);
  // 対策3: ルートの搬出元 (入口の後ろ＋各区間の側面・上下) のどこかに、搬出できる物が
  // 1つでもあるかだけを先に調べる。launchShipment が集める搬出元の集合と同一範囲。
  // 物が無ければ launchShipment は必ず失敗するので、呼び出し自体を省ける
  function routeHasStock(route) {
    const first=route.segments[0];
    if (!first) return false;
    const dim=route.dim;
    const entry=neighborOn(first.m,first.input);
    const startKey=keyOf(first.m.dim,entry);
    const stocked=(pos,segM)=>{
      const s=containerAt(dim,keyOf(segM.dim,pos),pos,true,segM);
      return !!s?.storage && s.slots.some(slot=>s.storage.getItem(slot));
    };
    if (stocked(entry,first.m)) return true;
    for (const seg of route.segments) {
      const [vx,vz]=directions[seg.direction];
      for (const [sx,sy,sz] of [[-vz,0,vx],[vz,0,-vx],[0,1,0],[0,-1,0]]) {
        const pos={x:seg.m.x+sx,y:seg.m.y+sy,z:seg.m.z+sz};
        if (keyOf(seg.m.dim,pos)===startKey) continue;
        if (stocked(pos,seg.m)) return true;
      }
    }
    return false;
  }
  function shipFromSource(route,target,source) {
    const {dim,routeKey}=route;
    if (source.storage===target.storage || route.sourceKey===route.targetKey) return false;
    for (const previous of confirmedBeltRoutes.values()) {
      if (previous.source===route.targetKey && previous.target===route.sourceKey && previous.routeKeys.some(key=>route.keys.includes(key))) return false;
    }

    for (const slot of source.slots) {
      const item=source.storage.getItem(slot);
      if (!item) continue;
      const beltLimit=Math.min(...route.segments.map(seg=>gradeOfKey(seg.m.key).cap()));
      const count=acceptsCargo(target,item)&&filterAllows(route.segments[0].m.key,item)?Math.min(beltLimit,item.amount):0;
      if (!count) continue;
      const stack=item.clone();stack.amount=count;
      const run={...route,distance:.5};
      const rest=item.clone();
      if (item.amount===count) source.storage.setItem(slot,undefined);
      else {rest.amount=item.amount-count;source.storage.setItem(slot,rest);}
      try {
        run.item=serializeItem(stack);
        run.icon=cargoLook(null,stack.typeId);
        run.nextVisual=0;
        run.distRate=0;
      } catch {
        source.storage.setItem(slot,item);
        return false;
      }
      trackCargo(run);
      saveCargoCheckpoint(run.routeKey);
      return true;
    }
    return false;
  }
  function launchShipment(route) {
    const {dim,segments,targetKey,targetPos,dx,dz,routeKey}=route;
    const target=destinationFor(dim,targetKey,targetPos,dx,dz);
    if (!target) return false;

    const entries=[];
    const first=segments[0];
    const entry=neighborOn(first.m,first.input);
    const startKey=keyOf(first.m.dim,entry);
    function addSource(pos,index) {
      const seg=segments[index];
      const key=keyOf(seg.m.dim,pos);
      if (key===targetKey || entries.some(candidate=>candidate.key===key)) return;
      const source=containerAt(dim,key,pos,true,seg.m);
      if (!source?.storage) return;
      entries.push({key,index,source});
    }
    addSource(entry,0);
    for (let index=0;index<segments.length;index++) {
      const seg=segments[index];
      const [vx,vz]=directions[seg.direction];
      for (const [sx,sy,sz] of [[-vz,0,vx],[vz,0,-vx],[0,1,0],[0,-1,0]]) {
        const pos={x:seg.m.x+sx,y:seg.m.y+sy,z:seg.m.z+sz};
        if (keyOf(seg.m.dim,pos)!==startKey) addSource(pos,index);
      }
    }

    let launched=false;
    for (const lane of cargoLanes) {
      const previous=entries.findIndex(entry=>entry.key===lastBeltSource.get(routeKey));
      for (let offset=1;offset<=entries.length;offset++) {
        const {key,index,source}=entries[(previous+offset)%entries.length];
        const remaining=segments.slice(index);
        const keys=remaining.map(seg=>seg.m.key);
        const keySet=new Set(keys);
        let busy=false;
        for (const run of cargoRuns) {
          if (run.route===route) {
            if (run.lane===lane && Math.abs(run.originIndex+run.distance-index-.5)<gradeOfKey(segments[index].m.key).spacing-1e-6) {
              busy=true;
              break;
            }
          } else if (run.keys.some(key=>keySet.has(key))) {
            // Differently routed cargo shares the physical belt until it clears.
            busy=true;
            break;
          }
        }
        if (busy) continue;
        // 投入間隔: 入口のベルトのグレードで1レーン毎秒 rate 便まで (端数は持ち越して平均を合わせる)
        const lk=`${routeKey}:${lane}:${index}`;
        const neck=remaining.reduce((a,seg)=>{const g=gradeOfKey(seg.m.key);return !a||g.cap()<a.cap()||(g.cap()===a.cap()&&g.rate<a.rate)?g:a;},null);
        const rate=neck.rate;
        const lb=laneBudget.get(lk) ?? {tokens:1,tick:system.currentTick};
        lb.tokens=Math.min(1.5,lb.tokens+(system.currentTick-lb.tick)*rate/20); lb.tick=system.currentTick; laneBudget.set(lk,lb);
        if (lb.tokens<1-1e-9) continue;
        const shipment={...route,segments:remaining,keys,sourceKey:key,route,originIndex:index,lane};
        if (!shipFromSource(shipment,target,source)) continue;
        lb.tokens-=1;
        lastBeltSource.set(routeKey,key);
        confirmedBeltRoutes.set(routeKey,{source:key,target:targetKey,routeKeys:route.keys});
        launched=true;
        break;
      }
    }
    return launched;
  }
  system.runInterval(()=>{
    segFreshCache=new Map();
    try {
    for (const shipments of activeRoutes.values()) {
      const latest=[...shipments].at(-1);

      // レイアウトが変わっていないルートは全区間再検証を省く (対策2)。区間接続の結果は
      // レイアウト (ベルト配置・向き・入力モード) だけで決まるため、版数が同じなら前回の
      // 検証結果がそのまま成り立つ。版数の取りこぼしに備え、有効なルートは5秒ごと、
      // 切れているルートは1秒ごとに再検証する。貨物自体は移動時に区間を確認するので、
      // 壊れたベルトを突っ切ることはない
      try {
        const route=latest.route;
        const rv=routeValidity.get(route);
        const nowTick=system.currentTick;
        let valid;
        if (rv && rv.version===layoutVersion && nowTick-rv.tick < (rv.valid?100:20)) valid=rv.valid;
        else {
          valid=route.segments.every((_,index)=>segmentStillConnected(route,index));
          routeValidity.set(route,{version:layoutVersion,tick:nowTick,valid});
        }
        if (valid && routeHasStock(route)) launchShipment(route);
      } catch {}
    }
    } finally { segFreshCache=null; }
  },2);

  const read=(key,fallback=null)=>{try{return JSON.parse(dpGet(key,JSON.stringify(fallback)));}catch{return fallback;}};
  const write=(key,value)=>dpSet(key,value===undefined?undefined:JSON.stringify(value));
  function locationAhead(p,d) {
    const v=p.getViewDirection(), x=Math.floor(p.location.x+v.x*d), z=Math.floor(p.location.z+v.z*d), y=Math.floor(p.location.y);
    for (let i=2;i>=-3;i--) {
      const foot=p.dimension.getBlock({x,y:y+i,z}), head=p.dimension.getBlock({x,y:y+i+1,z}), floor=p.dimension.getBlock({x,y:y+i-1,z});
      if (foot?.typeId==="minecraft:air"&&head?.typeId==="minecraft:air"&&floor&&!floor.isAir&&!floor.isLiquid) return {x:x+.5,y:y+i,z:z+.5};
    }
  }
  const rank=p=>Number(pGet(p,"of:boss_rank",0));
  // オーバーシア降下迎撃 (overseer_raid.js)
  const raid=installOverseerRaid({world,system,read,write,speedLimit,giveItems,countItem,removeItems,toast,pSet,rank,research,rocketStage,C,registry,spend:(k,n)=>spend(k,n),availablePower:k=>availablePower(k),createForm,keyOf});
  const summon=p=>raid.summon(p);
  const adoptOverseer=(e,p)=>raid.adopt(e,p);
  const hurtOverseer=(entity,hit,amount,part)=>raid.hurt(entity,hit,amount,part);
  async function operations(p) {
    const form=createForm().title("地上作戦").body(`オーバーシア迎撃 ${rank(p)} 回`);
    const actions=[];
    const add=(action,label,icon)=>{actions.push(action);form.button(label,icon);};
    if (rocketStage(p)>=4) add("summon","オーバーシア降下迎撃 (起動核)","textures/items/activation_core");
    const shown=read("of:boss");
    if (shown && (!shown.owner || shown.owner===p.id)) add("abort","迎撃作戦を中止");
    if(!actions.length){toast(p,"今できる地上作戦はありません (オーバーシア迎撃は軌道到達後)");return;}
    const r=await form.show(p);if(r.canceled)return;
    const action=actions[r.selection];
    if(action==="summon") summon(p);
    else if(action==="abort") raid.abort(p);
  }
  async function device(p,b,key) {
    const type=b.typeId;
    const st=machineState(key);
    if(isBelt(type)) {
      const label=item=>nameOf?.(item)??item.replace("minecraft:","");
      const inventory=p.getComponent("minecraft:inventory")?.container;
      const choices=new Set();
      if (inventory) for (let slot=0;slot<inventory.size;slot++) {
        const item=inventory.getItem(slot);
        if (item) choices.add(item.typeId);
      }
      const items=[...choices].filter(item=>item!==st.beltItemFilter);
      if (st.beltItemFilter) items.unshift(st.beltItemFilter);
      const selected=st.beltItemFilter?label(st.beltItemFilter):"すべての品目";
      const form=createForm().title("ベルトの搬送フィルター")
        .body(`選択中：${selected}\n出口：${directions[beltDirection(key)][2]}\nグレード：Mk ${["","I","II","III"][BELT_GRADES[type].grade]}\n積載：1便最大${BELT_GRADES[type].cap()}個 · 最大 毎秒${Math.round(BELT_GRADES[type].cap()*2*(BELT_GRADES[type].speed*10)/BELT_GRADES[type].spacing)}個 (2レーン合計)`)
        .button(st.beltItemFilter?"すべての品目を通す":"【選択中】すべての品目");
      for (const item of items) {
        form.button(item===st.beltItemFilter?`【選択中】${label(item)}`:label(item));
      }
      form.button("閉じる");
      const response=await form.show(p);
      if(response.canceled || !sameMachine(b,type)) return;
      const current=machineState(key);
      const chosen=items[response.selection-1];
      if(response.selection===0) delete current.beltItemFilter;
      else if(chosen) current.beltItemFilter=chosen;
      else return;
      if (current.beltItemFilter===st.beltItemFilter) return;
      saveMachineState(key,current);
      return device(p,b,key);
    }
    const form=createForm().title(type===id("oil_pump")?"原油ポンプ":"送電ケーブル");
    if(type===id("oil_pump"))form.body(`採油対象　水1000 mB+石炭1\n接続電力　${availablePower(key)} SE\n\n原油を自動で生産します。原油は液体パイプで取り出してください。`);
    else {
      // ケーブル自体は電力を使わないので、つながっている送電網の発電機・蓄電池にたまっている電力を表示する
      const net=cableNets.get(key)??{sources:[],terminals:0};
      const stored=net.sources.filter(canSupply).reduce((t,k)=>t+(generatorRecord(k).stored||0),0);
      form.body(`送電接続\n\n発電機と設備をケーブルでつないでください。上下を含む6面すべて接続できます。\n\n`+
        `この送電網の電力　${Math.floor(stored).toLocaleString("en-US")} SE\n`+
        `つながっている発電機・蓄電池 ${net.sources.length}台 · 設備 ${Math.max(0,net.terminals)}台`);
    }
    form.button("閉じる");
    const r=await form.show(p);if(r.canceled||!sameMachine(b,type))return;
  }
  const DEPOSIT_RESERVES={ancient_debris:[6,16]};
  const DEPOSIT_ITEMS=Object.fromEntries(Object.entries(ORE_PROCESSING.ores).map(([kind,ore])=>[kind,ore.raw]));
  const runningDrillVisuals=new Map();
  function updateDrillVisual(m,block,deposit,mining,speed) {
    setBlockActive(block,m.type,m.key,mining);
    if (mining) {
      const effect=id("drill_chips_"+deposit.block.typeId.slice(id("deposit_").length));
      if (!runningDrillVisuals.has(m.key)) {
        runningDrillVisuals.set(m.key,{m,dim:block.dimension,effect,frame:0,speed,nextPose:0});
      } else Object.assign(runningDrillVisuals.get(m.key),{effect,speed});
      return;
    }
    runningDrillVisuals.delete(m.key);
    const perm=block.permutation;
    const phase=id("drill_phase");
    if (perm.getState(phase)) block.setPermutation(perm.withState(phase,0));
  }
  system.runInterval(()=>{
    for (const [key,visual] of runningDrillVisuals) {
      if(system.currentTick<visual.nextPose)continue;
      visual.nextPose=system.currentTick+visualStepTicks(visual.speed);
      if(!nearMachine(visual.m)){visual.nextPose=system.currentTick+40;continue;}   // 遠くのドリルは削りかすの演出を止める
      try {
        const block=visual.dim.getBlock(visual.m);
        if (block?.typeId!==id("fixed_drill")) { runningDrillVisuals.delete(key); continue; }
        // 電力不足・満杯・枯渇になったら、巡回処理を待たずに約1秒で削りかすを止める
        if (visual.frame%7===6 && drillStatus(block,key,machineState(key)).reason!=="採掘中") {
          updateDrillVisual(visual.m,block,undefined,false); continue;
        }
        const perm=block.permutation, state=id("drill_phase");
        const phase=perm.getState(state);
        if (phase===undefined) { runningDrillVisuals.delete(key); continue; }
        block.setPermutation(perm.withState(state,(phase+1)%6));
        if (visual.frame++%4===0) {
          const {x,y,z}=visual.m;
          visual.dim.spawnParticle(visual.effect,{x:x+.5,y:y+.18,z:z+.5});
        }
      } catch { runningDrillVisuals.delete(key); }
    }
  },1);
  const DRILL_BUFFER=16;
  const DRILL_CYCLE_MS=4000;
  // 鉱床ブロック1つの情報。中心 (縁・露頭でない) だけが埋蔵量を持つ。
  // 種類が分からない場合は undefined (呼び出し側で保護扱い)。
  function depositAt(deposit) {
    const type=deposit?.typeId??"";
    if (!type.startsWith(id("deposit_"))) return;
    const outcrop=type.endsWith("_outcrop");
    const kind=type.slice(id("deposit_").length).replace(/_outcrop$/,"");
    const item=DEPOSIT_ITEMS[kind];
    if (!item) return;
    const pos=deposit.location;
    const key="of_deposit:"+keyOf(deposit.dimension.id,pos);
    let rim=false, depleted=false;
    try {rim=deposit.permutation.getState(id("vein_rim"))===true;} catch {}
    try {depleted=deposit.permutation.getState(id("depleted"))===true;} catch {}
    const {x,y,z}=pos;
    let hash=Math.imul(x,73856093)^Math.imul(y,19349663)^Math.imul(z,83492791);
    for (const letter of kind) hash=Math.imul(hash^letter.charCodeAt(0),16777619);
    // 埋蔵量: 通常 800〜2400。希少な資源は種類ごとに小さくし、旧版で記録済みの残量も上限で切り詰める
    const [low,high]=DEPOSIT_RESERVES[kind]??[800,2400];
    const stored=Number(dpGet(key,low+(hash>>>0)%(high-low+1)));
    const remaining=depleted?0:Math.max(0,Math.min(high,stored));
    if (stored>high) dpSet(key,high);   // 遠隔採掘も同じ残量を読むよう、保存値も切り詰める
    return {block:deposit,key,item,remaining,center:!rim&&!outcrop,kind};
  }
  function drillDeposit(block) {
    const pos={...block.location,y:block.location.y-1};
    const info=depositAt(block.dimension.getBlock(pos));
    if (!info || !info.center) return;
    return info;
  }
  function drillStatus(block,key,st,container=machineContainer(block,key)) {
    const deposit=drillDeposit(block);
    const buffered=container?outputSlots.reduce((count,slot)=>count+(container.getItem(slot)?.amount??0),0):0;
    const sources=sourceKeys(key);
    const power=sources.reduce((sum,source)=>sum+generatorRecord(source).stored,0);
    const reason=!deposit?"真下に鉱床がありません":!deposit.remaining?"鉱床枯渇":
      st.running===false?"手動停止":buffered>=DRILL_BUFFER?"搬出先が満杯":
      power<ENERGY.drillPerBlock?"電力不足":"採掘中";
    return {deposit,buffered,sources,power,reason,speed:affordableSpeed(speedLimit(key),power,value=>ENERGY.drillPerBlock*value)};
  }
  function tickDrill(m,block,st) {
    const container=machineContainer(block,m.key);
    if (!container) return;
    const before=drillStatus(block,m.key,st,container);
    if (st.remotePending && st.drillSnapshot) {
      const moved=Math.min(st.remotePending,DRILL_BUFFER-before.buffered);
      if (moved>0) {
        const stack=new ItemStack(st.drillSnapshot.item,moved);
        const remainder=insertCargo({storage:container,slots:outputSlots},stack);
        st.remotePending-=moved-(remainder?.amount??0);
        saveMachineState(m.key,st);
      }
    }
    const {deposit,reason,sources,buffered,speed}=drillStatus(block,m.key,st,container);
    const snapshot=deposit?{key:deposit.key,item:deposit.item,remaining:deposit.remaining,buffered,
      sources,wiring:drillWiring.get(m.key)??[],reason}:undefined;
    if (JSON.stringify(st.drillSnapshot)!==JSON.stringify(snapshot)) {
      st.drillSnapshot=snapshot;
      saveMachineState(m.key,st);
    }
    const mining=reason==="採掘中";
    updateDrillVisual(m,block,deposit,mining,speed);
    if (deposit && !deposit.remaining) markDepleted(block.dimension,deposit.block);
    if (!mining || Date.now()<(st.nextMine??0)) return;
    const item=new ItemStack(deposit.item);
    const output={storage:container,slots:outputSlots};
    if (!roomFor(output,item)) return;
    insertCargo(output,item);
    drawEnergy(ENERGY.drillPerBlock*speed,sources,false); noteUse(m.key,ENERGY.drillPerBlock*speed);
    const remaining=deposit.remaining-1;
    dpSet(deposit.key,remaining);
    st.nextMine=scheduledStart(st.nextMine,Date.now())+DRILL_CYCLE_MS/speed;
    st.drillSnapshot.remaining=remaining;
    st.drillSnapshot.buffered=buffered+1;
    saveMachineState(m.key,st);
    if (!remaining) {
      updateDrillVisual(m,block,deposit,false);
      markDepleted(block.dimension,deposit.block);
    }
  }
  function markDepleted(dimension,block) {
    const depleted=id("depleted");
    if (block.permutation.getState(depleted)===true) return;
    block.setPermutation(block.permutation.withState(depleted,true));
    const {x,y,z}=block.location;
    for (const [dx,dz] of [[-2,-1],[-2,0],[-2,1],[-1,-1],[-1,1],[1,-1],[1,1],[2,-1],[2,0],[2,1],[-3,0],[3,1],[0,-2],[0,2],[-1,0],[1,0],[0,-1],[0,1]]) {
      try {
        const rock=dimension.getBlock({x:x+dx,y,z:z+dz});
        if (rock?.typeId===block.typeId+"_outcrop" ||
            (rock?.typeId===block.typeId && rock.permutation.getState(id("vein_rim"))===true)) {
          rock.setPermutation(rock.permutation.withState(depleted,true));
        }
      } catch {}
    }
  }
  function remoteDrillRows(list) {
    return list.filter(m=>m.type===id("fixed_drill")).map(m=>{
      const st=machineState(m.key), snapshot=st.drillSnapshot;
      let block;
      try { block=world.getDimension(m.dim).getBlock(m); } catch {}
      if (!snapshot) return {m,block};
      const remaining=Number(dpGet(snapshot.key,snapshot.remaining));
      const wiredSources=snapshot.wiring.every(key=>machineIndex.get(key)?.type===id("power_cable"))
        ? orderedSources(snapshot.sources.filter(key=>isPowerSource(machineIndex.get(key)?.type) && canSupply(key))):[];
      const power=wiredSources.reduce((sum,source)=>sum+generatorRecord(source).stored,0);
      const buffered=snapshot.buffered+(st.remotePending??0);
      const reason=!remaining?"鉱床枯渇":st.running===false?"手動停止":
        buffered>=DRILL_BUFFER?"搬出先が満杯":power<ENERGY.drillPerBlock?"電力不足":"採掘中";
      return {m,st,snapshot,remaining,wiredSources,power,buffered,reason,block};
    });
  }
  const unloadedWork=new Map();
  function tickRemoteDrills(list) {
    const live=new Set();
    for (const {m,block,st,snapshot,remaining,wiredSources,power,buffered,reason} of remoteDrillRows(list)) {
      if (block || reason!=="採掘中") continue;
      live.add(m.key);
      const speed=affordableSpeed(speedLimit(m.key),power,value=>ENERGY.drillPerBlock*value);
      checkShort(m.key,ENERGY.drillPerBlock,power);
      const work=Math.min(8,(unloadedWork.get(m.key)??0)+speed);
      const unit=ENERGY.drillPerBlock*speed;
      const count=Math.min(Math.floor(work/4),Math.floor(power/unit),remaining,DRILL_BUFFER-buffered);
      unloadedWork.set(m.key,work-count*4);
      if(!count)continue;
      drawEnergy(unit*count,wiredSources,false); noteUse(m.key,unit*count);
      dpSet(snapshot.key,remaining-count);
      st.remotePending=(st.remotePending??0)+count;
      saveMachineState(m.key,st);
    }
    for(const key of unloadedWork.keys())if(!live.has(key))unloadedWork.delete(key);
  }
  function remoteDrills() { return remoteDrillRows(registry()); }
  function tick(m,b,st) {
    if(research && !research.allowsMachine(m.type,m))return;
    if(m.type===id("coal_generator")){distributeCoal(m,b);pullSideCoal(m,b);}
    else if(RECIPE_INPUTS.has(m.type) || m.type===id("launch_pad") || m.type===id("research_lab")){machineTransfers(m,b);if(m.type===id("crusher"))distributeMaterials(m,b);}
    else if(m.type===id("fixed_drill")||m.type===id("oil_pump")||m.type===id("nuclear_reactor"))machineTransfers(m,b);
  }
  function tickFast(m,b,st) {
    if(m.type===id("fixed_drill"))tickDrill(m,b,st);
  }
  return {splitterUi,orientSplitter,orientBelt,isSplitter:type=>!!SPLITTERS[type],cannonUi:(p,b,k)=>raid.cannonUi(p,b,k),attachDefense:d=>raid.attachDefense(d),overseerRaid:(p,at,m,debug)=>raid.summon(p,at,true,m,debug),adoptOverseer,hurtOverseer,updateNetwork,hasPower,availablePower,powerCapacity,spend,chargingSources,tick,tickFast,operations,device,rotateBelt,drillStatus,tickRemoteDrills,remoteDrills,
    setVirtualStorage,containerAt,destinationFor,manualMachineInput,roomFor,insertCargo,depositAt,growerPowerRoute,remoteGrowerPower};
}
