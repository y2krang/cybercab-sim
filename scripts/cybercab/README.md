# Cybercab sim: data prep

Builds the data files for `apps/cybercab/`.
Big downloads (about 1.5 GB) and in-between files go in the folder named by
the `CYBERCAB_DATA` environment variable (default `scripts/cybercab/.data/`,
not in git); small outputs go in `apps/cybercab/public/data/`.

Needs Python 3.13 with: `h3 osmium pandas numpy shapely pyogrio pyproj geopandas scipy requests matplotlib`.
Run from this folder, in order:

| step | script | makes |
| --- | --- | --- |
| 1 | `download.py` | OSM Texas, Census 2020 blocks, LODES 2022, ACS 2024 B25044 |
| 1 | `prep_area.py` | `hexes.csv`, `work_flows.csv`, `county.geojson`, `step1_totals.json` |
| 1 | `prep_roads.py` | `work/roads.npz` (road graph), `roads_summary.json` |
| 1 | `check_step1.py` | pass/fail for check A1 and sanity checks |
| 1 | `preview_step1.py` | preview pictures in `work/preview/` |
| 2 | `prep_travel.py` | `tt_base.bin.gz`, `tt_slow.bin.gz`, `next_hop.bin.gz`, `hex_neighbours.bin.gz`, `travel_meta.json` |
| 2 | `check_step2.py` | pass/fail for check A2 (`sample_drives.csv`) and table checks |
| 2 | `preview_step2.py` | drive-time picture in `work/preview/` |
| 3 | `prep_hubs.py` | `hubs.csv` (hub addresses looked up in the OSM extract) |
| 3 | `tiles.py` | `apps/cybercab/public/tiles/travis.pmtiles` (base map, not in git) |

Editable numbers: `apps/cybercab/public/data/area.csv` and `road_speeds.csv`
(columns `key,value,unit,label,source`).

## Output columns

- `hexes.csv`: `h3` id, centre `lat`/`lng`, `people` (Census 2020), `households`
  (2020 housing units), `jobs` (LODES jobs by workplace), `workers` (LODES
  workers by home), `cars_acs` (ACS vehicles available, spread to blocks by
  housing units), `cars` (scaled to the DMV registration total).
- `work_flows.csv`: `home` hex, `work` hex, `workers` (both ends in the county).
