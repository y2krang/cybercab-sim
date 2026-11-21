// End-of-day report (spec R10) and fleet sweep (R11).
import { Simulation, type DayStats } from './sim';
import { num, type World } from './world';
import type { SimEvent } from './events';

export interface HourRow { hour: number; avgWaitMin: number; requests: number; lost: number }

export interface DayReport {
  day: number;          // day of the run (0 = first)
  weekday: number;      // 0 = Monday
  hours: HourRow[];
  /** Per hex: average wait (min) of riders picked up; NaN = nobody asked for a cab. */
  hexAvgMin: Float32Array;
  /** Per hex: average wait (min) counting lost trips as the full 12 min. */
  hexAvgWithLostMin: Float32Array;
  requests: number;
  lost: number;
  avgWaitMin: number;
}

export function dayReport(sim: Simulation, day: number): DayReport {
  const w = sim.world;
  const weekday = (sim.startDay + day) % 7;
  const hours: HourRow[] = [];
  for (let h = 0; h < 24; h++) {
    const k = weekday * 24 + h;
    hours.push({
      hour: h,
      avgWaitMin: sim.hourWaitCount[k] ? sim.hourWaitSum[k] / sim.hourWaitCount[k] / 60 : NaN,
      requests: sim.hourRequests[k] * sim.sampleN,
      lost: sim.hourLost[k] * sim.sampleN,
    });
  }
  const s: DayStats = sim.dayStats(day * 86400);
  const n = w.n;
  const avg = new Float32Array(n).fill(NaN);
  const avgL = new Float32Array(n).fill(NaN);
  let req = 0; let lost = 0; let sum = 0; let picked = 0;
  for (let h = 0; h < n; h++) {
    req += s.requests[h]; lost += s.lost[h]; sum += s.waitSum[h]; picked += s.picked[h];
    if (s.picked[h] > 0) avg[h] = s.waitSum[h] / s.picked[h] / 60;
    if (s.picked[h] + s.lost[h] > 0) avgL[h] = (s.waitSum[h] + s.lost[h] * w.patienceS) / (s.picked[h] + s.lost[h]) / 60;
  }
  return {
    day, weekday, hours, hexAvgMin: avg, hexAvgWithLostMin: avgL,
    requests: req * sim.sampleN, lost: lost * sim.sampleN, avgWaitMin: picked ? sum / picked / 60 : NaN,
  };
}

export interface SweepRow {
  fleetPct: number;
  cabs: number;
  sampleN: number;
  avgWaitMin: number;
  lostPct: number;
  hexesWithDemand: number;
  /** Hexes whose average wait (lost trips counted as 12 min) is 5 min or more. */
  hexesOver5: number;
  seconds: number;
}

export const SWEEP_LIMIT_MIN = 5;

/** Sampling rule shared with the page: 1 in N above 20,000 cabs (spec section 8). */
export function samplingFor(world: World, fleetPct: number): { fullFleet: number; sampleN: number } {
  const fullFleet = Math.max(1, Math.round((fleetPct / 100) * num(world.area, 'registered_vehicles')));
  const limit = num(world.demand, 'sample_above_cabs');
  return { fullFleet, sampleN: fullFleet > limit ? Math.ceil(fullFleet / limit) : 1 };
}

/**
 * Fleet sweep (R11): run the first day at each fleet % without drawing. A fleet
 * passes when every hex where anyone asked for a cab averages under 5 min
 * (lost trips counted as a 12-min wait).
 */
export function runSweep(world: World, base: { seed: number; startDay: number; cabShare: number | null; rebalancing: boolean;
  events: SimEvent[] }, steps: number[], onRow: (row: SweepRow) => void): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const fleetPct of steps) {
    const t0 = performance.now();
    const { sampleN } = samplingFor(world, fleetPct);
    const sim = new Simulation(world, {
      seed: base.seed, fleetPct, startDay: base.startDay, sampleN, rebalancing: base.rebalancing,
      cabShare: base.cabShare ?? undefined,
    });
    sim.setEvents(base.events.filter((e) => e.startT < 86400));
    sim.runUntil(86400 + 15 * 60);
    const rep = dayReport(sim, 0);
    let withDemand = 0; let over = 0;
    for (let h = 0; h < world.n; h++) {
      if (Number.isNaN(rep.hexAvgWithLostMin[h])) continue;
      withDemand++;
      if (rep.hexAvgWithLostMin[h] >= SWEEP_LIMIT_MIN) over++;
    }
    const row: SweepRow = {
      fleetPct, cabs: sim.nCabs * sampleN, sampleN, avgWaitMin: rep.avgWaitMin,
      lostPct: rep.requests ? (100 * rep.lost) / rep.requests : 0,
      hexesWithDemand: withDemand, hexesOver5: over, seconds: (performance.now() - t0) / 1000,
    };
    rows.push(row);
    onRow(row);
  }
  return rows;
}
