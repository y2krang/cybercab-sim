// The simulation runs here, off the page's main thread (spec section 8).
// It advances the clock at the chosen speed and sends cab positions and
// states for drawing, plus live numbers a few times a second.
import { loadWorld } from './load-browser';
import { PositionTracker } from './positions';
import { Simulation } from './sim';
import { num, type World } from './world';
import type { EventDef, FromWorker, RunSettings, ToWorker } from './protocol';
import { scheduleEvent, type SimEvent } from './events';
import { dayReport, runSweep, samplingFor } from './report';

// Positions are sent ~30 times a second and drawn as they are (no sliding in
// between on the page), so every dot is always on its road route.
const FRAME_MS = 33;
const LIVE_EVERY = 8; // frames
const MAX_TICKS_PER_FRAME = 400;

let world: World | null = null;
let sim: Simulation | null = null;
let tracker: PositionTracker | null = null;
let playing = false;
let speed = 60;
let clock = 0;          // smooth simulated time for drawing (sim.now steps in 5 s)
let lastReal = performance.now();
let frameNo = 0;
let realSpeed = 0;
let dirty = false;      // something changed while paused: send one frame
let rebalanceOn = true; // switch on the page (R6), kept across restarts
let eventDefs: EventDef[] = []; // events chosen on the page (R7), kept across restarts
let heatOn = false;     // wait heat map (R9) shown on the page
let reportedDay = 0;    // end-of-day reports sent so far (R10)
let scheduled = new Map<string, SimEvent>(); // key -> event placed in this run

/** Place the chosen events in the running day and tell the page where and when. */
function applyEvents() {
  if (!sim || !world) return;
  const w = world;
  const next = new Map<string, SimEvent>();
  eventDefs.forEach((def, i) => {
    // Keep an event's times once placed, so changing the list doesn't move it.
    const old = scheduled.get(def.key);
    const times = old ?? scheduleEvent(def, sim!.startDay, sim!.now);
    const hex = old?.hex ?? w.nearestRoadHex(def.lat, def.lng);
    next.set(def.key, { id: i, name: def.name, place: def.place, lat: def.lat, lng: def.lng, hex, people: def.people,
      startT: times.startT, endT: times.endT });
  });
  scheduled = next;
  sim.setEvents([...next.values()]);
  post({
    type: 'eventsScheduled',
    events: eventDefs.map((def) => {
      const e = next.get(def.key)!;
      return { key: def.key, name: e.name, place: e.place, lng: w.roadLng[e.hex], lat: w.roadLat[e.hex],
        people: e.people, startT: e.startT, endT: e.endT };
    }),
  });
}

const post = (m: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(m, transfer);

function start(settings: RunSettings) {
  if (!world) return;
  const { fullFleet, sampleN } = samplingFor(world, settings.fleetPct);
  reportedDay = 0;
  sim = new Simulation(world, {
    seed: settings.seed,
    fleetPct: settings.fleetPct,
    cabShare: settings.cabShare ?? undefined,
    startDay: settings.startDay,
    sampleN,
    rebalancing: rebalanceOn,
  });
  tracker = new PositionTracker(world, sim.nCabs, settings.seed);
  clock = 0;
  scheduled = new Map();
  applyEvents();
  const w = world;
  post({
    type: 'started',
    settings,
    cabs: sim.nCabs,
    fullFleet,
    sampleN,
    cabShare: sim.cabShare,
    hubs: Array.from(sim.hubHex, (h, k) => ({
      name: sim!.hubName[k], lng: w.roadLng[h], lat: w.roadLat[h],
      chargeBays: sim!.chargeBays[k], cleanBays: sim!.cleanBays[k], auto: sim!.hubAuto[k],
    })),
  });
  dirty = true;
  sendLive();
}

function sendFrame() {
  if (!sim || !tracker) return;
  const positions = new Float32Array(sim.nCabs * 2);
  tracker.fill(sim, clock, positions);
  const states = sim.state.slice();
  post({ type: 'frame', t: clock, positions, states }, [positions.buffer, states.buffer]);
}

function sendLive() {
  if (!sim) return;
  const n = sim.live();
  post({ type: 'live', numbers: { ...n, now: clock }, simSpeed: realSpeed });
  if (heatOn && world) {
    const secs = sim.recentHexWaits(1800);
    const waitsMin = secs.map((s) => s / 60);
    post({ type: 'heat', waitsMin, hasDemand: world.hasDemand.slice() }, [waitsMin.buffer]);
  }
}

function loop() {
  const nowReal = performance.now();
  const dtReal = (nowReal - lastReal) / 1000;
  lastReal = nowReal;
  if (!sim) return;
  if (playing) {
    const before = clock;
    clock += speed * dtReal;
    let ticks = 0;
    while (sim.now + 5 <= clock && ticks < MAX_TICKS_PER_FRAME) { sim.step(); ticks++; }
    if (sim.now + 5 <= clock) clock = sim.now; // too slow to keep up: fall back to what's done
    realSpeed = dtReal > 0 ? (clock - before) / dtReal : 0;
    // End of a simulated day (after 15 min for the last riders): send its report.
    if (sim.now >= (reportedDay + 1) * 86400 + 15 * 60) {
      post({ type: 'dayReport', report: dayReport(sim, reportedDay), endOfDay: true });
      reportedDay++;
    }
  } else {
    realSpeed = 0;
    if (!dirty) return;
  }
  dirty = false;
  sendFrame();
  if (++frameNo % LIVE_EVERY === 0) sendLive();
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const t0 = performance.now();
      world = await loadWorld(m.base);
      post({
        type: 'ready',
        registeredVehicles: num(world.area, 'registered_vehicles'),
        loadSeconds: (performance.now() - t0) / 1000,
        presets: world.eventPresets.map((e, i) => ({
          key: `preset-${i}`, name: e.name, place: e.place, lat: e.lat, lng: e.lng, people: e.people,
          day: e.day, startMin: e.startMin, endMin: e.endMin,
        })),
      });
    } else if (m.type === 'start') {
      start(m.settings);
    } else if (m.type === 'play') {
      playing = m.on;
      lastReal = performance.now();
    } else if (m.type === 'speed') {
      speed = m.speed;
    } else if (m.type === 'heat') {
      heatOn = m.on;
      if (heatOn) sendLive();
    } else if (m.type === 'report') {
      if (sim) post({ type: 'dayReport', report: dayReport(sim, Math.floor(sim.now / 86400)), endOfDay: false });
    } else if (m.type === 'sweep') {
      // Runs in its own worker (the page starts a second one), so the map keeps going.
      if (!world) return;
      const w = world;
      const events: SimEvent[] = m.events.map((def, i) => ({
        id: i, name: def.name, place: def.place, lat: def.lat, lng: def.lng, hex: w.nearestRoadHex(def.lat, def.lng),
        people: def.people, ...scheduleEvent(def, m.settings.startDay, 0),
      }));
      const rows = runSweep(w, { seed: m.settings.seed, startDay: m.settings.startDay, cabShare: m.settings.cabShare,
        rebalancing: m.rebalancing, events }, m.steps, (row) => post({ type: 'sweepRow', row }));
      post({ type: 'sweepDone', rows });
    } else if (m.type === 'events') {
      eventDefs = m.events;
      applyEvents();
      dirty = true;
    } else if (m.type === 'rebalance') {
      rebalanceOn = m.on;
      if (sim) sim.rebalanceOn = m.on;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

setInterval(loop, FRAME_MS);
