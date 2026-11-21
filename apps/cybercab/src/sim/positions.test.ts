import { describe, expect, it } from 'vitest';
import { loadWorldFromDisk } from './load-node';
import { PositionTracker } from './positions';
import { STATE, Simulation } from './sim';
import { clockText, FLEET_STEPS, pctText } from '../format';
import { STATE_COLOURS, LEGEND_ORDER } from '../colours';

describe('page helpers', () => {
  it('clock shows day and time', () => {
    expect(clockText(1, 0)).toBe('Tue 00:00');
    expect(clockText(1, 8 * 3600 + 5 * 60 + 59)).toBe('Tue 08:05');
    expect(clockText(6, 86400 + 3600)).toBe('Mon 01:00');
  });
  it('fleet slider has the spec log steps', () => {
    expect(FLEET_STEPS).toEqual([0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]);
    expect(pctText(1.5)).toBe('1.5%');
    expect(pctText(60)).toBe('60%');
  });
  it('has a colour for every cab state, legend in spec order', () => {
    expect(STATE_COLOURS.length).toBe(7);
    expect(LEGEND_ORDER).toEqual([STATE.idle, STATE.withRider, STATE.toPickup, STATE.rebalance, STATE.charging, STATE.cleaning, STATE.parked]);
  });
});

describe('dot positions', () => {
  it('puts every cab inside the Travis County area and moves driving cabs', () => {
    const world = loadWorldFromDisk();
    const sim = new Simulation(world, { seed: 5, fleetPct: 0.2 });
    const tracker = new PositionTracker(world, sim.nCabs, 5);
    sim.runUntil(8 * 3600);
    const a = new Float32Array(sim.nCabs * 2);
    const b = new Float32Array(sim.nCabs * 2);
    tracker.fill(sim, sim.now, a);
    tracker.fill(sim, sim.now + 4, b);
    let moved = 0;
    for (let c = 0; c < sim.nCabs; c++) {
      expect(a[2 * c]).toBeGreaterThan(-98.4);
      expect(a[2 * c]).toBeLessThan(-97.2);
      expect(a[2 * c + 1]).toBeGreaterThan(29.9);
      expect(a[2 * c + 1]).toBeLessThan(30.75);
      if (a[2 * c] !== b[2 * c] || a[2 * c + 1] !== b[2 * c + 1]) {
        moved++;
        expect(PositionTracker.moving(sim, c)).toBe(true);
      }
    }
    expect(moved).toBeGreaterThan(50);
  });
});
