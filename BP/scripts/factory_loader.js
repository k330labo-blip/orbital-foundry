// 工場の常時稼働: 登録済みの機械と掘削中のチャンクを tickingarea で読み込み続ける
// プレイヤーが遠くにいても、すべての機械・ベルト・発電機・掘削機がそのまま動く
// Bedrock の制限: ワールド全体で tickingarea は10個まで、1個あたり100チャンクまで
// areas: ワールド全体の上限10枠のうち9枠を工場に使う (1枠はアストライアの着弾点用)
export const LOADER = { areas: 9, maxSpan: 10, every: 100, rotateTicks: 1200 };

// チャンク座標の集合を、10×10チャンク以内の箱にまとめる (貪欲法)
export function clusterChunks(chunks, maxSpan = LOADER.maxSpan) {
  const left = [...chunks];
  const boxes = [];
  while (left.length) {
    const seed = left.shift();
    const box = { x0: seed.cx, x1: seed.cx, z0: seed.cz, z1: seed.cz, n: 1 };
    for (let i = left.length - 1; i >= 0; i--) {
      const c = left[i];
      const x0 = Math.min(box.x0, c.cx), x1 = Math.max(box.x1, c.cx), z0 = Math.min(box.z0, c.cz), z1 = Math.max(box.z1, c.cz);
      // 1枠100チャンクまで。細長い工場も1枠に収める
      if ((x1 - x0 + 1) * (z1 - z0 + 1) <= maxSpan * maxSpan) { Object.assign(box, { x0, x1, z0, z1 }); box.n++; left.splice(i, 1); }
    }
    boxes.push(box);
  }
  return boxes.sort((a, b) => b.n - a.n);
}

// プレイヤーごとの工場の区画を公平に割り当てる。枠より区画が多いときは、60秒ごとに順番に交代して読み込む
export function planAreas(groups, slots = LOADER.areas) {
  // groups: [{owner, dim, box}] → 持ち主ごとに大きい順に並べ、1人1区画ずつ交互に並べ直す
  const byOwner = new Map();
  for (const g of groups) { if (!byOwner.has(g.owner)) byOwner.set(g.owner, []); byOwner.get(g.owner).push(g); }
  for (const list of byOwner.values()) list.sort((a, b) => b.n - a.n);
  const queues = [...byOwner.values()], order = [];
  while (queues.some(q => q.length)) for (const q of queues) if (q.length) order.push(q.shift());
  return order;
}
export function installFactoryLoader({ world, system, registry, dpGet }) {
  let lastSig = "", turn = 0, lastTurnTick = 0;
  const names = new Set();
  let info = { total: 0, loaded: 0, rotating: false, byOwner: {} };
  function refresh() {
    // 持ち主 × ディメンションごとにチャンクを集める
    const groups = new Map();
    const add = (owner, dim, cx, cz) => { const k = owner + "|" + dim; if (!groups.has(k)) groups.set(k, { owner, dim, set: new Map() }); groups.get(k).set.set(cx + "," + cz, { cx, cz }); };
    for (const m of registry()) add(m.owner ?? "共有", m.dim, Math.floor(m.x / 16), Math.floor(m.z / 16));
    // 掘削中・予約中のチャンク (持ち主はそのチャンクデストロイヤーの持ち主)
    try {
      const reg = new Map(registry().map(m => [m.key, m]));
      for (const [k, q] of Object.entries(JSON.parse(dpGet("of:quarry_claims", "{}")))) { const [dim, c] = k.split("|"); const [cx, cz] = c.split(",").map(Number); add(reg.get(q)?.owner ?? "共有", dim, cx, cz); }
    } catch { }
    const boxes = [];
    for (const g of groups.values()) for (const b of clusterChunks([...g.set.values()])) boxes.push({ owner: g.owner, dim: g.dim, ...b });
    const order = planAreas(boxes);
    let use = order;
    if (order.length > LOADER.areas) {
      if (system.currentTick - lastTurnTick >= LOADER.rotateTicks) { turn = (turn + LOADER.areas) % order.length; lastTurnTick = system.currentTick; }
      use = Array.from({ length: LOADER.areas }, (_, i) => order[(turn + i) % order.length]);
    }
    info = { total: order.length, loaded: use.length, rotating: order.length > LOADER.areas, byOwner: {} };
    for (const b of order) info.byOwner[b.owner] = (info.byOwner[b.owner] ?? 0) + 1;
    const sig = JSON.stringify(use.map(b => [b.dim, b.x0, b.x1, b.z0, b.z1]));
    if (sig === lastSig) return;
    lastSig = sig;
    for (const dim of ["overworld", "nether", "the_end"]) for (let i = 0; i < LOADER.areas; i++) {
      try { world.getDimension(dim).runCommand(`tickingarea remove of_factory_${i}`); } catch { }
    }
    names.clear();
    use.forEach((b, i) => {
      try {
        world.getDimension(b.dim).runCommand(`tickingarea add ${b.x0 * 16} 0 ${b.z0 * 16} ${b.x1 * 16 + 15} 0 ${b.z1 * 16 + 15} of_factory_${i} true`);
        names.add(`of_factory_${i}`);
      } catch { }
    });
  }
  system.runInterval(() => { try { refresh(); } catch (e) { console.warn("[Orbital Foundry] factory loader: " + e); } }, LOADER.every);
  system.runTimeout(() => { try { refresh(); } catch { } }, 40);
  return { refresh, stats: () => info };
}
