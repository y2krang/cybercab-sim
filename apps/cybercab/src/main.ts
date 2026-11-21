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
import { rampColour, waitColour, WAIT_BANDS, type Metric, METRIC_LABEL } from './shading';
import { initReport } from './report-ui';
import { LEGEND_ORDER, STATE_COLOURS, STATE_LABELS, cssColour } from './colours';
import type { FromWorker, HubInfo, LiveNumbers, RunSettings, ToWorker } from './sim/protocol';
import { clockText, fleetCabsText, FLEET_STEPS, pctText } from './format';
import { initEvents } from './events-ui';
import type { ScheduledEvent } from './sim/protocol';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

// ---- theme (dark by default, light switch; remembered on this device) ------

type Theme = 'dark' | 'light';
let theme: Theme = 'dark';
try { if (localStorage.getItem('cybercab-theme') === 'light') theme = 'light'; } catch { /* storage blocked: stay dark */ }
document.documentElement.dataset.theme = theme;

/** Marker colours that read well on each theme. */
function pal() {
  return theme === 'dark'
    ? { hubFill: [11, 13, 16, 255], hubLine: [255, 255, 255, 255], text: [255, 255, 255, 255], halo: [11, 13, 16, 255],
      county: [159, 180, 200, 200], eventText: [253, 186, 116, 255] }
    : { hubFill: [255, 255, 255, 255], hubLine: [31, 35, 40, 255], text: [31, 35, 40, 255], halo: [255, 255, 255, 255],
      county: [70, 90, 115, 220], eventText: [194, 65, 12, 255] };
}

// ---- map ------------------------------------------------------------------

maplibregl.setWorkerUrl(workerUrl);
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(theme, BASE),
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

// Cab dots: the worker sends positions ~30 times a second, already on the road
// route. They're drawn as sent: sliding between updates in a straight line cut
// corners at high speeds (owner, 2026-11-21).
let shownPos: Float32Array = new Float32Array(0);
let colours = new Uint8Array(0);
let cabCount = 0;
let dotsChanged = true;
let frameWaiting = false; // a frame from the worker is waiting to be drawn (then acknowledged)

// ---- worker ---------------------------------------------------------------

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);
const eventsUi = initEvents(map, (events) => send({ type: 'events', events }));
let eventMarkers: ScheduledEvent[] = [];
// Wait heat map (R9) and the report's wait-by-area map (R10), per hex in hexes.csv order.
let hexIndex = new Map<string, number>();
let heatWaits: Float32Array | null = null;
let heatDemand: Uint8Array | null = null;
let dayWaits: Float32Array | null = null;
let heatVersion = 0;
let rebalanceOn = true;

function setPlaying(on: boolean) {
  playing = on;
  $('play').textContent = playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  send({ type: 'play', on: playing });
}

const reportUi = initReport({
  send,
  pause: () => setPlaying(false),
  showOnMap: (w) => {
    dayWaits = w;
    setMetric('dayWaits');
  },
  current: () => ({ settings: { ...settings }, rebalancing: rebalanceOn, events: eventsUi.chosen() }),
});

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      status.textContent = `Simulation loaded in ${m.loadSeconds.toFixed(1)} s`;
      eventsUi.setPresets(m.presets);
      send({ type: 'start', settings });
      break;
    case 'eventsScheduled':
      eventMarkers = m.events;
      eventsUi.setScheduled(m.events, startDay);
      buildStaticLayers();
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
      shownPos = new Float32Array(0);
      buildStaticLayers();
      dotsChanged = true;
      break;
    case 'frame':
      shownPos = m.positions;
      dotsChanged = true;
      frameWaiting = true;
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
    case 'heat':
      heatWaits = m.waitsMin;
      heatDemand = m.hasDemand;
      heatVersion++;
      if (metric === 'waits') buildStaticLayers();
      break;
    case 'dayReport':
      reportUi.show(m.report, m.endOfDay);
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
  if (layer?.id === 'events') {
    const e = object as ScheduledEvent;
    return `${e.name} · ${e.place}\n${e.people.toLocaleString()} people\n${clockText(startDay, e.startT)}–${clockText(startDay, e.endT).slice(4)}`;
  }
  return null;
}

function hexFill(d: Hex, maxValue: number): [number, number, number, number] {
  const i = hexIndex.get(d.h3) ?? -1;
  if (metric === 'waits') {
    return waitColour(heatWaits ? heatWaits[i] : NaN, heatDemand ? heatDemand[i] === 1 : d.people + d.jobs > 0);
  }
  if (metric === 'dayWaits') return waitColour(dayWaits ? dayWaits[i] : NaN, d.people + d.jobs > 0);
  if (metric === 'none') return [0, 0, 0, 0];
  return rampColour(d[metric as 'people' | 'jobs' | 'cars'], maxValue);
}

function buildStaticLayers() {
  const ramp = metric === 'people' || metric === 'jobs' || metric === 'cars';
  const maxValue = ramp ? Math.max(1, ...hexes.map((h) => h[metric as 'people' | 'jobs' | 'cars'])) : 1;
  staticLayers = [
    new H3HexagonLayer<Hex>({
      id: 'hexes', data: hexes, visible: metric !== 'none',
      getHexagon: (d) => d.h3,
      getFillColor: (d) => hexFill(d, maxValue),
      stroked: false, opacity: metric === 'waits' || metric === 'dayWaits' ? 0.6 : 0.45, pickable: true, highPrecision: false,
      updateTriggers: { getFillColor: [metric, heatVersion, dayWaits] },
    }),
    new GeoJsonLayer({
      id: 'county', data: county as never, filled: false, stroked: true,
      getLineColor: pal().county as never, lineWidthMinPixels: 2, updateTriggers: { getLineColor: [theme] },
    }),
    new ScatterplotLayer<HubInfo>({
      id: 'hubs', data: hubs, getPosition: (d) => [d.lng, d.lat],
      getRadius: (d) => (d.auto ? 6 : 9), radiusUnits: 'pixels',
      getFillColor: pal().hubFill as never, getLineColor: pal().hubLine as never,
      updateTriggers: { getFillColor: [theme], getLineColor: [theme] },
      lineWidthMinPixels: 2.5, stroked: true, pickable: true,
    }),
    new ScatterplotLayer<ScheduledEvent>({
      id: 'events', data: eventMarkers, getPosition: (d) => [d.lng, d.lat],
      getRadius: 13, radiusUnits: 'pixels', filled: false, stroked: true,
      getLineColor: [249, 115, 22, 255], lineWidthMinPixels: 4, pickable: true,
    }),
    new TextLayer<ScheduledEvent>({
      id: 'event-names', data: eventMarkers, getPosition: (d) => [d.lng, d.lat],
      getText: (d) => `${d.name} ${clockText(startDay, d.startT).slice(4)}–${clockText(startDay, d.endT).slice(4)}`,
      getSize: 13, getColor: pal().eventText as never, getPixelOffset: [0, 24],
      outlineWidth: 3, outlineColor: pal().halo as never, fontSettings: { sdf: true }, updateTriggers: { getColor: [theme] },
      fontFamily: 'system-ui, sans-serif', fontWeight: 700,
    }),
    new TextLayer<HubInfo>({
      id: 'hub-names', data: hubs.filter((h) => !h.auto), getPosition: (d) => [d.lng, d.lat],
      getText: (d) => d.name, getSize: 13, getColor: pal().text as never, getPixelOffset: [0, -20],
      outlineWidth: 3, outlineColor: pal().halo as never, fontSettings: { sdf: true }, updateTriggers: { getColor: [theme] },
      fontFamily: 'system-ui, sans-serif', fontWeight: 600,
    }),
  ];
  dotsChanged = true;
  $('ramp-key').hidden = metric === 'none';
  const rampBar = document.querySelector<HTMLElement>('#ramp-key .ramp')!;
  const rampLabels = document.querySelector<HTMLElement>('#ramp-key .ramp-labels')!;
  let waitLegend = document.getElementById('wait-legend');
  if (!waitLegend) {
    waitLegend = document.createElement('div');
    waitLegend.id = 'wait-legend';
    waitLegend.className = 'wait-legend';
    waitLegend.innerHTML = WAIT_BANDS.map((b) => `<span><i style="background:rgb(${b.colour.join(',')})"></i>${b.label}</span>`).join('');
    $('ramp-key').appendChild(waitLegend);
  }
  const waitsShown = metric === 'waits' || metric === 'dayWaits';
  rampBar.hidden = waitsShown; rampLabels.hidden = waitsShown; waitLegend.hidden = !waitsShown;
  if (ramp) {
    $('ramp-title').textContent = `${METRIC_LABEL[metric as 'people' | 'jobs' | 'cars']} per hexagon`;
    $('ramp-hi').textContent = Math.round(maxValue).toLocaleString();
  } else if (metric === 'waits') {
    $('ramp-title').textContent = 'Average wait, last 30 min';
  } else if (metric === 'dayWaits') {
    $('ramp-title').textContent = 'Average wait for the day (lost trips as 12 min)';
  }
}

function setMetric(m: Metric) {
  metric = m;
  document.querySelectorAll<HTMLButtonElement>('.top .buttons button').forEach((x) =>
    x.classList.toggle('on', x.dataset.metric === m || (m === 'dayWaits' && x.dataset.metric === 'waits')));
  send({ type: 'heat', on: m === 'waits' });
  buildStaticLayers();
}

// Insert cab dots below the hub markers so hubs stay visible.
function drawFrame() {
  requestAnimationFrame(drawFrame);
  if (!dotsChanged) return;
  dotsChanged = false;
  const n = shownPos.length;
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
  if (frameWaiting) { frameWaiting = false; send({ type: 'ack' }); }
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

$('play').addEventListener('click', () => setPlaying(!playing));

document.querySelectorAll<HTMLButtonElement>('#speeds button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#speeds button').forEach((x) => x.classList.toggle('on', x === b));
    send({ type: 'speed', speed: Number(b.dataset.speed) });
  });
});

$('reset').addEventListener('click', restart);

$('rebalance').addEventListener('click', () => {
  rebalanceOn = !rebalanceOn;
  const b = $('rebalance');
  b.classList.toggle('on', rebalanceOn);
  b.setAttribute('aria-pressed', String(rebalanceOn));
  b.textContent = `Rebalancing: ${rebalanceOn ? 'On' : 'Off'}`;
  send({ type: 'rebalance', on: rebalanceOn });
});

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
  b.addEventListener('click', () => setMetric(b.dataset.metric as Metric));
});

$('side-toggle').addEventListener('click', () => {
  const side = $('side');
  side.classList.toggle('collapsed');
  $('side-toggle').textContent = side.classList.contains('collapsed') ? 'Numbers ▸' : 'Numbers ▾';
});
if (innerWidth < 760) { $('side').classList.add('collapsed'); $('side-toggle').textContent = 'Numbers ▸'; }

function showThemeButton() {
  $('theme').textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
  $('theme').setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
showThemeButton();
$('theme').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('cybercab-theme', theme); } catch { /* not remembered: fine */ }
  map.setStyle(basemapStyle(theme, BASE));
  showThemeButton();
  buildStaticLayers();
});

// The control bar wraps on narrow screens: size the other panels from its real height.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--controls-h', `${$('controls').offsetHeight}px`);
}).observe($('controls'));

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
  hexIndex = new Map(hexes.map((h, i) => [h.h3, i]));
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
