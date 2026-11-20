// A full simulated day, printed as a report. Runs only when asked:
//   REPORT=1 FLEET=1 npx vitest run src/sim/day-report.test.ts
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { loadWorldFromDisk } from './load-node';
import { Simulation } from './sim';

const on = !!process.env.REPORT;

it.runIf(on)('day report', () => {
  const world = loadWorldFromDisk();
  const fleetPct = Number(process.env.FLEET ?? 1);
  const day = Number(process.env.DAY ?? 1); // Tuesday
  const t0 = performance.now();
  const sim = new Simulation(world, { seed: 2026, fleetPct, startDay: day });
  sim.runUntil(86400);
  const secs = (performance.now() - t0) / 1000;
  const s = sim.summary();
  const lines = [
    `Fleet ${fleetPct}% = ${s.cabs.toLocaleString()} cabs, cab share ${(sim.cabShare * 100).toFixed(0)}% of car trips, day ${day}`,
    `Requests ${s.requests.toLocaleString()}, picked up ${s.pickedUp.toLocaleString()}, lost ${s.lost.toLocaleString()} (${((100 * s.lost) / s.requests).toFixed(1)}%)`,
    `Average wait ${s.avgWaitMin.toFixed(1)} min, worst 10% ${s.worst10WaitMin.toFixed(1)} min`,
    `Empty miles ${s.emptyMilesPct.toFixed(0)}% (A8 wants 30-50%), rides per cab per day ${s.ridesPerCabPerDay.toFixed(1)} (A9 wants 15-40)`,
    `Cabs with a flat battery (no charging until step 5): ${s.batteryEmptyCabs.toLocaleString()}`,
    `Ran a simulated day in ${secs.toFixed(0)} s on this PC (1200x needs under 72 s)`,
    'Hour  requests  avg wait (min)  lost',
  ];
  for (let h = 0; h < 24; h++) {
    const k = day * 24 + h;
    const avg = sim.hourWaitCount[k] ? sim.hourWaitSum[k] / sim.hourWaitCount[k] / 60 : 0;
    lines.push(`${String(h).padStart(2, '0')}    ${String(sim.hourRequests[k]).padStart(8)}  ${avg.toFixed(1).padStart(14)}  ${sim.hourLost[k]}`);
  }
  const out = process.env.REPORT_FILE;
  if (out) writeFileSync(out, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}, 900_000);
