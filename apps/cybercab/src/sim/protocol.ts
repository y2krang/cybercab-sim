// Messages between the page and the simulation worker.
import type { DayReport, SweepRow } from './report';
export type { DayReport, SweepRow };

export interface RunSettings {
  seed: number;
  fleetPct: number;
  /** null = linked to fleet size via share.csv (R4). */
  cabShare: number | null;
  startDay: number;
}

/** An event as chosen on the page (spec R7): a preset or one tapped on the map. */
export interface EventDef {
  key: string;
  name: string;
  place: string;
  lat: number;
  lng: number;
  people: number;
  /** 0 = Monday ... 6 = Sunday, or null for any day (the current day). */
  day: number | null;
  startMin: number;
  endMin: number;
}

/** An event placed in the running day (times in run seconds). */
export interface ScheduledEvent {
  key: string;
  name: string;
  place: string;
  lng: number;
  lat: number;
  people: number;
  startT: number;
  endT: number;
}

export type ToWorker =
  | { type: 'events'; events: EventDef[] }
  | { type: 'heat'; on: boolean }
  | { type: 'report' }
  | { type: 'sweep'; settings: RunSettings; rebalancing: boolean; events: EventDef[]; steps: number[] }
  | { type: 'init'; base: string }
  | { type: 'start'; settings: RunSettings }
  | { type: 'play'; on: boolean }
  | { type: 'speed'; speed: number }
  | { type: 'rebalance'; on: boolean };

export interface HubInfo {
  name: string;
  lng: number;
  lat: number;
  chargeBays: number;
  cleanBays: number;
  auto: boolean;
}

export interface LiveNumbers {
  now: number;
  day: number;
  avgWaitMin: number;
  worst10WaitMin: number;
  lostToday: number;
  requestsToday: number;
  emptyMilesPct: number;
  ridesPerCabPerDay: number;
  cabsByState: number[];
  chargerQueue: number;
  cleaningQueue: number;
  waitingRiders: number;
}

export type FromWorker =
  | { type: 'ready'; registeredVehicles: number; loadSeconds: number; presets: EventDef[] }
  | { type: 'eventsScheduled'; events: ScheduledEvent[] }
  | { type: 'heat'; waitsMin: Float32Array; hasDemand: Uint8Array }
  | { type: 'dayReport'; report: DayReport; endOfDay: boolean }
  | { type: 'sweepRow'; row: SweepRow }
  | { type: 'sweepDone'; rows: SweepRow[] }
  | {
      type: 'started';
      settings: RunSettings;
      cabs: number;
      fullFleet: number;
      sampleN: number;
      cabShare: number;
      hubs: HubInfo[];
    }
  | { type: 'frame'; t: number; positions: Float32Array; states: Uint8Array }
  | { type: 'live'; numbers: LiveNumbers; simSpeed: number }
  | { type: 'error'; message: string };
