"""Step 5: candidate places for auto-placed hubs (spec section 4: "on major road
junctions"). A hex qualifies if it holds a junction where at least three
major-road edges (motorway, trunk, primary, secondary, incl. their ramps) meet.
The simulation picks among these, spread by demand.

Input:  WORK/roads.npz, OUT/hexes.csv
Output: OUT/hub_sites.csv (h3, junctions)
"""
import csv
import sys

import h3
import numpy as np

from common import H3_RES, OUT, WORK


def main():
    with np.load(WORK / "roads.npz") as z:
        r = {k: z[k] for k in z.files}
    classes = [str(c) for c in r["classes"]]
    major = np.isin(r["edge_class"], [classes.index(c) for c in ("motorway", "trunk", "primary", "secondary")])
    n_nodes = len(r["node_lon"])
    # Count distinct neighbouring junctions reached by major roads (either direction):
    # three or more arms = a junction of major roads, not just a road passing a side street.
    u = r["edge_u"][major].astype(np.int64)
    v = r["edge_v"][major].astype(np.int64)
    pairs = np.unique(np.concatenate([np.stack([u, v], 1), np.stack([v, u], 1)]), axis=0)
    arms = np.bincount(pairs[:, 0], minlength=n_nodes)
    junction = arms >= 3
    with open(OUT / "hexes.csv", newline="") as f:
        valid = {row["h3"] for row in csv.DictReader(f)}
    counts = {}
    for i in np.flatnonzero(junction):
        h = h3.latlng_to_cell(float(r["node_lat"][i]), float(r["node_lon"][i]), H3_RES)
        if h in valid:
            counts[h] = counts.get(h, 0) + 1
    with open(OUT / "hub_sites.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["h3", "junctions"])
        for h in sorted(counts):
            w.writerow([h, counts[h]])
    print(f"{len(counts)} hexes with a major road junction")


if __name__ == "__main__":
    sys.exit(main())
