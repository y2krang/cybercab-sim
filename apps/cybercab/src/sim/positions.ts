// Dot positions for every cab at a moment in time. Cabs follow their route's
// hex chain (movement.ts); a small fixed offset per cab stops dots in the same
// hex sitting exactly on top of each other.
import { legFraction, routeChain } from './movement';
import { Rng } from './rng';
import { STATE, PHASE, type Simulation } from './sim';
import type { World } from './world';

interface Chain {
  lng: Float64Array;
  lat: Float64Array;
  cum: Float64Array; // cumulative length (degrees, longitude squashed)
}

const JITTER_LAT = 0.0012; // about 130 m
const JITTER_LNG = 0.0014;

export class PositionTracker {
  private readonly chains: (Chain | null)[];
  private readonly keyT0: Float64Array;
  private readonly keyA: Int32Array;
  private readonly keyB: Int32Array;
  private readonly jx: Float32Array;
  private readonly jy: Float32Array;
  private readonly kx: number;

  constructor(private readonly world: World, n: number, seed: number) {
    this.chains = new Array(n).fill(null);
    this.keyT0 = new Float64Array(n).fill(NaN);
    this.keyA = new Int32Array(n).fill(-1);
    this.keyB = new Int32Array(n).fill(-1);
    this.jx = new Float32Array(n);
    this.jy = new Float32Array(n);
    const rng = new Rng(seed ^ 0xd075);
    for (let i = 0; i < n; i++) {
      this.jx[i] = (rng.next() * 2 - 1) * JITTER_LNG;
      this.jy[i] = (rng.next() * 2 - 1) * JITTER_LAT;
    }
    this.kx = Math.cos((30.3 * Math.PI) / 180);
  }

  private chainFor(a: number, b: number): Chain {
    const w = this.world;
    const hexes = routeChain(w, a, b);
    const lng = Float64Array.from(hexes, (h) => w.lng[h]);
    const lat = Float64Array.from(hexes, (h) => w.lat[h]);
    const cum = new Float64Array(hexes.length);
    for (let i = 1; i < hexes.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot((lng[i] - lng[i - 1]) * this.kx, lat[i] - lat[i - 1]);
    }
    return { lng, lat, cum };
  }

  /** Is cab c driving at the moment (rather than standing in a hex)? */
  static moving(sim: Simulation, c: number): boolean {
    const st = sim.state[c];
    if (st === STATE.toPickup || st === STATE.withRider || st === STATE.rebalance) return true;
    return (st === STATE.charging || st === STATE.cleaning) && sim.phase[c] === PHASE.driving;
  }

  /** Write [lng, lat] for every cab at time `now` into out (length 2 x cabs). */
  fill(sim: Simulation, now: number, out: Float32Array) {
    const w = this.world;
    for (let c = 0; c < sim.nCabs; c++) {
      const a = sim.hex[c];
      const b = sim.dest[c];
      let x: number;
      let y: number;
      if (a !== b && PositionTracker.moving(sim, c)) {
        if (this.keyT0[c] !== sim.t0[c] || this.keyA[c] !== a || this.keyB[c] !== b) {
          this.chains[c] = this.chainFor(a, b);
          this.keyT0[c] = sim.t0[c]; this.keyA[c] = a; this.keyB[c] = b;
        }
        const ch = this.chains[c]!;
        const f = legFraction(sim.t0[c], sim.t1[c], now);
        const total = ch.cum[ch.cum.length - 1];
        const target = f * total;
        let i = 1;
        while (i < ch.cum.length - 1 && ch.cum[i] < target) i++;
        const seg = ch.cum[i] - ch.cum[i - 1];
        const g = seg > 0 ? Math.min(1, Math.max(0, (target - ch.cum[i - 1]) / seg)) : 1;
        x = ch.lng[i - 1] + (ch.lng[i] - ch.lng[i - 1]) * g;
        y = ch.lat[i - 1] + (ch.lat[i] - ch.lat[i - 1]) * g;
      } else {
        const h = PositionTracker.moving(sim, c) ? a : (sim.state[c] === STATE.withRider ? a : b);
        x = w.lng[h];
        y = w.lat[h];
        this.chains[c] = null;
        this.keyT0[c] = NaN;
      }
      out[2 * c] = x + this.jx[c];
      out[2 * c + 1] = y + this.jy[c];
    }
  }
}
