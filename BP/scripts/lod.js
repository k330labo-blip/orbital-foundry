// 軽量モード: プレイヤーの近く (同じディメンションで水平64ブロック以内) にある機械だけを毎回細かく処理し、
// 遠くの機械は処理の間隔を間引いて、その間に進んだ分をまとめて計算する (結果はほぼ同じ、負荷は数分の1)
import { world, system } from "@minecraft/server";

export const LOD = { radius: 64, farMs: 5000, farTicks: 100, catchUp: 24 };
let cacheTick = -1, cache = [];
function players() {
  if (cacheTick !== system.currentTick) {
    cacheTick = system.currentTick;
    cache = [];
    for (const p of world.getAllPlayers()) { try { cache.push({ dim: p.dimension.id, x: p.location.x, z: p.location.z }); } catch { } }
  }
  return cache;
}
const norm = d => d.startsWith("minecraft:") ? d : "minecraft:" + d;
// 機械の近くにプレイヤーがいるか
export function isNear(dim, x, z, radius = LOD.radius) {
  const d = norm(dim), r2 = radius * radius;
  for (const p of players()) if (p.dim === d && (p.x - x) ** 2 + (p.z - z) ** 2 <= r2) return true;
  return false;
}
export const nearMachine = (m, radius) => isNear(m.dim, m.x + .5, m.z + .5, radius);
