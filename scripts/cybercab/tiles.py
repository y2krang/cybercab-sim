"""Base map tiles for Travis County: extract from the free daily Protomaps build of
OpenStreetMap (ODbL) into apps/cybercab/public/tiles/travis.pmtiles.

Same source as the Isle of Man map's scripts/tiles.sh, but done in Python with the
`pmtiles` package (reads the remote file with HTTP range requests), so no extra tool
is needed. Max zoom 14; the map zooms past that by enlarging tiles.
"""
import datetime as dt
import json
import math
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import requests
from pmtiles.reader import Reader
from pmtiles.tile import zxy_to_tileid
from pmtiles.writer import Writer

from common import REPO

BBOX = (-98.30, 29.92, -97.25, 30.72)  # lon/lat, county plus a margin
MAX_ZOOM = 14
OUT = REPO / "apps" / "cybercab" / "public" / "tiles" / "travis.pmtiles"

_local = threading.local()


def session():
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def find_build():
    today = dt.datetime.now(dt.timezone.utc).date()
    for back in range(8):
        day = (today - dt.timedelta(days=back)).strftime("%Y%m%d")
        url = f"https://build.protomaps.com/{day}.pmtiles"
        if requests.head(url, timeout=30).ok:
            return url, day
    raise SystemExit("No recent Protomaps build found")


def tile_range(z):
    def x(lon):
        return int((lon + 180) / 360 * 2 ** z)

    def y(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)

    lo0, la0, lo1, la1 = BBOX
    return range(x(lo0), x(lo1) + 1), range(y(la1), y(la0) + 1)


def main():
    url, day = find_build()
    print(f"Using Protomaps build {day}")
    cache, lock = {}, threading.Lock()

    def get_bytes(offset, length):
        key = (offset, length)
        with lock:
            if key in cache:
                return cache[key]
        r = session().get(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"}, timeout=60)
        r.raise_for_status()
        data = r.content
        if length > 4096 or offset < 1 << 20:  # directories: keep for re-use
            with lock:
                cache[key] = data
        return data

    reader = Reader(get_bytes)
    header = reader.header()
    metadata = reader.metadata()
    jobs = []
    for z in range(0, MAX_ZOOM + 1):
        xs, ys = tile_range(z)
        jobs += [(z, x, y) for x in xs for y in ys]
    print(f"{len(jobs):,} tiles to fetch")

    def fetch(zxy):
        return zxy, reader.get(*zxy)

    with ThreadPoolExecutor(12) as pool:
        tiles = {}
        for i, (zxy, data) in enumerate(pool.map(fetch, jobs)):
            if data:
                tiles[zxy_to_tileid(*zxy)] = data
            if i % 500 == 0:
                print(f"  {i}/{len(jobs)}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "wb") as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        lo0, la0, lo1, la1 = BBOX
        header.update({
            "min_zoom": 0, "max_zoom": MAX_ZOOM,
            "min_lon_e7": int(lo0 * 1e7), "min_lat_e7": int(la0 * 1e7),
            "max_lon_e7": int(lo1 * 1e7), "max_lat_e7": int(la1 * 1e7),
            "center_zoom": 10, "center_lon_e7": int(-97.74 * 1e7), "center_lat_e7": int(30.27 * 1e7),
        })
        metadata = dict(metadata)
        metadata["description"] = f"Travis County extract of Protomaps build {day}"
        w.finalize(header, metadata)
    print(json.dumps({"tiles": len(tiles), "mb": round(OUT.stat().st_size / 1e6, 1), "build": day}))


if __name__ == "__main__":
    sys.exit(main())
