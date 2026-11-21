// Messages between the page and the simulation worker.

export interface RunSettings {
  seed: number;
  fleetPct: number;
  /** null = linked to fleet size via share.csv (R4). */
  cabShare: number | null;
  startDay: number;
}

export type ToWorker =
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
  | { type: 'ready'; registeredVehicles: number; loadSeconds: number }
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
