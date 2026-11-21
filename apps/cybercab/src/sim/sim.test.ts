import { beforeAll, describe, expect, it } from 'vitest';
import { Alias, Rng } from './rng';
import { loadWorldFromDisk } from './load-node';
import { PHASE, RIDER, STATE, Simulation, chargeMinutes } from './sim';
import { placeHubs } from './hubs';
import { legFraction, positionAlong, routeChain } from './movement';
import type { World } from './world';
import { num } from './world';

let world: World;
beforeAll(() => { world = loadWorldFromDisk(); });

const HOURS = 3600;

/** Check the rules that must hold at every moment. */
function checkInvariants(sim: Simulation) {
  const R = sim.riders;
  const cabsPerRider = new Map<number, number>();
  for (let c = 0; c < sim.nCabs; c++) {
    for (const r of [sim.rider[c], sim.nextRider[c]]) {
      if (r >= 0) cabsPerRider.set(r, (cabsPerRider.get(r) ?? 0) + 1);
    }
    if (sim.state[c] === STATE.withRider) {
      // A cab never carries more than 2 people (seats = 2).
      expect(R.people[sim.rider[c]]).toBeLessThanOrEqual(num(world.vehicle, 'seats'));
    }
  }
  // No rider is ever given two cabs.
  for (const n of cabsPerRider.values()) expect(n).toBe(1);
  // Hub bays: never more cabs in service than bays; a queue only when all bays are busy;
  // queues are in arrival order.
  const H = sim.hubHex.length;
  const inCharge = new Array(H).fill(0);
  const inClean = new Array(H).fill(0);
  for (let c = 0; c < sim.nCabs; c++) {
    if (sim.phase[c] !== PHASE.service) continue;
    if (sim.state[c] === STATE.charging) inCharge[sim.hubOf[c]]++;
    if (sim.state[c] === STATE.cleaning) inClean[sim.hubOf[c]]++;
  }
  for (let k = 0; k < H; k++) {
    expect(sim.chargeBusy[k]).toBe(inCharge[k]);
    expect(sim.cleanBusy[k]).toBe(inClean[k]);
    expect(sim.chargeBusy[k]).toBeLessThanOrEqual(sim.chargeBays[k]);
    expect(sim.cleanBusy[k]).toBeLessThanOrEqual(sim.cleanBays[k]);
    if (sim.chargeQueue[k].length) expect(sim.chargeBusy[k]).toBe(sim.chargeBays[k]);
    if (sim.cleanQueue[k].length) expect(sim.cleanBusy[k]).toBe(sim.cleanBays[k]);
    for (const q of [sim.chargeQueue[k], sim.cleanQueue[k]]) {
      for (let i = 1; i < q.length; i++) expect(sim.t0[q[i]]).toBeGreaterThanOrEqual(sim.t0[q[i - 1]]);
    }
  }
}

describe('random numbers', () => {
  it('same seed, same numbers; different seed, different numbers', () => {
    const a = new Rng(42); const b = new Rng(42); const c = new Rng(43);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
  });

  it('alias table draws in proportion to weights', () => {
    const rng = new Rng(1);
    const al = new Alias([1, 3, 0, 6]);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 100000; i++) counts[al.sample(rng)]++;
    expect(counts[2]).toBe(0);
    expect(counts[1] / counts[0]).toBeCloseTo(3, 0);
    expect(counts[3] / 100000).toBeCloseTo(0.6, 1);
  });

  it('Poisson counts have the right average', () => {
    const rng = new Rng(9);
    for (const lambda of [0.4, 5, 80]) {
      let s = 0;
      for (let i = 0; i < 20000; i++) s += rng.poisson(lambda);
      expect(s / 20000).toBeCloseTo(lambda, lambda < 10 ? 1 : 0);
    }
  });
});

describe('world', () => {
  it('fleet % maps to cab share as in share.csv', () => {
    expect(world.cabShareFor(0.1)).toBeCloseTo(0.01);
    expect(world.cabShareFor(10)).toBeCloseTo(0.6);
    expect(world.cabShareFor(100)).toBeCloseTo(1);
    expect(world.cabShareFor(0.3)).toBeGreaterThan(0.02);
  });

  it('hourly shares add up to a whole day', () => {
    for (const weekend of [false, true]) {
      let s = 0;
      for (let h = 0; h < 24; h++) s += world.hourShare(weekend, h);
      expect(s).toBeCloseTo(1, 6);
    }
  });

  it('finds 6th Street / Rainey Street hexes', () => {
    expect(world.nightlifeHexes.length).toBeGreaterThan(3);
  });
});

describe('charging and hubs', () => {
  it('20% to 80% charge takes 12 +- 1 min at 150 kW (check A5)', () => {
    const kwh = num(world.vehicle, 'battery_kwh');
    const kw = num(world.vehicle, 'charge_power');
    const m = chargeMinutes(0.2, 0.8, kwh, kw, 0);
    expect(m).toBeGreaterThanOrEqual(11);
    expect(m).toBeLessThanOrEqual(13);
    // Plus 2 min to park and leave.
    expect(chargeMinutes(0.2, 0.8, kwh, kw, 2) - m).toBeCloseTo(2);
  });

  it('places the two Austin hubs plus one per 300 cabs at distinct junctions', () => {
    const plan = placeHubs(world, 10, 24, 4);
    expect(plan.hex.length).toBe(12);
    expect(new Set(plan.hex).size).toBe(12);
    expect(plan.name.slice(0, 2)).toEqual(['Ben White hub', 'Ridgepoint hub']);
    for (const h of plan.hex.slice(2)) expect(world.hubSites).toContain(h);
  });

  it('auto hubs can be switched off', () => {
    const s = new Simulation(world, { seed: 1, fleetPct: 1, autoHubs: false });
    expect(s.summary().hubs).toBe(2);
  });
});

describe('movement', () => {
  it('route chains run from start to end through neighbours', () => {
    const a = world.peopleAlias.sample(new Rng(3));
    const b = world.peopleAlias.sample(new Rng(4));
    const chain = routeChain(world, a, b);
    expect(chain[0]).toBe(a);
    expect(chain[chain.length - 1]).toBe(b);
    expect(positionAlong(world, chain, 0)).toEqual([world.lng[a], world.lat[a]]);
    expect(positionAlong(world, chain, 1)).toEqual([world.lng[b], world.lat[b]]);
    expect(legFraction(100, 200, 150)).toBe(0.5);
  });
});

describe('simulation core (check A5 parts)', () => {
  let sim: Simulation;
  beforeAll(() => {
    sim = new Simulation(world, { seed: 1234, fleetPct: 0.5 });
    // Run to 08:00 Monday, checking the rules every 10 simulated minutes.
    for (let t = 600; t <= 8 * HOURS; t += 600) {
      sim.runUntil(t);
      checkInvariants(sim);
    }
  }, 120_000);

  it('serves riders', () => {
    const s = sim.summary();
    expect(s.cabs).toBe(5000);
    expect(s.requests).toBeGreaterThan(1000);
    expect(s.pickedUp).toBeGreaterThan(0.5 * s.requests);
  });

  it('never more than 2 people per cab; parties of 3-4 get exactly two cabs', () => {
    const R = sim.riders;
    const groups = new Map<number, number>();
    for (let r = 0; r < R.count; r++) {
      expect(R.people[r]).toBeGreaterThanOrEqual(1);
      expect(R.people[r]).toBeLessThanOrEqual(2);
      if (R.group[r] >= 0) groups.set(R.group[r], (groups.get(R.group[r]) ?? 0) + 1);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const n of groups.values()) expect(n).toBe(2);
  });

  it('battery use is 0.17 kWh per mile', () => {
    let checked = 0;
    for (let c = 0; c < sim.nCabs; c++) {
      if (sim.miles[c] === 0) continue;
      expect(sim.energyUsed[c]).toBeCloseTo(sim.miles[c] * 0.17, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('cabs charge and clean; no battery runs flat', () => {
    const s = sim.summary();
    expect(s.hubs).toBe(2 + Math.floor(5000 / 300));
    expect(s.charges).toBeGreaterThan(50);
    expect(s.cleans).toBeGreaterThan(50);
    expect(s.batteryEmptyCabs).toBe(0);
    for (let c = 0; c < sim.nCabs; c++) {
      // Quick clean every 15 rides.
      expect(sim.ridesSinceClean[c]).toBeLessThanOrEqual(15);
    }
  });

  it('nobody is picked up after giving up (12 min), lost trips are counted', () => {
    const R = sim.riders;
    let lost = 0;
    for (let r = 0; r < R.count; r++) {
      if (R.status[r] === RIDER.lost) { lost++; expect(Number.isNaN(R.pickup[r])).toBe(true); }
      if (!Number.isNaN(R.pickup[r])) expect(R.pickup[r] - R.reqTime[r]).toBeLessThanOrEqual(12 * 60 + 1);
    }
    expect(lost).toBe(sim.summary().lost);
  });

  it('cabs move: some are carrying riders or going to pickups at 08:00', () => {
    const s = sim.summary();
    expect(s.cabsByState[STATE.withRider] + s.cabsByState[STATE.toPickup]).toBeGreaterThan(100);
    expect(s.emptyMilesPct).toBeGreaterThan(5);
    expect(s.emptyMilesPct).toBeLessThan(80);
  });
});

describe('same seed gives identical results (check A5, R12)', () => {
  it('two runs with seed 7 match; seed 8 differs', () => {
    const run = (seed: number) => {
      const s = new Simulation(world, { seed, fleetPct: 0.2, startDay: 4 });
      s.runUntil(23 * HOURS + 1800); // Friday into the nightlife hours
      return [s.fingerprint(), JSON.stringify(s.summary())];
    };
    const a = run(7);
    expect(run(7)).toEqual(a);
    expect(run(8)[0]).not.toBe(a[0]);
  }, 120_000);
});
