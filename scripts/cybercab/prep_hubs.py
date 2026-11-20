"""Hub locations (spec section 4): look up the two reported Austin hub addresses in
the OpenStreetMap extract (no outside geocoding service) and write hubs.csv.
Bay counts are from the spec; edit hubs.csv to change them or add hubs."""
import csv
import sys

import osmium

from common import DOWNLOADS, OUT

HUBS = [
    ("Ben White hub", "5900", "Ben White"),
    ("Ridgepoint hub", "2323", "Ridgepoint"),
]
BBOX = (-98.30, 29.92, -97.25, 30.72)


def main():
    found = {}
    fp = osmium.FileProcessor(str(DOWNLOADS / "texas-latest.osm.pbf")).with_locations("sparse_mem_array") \
        .with_filter(osmium.filter.KeyFilter("addr:housenumber"))
    lo0, la0, lo1, la1 = BBOX
    for o in fp:
        num = o.tags.get("addr:housenumber", "")
        street = o.tags.get("addr:street", "")
        for name, want_num, want_street in HUBS:
            if num != want_num or want_street.lower() not in street.lower():
                continue
            if o.is_node():
                lon, lat = o.location.lon, o.location.lat
            elif o.is_way():
                pts = [(n.lon, n.lat) for n in o.nodes if n.location.valid()]
                if not pts:
                    continue
                lon = sum(p[0] for p in pts) / len(pts)
                lat = sum(p[1] for p in pts) / len(pts)
            else:
                continue
            if lo0 <= lon <= lo1 and la0 <= lat <= la1:
                found[name] = (lat, lon, f"{num} {street}")
                print(name, found[name])
    missing = [h[0] for h in HUBS if h[0] not in found]
    if missing:
        raise SystemExit(f"Not found in OSM: {missing}")
    with open(OUT / "hubs.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "address", "lat", "lng", "charge_bays", "clean_bays", "label", "source"])
        for name, _, _ in HUBS:
            lat, lon, addr = found[name]
            w.writerow([name, f"{addr}, Austin TX", round(lat, 6), round(lon, 6), 24, 4, "estimate",
                        "Spec section 4; location from OpenStreetMap address"])


if __name__ == "__main__":
    sys.exit(main())
