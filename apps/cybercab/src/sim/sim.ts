// Simulation core (spec section 8, build step 4): ride requests, dispatch every
// 5 s, and cabs moving between hexes. Cab data lives in typed arrays (no object
// per cab). Charging and cleaning come in step 5, rebalancing in step 7.
import { NO_ROAD } from '../travel';
import { Rng, sampleCdf } from './rng';
import { num, type World } from './world';
import { placeHubs } from './hubs';

/** Where a cab is in a hub visit (states charging / cleaning). */
export const PHASE = { driving: 0, queued: 1, service: 2 } as const;

/** Minutes to charge from one battery share to another (plus parking and leaving). */
export function chargeMinutes(from: number, to: number, batteryKwh: number, powerKw: number, parkLeaveMin: number): number {
  return (Math.max(0, to - from) * batteryKwh / powerKw) * 60 + parkLeaveMin;
}

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
  /** Auto-place extra hubs (spec section 4). Default: vehicle.csv auto_hubs. */
  autoHubs?: boolean;
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
  hubs: number;
  chargerQueue: number;
  cleaningQueue: number;
  charges: number;
  cleans: number;
  lowestBatteryPct: number;
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
  readonly energyUsed: Float64Array; // kWh driven
  readonly phase: Uint8Array;
  readonly hubOf: Int32Array;
  readonly chargeTo: Float32Array;   // battery share the current charge ends at
  readonly cleanMin: Float32Array;   // minutes of cleaning for the current visit
  readonly deepPending: Uint8Array;
  readonly ridesSinceClean: Int32Array;
  readonly lastClean: Float64Array;
  readonly lastWash: Float64Array;

  // Hubs
  readonly hubHex: Int32Array;
  readonly hubName: string[];
  readonly hubAuto: boolean[];
  readonly chargeBays: Int32Array;
  readonly cleanBays: Int32Array;
  readonly chargeBusy: Int32Array;
  readonly cleanBusy: Int32Array;
  readonly chargeHeading: Int32Array;
  readonly cleanHeading: Int32Array;
  readonly chargeQueue: number[][];
  readonly cleanQueue: number[][];

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
  private readonly batteryKwh: number;
  private readonly chargePowerKw: number;
  private readonly parkLeaveMin: number;
  private charges = 0;
  private cleans = 0;

  // Totals
  private requests = 0;
  private pickedUp = 0;
  private completed = 0;
  private lost = 0;
  private waits: number[] = [];
  private waitAt: number[] = [];
  private liveFrom = 0;
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
    this.batteryKwh = num(v, 'battery_kwh');
    this.chargePowerKw = num(v, 'wireless_on') ? num(v, 'wireless_power') : num(v, 'charge_power');
    this.parkLeaveMin = num(v, 'park_leave_min');
    this.battery = new Float32Array(N);
    this.miles = new Float64Array(N);
    this.emptyMiles = new Float64Array(N);
    this.rides = new Int32Array(N);
    this.energyUsed = new Float64Array(N);
    this.phase = new Uint8Array(N);
    this.hubOf = new Int32Array(N).fill(-1);
    this.chargeTo = new Float32Array(N);
    this.cleanMin = new Float32Array(N);
    this.deepPending = new Uint8Array(N);
    this.ridesSinceClean = new Int32Array(N);
    this.lastClean = new Float64Array(N);
    this.lastWash = new Float64Array(N);

    const autoOn = opts.autoHubs ?? num(v, 'auto_hubs') === 1;
    const extra = autoOn ? Math.floor(N / num(v, 'cabs_per_auto_hub')) : 0;
    const plan = placeHubs(world, extra, num(v, 'auto_hub_charge_bays'), num(v, 'auto_hub_clean_bays'));
    const H = plan.hex.length;
    this.hubHex = Int32Array.from(plan.hex);
    this.hubName = plan.name;
    this.hubAuto = plan.auto;
    this.chargeBays = Int32Array.from(plan.chargeBays);
    this.cleanBays = Int32Array.from(plan.cleanBays);
    this.chargeBusy = new Int32Array(H);
    this.cleanBusy = new Int32Array(H);
    this.chargeHeading = new Int32Array(H);
    this.cleanHeading = new Int32Array(H);
    this.chargeQueue = Array.from({ length: H }, () => []);
    this.cleanQueue = Array.from({ length: H }, () => []);
    this.idleHead = new Int32Array(world.n).fill(-1);
    this.idleNext = new Int32Array(N).fill(-1);
    this.idlePrev = new Int32Array(N).fill(-1);
    this.soonHead = new Int32Array(world.n).fill(-1);
    this.soonNext = new Int32Array(N).fill(-1);

    // Start: cabs spread across the county in proportion to people, batteries and
    // cleaning counters spread out so they don't all need a hub at once (estimates).
    const place = new Rng(opts.seed ^ 0x5eed);
    const bLo = num(v, 'start_battery_min');
    const bHi = num(v, 'start_battery');
    const qRides = num(v, 'quick_clean_rides');
    const washS = num(v, 'wash_days') * 86400;
    for (let c = 0; c < N; c++) {
      const h = world.peopleAlias.sample(place);
      this.hex[c] = h; this.dest[c] = h;
      this.state[c] = STATE.idle;
      this.battery[c] = this.batteryKwh * (bLo + (bHi - bLo) * place.next());
      this.ridesSinceClean[c] = place.int(qRides);
      this.lastClean[c] = -place.next() * 86400;
      this.lastWash[c] = -place.next() * washS;
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
    if (Math.floor(this.now / 60) !== Math.floor(from / 60)) this.checkWaitingCabs();
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
    this.energyUsed[c] += m * this.kwhPerMile;
    this.battery[c] = Math.max(0, this.battery[c] - m * this.kwhPerMile);
    this.hex[c] = from; this.dest[c] = to;
    this.t0[c] = depart; this.t1[c] = depart + secs;
    return depart + secs;
  }

  private advanceCabs() {
    const now = this.now;
    const R = this.riders;
    const arrivals: number[] = [];
    const services: number[] = [];
    for (let c = 0; c < this.nCabs; c++) {
      const st = this.state[c];
      if (st === STATE.toPickup && this.t1[c] <= now) {
        const r = this.rider[c];
        const arrive = this.t1[c];
        R.pickup[r] = arrive;
        R.status[r] = RIDER.riding;
        const wait = arrive - R.reqTime[r];
        this.waits.push(wait);
        this.waitAt.push(arrive);
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
        this.ridesSinceClean[c]++;
        if (this.rng.next() < num(this.world.vehicle, 'deep_clean_rate')) this.deepPending[c] = 1;
        const free = this.busyUntil[c];
        const h = this.dest[c];
        this.hex[c] = h;
        this.t0[c] = free; this.t1[c] = free;
        const nr = this.nextRider[c];
        this.rider[c] = -1;
        if (nr >= 0) {
          this.nextRider[c] = -1;
          this.startPickup(c, nr, h, free);
        } else {
          this.becomeFree(c, h, free);
        }
      } else if ((st === STATE.charging || st === STATE.cleaning) && this.t1[c] <= now) {
        if (this.phase[c] === PHASE.driving) arrivals.push(c);
        else if (this.phase[c] === PHASE.service) services.push(c);
      }
    }
    // Hub arrivals join queues in arrival order (spec section 4); services end in time order.
    services.sort((a, b) => this.t1[a] - this.t1[b] || a - b);
    for (const c of services) this.finishService(c);
    arrivals.sort((a, b) => this.t1[a] - this.t1[b] || a - b);
    for (const c of arrivals) {
      const kind = this.state[c] === STATE.cleaning ? 'clean' : 'charge';
      if (kind === 'charge') this.chargeHeading[this.hubOf[c]]--; else this.cleanHeading[this.hubOf[c]]--;
      this.hex[c] = this.dest[c];
      this.joinQueue(c, kind, this.t1[c]);
    }
  }

  // ---- charging and cleaning (spec sections 3-4) -------------------------

  private lowDemand(t: number): boolean {
    const w = this.world;
    const weekend = this.dayOfWeek(t) >= 5;
    return w.hourShare(weekend, this.hourOfDay(t)) < num(w.vehicle, 'low_demand_ratio') / 24;
  }

  private nearestHub(h: number): number {
    const n = this.world.n;
    const base = this.world.travel.base;
    let best = 0;
    let bestT = Infinity;
    for (let k = 0; k < this.hubHex.length; k++) {
      const b = base[h * n + this.hubHex[k]];
      if (b !== NO_ROAD && b < bestT) { bestT = b; best = k; }
    }
    return best;
  }

  /**
   * Hub to visit from hex h: shortest drive plus expected wait for a bay
   * (cabs already queued or heading there, shared over its bays).
   */
  private chooseHub(h: number, kind: 'charge' | 'clean'): number {
    const n = this.world.n;
    const base = this.world.travel.base;
    const avgServiceS = kind === 'clean' ? 12 * 60 : 14 * 60;
    let best = 0;
    let bestScore = Infinity;
    for (let k = 0; k < this.hubHex.length; k++) {
      const b = base[h * n + this.hubHex[k]];
      if (b === NO_ROAD) continue;
      const busy = kind === 'clean' ? this.cleanBusy[k] : this.chargeBusy[k];
      const waiting = kind === 'clean'
        ? this.cleanQueue[k].length + this.cleanHeading[k]
        : this.chargeQueue[k].length + this.chargeHeading[k];
      const bays = kind === 'clean' ? this.cleanBays[k] : this.chargeBays[k];
      const ahead = busy + waiting - bays + 1;
      const score = b + (ahead > 0 ? (ahead / bays) * avgServiceS : 0);
      if (score < bestScore) { bestScore = score; best = k; }
    }
    return best;
  }

  private chargerFree(k: number): boolean {
    return this.chargeBusy[k] + this.chargeQueue[k].length + this.chargeHeading[k] < this.chargeBays[k];
  }

  /** Does cab c need charging now? (spec section 3: < 20%, or < 50% when demand is low and a bay is free) */
  private needsCharge(c: number, t: number): boolean {
    const v = this.world.vehicle;
    const soc = this.battery[c] / this.batteryKwh;
    if (soc < num(v, 'charge_trigger')) return true;
    return soc < num(v, 'charge_trigger_low_demand') && this.lowDemand(t) && this.chargerFree(this.nearestHub(this.hex[c]));
  }

  /** Minutes of cleaning cab c needs now (0 = none). */
  private cleaningNeeded(c: number, t: number): number {
    const v = this.world.vehicle;
    let m = 0;
    if (this.deepPending[c]) m += num(v, 'deep_clean_min');
    else if (this.ridesSinceClean[c] >= num(v, 'quick_clean_rides') || t - this.lastClean[c] >= 86400) m += num(v, 'quick_clean_min');
    if (t - this.lastWash[c] >= num(v, 'wash_days') * 86400) m += num(v, 'wash_min');
    return m;
  }

  /** A cab has nothing to do at hex h from time t: go to a hub if needed, else wait. */
  private becomeFree(c: number, h: number, t: number) {
    this.hex[c] = h;
    const clean = this.cleaningNeeded(c, t);
    if (clean > 0 || this.needsCharge(c, t)) {
      this.sendToHub(c, h, t, clean);
      return;
    }
    const atHub = this.hubHex.includes(h);
    this.state[c] = atHub && this.lowDemand(t) ? STATE.parked : STATE.idle;
    this.phase[c] = 0;
    this.t0[c] = t; this.t1[c] = t;
    this.addIdle(c, h);
  }

  private sendToHub(c: number, from: number, t: number, cleanMin: number) {
    const k = this.chooseHub(from, cleanMin > 0 ? 'clean' : 'charge');
    this.hubOf[c] = k;
    this.cleanMin[c] = cleanMin;
    this.state[c] = cleanMin > 0 ? STATE.cleaning : STATE.charging;
    this.phase[c] = PHASE.driving;
    if (cleanMin === 0) this.chargeHeading[k]++; else this.cleanHeading[k]++;
    this.drive(c, from, this.hubHex[k], t, false);
  }

  private joinQueue(c: number, kind: 'charge' | 'clean', t: number) {
    const k = this.hubOf[c];
    this.state[c] = kind === 'clean' ? STATE.cleaning : STATE.charging;
    this.t0[c] = t; this.t1[c] = t;
    const busy = kind === 'clean' ? this.cleanBusy : this.chargeBusy;
    const bays = kind === 'clean' ? this.cleanBays : this.chargeBays;
    const queue = kind === 'clean' ? this.cleanQueue[k] : this.chargeQueue[k];
    if (busy[k] < bays[k] && queue.length === 0) this.startService(c, kind, t);
    else { this.phase[c] = PHASE.queued; queue.push(c); }
  }

  private startService(c: number, kind: 'charge' | 'clean', t: number) {
    const k = this.hubOf[c];
    const v = this.world.vehicle;
    this.phase[c] = PHASE.service;
    this.t0[c] = t;
    if (kind === 'clean') {
      this.cleanBusy[k]++;
      this.t1[c] = t + this.cleanMin[c] * 60;
    } else {
      this.chargeBusy[k]++;
      const h = this.hourOfDay(t);
      const target = h >= 1 && h < 5 ? num(v, 'charge_to_night') : num(v, 'charge_to');
      const from = this.battery[c] / this.batteryKwh;
      this.chargeTo[c] = Math.max(target, from);
      this.t1[c] = t + chargeMinutes(from, this.chargeTo[c], this.batteryKwh, this.chargePowerKw, this.parkLeaveMin) * 60;
    }
  }

  private finishService(c: number) {
    const k = this.hubOf[c];
    const t = this.t1[c];
    const kind = this.state[c] === STATE.cleaning ? 'clean' : 'charge';
    // Free the bay and start the next cab in the queue at the same moment.
    if (kind === 'clean') {
      this.cleanBusy[k]--;
      const next = this.cleanQueue[k].shift();
      if (next !== undefined) this.startService(next, 'clean', t);
      const v = this.world.vehicle;
      if (t - this.lastWash[c] >= num(v, 'wash_days') * 86400) this.lastWash[c] = t;
      this.lastClean[c] = t;
      this.ridesSinceClean[c] = 0;
      this.deepPending[c] = 0;
      this.cleanMin[c] = 0;
      this.cleans++;
      if (this.needsCharge(c, t)) { this.joinQueue(c, 'charge', t); return; }
    } else {
      this.chargeBusy[k]--;
      const next = this.chargeQueue[k].shift();
      if (next !== undefined) this.startService(next, 'charge', t);
      this.battery[c] = this.chargeTo[c] * this.batteryKwh;
      this.charges++;
    }
    this.hubOf[c] = -1;
    this.becomeFree(c, this.hubHex[k], t);
  }

  /** Every minute: waiting cabs that now need a hub go; parked cabs turn blue when demand picks up. */
  private checkWaitingCabs() {
    const t = this.now;
    const low = this.lowDemand(t);
    for (let c = 0; c < this.nCabs; c++) {
      const st = this.state[c];
      if (st !== STATE.idle && st !== STATE.parked) continue;
      const clean = this.cleaningNeeded(c, t);
      if (clean > 0 || this.needsCharge(c, t)) {
        this.removeIdle(c);
        this.sendToHub(c, this.hex[c], t, clean);
      } else if (st === STATE.parked && !low) {
        this.state[c] = STATE.idle;
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
    // Cabs that will need a hub after this drop-off (low battery, mess, 15th ride) aren't offered.
    const lowKwh = num(w.vehicle, 'charge_trigger') * this.batteryKwh;
    const cleanAfter = num(w.vehicle, 'quick_clean_rides') - 1;
    for (let c = 0; c < this.nCabs; c++) {
      if (this.state[c] === STATE.withRider && this.nextRider[c] < 0 && this.busyUntil[c] <= now + this.finishWindowS
        && this.battery[c] >= lowKwh && !this.deepPending[c] && this.ridesSinceClean[c] < cleanAfter) {
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
    let lowest = Infinity;
    const byState = new Array(7).fill(0);
    for (let c = 0; c < this.nCabs; c++) {
      miles += this.miles[c]; empty += this.emptyMiles[c]; rides += this.rides[c];
      byState[this.state[c]]++;
      if (this.battery[c] <= 0) flat++;
      lowest = Math.min(lowest, this.battery[c] / this.batteryKwh);
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
      hubs: this.hubHex.length,
      chargerQueue: this.chargeQueue.reduce((s, q) => s + q.length, 0),
      cleaningQueue: this.cleanQueue.reduce((s, q) => s + q.length, 0),
      charges: this.charges,
      cleans: this.cleans,
      lowestBatteryPct: 100 * lowest,
    };
  }

  /**
   * Numbers for the live panel (spec R8). Waits are over the last `windowS`
   * simulated seconds; lost trips and requests are for the current day; empty
   * miles and rides per cab per day since the start. Counts are for the
   * simulated cabs and riders (multiply by sampleN for the full fleet).
   */
  live(windowS = 1800) {
    const from = this.now - windowS;
    while (this.liveFrom < this.waitAt.length && this.waitAt[this.liveFrom] < from) this.liveFrom++;
    const recent = Float64Array.from(this.waits.slice(this.liveFrom)).sort();
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : NaN;
    const p90 = recent.length ? recent[Math.min(recent.length - 1, Math.floor(recent.length * 0.9))] : NaN;
    const day = this.dayOfWeek();
    let lostToday = 0;
    let requestsToday = 0;
    for (let h = 0; h < 24; h++) { lostToday += this.hourLost[day * 24 + h]; requestsToday += this.hourRequests[day * 24 + h]; }
    let miles = 0;
    let empty = 0;
    let rides = 0;
    const byState = [0, 0, 0, 0, 0, 0, 0];
    for (let c = 0; c < this.nCabs; c++) {
      miles += this.miles[c]; empty += this.emptyMiles[c]; rides += this.rides[c];
      byState[this.state[c]]++;
    }
    const days = this.now / 86400;
    return {
      now: this.now,
      day,
      avgWaitMin: avg / 60,
      worst10WaitMin: p90 / 60,
      pickupsInWindow: recent.length,
      lostToday,
      requestsToday,
      emptyMilesPct: miles > 0 ? (100 * empty) / miles : NaN,
      ridesPerCabPerDay: days >= 1 / 24 ? rides / this.nCabs / days : NaN,
      cabsByState: byState,
      chargerQueue: this.chargeQueue.reduce((s, q) => s + q.length, 0),
      cleaningQueue: this.cleanQueue.reduce((s, q) => s + q.length, 0),
      waitingRiders: this.waiting.length,
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
