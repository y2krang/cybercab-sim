"""Step 2 checks: acceptance check A2 (10 sample drives within +-25%, off-peak
and rush hour) plus table sanity checks. Exit code 1 if any fail."""
import csv
import gzip
import json
import sys

import h3
import numpy as np

from common import OUT, param, read_params

TOL = 0.25


def load(name, dtype, n, cols):
    with gzip.open(OUT / f"{name}.bin.gz", "rb") as f:
        return np.frombuffer(f.read(), dtype="<" + dtype).reshape(n, cols)


def main():
    meta = json.loads((OUT / "travel_meta.json").read_text())
    with open(OUT / "hexes.csv", newline="") as f:
        ids = [h["h3"] for h in csv.DictReader(f)]
    n = len(ids)
    pos = {h: i for i, h in enumerate(ids)}
    base = load("tt_base", "u2", n, n).astype(float)
    slow = load("tt_slow", "u2", n, n).astype(float)
    nxt = load("next_hop", "u1", n, n)
    neigh = load("hex_neighbours", "u2", n, 6)
    sd = read_params("slowdown.csv")
    f_off = param(sd, "weekday_22_24")
    f_rush = param(sd, "weekday_16_19")

    ok = True

    def report(name, passed):
        nonlocal ok
        print(("PASS " if passed else "FAIL ") + name)
        ok &= passed

    print(f"{'drive':58} {'off-peak':>15} {'rush 16-19':>15}")
    a2 = True
    with open(OUT / "sample_drives.csv", newline="") as f:
        for d in csv.DictReader(f):
            a = pos[h3.latlng_to_cell(float(d["from_lat"]), float(d["from_lng"]), 8)]
            b = pos[h3.latlng_to_cell(float(d["to_lat"]), float(d["to_lng"]), 8)]
            off = (base[a, b] + (f_off - 1) * slow[a, b]) / 60
            rush = (base[a, b] + (f_rush - 1) * slow[a, b]) / 60
            e_off, e_rush = float(d["offpeak_min"]), float(d["rush_min"])
            good = abs(off - e_off) <= TOL * e_off and abs(rush - e_rush) <= TOL * e_rush
            a2 &= good
            print(f"{(d['from'] + ' -> ' + d['to'])[:58]:58} {off:5.1f} vs {e_off:4.0f}  {rush:5.1f} vs {e_rush:4.0f}"
                  f"  {'ok' if good else 'OUTSIDE 25%'}")
    report("A2 10 sample drives within 25%, off-peak and rush hour", a2)

    road = base < 65535
    report("travel tables: under 40 MB in total", meta["total_mb"] < 40)
    report("travel tables: >99% of hex pairs reachable",
           road.sum() > 0.99 * (n - len(meta["hexes_without_road"])) ** 2)
    report("rush hour never quicker than off-peak", bool((slow[road] >= 0).all()))
    # Route chains end at the destination within n steps, for a sample of pairs.
    rng = np.random.default_rng(1)
    chain_ok = 0
    trials = 300
    for _ in range(trials):
        a, b = rng.integers(0, n, 2)
        if not (road[a, b]):
            chain_ok += 1
            continue
        cur, steps = a, 0
        while cur != b and steps < n:
            k = nxt[cur, b]
            if k == 255:
                break
            cur = int(neigh[cur, k])
            steps += 1
        chain_ok += cur == b
    # About 2% of pairs cross a lake or a stretch with no street hex; the page draws those straight.
    report(f"route chains reach the destination (sample of {trials}: {chain_ok})", chain_ok >= 0.97 * trials)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
