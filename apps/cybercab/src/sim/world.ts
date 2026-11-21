// The fixed "world" the simulation runs in: hexes, people, jobs, travel times,
// home-work flows and all the editable numbers from the CSV files.
import { parseCsv, parseHexes, parseHubs, parseParams, type Param } from '../data';
import { NO_ROAD, TravelTable, slowdownFactor } from '../travel';
import { Alias } from './rng';

export type Params = Map<string, Param>;

export interface WorldInput {
  hexesCsv: string;
  flowsCsv: string;
  base: Uint16Array;
  slow: Uint16Array;
  nextHop: Uint8Array;
  neighbours: Uint16Array;
  vehicleCsv: string;
  demandCsv: string;
  hourlyCsv: string;
  shareCsv: string;
  slowdownCsv: string;
  areaCsv: string;
  hubsCsv: string;
  hubSitesCsv: string;
}

export interface FixedHub {
  name: string;
  hex: number;
  chargeBays: number;
  cleanBays: number;
}

export function num(p: Params, key: string): number {
  const v = p.get(key);
  if (!v || !Number.isFinite(v.value)) throw new Error(`Missing number: ${key}`);
  return v.value;
}

const NIGHTLIFE_SPOTS: [number, number][] = [
  [30.2672, -97.7390], // 6th Street
  [30.2588, -97.7385], // Rainey Street
];

function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371008.8;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export class World {
  readonly n: number;
  readonly ids: string[];
  readonly lat: Float64Array;
  readonly lng: Float64Array;
  readonly people: Float64Array;
  readonly jobs: Float64Array;
  readonly hasRoad: Uint8Array;
  readonly travel: TravelTable;
  readonly nextHop: Uint8Array;
  readonly neighbours: Uint16Array;
  readonly vehicle: Params;
  readonly demand: Params;
  readonly hourly: Params;
  readonly share: Params;
  readonly slowdown: Params;
  readonly area: Params;
  readonly flowHome: Int32Array;
  readonly flowWork: Int32Array;
  readonly flowAlias: Alias;
  readonly peopleAlias: Alias;
  readonly jobsAlias: Alias;
  readonly nightlifeHexes: Int32Array;
  readonly nightlifeAlias: Alias;
  readonly circuity: number;
  readonly patienceS: number;
  /** Hubs from hubs.csv, each mapped to its hex. */
  readonly hubs: FixedHub[];
  /** Hexes with a major road junction (hub_sites.csv), for auto-placed hubs. */
  readonly hubSites: number[];

  private readonly nearbyCache = new Map<number, Int32Array>();
  private readonly gravityCache = new Map<number, Float64Array>();

  constructor(input: WorldInput) {
    const hexes = parseHexes(input.hexesCsv);
    this.n = hexes.length;
    const n = this.n;
    this.ids = hexes.map((h) => h.h3);
    this.lat = Float64Array.from(hexes, (h) => h.lat);
    this.lng = Float64Array.from(hexes, (h) => h.lng);
    this.travel = new TravelTable(n, input.base, input.slow);
    this.hasRoad = Uint8Array.from(hexes, (_, i) => (input.base[i * n + i] === NO_ROAD ? 0 : 1));
    this.people = Float64Array.from(hexes, (h, i) => (this.hasRoad[i] ? h.people : 0));
    this.jobs = Float64Array.from(hexes, (h, i) => (this.hasRoad[i] ? h.jobs : 0));
    this.nextHop = input.nextHop;
    this.neighbours = input.neighbours;
    this.vehicle = parseParams(input.vehicleCsv);
    this.demand = parseParams(input.demandCsv);
    this.hourly = parseParams(input.hourlyCsv);
    this.share = parseParams(input.shareCsv);
    this.slowdown = parseParams(input.slowdownCsv);
    this.area = parseParams(input.areaCsv);
    this.circuity = num(this.vehicle, 'road_circuity');
    this.patienceS = num(this.demand, 'patience_min') * 60;

    const pos = new Map(this.ids.map((h, i) => [h, i]));
    const flows = parseCsv(input.flowsCsv);
    const home: number[] = [];
    const work: number[] = [];
    const w: number[] = [];
    for (const f of flows) {
      const a = pos.get(f.home);
      const b = pos.get(f.work);
      if (a === undefined || b === undefined || !this.hasRoad[a] || !this.hasRoad[b]) continue;
      home.push(a); work.push(b); w.push(+f.workers);
    }
    this.flowHome = Int32Array.from(home);
    this.flowWork = Int32Array.from(work);
    this.flowAlias = new Alias(w);
    this.peopleAlias = new Alias(this.people);
    this.jobsAlias = new Alias(this.jobs);

    const radius = num(this.demand, 'nightlife_radius_m');
    const night: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.hasRoad[i]) continue;
      if (NIGHTLIFE_SPOTS.some(([la, lo]) => metresBetween(la, lo, this.lat[i], this.lng[i]) <= radius)) night.push(i);
    }
    this.hubs = parseHubs(input.hubsCsv).map((h) => ({
      name: h.name, chargeBays: h.chargeBays, cleanBays: h.cleanBays, hex: this.nearestRoadHex(h.lat, h.lng),
    }));
    this.hubSites = parseCsv(input.hubSitesCsv)
      .map((r) => pos.get(r.h3))
      .filter((i): i is number => i !== undefined && this.hasRoad[i] === 1);

    this.nightlifeHexes = Int32Array.from(night);
    this.nightlifeAlias = new Alias(night.map((i) => this.jobs[i] + this.people[i] + 1));
  }

  /** The hex with roads whose centre is closest to a point. */
  nearestRoadHex(lat: number, lng: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.hasRoad[i]) continue;
      const d = metresBetween(lat, lng, this.lat[i], this.lng[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** Road miles between hex centres (straight line x circuity; short floor inside one hex). */
  miles(a: number, b: number): number {
    if (a === b) return 0.3;
    return (metresBetween(this.lat[a], this.lng[a], this.lat[b], this.lng[b]) / 1609.344) * this.circuity;
  }

  /** Slowdown factor at simulated time t (seconds since the start of startDay). */
  factorAt(startDay: number, t: number): number {
    const day = (startDay + Math.floor(t / 86400)) % 7;
    const hour = (t % 86400) / 3600;
    return slowdownFactor(this.slowdown, day, hour);
  }

  /**
   * Hexes a cab could come from to reach hex `to` within the patience time at
   * free flow, nearest first (by time from that hex to `to`).
   */
  nearby(to: number): Int32Array {
    let list = this.nearbyCache.get(to);
    if (list) return list;
    const n = this.n;
    const limit = this.patienceS;
    const cand: number[] = [];
    for (let c = 0; c < n; c++) {
      const b = this.travel.base[c * n + to];
      if (b !== NO_ROAD && b <= limit) cand.push(c);
    }
    cand.sort((x, y) => this.travel.base[x * n + to] - this.travel.base[y * n + to] || x - y);
    list = Int32Array.from(cand);
    this.nearbyCache.set(to, list);
    return list;
  }

  /** Cumulative gravity weights from `from`: jobs at destination / (travel time)^2. */
  gravityCdf(from: number): Float64Array {
    let cdf = this.gravityCache.get(from);
    if (cdf) return cdf;
    const n = this.n;
    const floor = num(this.demand, 'gravity_min_time_s');
    cdf = new Float64Array(n);
    let acc = 0;
    for (let j = 0; j < n; j++) {
      const b = this.travel.base[from * n + j];
      if (b !== NO_ROAD && this.jobs[j] > 0) {
        const t = Math.max(b, floor);
        acc += this.jobs[j] / (t * t);
      }
      cdf[j] = acc;
    }
    this.gravityCache.set(from, cdf);
    return cdf;
  }

  /** Share of car trips by Cybercab for a fleet % (share.csv, linear between rows). */
  cabShareFor(fleetPct: number): number {
    const pts = [...this.share.entries()]
      .map(([k, v]) => [Number(k.replace('fleet_', '')), v.value] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    if (fleetPct <= pts[0][0]) return pts[0][1] * (fleetPct / pts[0][0]);
    for (let i = 1; i < pts.length; i++) {
      if (fleetPct <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        return y0 + ((y1 - y0) * (fleetPct - x0)) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  }

  private hourShares: { weekday: Float64Array; weekend: Float64Array } | null = null;

  /** Share of a day's trips in this hour (hourly.csv, normalised so each day sums to 1). */
  hourShare(weekend: boolean, hour: number): number {
    if (!this.hourShares) {
      const make = (prefix: string) => {
        const a = Float64Array.from({ length: 24 }, (_, h) => num(this.hourly, `${prefix}_${String(h).padStart(2, '0')}`));
        const total = a.reduce((s, x) => s + x, 0);
        return a.map((x) => x / total);
      };
      this.hourShares = { weekday: make('weekday'), weekend: make('weekend') };
    }
    return (weekend ? this.hourShares.weekend : this.hourShares.weekday)[Math.floor(hour) % 24];
  }
}
