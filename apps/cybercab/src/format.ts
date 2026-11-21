// Small text helpers for the page.

/** Fleet slider steps, % of the county's cars (spec R3, log steps). */
export const FLEET_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Tue 08:05" for simulated seconds t since the start of startDay. */
export function clockText(startDay: number, t: number): string {
  const day = DAYS[(startDay + Math.floor(t / 86400)) % 7];
  const s = Math.floor(t % 86400);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

export function fleetCabsText(cabs: number): string {
  return `${cabs.toLocaleString('en-US')} cabs`;
}

export function pctText(p: number): string {
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}
