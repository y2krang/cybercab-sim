"""Step 2: hex-to-hex driving times and route shapes.

For every pair of hexes (from, to) we store two numbers along the free-flow
shortest road route:
  base = free-flow seconds (speed x 0.85, capped at max_speed), including the
         short drive from the hex centre to the road network at each end
  slow = sum of (edge seconds x that road's share of extra delay)
Travel time in any time band with slowdown factor f is then
  time = base + (f - 1) x slow
so slowdown.csv stays editable in the browser without rebuilding. Routes
are taken from free-flow times (congestion doesn't re-route cabs).

Route shapes: next_hop[from, to] = which neighbouring hex to step into next
(index into hex_neighbours), so a cab's route is drawn as a chain of
neighbouring hex centres. Built from a hex-to-neighbour graph weighted by
road time, so chains are always consistent.

Inputs:  WORK/roads.npz, OUT/hexes.csv, OUT/road_speeds.csv, OUT/slowdown.csv
Outputs (OUT, gzip): tt_base.bin.gz, tt_slow.bin.gz (uint16 seconds, row =
  from, column = to, hexes.csv order; 65535 = no road), next_hop.bin.gz (uint8,
  255 = none), hex_neighbours.bin.gz (uint16 [hex, 6], 65535 = none),
  travel_meta.json
"""
import csv
import gzip
import json
import sys
import time

import h3
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from common import OUT, WORK, param, read_params
from roadgraph import MPH_TO_MS, SNAP_LIMIT_M, build_graph, load_roads, snap_hexes

NO_ROAD = 65535
ACCESS_MPH = 15           # centre-of-hex to road: parking-lot speed
ACCESS_DETOUR = 1.3       # straight line to road distance
SAME_HEX_MIN_S = 60
CHUNK = 32


def main():
    t0 = time.time()
    speeds = read_params("road_speeds.csv")
    slow = read_params("slowdown.csv")
    r = load_roads(WORK / "roads.npz")
    n_nodes = len(r["node_lon"])
    G, S, _ = build_graph(r, speeds, slow)

    # Hex centres snap to the nearest junction on a street (not motorways or service roads).
    with open(OUT / "hexes.csv", newline="") as f:
        hexes = list(csv.DictReader(f))
    ids = [h["h3"] for h in hexes]
    n = len(ids)
    hex_node, snap_d = snap_hexes(r, [float(h["lng"]) for h in hexes], [float(h["lat"]) for h in hexes])
    has_road = snap_d <= SNAP_LIMIT_M
    access = snap_d * ACCESS_DETOUR / (ACCESS_MPH * MPH_TO_MS)
    print(f"{n} hexes; {int((~has_road).sum())} with no road within {SNAP_LIMIT_M} m")

    base = np.full((n, n), np.inf)
    slowp = np.full((n, n), np.inf)
    src = np.flatnonzero(has_road)
    for c0 in range(0, len(src), CHUNK):
        rows = src[c0:c0 + CHUNK]
        dist, pred = dijkstra(G, directed=True, indices=hex_node[rows], return_predecessors=True)
        for k, row in enumerate(rows):
            d, p = dist[k], pred[k]
            reach = p >= 0
            w = np.zeros(n_nodes)
            pi = p[reach]
            ci = np.flatnonzero(reach)
            w[ci] = (d[ci] - d[pi]) * np.asarray(S[pi, ci]).ravel()
            jump = np.arange(n_nodes)
            jump[ci] = pi
            acc = w
            while True:
                nxt = jump[jump]
                acc = acc + acc[jump]
                if np.array_equal(nxt, jump):
                    break
                jump = nxt
            base[row] = d[hex_node]
            slowp[row] = acc[hex_node]
        if c0 % (CHUNK * 20) == 0:
            print(f"  {c0 + len(rows)}/{len(src)} hexes, {time.time() - t0:.0f} s")

    # Add hex-centre access at both ends (local roads: half extra delay share).
    acc_pair = access[:, None] + access[None, :]
    local_share = param(slow, "share_residential")
    base = base + acc_pair
    slowp = slowp + acc_pair * local_share
    idx = np.arange(n)
    base[idx, idx] = np.maximum(2 * access, SAME_HEX_MIN_S)
    slowp[idx, idx] = base[idx, idx] * local_share
    bad = ~np.isfinite(base) | ~has_road[:, None] | ~has_road[None, :]
    base_u16 = np.where(bad, NO_ROAD, np.minimum(np.round(base), NO_ROAD - 1)).astype(np.uint16)
    slow_u16 = np.where(bad, NO_ROAD, np.minimum(np.round(slowp), NO_ROAD - 1)).astype(np.uint16)

    # Neighbours and next-hop routes on the hex graph.
    pos = {h: i for i, h in enumerate(ids)}
    neigh = np.full((n, 6), NO_ROAD, dtype=np.uint16)
    hu, hv, hw = [], [], []
    for i, h in enumerate(ids):
        nb = sorted(x for x in h3.grid_ring(h, 1) if x in pos)
        for k, x in enumerate(nb[:6]):
            j = pos[x]
            neigh[i, k] = j
            if not bad[i, j]:
                hu.append(i); hv.append(j); hw.append(base[i, j])
    HG = csr_matrix((hw, (hu, hv)), shape=(n, n))
    _, hpred = dijkstra(HG.T.tocsr(), directed=True, return_predecessors=True)
    # hpred[to, from] = next hex after 'from' on the way to 'to'.
    nxt = hpred.T
    next_hop = np.full((n, n), 255, dtype=np.uint8)
    for k in range(6):
        match = (nxt == neigh[:, k].astype(np.int64)[:, None]) & (neigh[:, k] != NO_ROAD)[:, None]
        next_hop[match] = k
    no_chain = int(((next_hop == 255) & ~bad).sum() - n)  # the diagonal never needs a hop

    sizes = {}
    for name, arr in (("tt_base", base_u16), ("tt_slow", slow_u16), ("next_hop", next_hop),
                      ("hex_neighbours", neigh)):
        path = OUT / f"{name}.bin.gz"
        with gzip.open(path, "wb", compresslevel=9) as f:
            f.write(np.ascontiguousarray(arr).tobytes())
        sizes[name] = round(path.stat().st_size / 1e6, 2)
    meta = {
        "hexes": n, "order": "hexes.csv row order", "byte_order": "little-endian",
        "tt_units": "seconds", "no_road": NO_ROAD, "next_hop_none": 255,
        "formula": "time = tt_base + (slowdown_factor - 1) * tt_slow",
        "hexes_without_road": [ids[i] for i in np.flatnonzero(~has_road)],
        "pairs_without_hex_chain": no_chain,
        "files_mb": sizes, "total_mb": round(sum(sizes.values()), 2),
        "seconds": round(time.time() - t0),
    }
    (OUT / "travel_meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps({k: v for k, v in meta.items() if k != "hexes_without_road"}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
