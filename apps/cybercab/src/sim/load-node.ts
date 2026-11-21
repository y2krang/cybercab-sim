// Loads the World from public/data on disk (tests and the day report run in Node).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { World } from './world';

const file = (f: string) => new URL(`../../public/data/${f}`, import.meta.url);
const text = (f: string) => readFileSync(file(f), 'utf8');
const bytes = (f: string) => {
  const b = gunzipSync(readFileSync(file(f)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};

let cached: World | null = null;

export function loadWorldFromDisk(): World {
  if (cached) return cached;
  cached = new World({
    hexesCsv: text('hexes.csv'),
    flowsCsv: text('work_flows.csv'),
    base: new Uint16Array(bytes('tt_base.bin.gz')),
    slow: new Uint16Array(bytes('tt_slow.bin.gz')),
    nextHop: new Uint8Array(bytes('next_hop.bin.gz')),
    neighbours: new Uint16Array(bytes('hex_neighbours.bin.gz')),
    vehicleCsv: text('vehicle.csv'),
    demandCsv: text('demand.csv'),
    hourlyCsv: text('hourly.csv'),
    shareCsv: text('share.csv'),
    slowdownCsv: text('slowdown.csv'),
    areaCsv: text('area.csv'),
    hubsCsv: text('hubs.csv'),
    hubSitesCsv: text('hub_sites.csv'),
    roadShapes: bytes('road_shapes.bin.gz'),
    eventsCsv: text('events.csv'),
  });
  return cached;
}
