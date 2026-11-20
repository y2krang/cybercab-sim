# Cybercab sim (Austin)

Unofficial simulation of a self-driving robotaxi fleet in Travis County, Texas.
Static web page: TypeScript, Vite, MapLibre GL JS, deck.gl. No servers, no keys.
Work in progress, built step by step.

```
npm install
python ../../scripts/cybercab/tiles.py   # base map, ~30 MB, into public/tiles/
npm test
npm run build                            # CYBERCAB_BASE=/cybercab/ for GitHub Pages
npm run preview
```

Data files in `public/data/` come from `scripts/cybercab/` (see its README).
Map data © OpenStreetMap contributors (ODbL); population, jobs and cars from the
US Census (public domain).
