// Dot positions for every cab at a moment in time. A cab's route is the chain of
// neighbouring hexes from step 2 (movement.ts); each hop is drawn along the real
// road between the two hexes (road_shapes.bin, prep_shapes.py), so dots stay on
// roads. Waiting cabs stand a short way along one of their hex's roads, so cabs
// in the same hex don't sit on top of each other.
import { legFraction, routeChain } from './movement';
import { Rng } from './rng';
import { STATE, PHASE, type Simulation } from './sim';
import type { World } from './world';

const NONE = 255;
const PARK_MAX_FRAC = 0.4; // waiting cabs spread over the first 40% of a road link

interface Line {
  x: Float64Array;
  y: Float64Array;
  cum: Float64Array; // cumulative length (longitude squashed to match latitude)
}

export class PositionTracker {
  private readonly lines: (Line | null)[];
  private readonly keyT0: Float64Array;
  private readonly keyA: Int32Array;
  private readonly keyB: Int32Array;
  private readonly parkSlot: Uint8Array;
  private readonly parkFrac: Float32Array;
  private readonly kx: number;
  private readonly linkCache = new Map<number, Line | null>();

  constructor(private readonly world: World, n: number, seed: number) {
    this.lines = new Array(n).fill(null);
    this.keyT0 = new Float64Array(n).fill(NaN);
    this.keyA = new Int32Array(n).fill(-1);
    this.keyB = new Int32Array(n).fill(-1);
    this.parkSlot = new Uint8Array(n);
    this.parkFrac = new Float32Array(n);
    const rng = new Rng(seed ^ 0xd075);
    for (let i = 0; i < n; i++) {
      this.parkSlot[i] = rng.int(6);
      this.parkFrac[i] = 0.05 + rng.next() * (PARK_MAX_FRAC - 0.05);
    }
    this.kx = Math.cos((30.3 * Math.PI) / 180);
  }

  private makeLine(xs: number[], ys: number[]): Line {
    const x = Float64Array.from(xs);
    const y = Float64Array.from(ys);
    const cum = new Float64Array(x.length);
    for (let i = 1; i < x.length; i++) cum[i] = cum[i - 1] + Math.hypot((x[i] - x[i - 1]) * this.kx, y[i] - y[i - 1]);
    return { x, y, cum };
  }

  /** Road shape from hex h to its neighbour in slot k (null if none stored). */
  private link(h: number, k: number): Line | null {
    const w = this.world;
    const key = h * 6 + k;
    if (this.linkCache.has(key)) return this.linkCache.get(key)!;
    let line: Line | null = null;
    if (w.linkOffset && w.linkPoints) {
      const a = w.linkOffset[key];
      const b = w.linkOffset[key + 1];
      if (b - a >= 2) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let p = a; p < b; p++) { xs.push(w.linkPoints[2 * p]); ys.push(w.linkPoints[2 * p + 1]); }
        line = this.makeLine(xs, ys);
      }
    }
    this.linkCache.set(key, line);
    return line;
  }

  /** The drawn route from hex a to hex b: road shapes hop by hop (straight where none). */
  route(a: number, b: number): Line {
    const w = this.world;
    const chain = routeChain(w, a, b);
    const xs: number[] = [w.roadLng[a]];
    const ys: number[] = [w.roadLat[a]];
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1];
      const to = chain[i];
      const k = w.nextHop[from * w.n + b];
      const slotOk = k !== NONE && w.neighbours[from * 6 + k] === to;
      const line = slotOk ? this.link(from, k) : null;
      if (line) {
        for (let p = 1; p < line.x.length; p++) { xs.push(line.x[p]); ys.push(line.y[p]); }
      } else {
        xs.push(w.roadLng[to]); ys.push(w.roadLat[to]);
      }
    }
    return this.makeLine(xs, ys);
  }

  /** Is cab c driving at the moment (rather than standing in a hex)? */
  static moving(sim: Simulation, c: number): boolean {
    const st = sim.state[c];
    if (st === STATE.toPickup || st === STATE.withRider || st === STATE.rebalance) return true;
    return (st === STATE.charging || st === STATE.cleaning) && sim.phase[c] === PHASE.driving;
  }

  private at(line: Line, frac: number, out: Float32Array, o: number) {
    const total = line.cum[line.cum.length - 1];
    const target = frac * total;
    let i = 1;
    while (i < line.cum.length - 1 && line.cum[i] < target) i++;
    const seg = line.cum[i] - line.cum[i - 1];
    const g = seg > 0 ? Math.min(1, Math.max(0, (target - line.cum[i - 1]) / seg)) : 1;
    out[o] = line.x[i - 1] + (line.x[i] - line.x[i - 1]) * g;
    out[o + 1] = line.y[i - 1] + (line.y[i] - line.y[i - 1]) * g;
  }

  /** Write [lng, lat] for every cab at time `now` into out (length 2 x cabs). */
  fill(sim: Simulation, now: number, out: Float32Array) {
    const w = this.world;
    for (let c = 0; c < sim.nCabs; c++) {
      const a = sim.hex[c];
      const b = sim.dest[c];
      const o = 2 * c;
      if (a !== b && PositionTracker.moving(sim, c)) {
        if (this.keyT0[c] !== sim.t0[c] || this.keyA[c] !== a || this.keyB[c] !== b) {
          this.lines[c] = this.route(a, b);
          this.keyT0[c] = sim.t0[c]; this.keyA[c] = a; this.keyB[c] = b;
        }
        this.at(this.lines[c]!, legFraction(sim.t0[c], sim.t1[c], now), out, o);
        continue;
      }
      this.lines[c] = null;
      this.keyT0[c] = NaN;
      // Standing: a short way along one of the hex's roads.
      const h = sim.state[c] === STATE.withRider ? a : b;
      let line: Line | null = null;
      for (let s = 0; s < 6 && !line; s++) {
        const k = (this.parkSlot[c] + s) % 6;
        if (w.neighbours[h * 6 + k] !== 65535) line = this.link(h, k);
      }
      if (line) this.at(line, this.parkFrac[c], out, o);
      else { out[o] = w.roadLng[h]; out[o + 1] = w.roadLat[h]; }
    }
  }
}
