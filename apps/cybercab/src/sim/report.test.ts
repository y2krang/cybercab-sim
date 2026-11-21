import { beforeAll, describe, expect, it } from 'vitest';
import { loadWorldFromDisk } from './load-node';
import { Simulation } from './sim';
import { dayReport, runSweep, samplingFor } from './report';
import type { World } from './world';

let world: World;
beforeAll(() => { world = loadWorldFromDisk(); });

describe('big fleets: 1 in N sampling (spec section 8)', () => {
  it('samples above 20,000 cabs; 100% of cars runs at 1 in 50', () => {
    expect(samplingFor(world, 2).sampleN).toBe(1);
    expect(samplingFor(world, 5)).toEqual({ fullFleet: 50000, sampleN: 3 });
    expect(samplingFor(world, 100).sampleN).toBe(50);
  });

  it('hubs are placed for the full fleet and their bays shared at 1 in N', () => {
    const full = new Simulation(world, { seed: 1, fleetPct: 5 });                 // 50,000 cabs drawn
    const sampled = new Simulation(world, { seed: 1, fleetPct: 5, sampleN: 5 });  // 10,000 drawn
    expect(sampled.hubHex.length).toBe(full.hubHex.length);
    const bays = (s: Simulation) => s.chargeBays.reduce((a, b) => a + b, 0);
    expect(bays(sampled)).toBeCloseTo(bays(full) / 5, -1);
    expect(Math.min(...sampled.chargeBays)).toBeGreaterThanOrEqual(1);
    expect(Math.min(...sampled.cleanBays)).toBeGreaterThanOrEqual(1);
  });
});

describe('end-of-day report (R10) and wait heat map (R9)', () => {
  it('reports wait by hour and by area for a day', () => {
    const sim = new Simulation(world, { seed: 21, fleetPct: 0.2, startDay: 1 });
    sim.runUntil(86400 + 900);
    const r = dayReport(sim, 0);
    expect(r.weekday).toBe(1);
    expect(r.hours.length).toBe(24);
    expect(r.hours.reduce((a, h) => a + h.requests, 0)).toBe(r.requests);
    const withData = r.hexAvgMin.filter((x) => !Number.isNaN(x)).length;
    expect(withData).toBeGreaterThan(500);
    for (let h = 0; h < world.n; h++) {
      if (!Number.isNaN(r.hexAvgWithLostMin[h])) expect(r.hexAvgWithLostMin[h]).toBeLessThanOrEqual(12.01);
    }
    const heat = sim.recentHexWaits(1800);
    expect(heat.length).toBe(world.n);
  });

  it('fleet sweep runs a day per fleet size and counts slow areas', () => {
    const rows = runSweep(world, { seed: 3, startDay: 1, cabShare: null, rebalancing: true, events: [] }, [0.1], () => {});
    expect(rows.length).toBe(1);
    expect(rows[0].cabs).toBe(1000);
    expect(rows[0].hexesWithDemand).toBeGreaterThan(500);
    expect(rows[0].hexesOver5).toBeGreaterThanOrEqual(0);
  });
});
