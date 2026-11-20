import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCsv, parseHexes, parseHubs, parseParams } from './data';
import { TravelTable, slowdownFactor, NO_ROAD } from './travel';
import { rampColour } from './shading';
import { latLngToCell } from 'h3-js';

const data = (f: string) => new URL(`../public/data/${f}`, import.meta.url);

describe('CSV parsing', () => {
  it('handles quotes, commas and Windows line ends', () => {
    const rows = parseCsv('a,b\r\n"x, y",2\r\n"say ""hi""",3\r\n');
    expect(rows).toEqual([{ a: 'x, y', b: '2' }, { a: 'say "hi"', b: '3' }]);
  });

  it('loads every hex with census totals (check A1)', () => {
    const hexes = parseHexes(readFileSync(data('hexes.csv'), 'utf8'));
    expect(hexes.length).toBe(3209);
    expect(hexes.reduce((s, h) => s + h.people, 0)).toBe(1290188);
    expect(hexes.reduce((s, h) => s + h.cars, 0)).toBeCloseTo(1_000_000, -3);
  });

  it('loads both hubs with bay counts', () => {
    const hubs = parseHubs(readFileSync(data('hubs.csv'), 'utf8'));
    expect(hubs.map((h) => h.name)).toEqual(['Ben White hub', 'Ridgepoint hub']);
    expect(hubs.every((h) => h.chargeBays === 24 && h.cleanBays === 4)).toBe(true);
  });
});

describe('travel time lookup (check A5)', () => {
  const sd = parseParams(readFileSync(data('slowdown.csv'), 'utf8'));

  it('applies the slowdown to the slow part only', () => {
    const t = new TravelTable(2, Uint16Array.from([60, 600, 900, 60]), Uint16Array.from([30, 400, 500, 30]));
    expect(t.seconds(0, 1, 1.0)).toBe(600);
    expect(t.seconds(0, 1, 1.8)).toBeCloseTo(600 + 0.8 * 400);
    expect(t.seconds(1, 0, 1.5)).toBeCloseTo(900 + 0.5 * 500);
  });

  it('returns Infinity where there is no road', () => {
    const t = new TravelTable(2, Uint16Array.from([60, NO_ROAD, 900, 60]), Uint16Array.from([0, NO_ROAD, 0, 0]));
    expect(t.seconds(0, 1, 1)).toBe(Infinity);
  });

  it('picks the right slowdown band', () => {
    expect(slowdownFactor(sd, 0, 3)).toBe(1.0);   // Mon 03:00
    expect(slowdownFactor(sd, 1, 8)).toBe(1.5);   // Tue 08:00
    expect(slowdownFactor(sd, 2, 17.5)).toBe(1.8); // Wed 17:30
    expect(slowdownFactor(sd, 3, 20)).toBe(1.15); // Thu 20:00
    expect(slowdownFactor(sd, 5, 12)).toBe(1.1);  // Sat 12:00
    expect(slowdownFactor(sd, 6, 22)).toBe(1.0);  // Sun 22:00
  });

  it('reads the real step 2 tables: downtown to the Domain is 10-40 min at rush hour', () => {
    const n = 3209;
    const base = gunzipSync(readFileSync(data('tt_base.bin.gz')));
    const slow = gunzipSync(readFileSync(data('tt_slow.bin.gz')));
    const t = TravelTable.fromBuffers(n, base.buffer.slice(base.byteOffset, base.byteOffset + base.length),
      slow.buffer.slice(slow.byteOffset, slow.byteOffset + slow.length));
    const ids = parseHexes(readFileSync(data('hexes.csv'), 'utf8')).map((h) => h.h3);
    const downtown = ids.indexOf(latLngToCell(30.2682, -97.7429, 8));
    const domain = ids.indexOf(latLngToCell(30.4021, -97.7253, 8));
    expect(downtown).toBeGreaterThanOrEqual(0);
    expect(domain).toBeGreaterThanOrEqual(0);
    const mins = t.seconds(downtown, domain, 1.8) / 60;
    expect(mins).toBeGreaterThan(10);
    expect(mins).toBeLessThan(40);
  });
});

describe('hex shading', () => {
  it('is see-through at zero and brightest at the top', () => {
    expect(rampColour(0, 100)[3]).toBe(0);
    expect(rampColour(100, 100).slice(0, 3)).toEqual([252, 253, 191]);
  });
});
