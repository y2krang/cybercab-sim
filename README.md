# Cybercab sim · Austin

An unofficial simulation of a self-driving robotaxi fleet in Austin, Texas
(all of Travis County). Moving dots on a real map, demand from census data,
charging, cleaning and sending empty cabs to areas short of cabs.

**Unofficial simulation. Numbers are estimates.** Not affiliated with Tesla.

Work in progress. Open it here: https://y2krang.github.io/cybercab-sim/

- `apps/cybercab/`: the web page (TypeScript, Vite, MapLibre GL JS, deck.gl)
- `scripts/cybercab/`: Python data preparation (roads, hexagons, people, jobs,
  cars, travel times)

Free to run: a static page, no servers, no keys, no paid map tiles.

Data: © OpenStreetMap contributors (ODbL) · US Census 2020, LEHD LODES 2022
and ACS (public domain).
