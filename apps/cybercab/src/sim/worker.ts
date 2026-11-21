// The simulation runs here, off the page's main thread (spec section 8).
// It advances the clock at the chosen speed and sends cab positions and
// states for drawing, plus live numbers a few times a second.
import { loadWorld } from './load-browser';
import { PositionTracker } from './positions';
import { Simulation } from './sim';
import { num, type World } from './world';
import type { FromWorker, RunSettings, ToWorker } from './protocol';

const FRAME_MS = 66;
const LIVE_EVERY = 4; // frames
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
  });
  tracker = new PositionTracker(world, sim.nCabs, settings.seed);
  clock = 0;
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
      post({ type: 'ready', registeredVehicles: num(world.area, 'registered_vehicles'), loadSeconds: (performance.now() - t0) / 1000 });
    } else if (m.type === 'start') {
      start(m.settings);
    } else if (m.type === 'play') {
      playing = m.on;
      lastReal = performance.now();
    } else if (m.type === 'speed') {
      speed = m.speed;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

setInterval(loop, FRAME_MS);
