// Acceptance checks that need full simulated days (slow). Run with:
//   ACCEPT=1 npx vitest run src/sim/acceptance.test.ts
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { loadWorldFromDisk } from './load-node';
import { RIDER, Simulation } from './sim';
import { scheduleEvent } from './events';

const on = !!process.env.ACCEPT;
const DOWNTOWN: [number, number] = [30.2682, -97.7429];
const SUBURB_KM = 12; // "suburban" = more than 12 km from downtown (not defined in the spec)

function km(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = 6371;
  const p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lng2 - lng1) * p) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/**
 * Suburban riders, Tuesday 16:00-19:00. p90 = worst-10% wait of riders picked up
 * (the live panel's definition, R8; lost trips are counted separately).
 * p90WithLost counts lost trips as waiting the full 12 min.
 */
function suburbanWorst10(sim: Simulation) {
  const w = sim.world;
  const R = sim.riders;
  const picked: number[] = [];
  const all: number[] = [];
  let lost = 0;
  for (let r = 0; r < R.count; r++) {
    const t = R.reqTime[r];
    if (t < 16 * 3600 || t >= 19 * 3600) continue;
    const o = R.origin[r];
    if (km(DOWNTOWN[0], DOWNTOWN[1], w.lat[o], w.lng[o]) < SUBURB_KM) continue;
    if (R.status[r] === RIDER.lost) { all.push(w.patienceS); lost++; }
    else if (!Number.isNaN(R.pickup[r])) { picked.push(R.pickup[r] - t); all.push(R.pickup[r] - t); }
  }
  picked.sort((a, b) => a - b);
  all.sort((a, b) => a - b);
  return {
    p90: picked[Math.floor(picked.length * 0.9)] / 60,
    p90WithLost: all[Math.floor(all.length * 0.9)] / 60,
    avg: picked.reduce((a, b) => a + b, 0) / picked.length / 60,
    requests: all.length,
    lost,
  };
}

describe.runIf(on && process.env.CHECK === 'A7')('acceptance A7', () => {
  it('A7 event test: UT football end, 1% fleet, rebalancing on: 90% of leaving riders picked up', () => {
    const world = loadWorldFromDisk();
    const p = world.eventPresets.find((e) => e.name === 'UT football')!;
    const ev = { id: 0, name: p.name, place: p.place, lat: p.lat, lng: p.lng, hex: p.hex, people: p.people,
      ...scheduleEvent(p, 5, 0) };
    const run = (rebalancing: boolean) => {
      const sim = new Simulation(world, { seed: 2026, fleetPct: 1, startDay: 5, rebalancing });
      sim.setEvents([ev]);
      sim.runUntil(ev.endT + 2 * 3600 + 15 * 60);
      const R = sim.riders;
      let n = 0; let picked = 0; const waits: number[] = [];
      for (let r = 0; r < R.count; r++) {
        if (R.eventId[r] !== 0 || !R.eventLeave[r]) continue;
        n++;
        if (!Number.isNaN(R.pickup[r])) { picked++; waits.push(R.pickup[r] - R.reqTime[r]); }
      }
      waits.sort((a, b) => a - b);
      return { n, picked, share: picked / n, median: waits[Math.floor(waits.length / 2)] / 60,
        p90: waits[Math.floor(waits.length * 0.9)] / 60, moved: sim.summary().rebalanceMoves };
    };
    const off = run(false);
    const onR = run(true);
    const lines = [
      `A7 event test: Saturday, UT football ends 18:00, 1% fleet, leaving riders (they wait up to ${world.demand.get('event_leave_patience_min')!.value} min)`,
      `Rebalancing off: ${off.picked} of ${off.n} picked up (${(100 * off.share).toFixed(1)}%), median wait ${off.median.toFixed(1)} min, worst 10% ${off.p90.toFixed(1)} min`,
      `Rebalancing on:  ${onR.picked} of ${onR.n} picked up (${(100 * onR.share).toFixed(1)}%), median wait ${onR.median.toFixed(1)} min, worst 10% ${onR.p90.toFixed(1)} min, cabs moved ${onR.moved}`,
      'Needs: 90% picked up with rebalancing on',
    ];
    if (process.env.REPORT_FILE) writeFileSync(process.env.REPORT_FILE, lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    expect(onR.share).toBeGreaterThanOrEqual(0.9);
  }, 1_800_000);
});

describe.runIf(on && process.env.CHECK === 'A10')('acceptance A10', () => {
  it('A10: a 20,000-cab day in full and at 1-in-10 sampling give average waits within 10%', () => {
    const world = loadWorldFromDisk();
    const run = (sampleN: number) => {
      const sim = new Simulation(world, { seed: 2026, fleetPct: 2, startDay: 1, sampleN });
      sim.runUntil(86400);
      return { cabs: sim.nCabs, s: sim.summary() };
    };
    const full = run(1);
    const sampled = run(10);
    const diff = Math.abs(sampled.s.avgWaitMin - full.s.avgWaitMin) / full.s.avgWaitMin;
    const lines = [
      'A10 sampling test: Tuesday, 2% fleet = 20,000 cabs',
      `Full (${full.cabs} cabs): average wait ${full.s.avgWaitMin.toFixed(2)} min, lost ${((100 * full.s.lost) / full.s.requests).toFixed(1)}%`,
      `1 in 10 (${sampled.cabs} cabs): average wait ${sampled.s.avgWaitMin.toFixed(2)} min, lost ${((100 * sampled.s.lost) / sampled.s.requests).toFixed(1)}%`,
      `Difference: ${(100 * diff).toFixed(1)}% (needs under 10%)`,
    ];
    if (process.env.REPORT_FILE) writeFileSync(process.env.REPORT_FILE, lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    expect(diff).toBeLessThan(0.1);
  }, 3_600_000);
});

describe.runIf(on && !process.env.CHECK)('acceptance (full days)', () => {
  it('A6 drought test: rebalancing cuts suburban worst-10% wait, weekday 16:00-19:00, by at least 30%', () => {
    const world = loadWorldFromDisk();
    const fleetPct = Number(process.env.FLEET ?? 1);
    const full = (fleetPct / 100) * 1_000_000;
    const sampleN = full > 20000 ? Math.ceil(full / 20000) : 1;
    const run = (rebalancing: boolean) => {
      const cabShare = process.env.SHARE ? Number(process.env.SHARE) / 100 : undefined;
      const sim = new Simulation(world, { seed: 2026, fleetPct, startDay: 1, rebalancing, sampleN, cabShare });
      sim.runUntil(19 * 3600 + 15 * 60); // let 18:59 requests finish
      return { sub: suburbanWorst10(sim), all: sim.summary() };
    };
    const off = run(false);
    const onR = run(true);
    const cut = 1 - onR.sub.p90 / off.sub.p90;
    const lines = [
      `A6 drought test, Tuesday 16:00-19:00, ${fleetPct}% fleet (1 in ${sampleN}), cab share ${process.env.SHARE ?? 'linked'}%, suburbs = more than ${SUBURB_KM} km from downtown`,
      `Rebalancing off: suburban worst-10% wait ${off.sub.p90.toFixed(1)} min, average ${off.sub.avg.toFixed(1)} min, lost ${off.sub.lost} of ${off.sub.requests} (${((100 * off.sub.lost) / off.sub.requests).toFixed(1)}%), worst-10% counting lost as 12 min ${off.sub.p90WithLost.toFixed(1)}`,
      `Rebalancing on:  suburban worst-10% wait ${onR.sub.p90.toFixed(1)} min, average ${onR.sub.avg.toFixed(1)} min, lost ${onR.sub.lost} of ${onR.sub.requests} (${((100 * onR.sub.lost) / onR.sub.requests).toFixed(1)}%), worst-10% counting lost as 12 min ${onR.sub.p90WithLost.toFixed(1)}`,
      `Cut in worst-10% wait: ${(100 * cut).toFixed(0)}% (needs 30%); cut in lost trips ${(100 * (1 - onR.sub.lost / off.sub.lost)).toFixed(0)}%`,
      `Whole day so far, off: avg wait ${off.all.avgWaitMin.toFixed(1)} min, lost ${off.all.lost}, empty miles ${off.all.emptyMilesPct.toFixed(0)}%`,
      `Whole day so far, on:  avg wait ${onR.all.avgWaitMin.toFixed(1)} min, lost ${onR.all.lost}, empty miles ${onR.all.emptyMilesPct.toFixed(0)}%, cabs moved ${onR.all.rebalanceMoves}`,
    ];
    if (process.env.REPORT_FILE) writeFileSync(process.env.REPORT_FILE, lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    expect(cut).toBeGreaterThanOrEqual(0.3);
  }, 1_800_000);
});
