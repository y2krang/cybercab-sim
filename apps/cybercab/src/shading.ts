// Hex shading colours (magma-like ramp, log scale so suburbs still show).
export type Metric = 'people' | 'jobs' | 'cars' | 'waits' | 'dayWaits' | 'none';

/** Wait heat map colours (spec R9): green < 3 min, yellow 3-6, orange 6-10, red > 10, grey no demand. */
export const WAIT_BANDS: { label: string; colour: [number, number, number] }[] = [
  { label: 'Under 3 min', colour: [34, 197, 94] },
  { label: '3–6 min', colour: [250, 204, 21] },
  { label: '6–10 min', colour: [249, 115, 22] },
  { label: 'Over 10 min', colour: [239, 68, 68] },
  { label: 'No demand', colour: [107, 114, 128] },
];

export function waitColour(min: number, hasDemand: boolean): [number, number, number, number] {
  if (!hasDemand) return [0, 0, 0, 0];
  const band = Number.isNaN(min) ? 4 : min < 3 ? 0 : min < 6 ? 1 : min < 10 ? 2 : 3;
  const [r, g, b] = WAIT_BANDS[band].colour;
  return [r, g, b, band === 4 ? 110 : 200];
}

export const METRIC_LABEL: Record<'people' | 'jobs' | 'cars', string> = {
  people: 'People', jobs: 'Jobs', cars: 'Cars',
};

const STOPS: [number, number, number][] = [
  [44, 16, 92], [113, 31, 129], [182, 54, 121], [238, 96, 94], [253, 174, 120], [252, 253, 191],
];

/** Colour for value v on a log scale up to max. Zero is see-through. */
export function rampColour(v: number, max: number): [number, number, number, number] {
  if (!(v > 0)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.log1p(v) / Math.log1p(Math.max(max, 1)));
  const x = t * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    230,
  ];
}
