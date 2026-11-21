// Step 6: the map with moving cab dots, colours, controls and the live panel.
// The simulation itself runs in a Web Worker (sim/worker.ts).
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { basemapStyle } from './basemap';
import { fetchText, parseHexes, type Hex } from './data';
import { rampColour, type Metric, METRIC_LABEL } from './shading';
import { LEGEND_ORDER, STATE_COLOURS, STATE_LABELS, cssColour } from './colours';
import type { FromWorker, HubInfo, LiveNumbers, RunSettings, ToWorker } from './sim/protocol';
import { clockText, fleetCabsText, FLEET_STEPS, pctText } from './format';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

// ---- map ------------------------------------------------------------------

maplibregl.setWorkerUrl(workerUrl);
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle('dark', BASE),
  center: [-97.76, 30.33],
  zoom: 9.4,
  minZoom: 8,
  maxZoom: 17,
  maxBounds: [[-98.8, 29.6], [-96.7, 31.0]],
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
map.addControl(overlay);

// ---- state ----------------------------------------------------------------

let metric: Metric = 'none';
let hexes: Hex[] = [];
let county: unknown = null;
let hubs: HubInfo[] = [];
let staticLayers: Layer[] = [];
let sampleN = 1;
let startDay = 1;
let playing = false;

const settings: RunSettings = { seed: 2026, fleetPct: 1, cabShare: null, startDay: 1 };

// Cab dots: the worker sends positions ~15 times a second; the page slides the
// dots smoothly between the last two updates.
let prevPos: Float32Array = new Float32Array(0);
let nextPos: Float32Array = new Float32Array(0);
let shownPos: Float32Array = new Float32Array(0);
let colours = new Uint8Array(0);
let frameAt = 0;
let cabCount = 0;
const FRAME_MS = 66;

// ---- worker ---------------------------------------------------------------

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      status.textContent = `Simulation loaded in ${m.loadSeconds.toFixed(1)} s`;
      send({ type: 'start', settings });
      break;
    case 'started':
      sampleN = m.sampleN;
      startDay = m.settings.startDay;
      hubs = m.hubs;
      $('fleet-cabs').textContent = fleetCabsText(m.fullFleet);
      $('share-label').textContent = pctText(m.cabShare * 100);
      ($('share') as HTMLInputElement).value = String(Math.round(m.cabShare * 100));
      const s = $('sampling');
      s.hidden = m.sampleN === 1;
      s.textContent = `Showing 1 in ${m.sampleN} cabs (${m.cabs.toLocaleString()} drawn); totals scaled up`;
      cabCount = m.cabs;
      prevPos = nextPos = shownPos = new Float32Array(0);
      buildStaticLayers();
      break;
    case 'frame':
      if (m.positions.length !== nextPos.length) {
        prevPos = m.positions.slice();
        shownPos = m.positions.slice();
      } else {
        prevPos = shownPos.slice();
      }
      nextPos = m.positions;
      frameAt = performance.now();
      colours = new Uint8Array(m.states.length * 4);
      for (let i = 0; i < m.states.length; i++) {
        const c = STATE_COLOURS[m.states[i]];
        colours[4 * i] = c[0]; colours[4 * i + 1] = c[1]; colours[4 * i + 2] = c[2]; colours[4 * i + 3] = 235;
      }
      $('clock').textContent = clockText(startDay, m.t);
      break;
    case 'live':
      showLive(m.numbers, m.simSpeed);
      break;
    case 'error':
      status.textContent = `Simulation error: ${m.message}`;
      break;
  }
};

// ---- drawing --------------------------------------------------------------

function hexTooltip({ object, layer }: PickingInfo): string | null {
  if (!object) return null;
  if (layer?.id === 'hexes') {
    const h = object as Hex;
    return `People ${h.people.toLocaleString()}\nJobs ${h.jobs.toLocaleString()}\nCars ${Math.round(h.cars).toLocaleString()}`;
  }
  if (layer?.id === 'hubs') {
    const h = object as HubInfo;
    return `${h.name}\n${h.chargeBays} charge bays · ${h.cleanBays} cleaning bays`;
  }
  return null;
}

function buildStaticLayers() {
  const vals = hexes.map((h) => (metric === 'none' ? 0 : h[metric]));
  const maxValue = Math.max(1, ...vals);
  staticLayers = [
    new H3HexagonLayer<Hex>({
      id: 'hexes', data: hexes, visible: metric !== 'none',
      getHexagon: (d) => d.h3,
      getFillColor: (d) => rampColour(metric === 'none' ? 0 : d[metric], maxValue),
      stroked: false, opacity: 0.45, pickable: true, highPrecision: false,
      updateTriggers: { getFillColor: [metric] },
    }),
    new GeoJsonLayer({
      id: 'county', data: county as never, filled: false, stroked: true,
      getLineColor: [159, 180, 200, 200], lineWidthMinPixels: 2,
    }),
    new ScatterplotLayer<HubInfo>({
      id: 'hubs', data: hubs, getPosition: (d) => [d.lng, d.lat],
      getRadius: (d) => (d.auto ? 6 : 9), radiusUnits: 'pixels',
      getFillColor: [11, 13, 16, 255], getLineColor: [255, 255, 255, 255],
      lineWidthMinPixels: 2.5, stroked: true, pickable: true,
    }),
    new TextLayer<HubInfo>({
      id: 'hub-names', data: hubs.filter((h) => !h.auto), getPosition: (d) => [d.lng, d.lat],
      getText: (d) => d.name, getSize: 13, getColor: [255, 255, 255, 255], getPixelOffset: [0, -20],
      outlineWidth: 3, outlineColor: [11, 13, 16, 255], fontSettings: { sdf: true },
      fontFamily: 'system-ui, sans-serif', fontWeight: 600,
    }),
  ];
  $('ramp-key').hidden = metric === 'none';
  if (metric !== 'none') {
    $('ramp-title').textContent = `${METRIC_LABEL[metric]} per hexagon`;
    $('ramp-hi').textContent = Math.round(maxValue).toLocaleString();
  }
}

// Insert cab dots below the hub markers so hubs stay visible.
function drawFrame() {
  const a = Math.min(1, (performance.now() - frameAt) / FRAME_MS);
  const n = nextPos.length;
  if (shownPos.length !== n) shownPos = new Float32Array(n);
  if (prevPos.length === n) {
    for (let i = 0; i < n; i++) shownPos[i] = prevPos[i] + (nextPos[i] - prevPos[i]) * a;
  }
  const cabs = new ScatterplotLayer({
    id: 'cabs',
    data: { length: n / 2, attributes: {
      getPosition: { value: shownPos, size: 2 },
      getFillColor: { value: colours, size: 4 },
    } } as never,
    radiusUnits: 'meters', getRadius: 45, radiusMinPixels: 1.6, radiusMaxPixels: 6,
    stroked: false, updateTriggers: {},
  });
  overlay.setProps({ getTooltip: hexTooltip, layers: [staticLayers[0], staticLayers[1], cabs, ...staticLayers.slice(2)].filter(Boolean) });
  frames++;
  requestAnimationFrame(drawFrame);
}

// ---- live panel and legend --------------------------------------------------

const legend = $('legend-list');
legend.innerHTML = LEGEND_ORDER.map((i) =>
  `<li><span class="dot" style="background:${cssColour(i)}"></span>${STATE_LABELS[i]}<span class="count" id="count-${i}">–</span></li>`,
).join('');

function minutes(x: number) { return Number.isFinite(x) ? `${x.toFixed(1)} min` : '–'; }

function showLive(n: LiveNumbers, simSpeed: number) {
  $('n-avg').textContent = minutes(n.avgWaitMin);
  $('n-p90').textContent = minutes(n.worst10WaitMin);
  const lost = n.lostToday * sampleN;
  $('n-lost').textContent = n.requestsToday
    ? `${lost.toLocaleString()} (${((100 * n.lostToday) / n.requestsToday).toFixed(1)}%)` : '0';
  $('n-empty').textContent = Number.isFinite(n.emptyMilesPct) ? `${n.emptyMilesPct.toFixed(0)}%` : '–';
  $('n-rides').textContent = Number.isFinite(n.ridesPerCabPerDay) ? n.ridesPerCabPerDay.toFixed(1) : '–';
  $('n-queue').textContent = (n.chargerQueue * sampleN).toLocaleString();
  $('n-clean').textContent = (n.cleaningQueue * sampleN).toLocaleString();
  for (let i = 0; i < 7; i++) $(`count-${i}`).textContent = (n.cabsByState[i] * sampleN).toLocaleString();
  const fps = lastFps;
  status.textContent = `${playing ? `Running at ${Math.round(simSpeed)}×` : 'Paused'} · ${fps} frames/s · ${(cabCount).toLocaleString()} dots`;
}

let frames = 0;
let lastFps = 0;
setInterval(() => { lastFps = frames; frames = 0; }, 1000);

// ---- controls -----------------------------------------------------------------

function restart() {
  send({ type: 'start', settings: { ...settings } });
}

$('play').addEventListener('click', () => {
  playing = !playing;
  $('play').textContent = playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  send({ type: 'play', on: playing });
});

document.querySelectorAll<HTMLButtonElement>('#speeds button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#speeds button').forEach((x) => x.classList.toggle('on', x === b));
    send({ type: 'speed', speed: Number(b.dataset.speed) });
  });
});

$('reset').addEventListener('click', restart);

$('more').addEventListener('click', () => {
  const s = $('settings');
  s.hidden = !s.hidden;
  $('more').setAttribute('aria-expanded', String(!s.hidden));
});

const fleet = $<HTMLInputElement>('fleet');
fleet.addEventListener('input', () => {
  settings.fleetPct = FLEET_STEPS[Number(fleet.value)];
  $('fleet-label').textContent = `${settings.fleetPct}%`;
});
fleet.addEventListener('change', restart);

const share = $<HTMLInputElement>('share');
const linked = $<HTMLInputElement>('linked');
linked.addEventListener('change', () => {
  share.disabled = linked.checked;
  settings.cabShare = linked.checked ? null : Number(share.value) / 100;
  restart();
});
share.addEventListener('input', () => { $('share-label').textContent = `${share.value}%`; });
share.addEventListener('change', () => { settings.cabShare = Number(share.value) / 100; restart(); });

$<HTMLInputElement>('seed').addEventListener('change', (e) => {
  const v = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
  settings.seed = v;
  restart();
});
$<HTMLSelectElement>('day').value = String(settings.startDay);
$<HTMLSelectElement>('day').addEventListener('change', (e) => {
  settings.startDay = Number((e.target as HTMLSelectElement).value);
  restart();
});

document.querySelectorAll<HTMLButtonElement>('.top .buttons button').forEach((b) => {
  b.addEventListener('click', () => {
    metric = b.dataset.metric as Metric;
    document.querySelectorAll('.top .buttons button').forEach((x) => x.classList.toggle('on', x === b));
    buildStaticLayers();
  });
});

$('side-toggle').addEventListener('click', () => {
  const side = $('side');
  side.classList.toggle('collapsed');
  $('side-toggle').textContent = side.classList.contains('collapsed') ? 'Numbers ▸' : 'Numbers ▾';
});
if (innerWidth < 760) { $('side').classList.add('collapsed'); $('side-toggle').textContent = 'Numbers ▸'; }

// ---- start ----------------------------------------------------------------------

function fitCounty() {
  let w = 180, s = 90, e = -180, n = -90;
  for (const h of hexes) { w = Math.min(w, h.lng); e = Math.max(e, h.lng); s = Math.min(s, h.lat); n = Math.max(n, h.lat); }
  const small = innerWidth < 760;
  map.fitBounds([[w, s], [e, n]], {
    padding: small ? { top: 80, bottom: 260, left: 10, right: 10 } : { top: 80, bottom: 170, left: 20, right: 300 },
    animate: false,
  });
}

async function start() {
  const [hexText, countyText] = await Promise.all([fetchText(`${BASE}data/hexes.csv`), fetchText(`${BASE}data/county.geojson`)]);
  hexes = parseHexes(hexText);
  county = JSON.parse(countyText);
  if (!map.loaded()) await new Promise((r) => map.once('load', r));
  fitCounty();
  buildStaticLayers();
  requestAnimationFrame(drawFrame);
  map.once('idle', () => {
    (window as unknown as { cybercabLoadSeconds: number }).cybercabLoadSeconds = performance.now() / 1000;
  });
  status.textContent = 'Loading the simulation…';
  send({ type: 'init', base: new URL(BASE, location.href).href });
}

start().catch((e) => {
  status.textContent = `Could not load: ${e instanceof Error ? e.message : e}`;
  console.error(e);
});
