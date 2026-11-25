// ワールド内経過時間 (ミリ秒)。ワールドが動いている間だけ進み、保存される。
// ロケット・軌道便など「ワールド停止中は進めない」タイマーはこの時計で計る。
const KEY = "of:game_ms";
const STEP_TICKS = 20;
const STEP_MS = 1000;

export function createGameClock({ world, system }) {
  const read = () => { try { return Number(world.getDynamicProperty(KEY) ?? 0) || 0; } catch { return null; } };
  // ワールド読み込み前は動的プロパティを読めないため、初回使用時に読む。
  let now = null;
  const current = () => { if (now === null) now = read(); return now; };
  system.runInterval(() => {
    const elapsed=current();
    if (elapsed===null) return;
    now = elapsed + STEP_MS;
    try { world.setDynamicProperty(KEY, now); } catch {}
  }, STEP_TICKS);
  return { now: ()=>current()??0 };
}

// v0.8.74以前の保存値は実時刻 (Date.now()) 基準。残り時間を保ったままゲーム内時計へ移す。
export function migrateTimer(record, field, clock) {
  if (!record || record.clock === "game" || typeof record[field] !== "number") return false;
  const remaining = Math.max(0, record[field] - Date.now());
  record[field] = clock.now() + remaining;
  record.clock = "game";
  return true;
}
