export const SPEEDS = [1, 2, 4, 8];

export function nextSpeed(current, maximum = 8) {
  return current >= maximum || !SPEEDS.includes(current) ? 1 : current * 2;
}

export function affordableSpeed(limit, energy, cost) {
  for(let i=SPEEDS.length-1;i>=0;i--) {
    const speed=SPEEDS[i];
    if(speed<=limit && cost(speed)<=energy)return speed;
  }
  return 0;
}

export function processingCost(recipe, speed) {
  return { speed, sec: recipe.sec / speed, energy: Math.ceil(recipe.energy * speed) };
}

export const visualStepTicks = speed => Math.max(1, Math.ceil(8 / Math.max(1, speed ?? 1)));

// 遠くの機械をまとめて進めるときは SCHED.tolerance を広げ、遅れた分も前の予定から続けて数える
export const SCHED = { tolerance: 100 };
export function scheduledStart(previousDue, now, tolerance = SCHED.tolerance) {
  return previousDue > 0 && previousDue <= now && now - previousDue <= tolerance ? previousDue : now;
}

export const WATER_PUMP = { rate: 1000, energy: 10 };

export function waterPumpOutput(limit, power, room) {
  if (room <= 0 || power <= 0) return { speed: 0, amount: 0, energy: 0 };
  const cost = (speed, amount) => Math.ceil(WATER_PUMP.energy * speed * amount / WATER_PUMP.rate);
  const speed = affordableSpeed(limit, power, speed => cost(speed, Math.min(WATER_PUMP.rate * speed, room)));
  if (!speed) return { speed: 0, amount: 0, energy: 0 };
  const amount = Math.min(WATER_PUMP.rate * speed, room);
  return { speed, amount, energy: cost(speed, amount) };
}
