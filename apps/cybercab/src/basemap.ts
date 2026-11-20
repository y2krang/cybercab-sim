// Base map: self-hosted OpenStreetMap extract (Protomaps), no paid tiles or keys.
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';

const HIDDEN = new Set(['pois']);

export function basemapStyle(theme: 'dark' | 'light', baseUrl: string): StyleSpecification {
  const flavor = { ...namedFlavor(theme) };
  if (theme === 'dark') {
    Object.assign(flavor, {
      background: '#1c1f24', earth: '#24272d', water: '#14181f', buildings: '#2f333a',
      park_a: '#22322a', park_b: '#24382d', wood_a: '#22322a', wood_b: '#24382d',
    });
  }
  const style = layers('basemap', flavor, { lang: 'en' }).filter((l) => !HIDDEN.has(l.id));
  return {
    version: 8,
    glyphs: `${baseUrl}fonts/{fontstack}/{range}.pbf`,
    sprite: new URL(`${baseUrl}sprites/${theme}`, location.href).href,
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${new URL(`${baseUrl}tiles/travis.pmtiles`, location.href).href}`,
        attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
      },
    },
    layers: style,
  } as StyleSpecification;
}
