// Hex-to-hex drive times built in step 2 (scripts/cybercab/prep_travel.py).
// time = base + (slowdown factor - 1) x slow, in seconds.
import type { Param } from './data';

export const NO_ROAD = 65535;

export class TravelTable {
  constructor(
    readonly n: number,
    readonly base: Uint16Array,
    readonly slow: Uint16Array,
  ) {
    if (base.length !== n * n || slow.length !== n * n) throw new Error('Travel table size mismatch');
  }

  static fromBuffers(n: number, base: ArrayBuffer, slow: ArrayBuffer): TravelTable {
    return new TravelTable(n, new Uint16Array(base), new Uint16Array(slow));
  }

  /** Seconds from hex `from` to hex `to` with this slowdown factor; Infinity if no road. */
  seconds(from: number, to: number, factor: number): number {
    const i = from * this.n + to;
    const b = this.base[i];
    if (b === NO_ROAD) return Infinity;
    return b + (factor - 1) * this.slow[i];
  }
}

/**
 * Slowdown factor (slowdown.csv) for a day and time.
 * day: 0 = Monday ... 6 = Sunday; hour: 0-23.999.
 */
export function slowdownFactor(p: Map<string, Param>, day: number, hour: number): number {
  const v = (k: string) => {
    const x = p.get(k);
    if (!x) throw new Error(`slowdown.csv is missing ${k}`);
    return x.value;
  };
  if (day >= 5) return hour >= 10 && hour < 20 ? v('weekend_10_20') : v('weekend_other');
  if (hour < 6) return v('weekday_00_06');
  if (hour < 7) return v('weekday_06_07');
  if (hour < 9) return v('weekday_07_09');
  if (hour < 16) return v('weekday_09_16');
  if (hour < 19) return v('weekday_16_19');
  if (hour < 22) return v('weekday_19_22');
  return v('weekday_22_24');
}
