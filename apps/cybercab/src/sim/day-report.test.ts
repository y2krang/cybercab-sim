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
  // Try-out only: CLEAN_BAYS=8 overrides cleaning bays per hub for this run.
  if (process.env.CLEAN_BAYS) {
    const bays = Number(process.env.CLEAN_BAYS);
    const p = world.vehicle.get('auto_hub_clean_bays')!;
    world.vehicle.set('auto_hub_clean_bays', { ...p, value: bays });
    for (const h of world.hubs) h.cleanBays = bays;
  }
  const t0 = performance.now();
  const sim = new Simulation(world, { seed: 2026, fleetPct, startDay: day });
  let peakQueue = 0;
  let peakAt = '';
  let peakHub = 0;
  for (let t = 300; t <= 86400; t += 300) {
    sim.runUntil(t);
    const q = sim.chargeQueue.reduce((a, x) => a + x.length, 0);
    if (q > peakQueue) { peakQueue = q; peakAt = `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String((t % 3600) / 60).padStart(2, '0')}`; }
    let atHub = 0;
    for (let c = 0; c < sim.nCabs; c++) if (sim.state[c] === 4 || sim.state[c] === 5) atHub++;
    peakHub = Math.max(peakHub, atHub);
  }
  const secs = (performance.now() - t0) / 1000;
  const s = sim.summary();
  const lines = [
    `Fleet ${fleetPct}% = ${s.cabs.toLocaleString()} cabs, cab share ${(sim.cabShare * 100).toFixed(0)}% of car trips, day ${day}`,
    `Requests ${s.requests.toLocaleString()}, picked up ${s.pickedUp.toLocaleString()}, lost ${s.lost.toLocaleString()} (${((100 * s.lost) / s.requests).toFixed(1)}%)`,
    `Average wait ${s.avgWaitMin.toFixed(1)} min, worst 10% ${s.worst10WaitMin.toFixed(1)} min`,
    `Empty miles ${s.emptyMilesPct.toFixed(0)}% (A8 wants 30-50%), rides per cab per day ${s.ridesPerCabPerDay.toFixed(1)} (A9 wants 15-40)`,
    `Hubs ${s.hubs} (2 Austin + auto), charges ${s.charges.toLocaleString()}, cleans ${s.cleans.toLocaleString()}, flat batteries ${s.batteryEmptyCabs}, lowest battery ${s.lowestBatteryPct.toFixed(0)}%`,
    `At midnight: cabs by state [idle, to pickup, with rider, rebalance, charging, cleaning, parked] = [${s.cabsByState.join(', ')}], charger queue ${s.chargerQueue}, cleaning queue ${s.cleaningQueue}`,
    `Peak charger queue ${peakQueue} cabs at ${peakAt}; peak cabs at hubs (charging or cleaning) ${peakHub}`,
    `Ran a simulated day in ${secs.toFixed(0)} s on this PC (1200x needs under 72 s)`,
    `Cleaning queue by hub at midnight: ${sim.cleanQueue.map((q) => q.length).join(' ')}`,
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
