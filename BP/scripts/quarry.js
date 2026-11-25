import { nearMachine } from "./lod.js";
import { affordableSpeed, visualStepTicks } from "./machine-speed.js";
// チャンクデストロイヤー: 隣接チャンク1つを上から層ごとに掘り下げる大型採掘機。
// ・測量で 16×16 の境界に黄黒の警告線を引き、稼働中は境界上にガントリーを組んでドリル頭が掘削位置を走査する。
// ・処理はワールド稼働中・読込済みの範囲だけ。処理したセルにだけ結果を確定し、同じ位置から再開する。
import { ItemStack, MolangVariableMap } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { NS } from "./config.js";
import {
  QUARRY_TIERS, QUARRY_TYPES, TERRAIN_CATEGORIES, DEFAULT_FILTER, depositCap,
  classify, chunkOf, chunkBounds, cellOffset, cellsPerSecond, energyPerCell, estimate,
} from "./quarry_rules.js";

const OVERWORLD = "minecraft:overworld";
const TICK = 10;                 // 掘削処理の間隔 (tick)
const FRAME_LIFT = 3;            // ガントリーは開始高さの3ブロック上
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SOFT = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava"]);
const isFoliage = t => !t || SOFT.has(t) || t.endsWith("leaves") || t.endsWith("_log") || t.endsWith("_wood") || t.endsWith("_stem") || classify(t).kind === "clear";
const ENTITY = { frame: `${NS}:quarry_frame`, bridge: `${NS}:quarry_bridge`, head: `${NS}:quarry_head`,
  leg0: `${NS}:quarry_leg`, leg1: `${NS}:quarry_leg`, leg2: `${NS}:quarry_leg`, leg3: `${NS}:quarry_leg` };

export function installQuarry(core) {
  const { world, system, registry, keyOf, dpGet, dpSet, createForm, toast, giveItems, nameOf, research, expansion } = core;
  const jobKey = key => "of_q:" + key;
  const fresh = () => ({ status: "idle", filter: { ...DEFAULT_FILTER }, buffer: {}, stats: { cells: 0, kept: 0, discarded: {}, deposits: 0 } });
  function read(key) {
    try { const job = { ...fresh(), ...JSON.parse(dpGet(jobKey(key), "{}")) }; job.filter = { ...DEFAULT_FILTER, ...job.filter }; return job; }
    catch { return fresh(); }
  }
  // 動的プロパティは1つ約32KBまで。超えると保存が黙って失敗するので、表示用のデータから削って収める
  const write = (key, job) => {
    let text = JSON.stringify(job);
    if (text.length > 30000) { for (const q of job.queue ?? []) delete q.edges; for (const sub of job.subs ?? []) { delete sub.edges; delete sub.legs; sub.stats = { cells: sub.stats?.cells ?? 0, kept: 0, discarded: {}, deposits: 0 }; } job.preview = undefined; text = JSON.stringify(job); }
    if (text.length > 30000) { job.stats.discarded = {}; text = JSON.stringify(job); }
    if (text.length > 32000) console.warn(`[Orbital Foundry] quarry state too large (${text.length})`);
    dpSet(jobKey(key), text);
  };
  const tierOf = type => QUARRY_TIERS[type];
  const bufferTotal = job => Object.values(job.buffer).reduce((sum, n) => sum + n, 0);

  // ---- チャンクの予約 (他機が担当中のチャンクは予約できない) ----
  const claimKey = (dim, cx, cz) => `${dim}|${cx},${cz}`;
  const claims = () => { try { return JSON.parse(dpGet("of:quarry_claims", "{}")); } catch { return {}; } };
  function claim(chunk, key) {
    const all = claims();
    if (all[chunk] && all[chunk] !== key && registry().some(m => m.key === all[chunk])) return false;
    all[chunk] = key; dpSet("of:quarry_claims", JSON.stringify(all)); return true;
  }
  // chunk を指定するとそのチャンクだけ、省くとこの機械の予約をすべて解除する
  function release(key, chunk) {
    const all = claims();
    for (const c of Object.keys(all)) if (all[c] === key && (!chunk || c === chunk)) delete all[c];
    dpSet("of:quarry_claims", JSON.stringify(all));
  }

  // ---- 地表と警告線 ----
  function groundY(dim, x, z, fromY) {
    const min = dim.heightRange?.min ?? -64;
    for (let y = fromY; y > Math.max(min, fromY - 64); y--) {
      let block; try { block = dim.getBlock({ x, y, z }); } catch { return fromY; }
      if (!block) return fromY;
      if (!isFoliage(block.typeId)) return y + 1;
    }
    return fromY;
  }
  // ネザー (天井が岩盤) とエンドは最上ブロックが地面と限らないので、本体の高さ+16から下を見る
  function suggestStart(dim, cx, cz, around, underRoof) {
    const { minX, minZ } = chunkBounds(cx, cz);
    const maxStart = (dim.heightRange?.max ?? 320) - FRAME_LIFT - 2;
    let best = -Infinity;
    for (let dx = 0; dx < 16; dx += 3) for (let dz = 0; dz < 16; dz += 3) {
      let top; if (!underRoof) try { top = dim.getTopmostBlock?.({ x: minX + dx, z: minZ + dz })?.location.y; } catch {}
      const from = Math.min(maxStart, (top ?? around + 15) + 1);
      const ground = groundY(dim, minX + dx, minZ + dz, from) - 1;
      if (ground < from - 1 || !underRoof) best = Math.max(best, ground);
    }
    return Math.min(maxStart, Number.isFinite(best) ? best : around);
  }
  // 境界の外側に沿った64区画の高さ。線は外側の地面に引く (掘っても消えない)。
  function perimeter(dim, cx, cz, startY) {
    const { minX, minZ, maxX, maxZ } = chunkBounds(cx, cz);
    const edges = [];
    for (let i = 0; i < 16; i++) {
      edges.push({ x: minX + i + .5, z: minZ, axis: "x", y: groundY(dim, minX + i, minZ - 1, startY + 8) });
      edges.push({ x: minX + i + .5, z: maxZ + 1, axis: "x", y: groundY(dim, minX + i, maxZ + 1, startY + 8) });
      edges.push({ x: minX, z: minZ + i + .5, axis: "z", y: groundY(dim, minX - 1, minZ + i, startY + 8) });
      edges.push({ x: maxX + 1, z: minZ + i + .5, axis: "z", y: groundY(dim, maxX + 1, minZ + i, startY + 8) });
    }
    return edges;
  }
  const YELLOW = { red: 1, green: .78, blue: .1, alpha: 1 }, DARK = { red: .1, green: .09, blue: .08, alpha: 1 };
  const TEAL = { red: .16, green: .85, blue: .78, alpha: 1 };
  // 予約済みのチャンクは青緑と黒の線 (掘削中は黄黒)
  function hazardLines(dim, job, light = YELLOW) {
    if (!job.edges) return;
    for (let n = 0; n < job.edges.length; n++) {
      const e = job.edges[n];
      let vars;
      try { vars = new MolangVariableMap(); vars.setColorRGBA("variable.color", (e.axis === "x" ? Math.floor(e.x) : Math.floor(e.z)) % 2 ? light : DARK); } catch { vars = undefined; }
      try { dim.spawnParticle(`${NS}:hazard_${e.axis}`, { x: e.x, y: e.y + .06, z: e.z }, vars); } catch {}
    }
    const { minX, minZ, maxX, maxZ } = chunkBounds(job.cx, job.cz);
    for (const [x, z] of [[minX, minZ], [maxX + 1, minZ], [minX, maxZ + 1], [maxX + 1, maxZ + 1]]) {
      try { dim.spawnParticle(`${NS}:hazard_pillar`, { x, y: (job.edges.find(e => Math.abs(e.x - x) < 1 && Math.abs(e.z - z) < 1)?.y ?? job.startY) + .1, z }); } catch {}
    }
  }

  // ガントリー四隅の脚の長さ (ブロック)。掘る前に、角のすぐ外側の地面までを測る。
  // 脚は1本ずつのエンティティを、チャンクの四隅のすぐ外側 (ワールド座標) に置き、真下の地面まで伸ばす。
  // モデルの向き (X の鏡像) に左右されないよう、位置も測る列もワールド座標だけで決める。
  function legCorners(job) {
    const { minX, minZ, maxX, maxZ } = chunkBounds(job.cx, job.cz);
    return [[minX - .32, minZ - .32], [maxX + 1.32, minZ - .32], [minX - .32, maxZ + 1.32], [maxX + 1.32, maxZ + 1.32]];
  }
  function legLengths(dim, cx, cz, frameY) {
    return legCorners({ cx, cz }).map(([x, z]) => Math.max(1, Math.min(400, Math.round(frameY + .25 - groundY(dim, Math.floor(x), Math.floor(z), frameY)))));
  }
  // ---- 掘る候補: 正面の扇形 (A) と 掘削マーカー (C) ----
  const FACING = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
  const COMPASS = { "0,-1": "北", "0,1": "南", "1,0": "東", "-1,0": "西" };
  function facingOf(block) {
    let dir; try { dir = block.permutation.getState("minecraft:cardinal_direction"); } catch {}
    return FACING[dir] ?? FACING.north;
  }
  // 正面から depth 列 × 左右3つ。row=1 が本体のすぐ前のチャンク
  function fanChunks(block, tier) {
    const own = chunkOf(block.location.x, block.location.z);
    const [fx, fz] = facingOf(block), [rx, rz] = [-fz, fx];
    const list = [];
    for (let row = 1; row <= (tier.rows ?? 1); row++) for (const col of [-1, 0, 1])
      list.push({ cx: own.cx + fx * row + rx * col, cz: own.cz + fz * row + rz * col, row, col,
        label: `${row}列先・${col === 0 ? "正面" : (COMPASS[`${rx * col},${rz * col}`] ?? "") + "寄り"}` });
    return list;
  }
  const MARKER = `${NS}:quarry_marker`;
  const markers = () => { try { return JSON.parse(dpGet("of:quarry_markers", "[]")); } catch { return []; } };
  // マーカーは置いた人 (owner) を記録し、持ち主が自分のチャンクデストロイヤーに登録したもの (link) だけが候補になる
  const sameMarker = (m, dimId, pos) => m.dim === dimId && m.x === pos.x && m.y === pos.y && m.z === pos.z;
  function addMarker(dimId, pos, owner, ownerName) {
    const list = markers().filter(m => !sameMarker(m, dimId, pos));
    list.push({ dim: dimId, x: pos.x, y: pos.y, z: pos.z, owner, ownerName }); dpSet("of:quarry_markers", JSON.stringify(list.slice(-64)));
  }
  function setMarkerLink(dimId, pos, key) {
    dpSet("of:quarry_markers", JSON.stringify(markers().map(m => sameMarker(m, dimId, pos) ? { ...m, link: key } : m)));
  }
  // チャンクデストロイヤーの持ち主 (設置した人)。旧版で記録がなければ、最初に画面を開いた人
  const ownerKey = key => "of_q_owner:" + key;
  const ownerOf = key => { try { return JSON.parse(dpGet(ownerKey(key), "null")); } catch { return null; } };
  const setOwner = (key, player) => dpSet(ownerKey(key), JSON.stringify({ id: player.id, name: player.name }));
  function removeMarker(dimId, pos) {
    dpSet("of:quarry_markers", JSON.stringify(markers().filter(m => !(m.dim === dimId && m.x === pos.x && m.y === pos.y && m.z === pos.z))));
  }
  // マーカーが効く距離 (チャンク、本体のチャンクから縦横斜めとも)
  const markerRange = tier => tier.markerRange ?? 2;
  function markerInRange(block, m) {
    const own = chunkOf(block.location.x, block.location.z), c = chunkOf(m.x, m.z);
    if (m.dim !== block.dimension.id || (c.cx === own.cx && c.cz === own.cz)) return false;
    return Math.max(Math.abs(c.cx - own.cx), Math.abs(c.cz - own.cz)) <= markerRange(tierOf(block.typeId) ?? {});
  }
  // このチャンクデストロイヤーに登録済みで、距離内のマーカー (読込済みで撤去されていたら一覧から外す)
  function markerChunks(block, key = keyOf(block.dimension.id, block.location)) {
    const own = chunkOf(block.location.x, block.location.z), seen = new Set(), out = [], owner = ownerOf(key);
    for (const m of markers()) {
      if (m.link !== key || !markerInRange(block, m)) continue;
      if (owner && m.owner !== owner.id) continue;   // 持ち主以外が置いたマーカーは使わない
      let b; try { b = block.dimension.getBlock(m); } catch {}
      if (b && b.typeId !== MARKER) { removeMarker(m.dim, m); continue; }
      const c = chunkOf(m.x, m.z), k = c.cx + "," + c.cz;
      if (seen.has(k) || (c.cx === own.cx && c.cz === own.cz)) continue;
      seen.add(k); out.push({ ...c, label: `目印 (${m.x}, ${m.y}, ${m.z})` });
    }
    return out;
  }
  // ---- 掘削エリア (Mk I 1×1 / Mk II 2×2 / Mk III 4×4 チャンク) ----
  // 登録済みマーカーがあれば、そのチャンクを本体側の角にして奥へ広げる。なければ本体の正面の奥に置く
  const areaSize = tier => tier.area ?? 1;
  function areaChunks(block, key = keyOf(block.dimension.id, block.location)) {
    const tier = tierOf(block.typeId) ?? {}, n = areaSize(tier), own = chunkOf(block.location.x, block.location.z);
    const mk = markerChunks(block, key)[0];
    let x0, z0, sx, sz;
    if (mk) { sx = Math.sign(mk.cx - own.cx) || 1; sz = Math.sign(mk.cz - own.cz) || 1; x0 = mk.cx; z0 = mk.cz; }
    else {
      const [fx, fz] = facingOf(block), [rx, rz] = [-fz, fx], left = -Math.floor((n - 1) / 2);
      x0 = own.cx + fx + rx * left; z0 = own.cz + fz + rz * left;
      sx = fx || rx; sz = fz || rz;
    }
    const out = [];
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) out.push({ cx: x0 + sx * a, cz: z0 + sz * b });
    return { list: out, marker: !!mk, minX: Math.min(x0, x0 + sx * (n - 1)) * 16, maxX: Math.max(x0, x0 + sx * (n - 1)) * 16 + 15, minZ: Math.min(z0, z0 + sz * (n - 1)) * 16, maxZ: Math.max(z0, z0 + sz * (n - 1)) * 16 + 15 };
  }
  // エリアの外周を光の線で示す (発射台・着陸台の区画表示のように、置いてから掘削開始まで常に出す)
  const areaCache = new Map();
  function drawArea(dim, area, y) {
    const id = `${dim.id}:${area.minX},${area.minZ},${area.maxX},${area.maxZ}`;
    let pts = areaCache.get(id);
    if (!pts || system.currentTick - pts.at > 200) {
      const ground = (x, z) => { try { const t = dim.getTopmostBlock({ x, z }); if (t) return t.location.y + 1; } catch {} return y; };
      const X1 = area.maxX + 1, Z1 = area.maxZ + 1, list = [];
      for (let x = area.minX; x < X1; x++) { list.push(["x", x + .5, ground(x, area.minZ), area.minZ]); list.push(["x", x + .5, ground(x, area.maxZ), Z1]); }
      for (let z = area.minZ; z < Z1; z++) { list.push(["z", area.minX, ground(area.minX, z), z + .5]); list.push(["z", X1, ground(area.maxX, z), z + .5]); }
      const corners = [[area.minX, area.minZ], [X1, area.minZ], [area.minX, Z1], [X1, Z1]].map(([x, z]) => [x, ground(Math.min(x, area.maxX), Math.min(z, area.maxZ)), z]);
      pts = { at: system.currentTick, list, corners }; areaCache.set(id, pts);
      if (areaCache.size > 32) areaCache.delete(areaCache.keys().next().value);
    }
    for (const [axis, x, gy, z] of pts.list) {
      let vars; try { vars = new MolangVariableMap(); vars.setColorRGBA("variable.color", Math.floor(axis === "x" ? x : z) % 2 ? TEAL : DARK); } catch { vars = undefined; }
      try { dim.spawnParticle(`${NS}:hazard_${axis}`, { x, y: gy + .06, z }, vars); } catch {}
    }
    for (const [x, gy, z] of pts.corners) try { dim.spawnParticle(`${NS}:hazard_pillar`, { x, y: gy + .1, z }); } catch {}
  }
  // エリア全体を開始: 最初のチャンクを掘り、残りは予約に積む
  function beginArea(key, block) {
    const tier = tierOf(block.typeId), dim = block.dimension, area = areaChunks(block, key), busy = claims();
    const free = area.list.filter(c => { const o = busy[claimKey(dim.id, c.cx, c.cz)]; return !o || o === key; });
    if (!free.length) return "エリアのチャンクはすべて別のチャンクデストロイヤーが担当中です";
    const plans = free.map(c => planFor(dim, c.cx, c.cz, suggestStart(dim, c.cx, c.cz, block.location.y, dim.id !== OVERWORLD), tier));
    const job = read(key);
    for (const c of free) claim(claimKey(dim.id, c.cx, c.cz), key);
    applyPlan(job, dim, plans[0]);
    // エリアのチャンクはすべて同時に掘る (1チャンクごとに電力がかかる。足りない分は遅くなる)
    job.queue = [];
    job.subs = plans.slice(1).map(pl => { const sub = { isSub: true }; applyPlan(sub, dim, { ...pl, edges: undefined }); delete sub.legs; delete sub.edges; delete sub.preview; delete sub.head; return sub; });
    job.areaRun = true;
    job.area = { minX: area.minX, maxX: area.maxX, minZ: area.minZ, maxZ: area.maxZ };
    job.markersBack = collectMarkers(key, dim, job);
    write(key, job);
  }
  // 掘削がすべて終わったら、登録していたマーカーを回収してバッファに入れる
  // 登録マーカーを回収してバッファへ入れる (読み込まれていなくても記録上は回収し、ブロックは読み込み済みなら消す)
  // エリアは開始時に job.area として保存済みなので、掘削開始の時点で回収してよい。掘削でマーカーごと掘られて消えるのも防げる
  function collectMarkers(key, dim, job) {
    let n = 0;
    const left = [];
    for (const m of markers()) {
      if (m.link !== key) { left.push(m); continue; }
      n++;
      try { const d = m.dim ? world.getDimension(m.dim) : dim, b = d.getBlock(m); if (b?.typeId === MARKER) b.setType("minecraft:air"); } catch { }
    }
    dpSet("of:quarry_markers", JSON.stringify(left));
    if (n) job.markerStash = (job.markerStash ?? 0) + n;   // バッファとは別に保管 (自動搬出されない)
    return n;
  }
  // 画面用の文字地図。上が奥。掘=掘削中、1〜8=予約順、計=計画中、他=別の掘削機、・=空き、機=本体
  function fanMap(block, tier, job) {
    const fan = fanChunks(block, tier), busy = claims(), dimId = block.dimension.id;
    const mark = c => {
      if (job.cx === c.cx && job.cz === c.cz && job.status !== "done" && job.status !== "idle") return "掘";
      const q = (job.queue ?? []).findIndex(r => r.cx === c.cx && r.cz === c.cz);
      if (q >= 0) return String(q + 1);
      if (job.preview && job.preview.cx === c.cx && job.preview.cz === c.cz) return "計";
      const owner = busy[claimKey(dimId, c.cx, c.cz)];
      return owner && owner !== keyOf(dimId, block.location) ? "他" : "・";
    };
    const lines = [];
    for (let row = tier.rows ?? 1; row >= 1; row--) lines.push("　" + [-1, 0, 1].map(col => "［" + mark(fan.find(c => c.row === row && c.col === col)) + "］").join(""));
    lines.push("　　　［機］");
    return lines.join("\n");
  }

  // ---- 測量・開始 ----
  function planFor(dim, cx, cz, startY, tier) {
    const min = dim.heightRange?.min ?? -64;
    const depth = Math.max(1, startY - min + 1);
    return { cx, cz, startY, depth, ...estimate(tier, depth), edges: perimeter(dim, cx, cz, startY) };
  }
  function applyPlan(job, dim, plan) {
    Object.assign(job, {
      status: "running", reason: "掘削中", dim: dim.id, chunk: claimKey(dim.id, plan.cx, plan.cz), cx: plan.cx, cz: plan.cz,
      startY: plan.startY, frameY: plan.startY + FRAME_LIFT, y: plan.startY, layer: 0, i: 0, minY: dim.heightRange?.min ?? -64,
      ended: "0".repeat(256), carry: 0, costCarry: 0, edges: job.isSub ? undefined : (plan.edges ?? perimeter(dim, plan.cx, plan.cz, plan.startY)), preview: undefined,
      legs: legLengths(dim, plan.cx, plan.cz, plan.startY + FRAME_LIFT),
      head: undefined, stats: { cells: 0, kept: 0, discarded: {}, deposits: 0 },
    });
  }
  function begin(key, block, plan) {
    const job = read(key);
    if (!claim(claimKey(block.dimension.id, plan.cx, plan.cz), key)) return "このチャンクは別のチャンクデストロイヤーが担当中です";
    applyPlan(job, block.dimension, plan);
    write(key, job);
  }
  // 上位機の予約: 今のチャンクが終わったら、予約した順に自動で次へ進む
  function reserve(key, block, plan) {
    const job = read(key), tier = tierOf(block.typeId);
    job.queue ??= [];
    const chunk = claimKey(block.dimension.id, plan.cx, plan.cz);
    if (chunk === job.chunk || job.queue.some(q => q.chunk === chunk)) return "このチャンクはすでに予定に入っています";
    if (job.queue.length >= (tier.queue ?? 0)) return `予約は${tier.queue ?? 0}件までです`;
    if (!claim(chunk, key)) return "このチャンクは別のチャンクデストロイヤーが担当中です";
    job.queue.push({ chunk, cx: plan.cx, cz: plan.cz, startY: plan.startY });   // 線の高さは移動時に測り直す (保存容量の節約)
    job.preview = undefined;
    write(key, job);
  }
  function unreserve(key, index) {
    const job = read(key);
    const [removed] = (job.queue ?? []).splice(index, 1);
    if (removed) release(key, removed.chunk);
    write(key, job);
  }

  // ---- 1セルの処理 ----
  function canStore(job, tier, drops) {
    const add = drops.reduce((sum, [, n]) => sum + n, 0);
    return bufferTotal(job) + add <= tier.buffer;
  }
  function keepDrops(job, drops) {
    for (const [item, n] of drops) job.buffer[item] = (job.buffer[item] ?? 0) + n;
    job.stats.kept += drops.reduce((sum, [, n]) => sum + n, 0);
  }
  // 戻り値: undefined = 進める / 文字列 = その理由で停止 (セルは未処理のまま)
  function processCell(dim, job, tier, pos, column) {
    let block;
    try { block = dim.getBlock(pos); } catch { return "未読込"; }
    if (!block) return "未読込";
    const info = classify(block.typeId);
    switch (info.kind) {
      case "air": case "protected": return;
      case "bedrock":
        if (pos.y < bedrockFloor(job)) job.ended = job.ended.slice(0, column) + "1" + job.ended.slice(column + 1);
        return;
      case "liquid": case "clear":
        block.setType("minecraft:air"); return;
      case "terrain": {
        const discard = job.filter[info.category] !== false;
        if (!discard && !canStore(job, tier, info.drops)) return "搬出待ち";
        block.setType("minecraft:air");
        if (discard) job.stats.discarded[info.category] = (job.stats.discarded[info.category] ?? 0) + info.drops.reduce((s, [, n]) => s + n, 0);
        else keepDrops(job, info.drops);
        return;
      }
      case "ore":
        if (!canStore(job, tier, info.drops)) return "搬出待ち";
        block.setType("minecraft:air"); keepDrops(job, info.drops); return;
      case "deposit": {
        const deposit = expansion.depositAt?.(block);
        if (!deposit) { console.warn(`[Orbital Foundry] 鉱床を特定できないため保護: ${block.typeId} @ ${pos.x},${pos.y},${pos.z}`); return; }
        // 鉱床の中心だけが報酬を持つ。縁・露頭は中心と同じ鉱床の一部なので報酬なし (二重回収防止)
        const reward = deposit.center ? Math.min(depositCap(deposit.kind), deposit.remaining) : 0;
        const drops = reward > 0 ? [[deposit.item, reward]] : [];
        if (reward > 0 && !canStore(job, tier, drops)) return "搬出待ち";
        if (deposit.center) dpSet(deposit.key, 0);
        block.setType("minecraft:air");
        if (reward > 0) { keepDrops(job, drops); job.stats.deposits++; }
        return;
      }
    }
  }
  function currentCell(job) {
    const { minX, minZ } = chunkBounds(job.cx, job.cz);
    const { dx, dz, column } = cellOffset(job.layer, job.i);
    return { pos: { x: minX + dx, y: job.y, z: minZ + dz }, column };
  }
  // 岩盤: 底の5層 (オーバーワールド Y-64〜-60、ネザー Y0〜4) に当たった列だけ終わり。
  // ネザーの天井の岩盤 (Y123〜127) などは保護して下へ進む。
  const bedrockFloor = (job) => (job.minY ?? -64) + 5;
  function advance(job, min) {
    job.i++;
    if (job.i < 256) return;
    job.i = 0; job.layer++; job.y--;
    if (job.y < min || !job.ended.includes("0")) { job.status = "done"; job.reason = "完了"; }
  }
  function dig(m, job, tier) {
    const dim = world.getDimension(job.dim);
    const min = dim.heightRange?.min ?? -64;
    const power = expansion.availablePower(m.key);
    const limit = core.speedLimit(m.key);
    const baseCost = energyPerCell(tier), perTick = cellsPerSecond(tier) * TICK / 20;
    const speed = affordableSpeed(limit,power,value=>Math.ceil(perTick*baseCost*value**2)) || 1;
    const epc = baseCost * speed;
    job.carry = (job.carry ?? 0) % 1 + perTick * speed;
    let budget = Math.floor(job.carry);
    if (budget <= 0) return;
    const affordable = Math.floor((power + (job.costCarry ?? 0)) / epc);
    if (affordable <= 0) { job.reason = "電力不足"; job.actualSpeed=0; return; }
    budget = Math.min(budget, affordable);
    let processed = 0, stop;
    while (processed < budget && job.status === "running") {
      const { pos, column } = currentCell(job);
      if (job.ended[column] === "1") { advance(job, min); continue; }
      stop = processCell(dim, job, tier, pos, column);
      if (stop) break;
      processed++; job.stats.cells++;
      job.head = { x: pos.x, y: pos.y, z: pos.z };
      advance(job, min);
    }
    job.carry -= processed;
    // 実際にセルを処理したときだけ「稼働中」とし、エフェクト・回転・状態灯をこれに合わせる
    job.actualSpeed=processed>0?speed:0;
    if (processed > 0) job.activeUntil = system.currentTick + 15;
    // 電力は処理したセルにだけ按分して払う
    const owed = processed * epc - (job.costCarry ?? 0);
    const pay = Math.max(0, Math.ceil(owed));
    if (pay && !expansion.spend(m.key, pay)) { job.reason = "電力不足"; return; }
    job.costCarry = pay - owed;
    job.reason = job.status === "done" ? "完了" : stop ?? "掘削中";
    if (job.status === "done") {
      release(m.key, job.chunk); removeRig(m.key, dim, rigCenter(job));
      const next = job.queue?.shift();
      if (next) { applyPlan(job, dim, next); job.reason = "次の予約へ移動"; }
      else if (!job.isSub && !(job.subs ?? []).some(x => x.status === "running")) { const got = collectMarkers(m.key, dim, job); job.areaRun = false; job.subs = []; if (got) job.reason = `完了 · マーカー${got}個を回収`; }
    }
  }

  // ---- 搬出 ----
  function exportBuffer(m, job, tier) {
    let budget = Math.ceil(tier.push * TICK / 20);
    const dim = world.getDimension(m.dim);
    for (const [dx, dy, dz] of SIDES) {
      if (budget <= 0) break;
      const pos = { x: m.x + dx, y: m.y + dy, z: m.z + dz };
      let target;
      try { target = expansion.destinationFor(dim, keyOf(m.dim, pos), pos, dx, dz); } catch {}
      if (!target?.storage) continue;
      for (const item of Object.keys(job.buffer)) {
        if (budget <= 0) break;
        const have = job.buffer[item];
        if (!have) { delete job.buffer[item]; continue; }
        const stack = new ItemStack(item, Math.min(have, budget, new ItemStack(item).maxAmount));
        if (!expansion.roomFor(target, stack)) continue;
        const rest = expansion.insertCargo(target, stack);
        const moved = stack.amount - (rest?.amount ?? 0);
        if (!moved) continue;
        budget -= moved;
        job.buffer[item] = have - moved;
        if (!job.buffer[item]) delete job.buffer[item];
      }
    }
  }
  // ベルトや機械が直接取りに来るための搬出元ビュー (品目ごとに1スロット)
  function bufferView(block, key) {
    const items = Object.keys(read(key).buffer);
    const storage = {
      size: items.length,
      getItem(slot) {
        const item = items[slot], job = read(key), n = item && job.buffer[item];
        return n ? new ItemStack(item, Math.min(n, new ItemStack(item).maxAmount)) : undefined;
      },
      setItem(slot, stack) {
        const item = items[slot], job = read(key), n = item && job.buffer[item];
        if (!n || (stack && stack.typeId !== item)) return;
        const shown = Math.min(n, new ItemStack(item).maxAmount);
        const next = n - shown + (stack?.amount ?? 0);
        if (next > 0) job.buffer[item] = next; else delete job.buffer[item];
        write(key, job);
      },
    };
    return { block, storage, slots: items.map((_, i) => i), quarry: true };
  }
  function view(block, key, output) {
    if (!QUARRY_TYPES.has(block.typeId)) return undefined;
    return output ? bufferView(block, key) : null;
  }

  // ---- 本体の見た目 (回転・状態灯) ----
  const LAMP = { off: 0, run: 1, wait: 2, done: 3 };
  const isWorking = job => job.status === "running" && (job.activeUntil ?? -1) > system.currentTick;
  const blockPoses=new Map();
  function updateBlock(block, job, frame,key) {
    try {
      const perm = block.permutation;
      const working = isWorking(job);
      const lamp = job.status === "done" ? LAMP.done : job.status !== "running" ? LAMP.off :
        job.reason === "電力不足" ? LAMP.off : working ? LAMP.run : job.reason === "掘削中" ? LAMP.off : (frame % 2 ? LAMP.wait : LAMP.off);
      const advance=working && (blockPoses.get(key)??0)<=system.currentTick;
      if(advance)blockPoses.set(key,system.currentTick+2*visualStepTicks(job.actualSpeed));
      else if(!working)blockPoses.delete(key);
      const spin = (perm.getState(`${NS}:spin`)+Number(advance))%4;
      if (perm.getState(`${NS}:lamp`) !== lamp || perm.getState(`${NS}:spin`) !== spin)
        block.setPermutation(perm.withState(`${NS}:lamp`, lamp).withState(`${NS}:spin`, spin));
    } catch {}
  }

  // ---- ガントリー (枠・横梁・ドリル頭) ----
  const tagOf = key => "ofq_" + key.replace(/[^A-Za-z0-9_-]/g, "_");
  const rigs = new Map();
  function findRig(dim, key, center) {
    const tag = tagOf(key), parts = {};
    let found = [];
    try { found = dim.getEntities({ tags: [tag], location: center, maxDistance: 48 }); } catch {}
    for (const entity of found) {
      let part = Object.keys(ENTITY).find(name => ENTITY[name] === entity.typeId);
      if (entity.typeId === ENTITY.leg0) { try { part = "leg" + entity.getDynamicProperty("of:leg"); } catch { part = undefined; } }
      if (!part || parts[part]) { try { entity.remove(); } catch {} continue; }
      parts[part] = entity;
    }
    return parts;
  }
  function removeRig(key, dim, center) {
    const rig = rigs.get(key);
    for (const entity of Object.values(rig?.parts ?? {})) { try { entity.remove(); } catch {} }
    rigs.delete(key);
    if (dim && center) for (const entity of Object.values(findRig(dim, key, center))) { try { entity.remove(); } catch {} }
  }
  function rigCenter(job) { const { minX, minZ } = chunkBounds(job.cx, job.cz); return { x: minX + 8, y: job.frameY, z: minZ + 8 }; }
  function ensureRig(m, job) {
    const dim = world.getDimension(job.dim);
    const center = rigCenter(job);
    let rig = rigs.get(m.key);
    const valid = rig && Object.keys(ENTITY).every(part => { try { return rig.parts[part]?.isValid; } catch { return false; } });
    if (!valid) {
      const parts = findRig(dim, m.key, center);
      const { minX, minZ } = chunkBounds(job.cx, job.cz);
      const start = job.head ?? { x: minX, y: job.startY, z: minZ };
      const spawnAt = { frame: center, bridge: { x: center.x, y: job.frameY, z: start.z + .5 }, head: { x: start.x + .5, y: job.frameY, z: start.z + .5 } };
      legCorners(job).forEach(([x, z], i) => { spawnAt["leg" + i] = { x, y: job.frameY, z }; });
      for (const part of Object.keys(ENTITY)) {
        if (parts[part]) continue;
        try {
          if (!dim.getBlock(spawnAt[part])) return;
          parts[part] = dim.spawnEntity(ENTITY[part], spawnAt[part]);
          parts[part].addTag(tagOf(m.key));
          parts[part].setDynamicProperty("of:quarry", m.key);
          if (part.startsWith("leg")) parts[part].setDynamicProperty("of:leg", Number(part.slice(3)));
        } catch { return; }
      }
      rig = { parts, pos: { ...spawnAt.head } };
      rigs.set(m.key, rig);
    }
    return rig;
  }
  function moveRig(m, job, tier) {
    const rig = ensureRig(m, job);
    if (!rig) return;
    const { minX, minZ } = chunkBounds(job.cx, job.cz);
    const target = job.head ?? { x: minX, y: job.startY, z: minZ };
    const goal = { x: target.x + .5, z: target.z + .5 };
    // 小刻みに追従させ、瞬間移動に見えないようにする
    const step = Math.max(.35, cellsPerSecond(tier) / 20 * 1.6) * (job.actualSpeed||1);
    const dx = goal.x - rig.pos.x, dz = goal.z - rig.pos.z, dist = Math.hypot(dx, dz);
    if (dist > 0) { const k = Math.min(1, step / dist); rig.pos.x += dx * k; rig.pos.z += dz * k; }
    const working = isWorking(job);
    try {
      rig.parts.head.teleport({ x: rig.pos.x, y: job.frameY, z: rig.pos.z });
      rig.parts.bridge.teleport({ x: minX + 8, y: job.frameY, z: rig.pos.z });
      const depth = Math.max(0, Math.min(400, Math.round(job.frameY - target.y - 1)));
      if (rig.parts.head.getProperty(`${NS}:depth`) !== depth) rig.parts.head.setProperty(`${NS}:depth`, depth);
      if (rig.parts.head.getProperty(`${NS}:working`) !== working) rig.parts.head.setProperty(`${NS}:working`, working);
      const speed=job.actualSpeed||1;
      if(rig.parts.head.getProperty(`${NS}:work_speed`)!==speed)rig.parts.head.setProperty(`${NS}:work_speed`,speed);
      if (!rig.legsSet) {
        const legs = legLengths(world.getDimension(job.dim), job.cx, job.cz, job.frameY);
        legs.forEach((n, i) => rig.parts["leg" + i].setProperty(`${NS}:length`, n));
        rig.legsSet = true;
      }
      if (rig.parts.frame.getProperty(`${NS}:alert`) !== !working) rig.parts.frame.setProperty(`${NS}:alert`, !working);
    } catch { rigs.delete(m.key); }
  }

  // ---- ループ ----
  let machines = [];
  system.runInterval(() => { machines = registry().filter(m => QUARRY_TYPES.has(m.type)); }, 20);
  let frame = 0;
  system.runInterval(() => {
    frame++;
    for (const m of machines) {
      try {
        if (research && !research.allowsMachine(m.type, m)) continue;
        const block = world.getDimension(m.dim).getBlock(m);
        if (block?.typeId !== m.type) continue;   // 未読込なら何もしない
        const tier = tierOf(m.type), job = read(m.key);
        if (job.status === "running") dig(m, job, tier);
        if (job.subs?.length && job.status !== "paused") {
          for (const sub of job.subs) if (sub.status === "running") { sub.buffer = job.buffer; sub.filter = job.filter; sub.stats ??= { cells: 0, kept: 0, discarded: {}, deposits: 0 }; sub.stats.discarded ??= {}; dig(m, sub, tier); delete sub.buffer; delete sub.filter; }
          if (job.subs.every(x => x.status !== "running") && job.status === "done" && job.areaRun) {
            const got = collectMarkers(m.key, world.getDimension(m.dim), job); job.areaRun = false; job.subs = [];
            job.reason = got ? `エリア完了 · マーカー${got}個を回収` : "エリア完了";
          }
        }
        if (bufferTotal(job)) exportBuffer(m, job, tier);
        write(m.key, job);
        if (nearMachine(m)) updateBlock(block, job, frame,m.key);   // 遠くでは見た目の更新を省く
      } catch (error) { console.warn("[Orbital Foundry] quarry: " + error); }
    }
  }, TICK);
  system.runInterval(() => {
    for (const m of machines) {
      try {
        if (!nearMachine(m, 96)) continue;   // 遠くではガントリーを動かさない (近づけば現在位置へ戻る)
        const job = read(m.key);
        if (job.status === "running" && job.cx !== undefined) {
          moveRig(m, job, tierOf(m.type));
          if(isWorking(job)){
            const block=world.getDimension(m.dim).getBlock(m);
            if(block?.typeId===m.type)updateBlock(block,job,frame,m.key);
          }
        }
      } catch {}
    }
  }, 2);
  // 警告線: 測量中は0.5秒ごと、稼働中は1秒ごと
  system.runInterval(() => {
    for (const m of machines) {
      try {
        if (!nearMachine(m, 128)) continue;   // 見える人がいなければ線を描かない
        const job = read(m.key);
        const dim = world.getDimension(m.dim);
        if (job.preview && job.preview.until > system.currentTick) hazardLines(dim, { ...job.preview, startY: job.preview.startY });
        else if (job.status !== "running" && job.status !== "paused" && (system.currentTick % 20) < 10) {
          const block = dim.getBlock(m); if (block && QUARRY_TYPES.has(block.typeId)) drawArea(dim, areaChunks(block, m.key), m.y);
        }
        else if (job.status === "running" && (system.currentTick % 20) < 10) {
          hazardLines(dim, job);
          if (job.areaRun && job.area) drawArea(dim, job.area, m.y);   // 同時掘削中はエリア全体の外周も出す
          for (const reserved of job.queue ?? []) hazardLines(dim, reserved, TEAL);
          if (job.head && isWorking(job)) try { dim.spawnParticle(`${NS}:debris_stone`, { x: job.head.x + .5, y: job.head.y + 1.1, z: job.head.z + .5 }); } catch {}
        }
      } catch {}
    }
  }, 10);
  world.afterEvents.playerPlaceBlock?.subscribe(ev => {
    if (ev.block?.typeId !== MARKER) return;
    addMarker(ev.dimension.id, ev.block.location, ev.player.id, ev.player.name);
    const c = chunkOf(ev.block.location.x, ev.block.location.z);
    try { ev.player.onScreenDisplay?.setActionBar(`掘削マーカーを置きました: チャンク(${c.cx}, ${c.cz})。チャンクデストロイヤーの画面で登録すると候補になります`); } catch {}
  });
  world.afterEvents.playerPlaceBlock?.subscribe(ev => {
    if (QUARRY_TYPES.has(ev.block?.typeId)) setOwner(keyOf(ev.dimension.id, ev.block.location), ev.player);
  });
  world.afterEvents.playerBreakBlock?.subscribe(ev => {
    if (ev.brokenBlockPermutation?.type?.id !== MARKER) return;
    removeMarker(ev.dimension.id, ev.block.location);
  });
  // マーカーの上に黄黒の光の柱 (読込済みのものだけ)
  system.runInterval(() => {
    for (const m of markers()) {
      try {
        const dim = world.getDimension(m.dim), b = dim.getBlock(m);
        if (!b) continue;
        if (b.typeId !== MARKER) { removeMarker(m.dim, m); continue; }
        dim.spawnParticle(`${NS}:hazard_pillar`, { x: m.x + .5, y: m.y + 1.2, z: m.z + .5 });
        dim.spawnParticle(`${NS}:hazard_pillar`, { x: m.x + .5, y: m.y + 4.2, z: m.z + .5 });
      } catch {}
    }
  }, 20);
  // 記録と結びつかないガントリー部品は読込時に除去する
  world.afterEvents.entityLoad?.subscribe(ev => {
    try {
      const entity = ev.entity;
      if (!Object.values(ENTITY).includes(entity?.typeId)) return;
      const key = entity.getDynamicProperty("of:quarry");
      const job = key && read(key);
      if (!job || job.status !== "running") entity.remove();
    } catch {}
  });

  // ---- 撤去 ----
  function canBreak(key) {
    const job = read(key);
    if (job.status === "running") return "掘削中は回収できません。一時停止してから回収してください";
    if (bufferTotal(job)) return "バッファに資源が残っています。取り出してから回収してください";
    if (job.markerStash) return "回収したマーカーが残っています。画面から受け取ってから回収してください";
  }
  function forget(key, dim) {
    blockPoses.delete(key);
    const job = read(key);
    if (job.cx !== undefined) removeRig(key, dim, rigCenter(job));
    release(key);
    dpSet(jobKey(key), undefined);
    dpSet(ownerKey(key), undefined);
    dpSet("of:quarry_markers", JSON.stringify(markers().map(m => m.link === key ? { ...m, link: undefined } : m)));
  }

  // ---- 画面 ----
  const bar = (part, whole, width = 16) => { const n = whole ? Math.round(Math.min(1, part / whole) * width) : 0; return "[" + "|".repeat(n) + ".".repeat(width - n) + "]"; };
  const time = s => s >= 60 ? `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, "0")}秒` : `${Math.round(s)}秒`;
  function summary(m, job, tier) {
    const lines = [];
    const status = job.status === "running" ? (job.reason === "掘削中" ? "§a掘削中§r" : `§6停止中 · ${job.reason}§r`) :
      job.status === "done" ? "§a完了 · 次のチャンクを測量してください§r" : job.status === "paused" ? "§e一時停止§r" : "§7待機中 · 範囲を測量してください§r";
    lines.push("状態　" + status);
    if (job.cx !== undefined) {
      const b = chunkBounds(job.cx, job.cz);
      const total = (job.startY - (world.getDimension(job.dim ?? m.dim).heightRange?.min ?? -64) + 1) * 256;
      const done = Math.min(total, job.layer * 256 + job.i);
      lines.push(`範囲　チャンク(${job.cx}, ${job.cz})  X ${b.minX}〜${b.maxX} / Z ${b.minZ}〜${b.maxZ}`);
      lines.push(`深さ　Y ${job.status === "done" ? "岩盤" : job.y}（開始 Y ${job.startY} > 岩盤）`);
      if (job.subs?.length) lines.push(`同時掘削 ${1 + job.subs.length}チャンク · 掘削中 ${(job.status === "running" ? 1 : 0) + job.subs.filter(x => x.status === "running").length} · 1チャンクごとに電力を使う`);
      lines.push(`進捗　${bar(done, total)} ${Math.floor(done / Math.max(1, total) * 100)}%`);
      if (job.status === "running") lines.push(`残り　約${time((total - done) / cellsPerSecond(tier))}（電力・搬出が揃っている場合）`);
    }
    if (job.queue?.length) lines.push(`予約　${job.queue.map((q, i) => `${i + 1}:(${q.cx}, ${q.cz})`).join(" > ")}`);
    if (m.block) lines.push(fanMap(m.block, tier, job));
    lines.push(`バッファ　${bufferTotal(job)} / ${tier.buffer}個　${bar(bufferTotal(job), tier.buffer, 10)}`);
    lines.push(`電力　${expansion.availablePower(m.key)} SE（稼働時 ${tier.powerPerSecond} SE/秒）`);
    const trash = TERRAIN_CATEGORIES.map(c => `${c.name} ${job.stats.discarded?.[c.id] ?? 0}`).join(" / ");
    lines.push(`ゴミ箱　${trash}`);
    if (job.stats.deposits) lines.push(`鉱床回収　${job.stats.deposits}か所`);
    return lines.join("\n");
  }
  async function show(p, block, key) {
    const tier = tierOf(block.typeId);
    const m = { key, x: block.location.x, y: block.location.y, z: block.location.z, dim: block.dimension.id, type: block.typeId, block };
    const job = read(key);
    if (!ownerOf(key)) setOwner(key, p);
    const form = createForm().title(tier.name).body(summary(m, job, tier));
    const actions = [];
    if (expansion.hasPower && !expansion.hasPower(key)) form.body(summary(m, job, tier) + "\n\n電力: ケーブルで発電機につないでください");
    const add = (label, icon, act) => { if (icon) form.button(label, icon); else form.button(label); actions.push(act); };
    if (job.status === "running") add("一時停止\n§7同じ位置から再開できます", "textures/ui/of_quarry_pause", "pause");
    else if (job.status === "paused") add("§a掘削を再開§r\n§7チャンク(" + job.cx + ", " + job.cz + ")", "textures/ui/of_quarry_start", "resume");
    if (job.status !== "running" && job.status !== "paused") { const ar = areaChunks(block, key), n = areaSize(tier); add(`§a§lエリアを掘削開始§r\n§7${n}×${n}チャンク・${ar.marker ? "マーカーの位置" : "正面の奥"} (光の線の内側)`, "textures/ui/of_quarry_start", "area"); }
    if (job.status !== "running" && job.status !== "paused") add("範囲を測量\n§7隣のチャンクを選び警告線を表示", "textures/ui/of_quarry_survey", "survey");
    const queue = job.queue ?? [];
    if ((job.status === "running" || job.status === "paused") && queue.length < (tier.queue ?? 0))
      add(`次のチャンクを予約\n§7${queue.length} / ${tier.queue}件・終わると自動で移動`, "textures/ui/of_quarry_survey", "survey");
    queue.forEach((q, i) => add(`予約${i + 1}を取り消す\n§7チャンク(${q.cx}, ${q.cz}) 開始 Y ${q.startY}`, "textures/ui/of_quarry_stop", "unreserve:" + i));
    const linked = markers().filter(mk => mk.link === key).length;
    add(`掘削マーカーを登録\n登録中 ${linked}個・${markerRange(tier)}チャンク以内`, "textures/blocks/quarry_marker", "markers");
    add("廃棄フィルター\n§7石系・砂系などをゴミ箱へ", "textures/ui/of_filter_trash", "filter");
    if (job.markerStash) add(`§e回収したマーカーを受け取る§r\n§7${job.markerStash}個`, "textures/blocks/quarry_marker", "marker_take");
    add(`バッファを取り出す\n§7${bufferTotal(job)}個`, "textures/ui/of_quarry_take", "take");
    if (job.status === "paused") add("§c作業を中止§r\n§7予約を解除します", "textures/ui/of_quarry_stop", "cancel");
    add(`速度上限を切り替える（現在 ${core.speedLimit(key)}倍）`, undefined, "speed");
    add("閉じる", undefined, "close");
    const result = await form.show(p);
    if (result.canceled || !sameBlock(block, key)) return;
    const act = actions[result.selection];
    const now = read(key);
    if (act === "pause" && now.status === "running") { now.status = "paused"; now.reason = "一時停止"; write(key, now); removeRig(key, block.dimension, rigCenter(now)); }
    else if (act === "resume" && now.status === "paused") {
      if (!claim(now.chunk, key)) toast(p, "このチャンクは別のチャンクデストロイヤーが担当中です");
      else { now.status = "running"; now.reason = "掘削中"; write(key, now); }
    }
    else if (act === "area") { const err = beginArea(key, block); const back = read(key).markersBack ?? 0; toast(p, err ?? `${areaSize(tier)}×${areaSize(tier)}チャンクの同時掘削を開始しました${back ? ` · マーカー${back}個を回収しました (画面から受け取れます)` : ""}`); }
    else if (act === "marker_take") { const n = now.markerStash ?? 0; if (n) { now.markerStash = 0; write(key, now); giveItems(p, MARKER, n); toast(p, `掘削マーカー ×${n} を受け取りました`); } }
    else if (act === "survey") return survey(p, block, key);
    else if (act === "filter") return filterScreen(p, block, key);
    else if (act === "markers") return markerScreen(p, block, key);
    else if (act?.startsWith?.("unreserve:")) unreserve(key, Number(act.split(":")[1]));
    else if (act === "take") takeBuffer(p, key);
    else if (act === "speed") core.switchSpeed(key);
    else if (act === "cancel" && now.status === "paused") {
      release(key);
      Object.assign(now, { status: "idle", reason: undefined, cx: undefined, cz: undefined, edges: undefined, head: undefined, queue: [], subs: [], areaRun: false });
      write(key, now);
    }
    else return;
    return show(p, block, key);
  }
  function sameBlock(block, key) {
    try { return QUARRY_TYPES.has(block.dimension.getBlock(block.location)?.typeId) && keyOf(block.dimension.id, block.location) === key; } catch { return false; }
  }
  function takeBuffer(p, key) {
    const job = read(key);
    let moved = 0;
    for (const [item, n] of Object.entries(job.buffer)) { giveItems(p, item, n); moved += n; }
    job.buffer = {}; write(key, job);
    toast(p, moved ? `${moved}個を受け取りました` : "バッファは空です");
  }
  async function survey(p, block, key) {
    const tier = tierOf(block.typeId);
    const dim = block.dimension;
    const busy = claims(), job = read(key);
    const candidates = [...fanChunks(block, tier).map(c => ({ ...c, kind: "fan" })), ...markerChunks(block, key).map(c => ({ ...c, kind: "marker" }))]
      .filter((c, i, all) => all.findIndex(o => o.cx === c.cx && o.cz === c.cz) === i);
    const [fx, fz] = facingOf(block);
    const pick = createForm().title(tier.name + " · 測量").body(
      `本体の正面（${COMPASS[fx + "," + fz]}）側から選びます。${tier.rows ?? 1}列先まで選べます。\n登録した掘削マーカーのチャンク（${markerRange(tier)}チャンク以内）も選べます。\n選ぶと境界に黄黒の警告線を引きます。\n\n${fanMap(block, tier, job)}`);
    for (const c of candidates) {
      const owner = busy[claimKey(dim.id, c.cx, c.cz)];
      const state = owner === key ? (job.cx === c.cx && job.cz === c.cz ? "掘削中" : "予約済み") : owner ? "別の掘削機が担当中" : `X ${c.cx * 16}〜${c.cx * 16 + 15} / Z ${c.cz * 16}〜${c.cz * 16 + 15}`;
      pick.button(`${c.label}　チャンク(${c.cx}, ${c.cz})\n${state}`, c.kind === "marker" ? "textures/blocks/quarry_marker" : "textures/ui/of_quarry_survey");
    }
    pick.button("戻る");
    const chosen = await pick.show(p);
    if (chosen.canceled || !sameBlock(block, key)) return;
    const target = candidates[chosen.selection];
    if (!target) return show(p, block, key);
    const { cx, cz } = target;
    const suggested = suggestStart(dim, cx, cz, block.location.y, dim.id !== OVERWORLD);
    return confirmPlan(p, block, key, cx, cz, suggested);
  }
  async function confirmPlan(p, block, key, cx, cz, startY) {
    const tier = tierOf(block.typeId), dim = block.dimension;
    const plan = planFor(dim, cx, cz, startY, tier);
    const job = read(key);
    job.preview = { cx, cz, startY, edges: plan.edges, until: system.currentTick + 20 * 30 };
    write(key, job);
    const b = chunkBounds(cx, cz);
    const form = createForm().title(tier.name + " · 掘削計画").body([
      `§e警告線を表示中§r（30秒）。線の内側 16×16 が掘削範囲です。`,
      `範囲　X ${b.minX}〜${b.maxX} / Z ${b.minZ}〜${b.maxZ}`,
      `開始の高さ　Y ${startY}（この高さから${dim.id === "minecraft:the_end" ? "ワールドの底" : "岩盤"}まで）`,
      `見込み深度　${plan.depth}ブロック`,
      `処理時間　約${time(plan.seconds/core.speedLimit(key))}`,
      `消費電力　約${(plan.energy*core.speedLimit(key)).toLocaleString()} SE（${tier.powerPerSecond*core.speedLimit(key)**2} SE/秒）`,
      "",
      "§7開始前に確認してください: 範囲内の石・土・砂・ネザーやエンドの地形・鉱石・液体を撤去します。チェストなどの在庫ブロック、機械、岩盤は残ります。自然のものか置いたものかは区別しないため、範囲内の石や土の建物は掘られます。§r",
    ].join("\n"));
    form.button(["running", "paused"].includes(read(key).status) ? "§a§lこの範囲を予約§r" : "§a§lこの範囲で掘削開始§r", "textures/ui/of_quarry_start");
    form.button("開始の高さを変える\n§7地表より高い地形があれば上げる", "textures/ui/of_quarry_height");
    form.button("別のチャンクを選ぶ", "textures/ui/of_quarry_survey");
    form.button("やめる");
    const result = await form.show(p);
    if (result.canceled || !sameBlock(block, key)) return;
    if (result.selection === 0) {
      const busy = ["running", "paused"].includes(read(key).status);
      const error = busy ? reserve(key, block, plan) : begin(key, block, plan);
      if (error) { toast(p, error); return show(p, block, key); }
      toast(p, busy ? `チャンク(${cx}, ${cz})を予約しました` : `チャンク(${cx}, ${cz})の掘削を開始しました`);
      return show(p, block, key);
    }
    if (result.selection === 1) {
      const min = (dim.heightRange?.min ?? -64) + 1, max = Math.min((dim.heightRange?.max ?? 320) - FRAME_LIFT - 2, 300);
      const modal = new ModalFormData().title("開始の高さ");
      try { modal.slider(`掘り始める高さ (Y)\n推奨は範囲内で一番高い地面です。今の値 ${startY}`, min, max, { valueStep: 1, defaultValue: Math.max(min, Math.min(max, startY)) }); }
      catch { modal.slider(`掘り始める高さ (Y)`, min, max, 1, Math.max(min, Math.min(max, startY))); }
      const answer = await modal.show(p);
      if (answer.canceled || !sameBlock(block, key)) return confirmPlan(p, block, key, cx, cz, startY);
      return confirmPlan(p, block, key, cx, cz, Math.round(Number(answer.formValues?.[0] ?? startY)));
    }
    const cleared = read(key); cleared.preview = undefined; write(key, cleared);
    if (result.selection === 2) return survey(p, block, key);
  }
  // 自分で置いたマーカーを、自分のチャンクデストロイヤーに登録・解除する (マルチプレイで他人の土地を掘らせないため)
  async function markerScreen(p, block, key) {
    const tier = tierOf(block.typeId), owner = ownerOf(key);
    const mine = owner?.id === p.id;
    const list = markers().filter(mk => mk.owner === p.id && markerInRange(block, mk));
    const form = createForm().title("掘削マーカーの登録").body([
      `持ち主　${owner?.name ?? "未設定"}`,
      `効く距離　本体のチャンクから${markerRange(tier)}チャンク以内`,
      mine ? "自分で置いたマーカーだけを登録できます。登録したマーカーのチャンクが、測量の候補に入ります。" :
        "このチャンクデストロイヤーの持ち主ではないため、マーカーを登録できません。",
      list.length ? "" : "\n距離内に、あなたが置いたマーカーがありません。",
    ].join("\n"));
    const shown = mine ? list : [];
    for (const mk of shown) {
      const c = chunkOf(mk.x, mk.z), state = mk.link === key ? "登録中（選ぶと解除）" : mk.link ? "別の掘削機に登録中（選ぶとこちらへ）" : "未登録（選ぶと登録）";
      form.button(`目印 (${mk.x}, ${mk.y}, ${mk.z})　チャンク(${c.cx}, ${c.cz})\n${state}`, "textures/blocks/quarry_marker");
    }
    form.button("戻る");
    const result = await form.show(p);
    if (result.canceled || !sameBlock(block, key)) return;
    const mk = shown[result.selection];
    if (!mk) return show(p, block, key);
    setMarkerLink(mk.dim, mk, mk.link === key ? undefined : key);
    return markerScreen(p, block, key);
  }
  async function filterScreen(p, block, key) {
    const job = read(key);
    const form = createForm().title("廃棄フィルター").body(
      "［廃棄］の分類は掘っても回収せず、ゴミ箱へ送ります（バッファを使いません）。\n［搬出］の分類はバッファに入り、ベルトや倉庫へ送られます。\n鉱石・専用鉱床は常に搬出します。選ぶたびに切り替わります。");
    for (const c of TERRAIN_CATEGORIES) {
      const discard = job.filter[c.id] !== false;
      form.button(`${c.name}　${discard ? "［廃棄］ゴミ箱へ" : "［搬出］バッファへ"}\n§7${c.hint}`, discard ? c.icon + "_trash" : c.icon);
    }
    form.button("すべて廃棄（鉱石だけ搬出）", "textures/ui/of_filter_trash");
    form.button("戻る");
    const result = await form.show(p);
    if (result.canceled || !sameBlock(block, key)) return;
    const now = read(key);
    const category = TERRAIN_CATEGORIES[result.selection];
    if (category) { now.filter[category.id] = now.filter[category.id] === false; write(key, now); return filterScreen(p, block, key); }
    if (result.selection === TERRAIN_CATEGORIES.length) { now.filter = { ...DEFAULT_FILTER }; write(key, now); return filterScreen(p, block, key); }
    return show(p, block, key);
  }

  return { fanChunks, markerChunks, fanMap, addMarker, removeMarker, setMarkerLink, ownerOf, setOwner, markers, show, view, canBreak, forget, read, write, dig, processCell, planFor, begin, reserve, unreserve, bufferView, exportBuffer, claims, legCorners, legLengths };
}
