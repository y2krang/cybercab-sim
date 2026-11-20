// Hex shading colours (magma-like ramp, log scale so suburbs still show).
export type Metric = 'people' | 'jobs' | 'cars' | 'none';

export const METRIC_LABEL: Record<Exclude<Metric, 'none'>, string> = {
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
