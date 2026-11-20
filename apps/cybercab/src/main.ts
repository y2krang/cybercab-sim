// Step 3: map page with Travis County, its hexagons and the hubs.
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import type { PickingInfo } from '@deck.gl/core';
import { basemapStyle } from './basemap';
import { fetchText, parseHexes, parseHubs, type Hex, type Hub } from './data';
import { rampColour, type Metric, METRIC_LABEL } from './shading';

const BASE = import.meta.env.BASE_URL;
const status = document.getElementById('status')!;

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

let metric: Metric = 'people';
let hexes: Hex[] = [];
let hubs: Hub[] = [];
let county: unknown = null;
let maxValue = 1;

function tooltip({ object, layer }: PickingInfo): string | null {
  if (!object) return null;
  if (layer?.id === 'hexes') {
    const h = object as Hex;
    return `People ${h.people.toLocaleString()}\nJobs ${h.jobs.toLocaleString()}\nCars ${Math.round(h.cars).toLocaleString()}`;
  }
  if (layer?.id === 'hubs') {
    const h = object as Hub;
    return `${h.name}\n${h.address}\n${h.chargeBays} charge bays · ${h.cleanBays} cleaning bays`;
  }
  return null;
}

function render() {
  const vals = hexes.map((h) => (metric === 'none' ? 0 : h[metric]));
  maxValue = Math.max(1, ...vals);
  overlay.setProps({
    getTooltip: tooltip,
    layers: [
      new H3HexagonLayer<Hex>({
        id: 'hexes',
        data: hexes,
        visible: metric !== 'none',
        getHexagon: (d) => d.h3,
        getFillColor: (d) => rampColour(metric === 'none' ? 0 : d[metric], maxValue),
        extruded: false,
        stroked: false,
        opacity: 0.55,
        pickable: true,
        highPrecision: false,
        updateTriggers: { getFillColor: [metric] },
      }),
      new GeoJsonLayer({
        id: 'county',
        data: county as never,
        filled: false,
        stroked: true,
        getLineColor: [159, 180, 200, 220],
        lineWidthMinPixels: 2,
      }),
      new ScatterplotLayer<Hub>({
        id: 'hubs',
        data: hubs,
        getPosition: (d) => [d.lng, d.lat],
        getRadius: 9,
        radiusUnits: 'pixels',
        getFillColor: [11, 13, 16, 255],
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 3,
        stroked: true,
        pickable: true,
      }),
      new TextLayer<Hub>({
        id: 'hub-names',
        data: hubs,
        getPosition: (d) => [d.lng, d.lat],
        getText: (d) => d.name,
        getSize: 13,
        getColor: [255, 255, 255, 255],
        getPixelOffset: [0, -20],
        outlineWidth: 3,
        outlineColor: [11, 13, 16, 255],
        fontSettings: { sdf: true },
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 600,
      }),
    ],
  });
  document.getElementById('legend')!.style.visibility = 'visible';
  document.getElementById('ramp-title')!.textContent = metric === 'none' ? 'Shading off' : `${METRIC_LABEL[metric]} per hexagon`;
  document.getElementById('ramp-hi')!.textContent = metric === 'none' ? '' : Math.round(maxValue).toLocaleString();
}

document.querySelectorAll<HTMLButtonElement>('.buttons button').forEach((b) => {
  b.addEventListener('click', () => {
    metric = b.dataset.metric as Metric;
    document.querySelectorAll('.buttons button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
});

// Frame counter, shown with the load time (check A3 / A4 are done on the owner's device).
let frames = 0;
let fps = 0;
let loadedIn = '';
function tick() { frames++; requestAnimationFrame(tick); }
requestAnimationFrame(tick);
setInterval(() => {
  fps = frames; frames = 0;
  status.textContent = `${loadedIn}${fps} frames/s`;
}, 1000);

/** Show the whole county, leaving room for the panels. */
function fitCounty() {
  let w = 180, s = 90, e = -180, n = -90;
  for (const h of hexes) {
    w = Math.min(w, h.lng); e = Math.max(e, h.lng);
    s = Math.min(s, h.lat); n = Math.max(n, h.lat);
  }
  const small = innerWidth < 600;
  map.fitBounds([[w, s], [e, n]], {
    padding: small ? { top: 120, bottom: 200, left: 10, right: 10 } : { top: 100, bottom: 60, left: 20, right: 250 },
    animate: false,
  });
}

async function start() {
  const [hexText, hubText, countyText] = await Promise.all([
    fetchText(`${BASE}data/hexes.csv`),
    fetchText(`${BASE}data/hubs.csv`),
    fetchText(`${BASE}data/county.geojson`),
  ]);
  hexes = parseHexes(hexText);
  hubs = parseHubs(hubText);
  county = JSON.parse(countyText);
  if (!map.loaded()) await new Promise((r) => map.once('load', r));
  fitCounty();
  render();
  map.once('idle', () => {
    const secs = performance.now() / 1000;
    loadedIn = `Loaded in ${secs.toFixed(1)} s · ${hexes.length.toLocaleString()} hexagons · `;
    (window as unknown as { cybercabLoadSeconds: number }).cybercabLoadSeconds = secs;
    status.textContent = `${loadedIn}${fps} frames/s`;
  });
}

start().catch((e) => {
  status.textContent = `Could not load: ${e instanceof Error ? e.message : e}`;
  console.error(e);
});
