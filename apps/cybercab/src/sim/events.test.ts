import { beforeAll, describe, expect, it } from 'vitest';
import { loadWorldFromDisk } from './load-node';
import { eventRates, peoplePerRequest, scheduleEvent, type SimEvent } from './events';
import { Simulation } from './sim';
import type { World } from './world';

let world: World;
beforeAll(() => { world = loadWorldFromDisk(); });

function eventFrom(name: string, startDay: number, nowT = 0, id = 0): SimEvent {
  const p = world.eventPresets.find((e) => e.name === name)!;
  const { startT, endT } = scheduleEvent(p, startDay, nowT);
  return { id, name: p.name, place: p.place, lat: p.lat, lng: p.lng, hex: p.hex, people: p.people, startT, endT };
}

describe('event presets (spec section 7)', () => {
  it('has the six spec events with their times and places', () => {
    expect(world.eventPresets.map((e) => e.name)).toEqual(
      ['UT football', 'Austin FC', 'Concert', 'F1 race day', 'ACL Festival day', 'SXSW evening']);
    const ut = world.eventPresets[0];
    expect([ut.people, ut.day, ut.startMin, ut.endMin]).toEqual([100000, 5, 14 * 60 + 30, 18 * 60]);
    expect(world.eventPresets[2].day).toBeNull();
    for (const e of world.eventPresets) expect(world.hasRoad[e.hex]).toBe(1);
  });

  it('schedules on the right day; events past midnight end the next day', () => {
    const ut = eventFrom('UT football', 0); // run starts Monday
    expect(ut.startT).toBe(5 * 86400 + 14.5 * 3600);
    expect(ut.endT).toBe(5 * 86400 + 18 * 3600);
    const sx = eventFrom('SXSW evening', 2, 10 * 3600); // Wednesday 10:00, any day -> today
    expect(sx.startT).toBe(18 * 3600);
    expect(sx.endT).toBe(26 * 3600);
  });

  it('15% of attendees ride: arrivals over 2 h before, 60% leave in 45 min, rest in 75 min', () => {
    const e = eventFrom('UT football', 5);
    let arrive = 0; let leave = 0; let fast = 0;
    for (let t = e.startT - 4 * 3600; t < e.endT + 4 * 3600; t += 10) {
      const r = eventRates(e, world.demand, t);
      arrive += r.arrive * 10; leave += r.leave * 10;
      if (t >= e.endT && t < e.endT + 45 * 60) fast += r.leave * 10;
    }
    expect(arrive).toBeCloseTo(15000, -1);
    expect(leave).toBeCloseTo(15000, -1);
    expect(fast / leave).toBeCloseTo(0.6, 3);
  });

  it('the sim creates about the right number of event ride requests', () => {
    const sim = new Simulation(world, { seed: 11, fleetPct: 0.2, startDay: 5 });
    sim.setEvents([eventFrom('UT football', 5)]);
    sim.runUntil(20 * 3600 + 30 * 60);
    const R = sim.riders;
    let arrive = 0; let leave = 0;
    for (let r = 0; r < R.count; r++) {
      if (R.eventId[r] !== 0) continue;
      if (R.eventLeave[r]) leave++; else arrive++;
    }
    // 15,000 riders / people per request, x ~1.05 for parties of 3-4 needing two cabs.
    const expected = (15000 / peoplePerRequest(world.demand)) * 1.05;
    expect(arrive / expected).toBeGreaterThan(0.95);
    expect(arrive / expected).toBeLessThan(1.05);
    expect(leave / expected).toBeGreaterThan(0.95);
    expect(leave / expected).toBeLessThan(1.05);
  }, 120_000);

  it('the rebalancing forecast sees an event ending', () => {
    const sim = new Simulation(world, { seed: 12, fleetPct: 0.2, startDay: 5 });
    const e = eventFrom('UT football', 5);
    sim.runUntil(17 * 3600 + 40 * 60);
    const before = sim.forecast()[e.hex];
    sim.setEvents([e]);
    const after = sim.forecast()[e.hex];
    expect(after - before).toBeGreaterThan(100);
  }, 120_000);
});
