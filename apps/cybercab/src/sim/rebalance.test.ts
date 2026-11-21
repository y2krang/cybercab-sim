import { beforeAll, describe, expect, it } from 'vitest';
import { MinCostFlow } from './mcf';
import { loadWorldFromDisk } from './load-node';
import { STATE, Simulation } from './sim';
import { num, type World } from './world';

describe('min-cost flow solver', () => {
  it('finds the cheapest way to move 3 cabs from 2 places to 2 places', () => {
    // A has 2 spare, B has 1 spare; X needs 2, Y needs 1.
    // Costs: A-X 1, A-Y 5, B-X 2, B-Y 1. Best: A->X 2 (2), B->Y 1 (1) = 3.
    const g = new MinCostFlow(6);
    const S = 0, T = 1, A = 2, B = 3, X = 4, Y = 5;
    g.addEdge(S, A, 2, 0); g.addEdge(S, B, 1, 0);
    g.addEdge(X, T, 2, 0); g.addEdge(Y, T, 1, 0);
    const ax = g.addEdge(A, X, Infinity, 1);
    const ay = g.addEdge(A, Y, Infinity, 5);
    const bx = g.addEdge(B, X, Infinity, 2);
    const by = g.addEdge(B, Y, Infinity, 1);
    expect(g.run(S, T)).toEqual({ flow: 3, cost: 3 });
    expect([g.flowOn(ax), g.flowOn(ay), g.flowOn(bx), g.flowOn(by)]).toEqual([2, 0, 0, 1]);
  });

  it('uses a re-routing (undo) path when greedy would be worse', () => {
    // Greedy would send A->X (cost 1) first, leaving B->Y impossible (no edge) and
    // A->Y unavailable. Optimal: A->Y 3 + B->X 3 = 6 with flow 2.
    const g = new MinCostFlow(6);
    const S = 0, T = 1, A = 2, B = 3, X = 4, Y = 5;
    g.addEdge(S, A, 1, 0); g.addEdge(S, B, 1, 0);
    g.addEdge(X, T, 1, 0); g.addEdge(Y, T, 1, 0);
    g.addEdge(A, X, Infinity, 1);
    g.addEdge(A, Y, Infinity, 3);
    g.addEdge(B, X, Infinity, 3);
    expect(g.run(S, T)).toEqual({ flow: 2, cost: 6 });
  });
});

describe('rebalancing in the simulation', () => {
  let world: World;
  beforeAll(() => { world = loadWorldFromDisk(); });

  it('forecast adds up to the expected requests for the next 30 min', () => {
    const sim = new Simulation(world, { seed: 3, fleetPct: 1, startDay: 1 });
    sim.runUntil(8 * 3600);
    const total = sim.forecast().reduce((a, b) => a + b, 0);
    // Tuesday 08:00-08:30 at 10% cab share: ~1.29M people x 3 trips x 10% x 7.3%/h x 0.5 h ~ 14,000
    expect(total).toBeGreaterThan(10000);
    expect(total).toBeLessThan(20000);
  });

  it('moves blue cabs (purple while moving), never more than 15 min, never below 30% battery', () => {
    const sim = new Simulation(world, { seed: 4, fleetPct: 0.5, startDay: 1 });
    const minKwh = num(world.demand, 'rebalance_min_battery') * num(world.vehicle, 'battery_kwh');
    let purpleSeen = 0;
    for (let t = 300; t <= 6 * 3600; t += 300) {
      sim.runUntil(t);
      for (let c = 0; c < sim.nCabs; c++) {
        if (sim.state[c] !== STATE.rebalance) continue;
        purpleSeen++;
        expect(sim.t1[c] - sim.t0[c]).toBeLessThanOrEqual(15 * 60 + 1e-6);
        const legKwh = world.miles(sim.hex[c], sim.dest[c]) * num(world.vehicle, 'energy_use');
        expect(sim.battery[c] + legKwh).toBeGreaterThanOrEqual(minKwh - 1e-3);
      }
    }
    expect(purpleSeen).toBeGreaterThan(0);
    expect(sim.summary().rebalanceMoves).toBeGreaterThan(0);
  });

  it('switched off: no cab is ever purple', () => {
    const sim = new Simulation(world, { seed: 4, fleetPct: 0.5, startDay: 1, rebalancing: false });
    sim.runUntil(3 * 3600);
    expect(sim.summary().cabsByState[STATE.rebalance]).toBe(0);
    expect(sim.summary().rebalanceMoves).toBe(0);
  });
});
