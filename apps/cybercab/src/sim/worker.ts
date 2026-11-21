// The simulation runs here, off the page's main thread (spec section 8).
// It advances the clock at the chosen speed and sends cab positions and
// states for drawing, plus live numbers a few times a second.
import { loadWorld } from './load-browser';
import { PositionTracker } from './positions';
import { Simulation } from './sim';
import { num, type World } from './world';
import type { EventDef, FromWorker, RunSettings, ToWorker } from './protocol';
import { scheduleEvent, type SimEvent } from './events';

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
  const registered = num(world.area, 'registered_vehicles');
  const fullFleet = Math.max(1, Math.round((settings.fleetPct / 100) * registered));
  const limit = num(world.demand, 'sample_above_cabs');
  const sampleN = fullFleet > limit ? Math.ceil(fullFleet / limit) : 1;
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
