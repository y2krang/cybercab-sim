// Seeded random numbers: the same seed always gives the same run (requirement R12).

/** sfc32 generator, seeded through splitmix32. Returns numbers in [0, 1). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next(); this.b = next(); this.c = next(); this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Poisson-distributed count with mean lambda. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const l = Math.exp(-lambda);
      let k = 0;
      let p = this.next();
      while (p > l) { k++; p *= this.next(); }
      return k;
    }
    // Normal approximation for large means.
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
}

/** Walker/Vose alias table: draw index i with probability weight[i] / sum. O(1) per draw. */
export class Alias {
  readonly prob: Float64Array;
  readonly alias: Int32Array;
  readonly total: number;

  constructor(weights: ArrayLike<number>) {
    const n = weights.length;
    this.prob = new Float64Array(n);
    this.alias = new Int32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.max(0, weights[i]);
    this.total = total;
    if (n === 0 || total <= 0) throw new Error('Alias table needs a positive weight');
    const scaled = new Float64Array(n);
    const small: number[] = [];
    const large: number[] = [];
    for (let i = 0; i < n; i++) {
      scaled[i] = (Math.max(0, weights[i]) * n) / total;
      (scaled[i] < 1 ? small : large).push(i);
    }
    while (small.length && large.length) {
      const s = small.pop()!;
      const l = large.pop()!;
      this.prob[s] = scaled[s];
      this.alias[s] = l;
      scaled[l] = scaled[l] + scaled[s] - 1;
      (scaled[l] < 1 ? small : large).push(l);
    }
    for (const i of large) this.prob[i] = 1;
    for (const i of small) this.prob[i] = 1;
  }

  sample(rng: Rng): number {
    const i = rng.int(this.prob.length);
    return rng.next() < this.prob[i] ? i : this.alias[i];
  }
}

/** Index in a cumulative weight array (binary search). */
export function sampleCdf(cdf: Float64Array, rng: Rng): number {
  const x = rng.next() * cdf[cdf.length - 1];
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] > x) hi = mid; else lo = mid + 1;
  }
  return lo;
}
