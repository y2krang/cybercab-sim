// Events (spec section 7): presets from events.csv, or added on the map.
// 15% of attendees use a Cybercab; arrivals spread evenly over the 2 hours
// before the start; departures 60% within 45 min of the end, the rest over the
// next 75 min. Riders come from (and go back to) hexes in proportion to people.
import { parseCsv } from '../data';
import { num, type Params } from './world';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface EventPreset {
  name: string;
  place: string;
  lat: number;
  lng: number;
  people: number;
  /** 0 = Monday ... 6 = Sunday, or null for any day. */
  day: number | null;
  startMin: number;
  endMin: number;
}

/** An event placed in a run: times in simulated seconds since the run started. */
export interface SimEvent {
  id: number;
  name: string;
  place: string;
  lat: number;
  lng: number;
  hex: number;
  people: number;
  startT: number;
  endT: number;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function parseEvents(text: string): EventPreset[] {
  return parseCsv(text).map((r) => ({
    name: r.name,
    place: r.place,
    lat: +r.lat,
    lng: +r.lng,
    people: +r.people,
    day: DAYS.indexOf(r.day) >= 0 ? DAYS.indexOf(r.day) : null,
    startMin: minutes(r.start),
    endMin: minutes(r.end),
  }));
}

/**
 * Place an event in the run: the first occurrence whose end hasn't passed at
 * time `nowT` (run seconds). "Any day" events go on the current day.
 */
export function scheduleEvent(p: { day: number | null; startMin: number; endMin: number },
  startDay: number, nowT: number): { startT: number; endT: number } {
  const today = Math.floor(nowT / 86400);
  for (let d = 0; d < 8; d++) {
    const dayIndex = today + d;
    const weekday = (startDay + dayIndex) % 7;
    if (p.day !== null && p.day !== weekday) continue;
    const startT = dayIndex * 86400 + p.startMin * 60;
    let endT = dayIndex * 86400 + p.endMin * 60;
    if (endT <= startT) endT += 86400; // ends after midnight
    if (endT > nowT) return { startT, endT };
  }
  return { startT: nowT, endT: nowT + 3600 };
}

/** Average people per ride request (party sizes, demand.csv). */
export function peoplePerRequest(d: Params): number {
  const p1 = num(d, 'party_1');
  const p2 = num(d, 'party_2');
  const p34 = num(d, 'party_3_4');
  const four = num(d, 'party_4_of_3_4');
  return (p1 * 1 + p2 * 2 + p34 * (3 + four)) / (p1 + p2 + p34);
}

/** Cybercab attendees per second arriving at / leaving an event at time t. */
export function eventRates(e: SimEvent, d: Params, t: number): { arrive: number; leave: number } {
  const riders = e.people * num(d, 'event_cab_share');
  const w = num(d, 'event_arrive_window_min') * 60;
  const fastShare = num(d, 'event_leave_fast_share');
  const fast = num(d, 'event_leave_fast_min') * 60;
  const slow = num(d, 'event_leave_slow_min') * 60;
  let arrive = 0;
  let leave = 0;
  if (t >= e.startT - w && t < e.startT) arrive = riders / w;
  if (t >= e.endT && t < e.endT + fast) leave = (riders * fastShare) / fast;
  else if (t >= e.endT + fast && t < e.endT + fast + slow) leave = (riders * (1 - fastShare)) / slow;
  return { arrive, leave };
}
