// Charging and cleaning hubs (spec section 4): the two reported Austin hubs from
// hubs.csv, plus (setting, default on) one extra hub per 300 cabs at major road
// junctions, spread by demand.
import { NO_ROAD } from '../travel';
import type { World } from './world';

export interface HubPlan {
  hex: number[];
  chargeBays: number[];
  cleanBays: number[];
  name: string[];
  auto: boolean[];
}

/**
 * Choose `extra` hub hexes among the junction sites, one at a time, each time
 * taking the site that most cuts the demand-weighted drive time to the nearest
 * hub. If there are more hubs than sites, the extra ones add bays to the
 * busiest-served existing auto hubs.
 */
export function placeHubs(world: World, extra: number, chargeBays: number, cleanBays: number): HubPlan {
  const n = world.n;
  const base = world.travel.base;
  const plan: HubPlan = { hex: [], chargeBays: [], cleanBays: [], name: [], auto: [] };
  for (const h of world.hubs) {
    plan.hex.push(h.hex); plan.chargeBays.push(h.chargeBays); plan.cleanBays.push(h.cleanBays);
    plan.name.push(h.name); plan.auto.push(false);
  }
  if (extra <= 0) return plan;

  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) weight[i] = world.people[i] + world.jobs[i];
  const t = (from: number, to: number) => {
    const b = base[from * n + to];
    return b === NO_ROAD ? 1e6 : b;
  };
  const best = new Float64Array(n).fill(1e6);
  for (const hub of plan.hex) for (let i = 0; i < n; i++) best[i] = Math.min(best[i], t(i, hub));

  const used = new Set(plan.hex);
  const sites = world.hubSites.filter((s) => !used.has(s));
  let placed = 0;
  while (placed < extra && sites.length) {
    let bestGain = 0;
    let bestK = -1;
    for (let k = 0; k < sites.length; k++) {
      const s = sites[k];
      let gain = 0;
      for (let i = 0; i < n; i++) {
        if (weight[i] === 0) continue;
        const d = best[i] - t(i, s);
        if (d > 0) gain += weight[i] * d;
      }
      if (gain > bestGain) { bestGain = gain; bestK = k; }
    }
    if (bestK < 0) break;
    const s = sites.splice(bestK, 1)[0];
    for (let i = 0; i < n; i++) best[i] = Math.min(best[i], t(i, s));
    plan.hex.push(s); plan.chargeBays.push(chargeBays); plan.cleanBays.push(cleanBays);
    plan.name.push(`Auto hub ${placed + 1}`); plan.auto.push(true);
    placed++;
  }
  // More hubs than junction sites: add their bays to existing auto hubs in turn.
  const autos = plan.auto.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; placed < extra && autos.length; k++, placed++) {
    const i = autos[k % autos.length];
    plan.chargeBays[i] += chargeBays;
    plan.cleanBays[i] += cleanBays;
  }
  return plan;
}
