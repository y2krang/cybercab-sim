// Where a cab is at a given moment: it follows the chain of neighbouring hexes
// from step 2 (next_hop), position by time (spec section 8, "Movement").
import type { World } from './world';

const NONE = 255;

/** Hex ids from a to b along the stored route; falls back to [a, b] (straight line). */
export function routeChain(w: World, a: number, b: number): number[] {
  const chain = [a];
  let cur = a;
  for (let guard = 0; cur !== b && guard < w.n; guard++) {
    const k = w.nextHop[cur * w.n + b];
    if (k === NONE) { chain.push(b); return chain; }
    cur = w.neighbours[cur * 6 + k];
    chain.push(cur);
  }
  if (cur !== b) chain.push(b);
  return chain;
}

/** [lng, lat] a fraction 0..1 of the way along a chain (even spacing by distance). */
export function positionAlong(w: World, chain: number[], frac: number): [number, number] {
  if (chain.length === 1 || frac <= 0) return [w.lng[chain[0]], w.lat[chain[0]]];
  const last = chain[chain.length - 1];
  if (frac >= 1) return [w.lng[last], w.lat[last]];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < chain.length; i++) {
    const dx = (w.lng[chain[i]] - w.lng[chain[i - 1]]) * Math.cos((w.lat[chain[i]] * Math.PI) / 180);
    const dy = w.lat[chain[i]] - w.lat[chain[i - 1]];
    const d = Math.hypot(dx, dy);
    seg.push(d);
    total += d;
  }
  let target = frac * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const f = seg[i] > 0 ? Math.min(1, target / seg[i]) : 1;
      const a = chain[i];
      const b = chain[i + 1];
      return [w.lng[a] + (w.lng[b] - w.lng[a]) * f, w.lat[a] + (w.lat[b] - w.lat[a]) * f];
    }
    target -= seg[i];
  }
  return [w.lng[last], w.lat[last]];
}

/** Fraction of a leg done at time now (0 before departure, 1 after arrival). */
export function legFraction(t0: number, t1: number, now: number): number {
  if (now <= t0) return 0;
  if (now >= t1 || t1 <= t0) return 1;
  return (now - t0) / (t1 - t0);
}
