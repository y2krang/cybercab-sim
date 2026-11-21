// Cab dot colours (spec R2, owner-approved) in STATE order:
// idle, toPickup, withRider, rebalance, charging, cleaning, parked.
export const STATE_COLOURS: [number, number, number][] = [
  [59, 130, 246],  // blue: available (empty, charged)
  [250, 204, 21],  // yellow: empty, going to a pickup
  [239, 68, 68],   // red: carrying passengers
  [168, 85, 247],  // purple: empty, moving to an area short of cabs
  [34, 197, 94],   // green: going to / at a charger
  [156, 163, 175], // grey: going to / at cleaning
  [45, 75, 125],   // dim blue: parked at a hub, not needed
];

export const STATE_LABELS = [
  'Available',
  'Going to a pickup',
  'Carrying passengers',
  'Moving to an area short of cabs',
  'Charging',
  'Cleaning',
  'Parked at a hub',
];

/** Spec legend order: blue, red, yellow, purple, green, grey, dim blue. */
export const LEGEND_ORDER = [0, 2, 1, 3, 4, 5, 6];

export function cssColour(i: number): string {
  const [r, g, b] = STATE_COLOURS[i];
  return `rgb(${r}, ${g}, ${b})`;
}
