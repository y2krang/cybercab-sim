// Simulation core (spec section 8, build step 4): ride requests, dispatch every
// 5 s, and cabs moving between hexes. Cab data lives in typed arrays (no object
// per cab). Charging and cleaning come in step 5, rebalancing in step 7.
import { NO_ROAD } from '../travel';
import { Rng, sampleCdf } from './rng';
import { num, type World } from './world';

/** Cab states. Colours (spec R2) are applied by the map in step 6. */
export const STATE = {
  idle: 0,        // blue: empty, charged, waiting
  toPickup: 1,    // yellow: empty, going to a pickup
  withRider: 2,   // red: carrying passengers
  rebalance: 3,   // purple: empty, moving to an area short of cabs (step 7)
  charging: 4,    // green (step 5)
  cleaning: 5,    // grey (step 5)
  parked: 6,      // dim blue: parked at a hub, not needed (step 5)
} as const;

export const RIDER = { waiting: 0, assigned: 1, riding: 2, done: 3, lost: 4 } as const;

export interface SimOptions {
  seed: number;
  /** Fleet as % of the county's registered cars (0.1 to 100). */
  fleetPct: number;
  /** Share of car trips by Cybercab. Default: linked to fleetPct via share.csv (R4). */
  cabShare?: number;
  /** 0 = Monday ... 6 = Sunday. */
  startDay?: number;
  /** 1-in-N sampling of cabs and riders (step 9). Default 1. */
  sampleN?: number;
  /** Override the number of cabs (tests). */
  cabs?: number;
}

/** Growable typed-array store for riders (one row per cab request). */
class Riders {
  count = 0;
  reqTime = new Float64Array(1024);
  origin = new Int32Array(1024);
  dest = new Int32Array(1024);
  people = new Uint8Array(1024);
  group = new Int32Array(1024);
  cab = new Int32Array(1024);
  pickup = new Float64Array(1024);
  status = new Uint8Array(1024);

  add(t: number, o: number, d: number, people: number, group: number): number {
    if (this.count === this.reqTime.length) this.grow();
    const i = this.count++;
    this.reqTime[i] = t; this.origin[i] = o; this.dest[i] = d; this.people[i] = people;
    this.group[i] = group; this.cab[i] = -1; this.pickup[i] = NaN; this.status[i] = RIDER.waiting;
    return i;
  }

  private grow() {
    const g = <T extends Float64Array | Int32Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.reqTime = g(this.reqTime); this.origin = g(this.origin); this.dest = g(this.dest);
    this.people = g(this.people); this.group = g(this.group); this.cab = g(this.cab);
    this.pickup = g(this.pickup); this.status = g(this.status);
  }
}

export interface Summary {
  simSeconds: number;
  cabs: number;
  sampleN: number;
  requests: number;
  pickedUp: number;
  completed: number;
  lost: number;
  waiting: number;
  avgWaitMin: number;
  worst10WaitMin: number;
  emptyMilesPct: number;
  ridesPerCabPerDay: number;
  cabsByState: number[];
  batteryEmptyCabs: number;
}

export class Simulation {
  readonly world: World;
  readonly nCabs: number;
  readonly sampleN: number;
  readonly startDay: number;
  readonly cabShare: number;
  now = 0;

  // Cabs
  readonly state: Uint8Array;
  readonly hex: Int32Array;      // where the current leg starts (or where the cab is)
  readonly dest: Int32Array;     // where the current leg ends
  readonly t0: Float64Array;     // leg departure time
  readonly t1: Float64Array;     // leg arrival time
  readonly busyUntil: Float64Array; // red cabs: free after drop-off
  readonly rider: Int32Array;
  readonly nextRider: Int32Array;
  readonly battery: Float32Array; // kWh
  readonly miles: Float64Array;
  readonly emptyMiles: Float64Array;
  readonly rides: Int32Array;

  readonly riders = new Riders();
  private waiting: number[] = [];
  private readonly rng: Rng;
  private nextGroup = 0;

  // Idle cabs bucketed by hex (doubly linked lists).
  private readonly idleHead: Int32Array;
  private readonly idleNext: Int32Array;
  private readonly idlePrev: Int32Array;
  // Red cabs finishing soon, rebuilt every dispatch.
  private readonly soonHead: Int32Array;
  private readonly soonNext: Int32Array;
  private readonly soonTouched: number[] = [];

  private readonly dt: number;
  private readonly pickupS: number;
  private readonly dropoffS: number;
  private readonly kwhPerMile: number;
  private readonly finishWindowS: number;

  // Totals
  private requests = 0;
  private pickedUp = 0;
  private completed = 0;
  private lost = 0;
  private waits: number[] = [];
  readonly hourWaitSum = new Float64Array(24 * 7);
  readonly hourWaitCount = new Float64Array(24 * 7);
  readonly hourLost = new Float64Array(24 * 7);
  readonly hourRequests = new Float64Array(24 * 7);

  constructor(world: World, opts: SimOptions) {
    this.world = world;
    const d = world.demand;
    const v = world.vehicle;
    this.rng = new Rng(opts.seed);
    this.startDay = opts.startDay ?? 0;
    this.sampleN = Math.max(1, Math.round(opts.sampleN ?? 1));
    this.cabShare = opts.cabShare ?? world.cabShareFor(opts.fleetPct);
    const fleet = opts.cabs ?? Math.round((opts.fleetPct / 100) * num(world.area, 'registered_vehicles'));
    this.nCabs = Math.max(1, Math.round(fleet / (opts.cabs === undefined ? this.sampleN : 1)));
    this.dt = num(d, 'dispatch_interval_s');
    this.pickupS = num(v, 'pickup_time_min') * 60;
    this.dropoffS = num(v, 'dropoff_time_min') * 60;
    this.kwhPerMile = num(v, 'energy_use');
    this.finishWindowS = num(d, 'red_finish_window_min') * 60;

    const N = this.nCabs;
    this.state = new Uint8Array(N);
    this.hex = new Int32Array(N);
    this.dest = new Int32Array(N);
    this.t0 = new Float64Array(N);
    this.t1 = new Float64Array(N);
    this.busyUntil = new Float64Array(N);
    this.rider = new Int32Array(N).fill(-1);
    this.nextRider = new Int32Array(N).fill(-1);
    this.battery = new Float32Array(N).fill(num(v, 'battery_kwh') * num(v, 'start_battery'));
    this.miles = new Float64Array(N);
    this.emptyMiles = new Float64Array(N);
    this.rides = new Int32Array(N);
    this.idleHead = new Int32Array(world.n).fill(-1);
    this.idleNext = new Int32Array(N).fill(-1);
    this.idlePrev = new Int32Array(N).fill(-1);
    this.soonHead = new Int32Array(world.n).fill(-1);
    this.soonNext = new Int32Array(N).fill(-1);

    // Start: cabs spread across the county in proportion to people (estimate).
    const place = new Rng(opts.seed ^ 0x5eed);
    for (let c = 0; c < N; c++) {
      const h = world.peopleAlias.sample(place);
      this.hex[c] = h; this.dest[c] = h;
      this.state[c] = STATE.idle;
      this.addIdle(c, h);
    }
  }

  // ---- clock -------------------------------------------------------------

  dayOfWeek(t = this.now): number { return (this.startDay + Math.floor(t / 86400)) % 7; }
  hourOfDay(t = this.now): number { return (t % 86400) / 3600; }

  // ---- idle buckets ------------------------------------------------------

  private addIdle(c: number, h: number) {
    const head = this.idleHead[h];
    this.idleNext[c] = head;
    this.idlePrev[c] = -1;
    if (head >= 0) this.idlePrev[head] = c;
    this.idleHead[h] = c;
  }

  private removeIdle(c: number) {
    const h = this.hex[c];
    const p = this.idlePrev[c];
    const nx = this.idleNext[c];
    if (p >= 0) this.idleNext[p] = nx; else this.idleHead[h] = nx;
    if (nx >= 0) this.idlePrev[nx] = p;
    this.idleNext[c] = -1; this.idlePrev[c] = -1;
  }

  // ---- main loop ---------------------------------------------------------

  /** Advance one dispatch interval (5 s). */
  step() {
    const from = this.now;
    this.now += this.dt;
    this.advanceCabs();
    this.generateDemand(from, this.now);
    this.dispatch();
  }

  runUntil(t: number) {
    while (this.now + this.dt <= t + 1e-9) this.step();
  }

  // ---- movement ----------------------------------------------------------

  private drive(c: number, from: number, to: number, depart: number, loaded: boolean): number {
    const f = this.world.factorAt(this.startDay, depart);
    const secs = this.world.travel.seconds(from, to, f);
    const m = this.world.miles(from, to);
    this.miles[c] += m;
    if (!loaded) this.emptyMiles[c] += m;
    this.battery[c] = Math.max(0, this.battery[c] - m * this.kwhPerMile);
    this.hex[c] = from; this.dest[c] = to;
    this.t0[c] = depart; this.t1[c] = depart + secs;
    return depart + secs;
  }

  private advanceCabs() {
    const now = this.now;
    const R = this.riders;
    for (let c = 0; c < this.nCabs; c++) {
      const st = this.state[c];
      if (st === STATE.toPickup && this.t1[c] <= now) {
        const r = this.rider[c];
        const arrive = this.t1[c];
        R.pickup[r] = arrive;
        R.status[r] = RIDER.riding;
        const wait = arrive - R.reqTime[r];
        this.waits.push(wait);
        const slot = this.dayOfWeek(R.reqTime[r]) * 24 + Math.floor(this.hourOfDay(R.reqTime[r]));
        this.hourWaitSum[slot] += wait; this.hourWaitCount[slot]++;
        this.pickedUp++;
        this.state[c] = STATE.withRider;
        const end = this.drive(c, R.origin[r], R.dest[r], arrive + this.pickupS, true);
        this.busyUntil[c] = end + this.dropoffS;
      } else if (st === STATE.withRider && this.busyUntil[c] <= now) {
        const r = this.rider[c];
        R.status[r] = RIDER.done;
        this.completed++;
        this.rides[c]++;
        const free = this.busyUntil[c];
        const h = this.dest[c];
        this.hex[c] = h;
        this.t0[c] = free; this.t1[c] = free;
        const nr = this.nextRider[c];
        if (nr >= 0) {
          this.nextRider[c] = -1;
          this.startPickup(c, nr, h, free);
        } else {
          this.rider[c] = -1;
          this.state[c] = STATE.idle;
          this.addIdle(c, h);
        }
      }
    }
  }

  private startPickup(c: number, r: number, from: number, depart: number) {
    this.state[c] = STATE.toPickup;
    this.rider[c] = r;
    this.riders.cab[r] = c;
    this.riders.status[r] = RIDER.assigned;
    this.drive(c, from, this.riders.origin[r], depart, false);
  }

  // ---- demand ------------------------------------------------------------

  private generateDemand(from: number, to: number) {
    const w = this.world;
    const d = w.demand;
    const day = this.dayOfWeek(from);
    const hour = this.hourOfDay(from);
    const weekend = day >= 5;
    const tripsPerPerson = num(d, weekend ? 'trips_per_person_weekend' : 'trips_per_person_weekday');
    const daily = (w.peopleAlias.total * tripsPerPerson * this.cabShare) / this.sampleN;
    const perSecond = (daily * w.hourShare(weekend, hour)) / 3600;
    const span = to - from;

    // Nightlife: Fri/Sat 22:00-24:00 and the following 00:00-02:00.
    const prevDay = (day + 6) % 7;
    const nightBefore = (day === 4 || day === 5) && hour >= 22;
    const nightAfter = (prevDay === 4 || prevDay === 5) && hour < 2;
    const nightRate = nightBefore || nightAfter ? perSecond * num(d, 'nightlife_extra') : 0;

    const k = this.rng.poisson(perSecond * span);
    const kn = this.rng.poisson(nightRate * span);
    const times: number[] = [];
    for (let i = 0; i < k + kn; i++) times.push(from + this.rng.next() * span);
    times.sort((a, b) => a - b);
    // Decide which of the requests are nightlife ones, in time order.
    let nightLeft = kn;
    for (let i = 0; i < times.length; i++) {
      const isNight = nightLeft > 0 && this.rng.next() < nightLeft / (times.length - i);
      if (isNight) nightLeft--;
      const od = isNight ? this.nightTrip(nightBefore) : this.tripFor(hour);
      if (!od) continue;
      this.addRequest(times[i], od[0], od[1]);
    }
  }

  private tripFor(hour: number): [number, number] | null {
    const w = this.world;
    const d = w.demand;
    const hw = num(d, 'purpose_home_work');
    const ho = num(d, 'purpose_home_other');
    const oo = num(d, 'purpose_other_other');
    const x = this.rng.next() * (hw + ho + oo);
    if (x < hw) {
      const i = w.flowAlias.sample(this.rng);
      return hour < 12 ? [w.flowHome[i], w.flowWork[i]] : [w.flowWork[i], w.flowHome[i]];
    }
    if (x < hw + ho) {
      const home = w.peopleAlias.sample(this.rng);
      const other = sampleCdf(w.gravityCdf(home), this.rng);
      const pFromHome = hour < 12 ? num(d, 'from_home_morning') : hour >= 15 ? num(d, 'from_home_evening') : 0.5;
      return this.rng.next() < pFromHome ? [home, other] : [other, home];
    }
    const o = w.jobsAlias.sample(this.rng);
    return [o, sampleCdf(w.gravityCdf(o), this.rng)];
  }

  private nightTrip(beforeMidnight: boolean): [number, number] {
    const w = this.world;
    const spot = w.nightlifeHexes[w.nightlifeAlias.sample(this.rng)];
    const home = w.peopleAlias.sample(this.rng);
    return beforeMidnight ? [home, spot] : [spot, home];
  }

  private addRequest(t: number, o: number, dst: number) {
    const w = this.world;
    if (w.travel.base[o * w.n + dst] === NO_ROAD) return;
    const d = w.demand;
    const p1 = num(d, 'party_1');
    const p2 = num(d, 'party_2');
    const p34 = num(d, 'party_3_4');
    const x = this.rng.next() * (p1 + p2 + p34);
    const R = this.riders;
    const slot = this.dayOfWeek(t) * 24 + Math.floor(this.hourOfDay(t));
    if (x < p1 + p2) {
      this.waiting.push(R.add(t, o, dst, x < p1 ? 1 : 2, -1));
      this.requests++;
      this.hourRequests[slot]++;
    } else {
      // 3-4 people: two cabs, each with at most 2 people.
      const four = this.rng.next() < num(d, 'party_4_of_3_4');
      const g = this.nextGroup++;
      this.waiting.push(R.add(t, o, dst, 2, g));
      this.waiting.push(R.add(t, o, dst, four ? 2 : 1, g));
      this.requests += 2;
      this.hourRequests[slot] += 2;
    }
  }

  // ---- dispatch (spec section 8) -----------------------------------------

  private dispatch() {
    const w = this.world;
    const n = w.n;
    const now = this.now;
    const R = this.riders;
    const f = w.factorAt(this.startDay, now);

    // Red cabs finishing within the window, by drop-off hex.
    for (const h of this.soonTouched) this.soonHead[h] = -1;
    this.soonTouched.length = 0;
    for (let c = 0; c < this.nCabs; c++) {
      if (this.state[c] === STATE.withRider && this.nextRider[c] < 0 && this.busyUntil[c] <= now + this.finishWindowS) {
        const h = this.dest[c];
        if (this.soonHead[h] < 0) this.soonTouched.push(h);
        this.soonNext[c] = this.soonHead[h];
        this.soonHead[h] = c;
      }
    }

    const still: number[] = [];
    const base = w.travel.base;
    for (const r of this.waiting) {
      if (R.status[r] !== RIDER.waiting) continue;
      const deadline = R.reqTime[r] + w.patienceS;
      if (now > deadline) {
        R.status[r] = RIDER.lost;
        this.lost++;
        this.hourLost[this.dayOfWeek(R.reqTime[r]) * 24 + Math.floor(this.hourOfDay(R.reqTime[r]))]++;
        continue;
      }
      const o = R.origin[r];
      let best = Infinity;
      let bestCab = -1;
      let bestSoon = false;
      const list = w.nearby(o);
      for (let k = 0; k < list.length; k++) {
        const h = list[k];
        const lb = now + base[h * n + o];
        if (lb >= best || lb > deadline) break;
        const idle = this.idleHead[h];
        if (idle >= 0) {
          const eta = now + w.travel.seconds(h, o, f);
          if (eta < best) { best = eta; bestCab = idle; bestSoon = false; }
        }
        for (let c = this.soonHead[h]; c >= 0; c = this.soonNext[c]) {
          if (this.nextRider[c] >= 0) continue;
          // It sets off after its drop-off, in that moment's traffic.
          const eta = this.busyUntil[c] + w.travel.seconds(h, o, w.factorAt(this.startDay, this.busyUntil[c]));
          if (eta < best) { best = eta; bestCab = c; bestSoon = true; }
        }
      }
      if (bestCab >= 0 && best <= deadline) {
        if (bestSoon) {
          this.nextRider[bestCab] = r;
          R.cab[r] = bestCab;
          R.status[r] = RIDER.assigned;
        } else {
          this.removeIdle(bestCab);
          this.startPickup(bestCab, r, this.hex[bestCab], now);
        }
      } else {
        still.push(r);
      }
    }
    this.waiting = still;
  }

  // ---- results -----------------------------------------------------------

  summary(): Summary {
    const sorted = Float64Array.from(this.waits).sort();
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;
    let miles = 0;
    let empty = 0;
    let rides = 0;
    let flat = 0;
    const byState = new Array(7).fill(0);
    for (let c = 0; c < this.nCabs; c++) {
      miles += this.miles[c]; empty += this.emptyMiles[c]; rides += this.rides[c];
      byState[this.state[c]]++;
      if (this.battery[c] <= 0) flat++;
    }
    const days = this.now / 86400;
    return {
      simSeconds: this.now,
      cabs: this.nCabs,
      sampleN: this.sampleN,
      requests: this.requests,
      pickedUp: this.pickedUp,
      completed: this.completed,
      lost: this.lost,
      waiting: this.waiting.length,
      avgWaitMin: avg / 60,
      worst10WaitMin: p90 / 60,
      emptyMilesPct: miles > 0 ? (100 * empty) / miles : 0,
      ridesPerCabPerDay: days > 0 ? rides / this.nCabs / days : 0,
      cabsByState: byState,
      batteryEmptyCabs: flat,
    };
  }

  /** A short fingerprint of the full state, for the same-seed test. */
  fingerprint(): string {
    let h = 2166136261;
    const mix = (x: number) => { h = Math.imul(h ^ (x | 0), 16777619) >>> 0; };
    for (let c = 0; c < this.nCabs; c++) {
      mix(this.state[c]); mix(this.hex[c]); mix(this.dest[c]); mix(Math.round(this.t1[c])); mix(this.rider[c]);
    }
    for (let r = 0; r < this.riders.count; r++) { mix(this.riders.status[r]); mix(this.riders.cab[r]); }
    return `${this.riders.count}:${h.toString(16)}`;
  }
}
