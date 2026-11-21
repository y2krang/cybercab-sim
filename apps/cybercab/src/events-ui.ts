// Events panel (spec R7): switch preset events on and off, or tap the map to
// add one (place, attendance, start, end).
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import type { EventDef, ScheduledEvent } from './sim/protocol';
import { clockText } from './format';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function toMin(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function initEvents(map: MapLibreMap, sendEvents: (events: EventDef[]) => void) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('events-panel');
  const list = $('event-list');
  const form = $('event-form');
  let presets: EventDef[] = [];
  const custom: EventDef[] = [];
  const active = new Set<string>();
  let scheduled = new Map<string, ScheduledEvent>();
  let startDay = 1;
  let picked: { lat: number; lng: number } | null = null;
  let customCount = 0;

  const all = () => [...presets, ...custom];
  const chosen = () => all().filter((e) => active.has(e.key));

  function when(e: EventDef): string {
    const s = scheduled.get(e.key);
    if (s) return `${clockText(startDay, s.startT)}–${clockText(startDay, s.endT).slice(4)}`;
    return `${e.day === null ? 'Any day' : DAYS[e.day].slice(0, 3)} ${hhmm(e.startMin)}–${hhmm(e.endMin)}`;
  }

  function render() {
    list.innerHTML = all().map((e) => `
      <li>
        <div class="ev-text"><b>${escapeHtml(e.name)}</b> · ${escapeHtml(e.place)}<br>
          <span class="ev-when">${e.people.toLocaleString('en-US')} people · ${when(e)}</span></div>
        <button class="plain ${active.has(e.key) ? 'on-ev' : ''}" data-key="${e.key}">${active.has(e.key) ? 'On' : 'Off'}</button>
        ${e.key.startsWith('custom') ? `<button class="plain" data-remove="${e.key}" aria-label="Remove">✕</button>` : ''}
      </li>`).join('');
  }

  list.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.key) {
      if (active.has(b.dataset.key)) active.delete(b.dataset.key); else active.add(b.dataset.key);
    } else if (b.dataset.remove) {
      const i = custom.findIndex((e) => e.key === b.dataset.remove);
      if (i >= 0) custom.splice(i, 1);
      active.delete(b.dataset.remove);
    }
    render();
    sendEvents(chosen());
  });

  $('events-btn').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    $('events-btn').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('events-close').addEventListener('click', () => { panel.hidden = true; stopPicking(); });

  function stopPicking() {
    document.body.classList.remove('picking');
    form.hidden = true;
    $('event-add').hidden = false;
    picked = null;
  }

  $('event-add').addEventListener('click', () => {
    form.hidden = false;
    $('event-add').hidden = true;
    $('event-place').textContent = 'Tap the map where the event is.';
    ($('ev-ok') as HTMLButtonElement).disabled = true;
    document.body.classList.add('picking');
  });
  $('ev-cancel').addEventListener('click', stopPicking);

  map.on('click', (e: MapMouseEvent) => {
    if (!document.body.classList.contains('picking')) return;
    picked = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    $('event-place').textContent = `Place: ${picked.lat.toFixed(4)}, ${picked.lng.toFixed(4)} (tap again to move it)`;
    ($('ev-ok') as HTMLButtonElement).disabled = false;
  });

  $('ev-ok').addEventListener('click', () => {
    if (!picked) return;
    const people = Math.max(100, Math.min(500000, Math.round(Number(($('ev-people') as HTMLInputElement).value) || 0)));
    const dayValue = ($('ev-day') as HTMLSelectElement).value;
    const def: EventDef = {
      key: `custom-${++customCount}`,
      name: (($('ev-name') as HTMLInputElement).value || 'My event').trim().slice(0, 40),
      place: 'Your place',
      lat: picked.lat,
      lng: picked.lng,
      people,
      day: dayValue === '' ? null : Number(dayValue),
      startMin: toMin(($('ev-start') as HTMLInputElement).value),
      endMin: toMin(($('ev-end') as HTMLInputElement).value),
    };
    custom.push(def);
    active.add(def.key);
    stopPicking();
    render();
    sendEvents(chosen());
  });

  return {
    setPresets(p: EventDef[]) { presets = p; render(); },
    setScheduled(events: ScheduledEvent[], day: number) {
      startDay = day;
      scheduled = new Map(events.map((e) => [e.key, e]));
      render();
    },
    /** Send the chosen events again (after the day restarts). */
    resend() { sendEvents(chosen()); },
  };
}
