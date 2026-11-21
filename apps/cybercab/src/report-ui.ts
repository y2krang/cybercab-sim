// End-of-day report window (R10) and fleet sweep window (R11).
import type { DayReport, EventDef, FromWorker, RunSettings, SweepRow, ToWorker } from './sim/protocol';
import { waitColour } from './shading';
import { FLEET_STEPS } from './format';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Bar chart of average wait by hour, as SVG (no chart library). */
function chart(report: DayReport): string {
  const W = 480; const H = 190; const left = 26; const bottom = 20; const top = 8;
  const max = Math.max(12, ...report.hours.map((h) => (Number.isNaN(h.avgWaitMin) ? 0 : h.avgWaitMin)));
  const bw = (W - left - 4) / 24;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  let svg = '';
  for (const v of [0, 3, 6, 10, Math.round(max)]) {
    if (v > max) continue;
    svg += `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)"/>`;
    svg += `<text x="${left - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  report.hours.forEach((h) => {
    const x = left + h.hour * bw + 1;
    if (!Number.isNaN(h.avgWaitMin)) {
      const [r, g, b] = waitColour(h.avgWaitMin, true);
      const lostPct = h.requests ? (100 * h.lost) / h.requests : 0;
      svg += `<rect x="${x}" y="${y(h.avgWaitMin)}" width="${bw - 2}" height="${y(0) - y(h.avgWaitMin)}" rx="2" fill="rgb(${r},${g},${b})">`
        + `<title>${String(h.hour).padStart(2, '0')}:00 · ${h.avgWaitMin.toFixed(1)} min average · ${Math.round(h.requests).toLocaleString('en-US')} requests · ${lostPct.toFixed(0)}% lost</title></rect>`;
    }
    if (h.hour % 3 === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${String(h.hour).padStart(2, '0')}</text>`;
  });
  return svg;
}

export function initReport(opts: {
  send: (m: ToWorker) => void;
  pause: () => void;
  showOnMap: (hexWaitsMin: Float32Array) => void;
  current: () => { settings: RunSettings; rebalancing: boolean; events: EventDef[] };
}) {
  let last: DayReport | null = null;
  const panel = $('report');
  $('report-btn').addEventListener('click', () => opts.send({ type: 'report' }));
  $('report-close').addEventListener('click', () => { panel.hidden = true; });
  $('report-map').addEventListener('click', () => {
    if (last) opts.showOnMap(last.hexAvgWithLostMin);
    panel.hidden = true;
  });

  function show(report: DayReport, endOfDay: boolean) {
    last = report;
    if (endOfDay) opts.pause();
    const lostPct = report.requests ? (100 * report.lost) / report.requests : 0;
    $('report-title').textContent = `${endOfDay ? 'End of day' : 'Day so far'}: ${DAYS[report.weekday]} (day ${report.day + 1})`;
    $('report-summary').innerHTML = `<b>${Math.round(report.requests).toLocaleString('en-US')}</b> ride requests ·
      average wait <b>${Number.isNaN(report.avgWaitMin) ? '–' : report.avgWaitMin.toFixed(1) + ' min'}</b> ·
      lost trips <b>${Math.round(report.lost).toLocaleString('en-US')}</b> (${lostPct.toFixed(1)}%)`;
    $('report-chart').innerHTML = chart(report);
    panel.hidden = false;
  }

  // ---- fleet sweep ----------------------------------------------------------
  const sweepPanel = $('sweep');
  let sweeper: Worker | null = null;
  const rows: SweepRow[] = [];

  function stopSweep() {
    sweeper?.terminate();
    sweeper = null;
    $('sweep-start').textContent = 'Start sweep';
  }

  function renderRows(done: boolean) {
    const pass = rows.find((r) => r.hexesOver5 === 0);
    $('sweep-rows').innerHTML = rows.map((r) => `<tr class="${r === pass ? 'pass' : ''}">
      <td>${r.fleetPct}%</td><td>${r.cabs.toLocaleString('en-US')}${r.sampleN > 1 ? ` (1 in ${r.sampleN})` : ''}</td>
      <td>${r.avgWaitMin.toFixed(1)} min</td><td>${r.lostPct.toFixed(1)}%</td>
      <td>${r.hexesOver5.toLocaleString('en-US')} of ${r.hexesWithDemand.toLocaleString('en-US')}</td></tr>`).join('');
    const res = $('sweep-result');
    if (pass) res.textContent = `Smallest fleet with every area under 5 min: ${pass.fleetPct}% of the county's cars (${pass.cabs.toLocaleString('en-US')} cabs).`;
    else if (done) {
      const best = rows.reduce((a, b) => (b.hexesOver5 < a.hexesOver5 ? b : a), rows[0]);
      res.textContent = `No fleet size got every area under 5 min. Closest: ${best.fleetPct}% (${best.hexesOver5} areas at 5 min or more).`;
    } else res.textContent = `Running… ${rows.length} of ${FLEET_STEPS.length} fleet sizes done.`;
  }

  $('sweep-btn').addEventListener('click', () => { sweepPanel.hidden = false; });
  $('sweep-close').addEventListener('click', () => { sweepPanel.hidden = true; });
  $('sweep-start').addEventListener('click', () => {
    if (sweeper) { stopSweep(); $('sweep-result').textContent = 'Stopped.'; return; }
    rows.length = 0;
    renderRows(false);
    $('sweep-result').textContent = 'Loading…';
    $('sweep-start').textContent = 'Stop';
    const cur = opts.current();
    sweeper = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    sweeper.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'ready') {
        renderRows(false);
        sweeper!.postMessage({ type: 'sweep', settings: cur.settings, rebalancing: cur.rebalancing, events: cur.events,
          steps: FLEET_STEPS } satisfies ToWorker);
      } else if (m.type === 'sweepRow') {
        rows.push(m.row);
        renderRows(false);
      } else if (m.type === 'sweepDone') {
        renderRows(true);
        stopSweep();
      } else if (m.type === 'error') {
        $('sweep-result').textContent = `Sweep error: ${m.message}`;
        stopSweep();
      }
    };
    sweeper.postMessage({ type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href } satisfies ToWorker);
  });

  return { show };
}
