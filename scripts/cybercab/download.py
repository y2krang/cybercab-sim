"""Step 1 downloads (all open data, no keys). Skips files already present.

Geofabrik's Texas extract is checked against its published MD5.
"""
import hashlib
import sys

import requests

from common import DOWNLOADS

FILES = {
    "texas-latest.osm.pbf": "https://download.geofabrik.de/north-america/us/texas/texas-latest.osm.pbf",
    "tl_2020_48_tabblock20.zip": "https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_48_tabblock20.zip",
    "tx_wac_S000_JT00_2022.csv.gz": "https://lehd.ces.census.gov/data/lodes/LODES8/tx/wac/tx_wac_S000_JT00_2022.csv.gz",
    "tx_rac_S000_JT00_2022.csv.gz": "https://lehd.ces.census.gov/data/lodes/LODES8/tx/rac/tx_rac_S000_JT00_2022.csv.gz",
    "tx_od_main_JT00_2022.csv.gz": "https://lehd.ces.census.gov/data/lodes/LODES8/tx/od/tx_od_main_JT00_2022.csv.gz",
    "acsdt5y2024-b25044.dat": "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b25044.dat",
}


def fetch(name, url):
    path = DOWNLOADS / name
    if path.exists():
        print(f"have {name}")
        return
    print(f"getting {name}")
    tmp = path.with_suffix(path.suffix + ".part")
    md5 = hashlib.md5()
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                md5.update(chunk)
    if name.endswith(".osm.pbf"):
        want = requests.get(url + ".md5", timeout=60).text.split()[0]
        if md5.hexdigest() != want:
            tmp.unlink()
            raise SystemExit(f"MD5 mismatch for {name}")
    tmp.rename(path)


def main():
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        fetch(name, url)


if __name__ == "__main__":
    sys.exit(main())
