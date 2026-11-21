// Loading the CSV and binary data files from public/data.

export interface Hex {
  h3: string;
  lat: number;
  lng: number;
  people: number;
  households: number;
  jobs: number;
  workers: number;
  cars: number;
}

export interface Hub {
  name: string;
  address: string;
  lat: number;
  lng: number;
  chargeBays: number;
  cleanBays: number;
}

export interface Param {
  value: number;
  unit: string;
  label: string;
  source: string;
}

/** Parse CSV text (quoted fields allowed) into rows of strings keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** key,value,unit,label,source files -> map of key to number and notes. */
export function parseParams(text: string): Map<string, Param> {
  return new Map(parseCsv(text).map((r) => [r.key, {
    value: Number(r.value), unit: r.unit, label: r.label, source: r.source,
  }]));
}

export function parseHexes(text: string): Hex[] {
  return parseCsv(text).map((r) => ({
    h3: r.h3, lat: +r.lat, lng: +r.lng, people: +r.people, households: +r.households,
    jobs: +r.jobs, workers: +r.workers, cars: +r.cars,
  }));
}

export function parseHubs(text: string): Hub[] {
  return parseCsv(text).map((r) => ({
    name: r.name, address: r.address, lat: +r.lat, lng: +r.lng,
    chargeBays: +r.charge_bays, cleanBays: +r.clean_bays,
  }));
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.text();
}

/**
 * Fetch a .bin.gz file and unzip it in the browser. Some servers send it with
 * "Content-Encoding: gzip", so the browser has already unzipped it: only unzip
 * when the bytes still start with the gzip marker (1f 8b).
 */
export async function fetchGzipBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const raw = await res.arrayBuffer();
  const head = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return raw;
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
