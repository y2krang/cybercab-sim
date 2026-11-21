"""Road shapes for drawing (spec section 5: "a simplified route shape for drawing").

A cab's route is a chain of neighbouring hexes (next_hop from prep_travel.py).
For every hex and each of its neighbours, this stores the road path between the
two hexes' road points (the same street junctions the travel times start and end
at), so dots follow real roads hop by hop. Shapes are simplified to ~8 m.

Inputs:  WORK/roads.npz, OUT/hexes.csv, OUT/hex_neighbours.bin.gz,
         OUT/road_speeds.csv, OUT/slowdown.csv
Output:  OUT/road_shapes.bin.gz, little-endian:
           uint32 n
           float32 anchor[n][2]            road point (lng, lat) of each hex
           uint32  offset[n*6 + 1]         start of each link's points (in points)
           float32 point[P][2]             (lng, lat); link (hex i, neighbour slot k) is
                                           points offset[i*6+k] .. offset[i*6+k+1]-1
         An empty link (no road path found) is drawn as a straight line.
"""
import csv
import gzip
import json
import sys
import time

import numpy as np
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import LineString

from common import OUT, WORK, read_params
from roadgraph import SNAP_LIMIT_M, build_graph, load_roads, snap_hexes

NONE16 = 65535
LIMIT_S = 1200        # neighbouring hexes further apart than this by road: straight line
SIMPLIFY_DEG = 0.00008
CHUNK = 48


def main():
    t0 = time.time()
    speeds = read_params("road_speeds.csv")
    slow = read_params("slowdown.csv")
    r = load_roads(WORK / "roads.npz")
    n_nodes = len(r["node_lon"])
    G, _, sel = build_graph(r, speeds, slow)
    keys = r["edge_u"][sel].astype(np.int64) * n_nodes + r["edge_v"][sel].astype(np.int64)
    order = np.argsort(keys)
    keys_sorted = keys[order]
    sel_sorted = sel[order]

    with open(OUT / "hexes.csv", newline="") as f:
        hexes = list(csv.DictReader(f))
    n = len(hexes)
    lng = np.array([float(h["lng"]) for h in hexes])
    lat = np.array([float(h["lat"]) for h in hexes])
    hex_node, snap_d = snap_hexes(r, lng, lat)
    has_road = snap_d <= SNAP_LIMIT_M
    with gzip.open(OUT / "hex_neighbours.bin.gz", "rb") as f:
        neigh = np.frombuffer(f.read(), dtype="<u2").reshape(n, 6)

    anchor = np.column_stack([np.where(has_road, r["node_lon"][hex_node], lng),
                              np.where(has_road, r["node_lat"][hex_node], lat)]).astype(np.float32)

    shp_lon, shp_lat = r["shape_lon"], r["shape_lat"]
    s_start, s_count = r["edge_shape_start"], r["edge_shape_count"]

    def edge_points(a, b):
        e = sel_sorted[np.searchsorted(keys_sorted, a * n_nodes + b)]
        s0, c = int(s_start[e]), int(s_count[e])
        if c > 0:
            return shp_lon[s0:s0 + c], shp_lat[s0:s0 + c]
        return shp_lon[s0:s0 - c][::-1], shp_lat[s0:s0 - c][::-1]

    links = [None] * (n * 6)
    missing = 0
    src = np.flatnonzero(has_road)
    for c0 in range(0, len(src), CHUNK):
        rows = src[c0:c0 + CHUNK]
        _, pred = dijkstra(G, directed=True, indices=hex_node[rows], return_predecessors=True, limit=LIMIT_S)
        for k, i in enumerate(rows):
            p = pred[k]
            for slot in range(6):
                j = int(neigh[i, slot])
                if j == NONE16 or not has_road[j]:
                    continue
                target = hex_node[j]
                if target == hex_node[i]:
                    links[i * 6 + slot] = np.array([anchor[i], anchor[j]], dtype=np.float32)
                    continue
                if p[target] < 0:
                    missing += 1
                    continue
                path = [target]
                while path[-1] != hex_node[i]:
                    path.append(p[path[-1]])
                path.reverse()
                xs, ys = [], []
                for a, b in zip(path[:-1], path[1:]):
                    ex, ey = edge_points(int(a), int(b))
                    if xs:
                        ex, ey = ex[1:], ey[1:]
                    xs.extend(ex.tolist()); ys.extend(ey.tolist())
                line = LineString(list(zip(xs, ys))).simplify(SIMPLIFY_DEG, preserve_topology=False)
                links[i * 6 + slot] = np.asarray(line.coords, dtype=np.float32)
        if c0 % (CHUNK * 10) == 0:
            print(f"  {c0 + len(rows)}/{len(src)} hexes, {time.time() - t0:.0f} s")

    offsets = np.zeros(n * 6 + 1, dtype=np.uint32)
    parts = []
    total = 0
    for idx, pts in enumerate(links):
        offsets[idx] = total
        if pts is not None:
            parts.append(pts)
            total += len(pts)
    offsets[-1] = total
    points = np.concatenate(parts) if parts else np.zeros((0, 2), np.float32)
    path = OUT / "road_shapes.bin.gz"
    with gzip.open(path, "wb", compresslevel=9) as f:
        f.write(np.array([n], dtype="<u4").tobytes())
        f.write(anchor.astype("<f4").tobytes())
        f.write(offsets.astype("<u4").tobytes())
        f.write(points.astype("<f4").tobytes())
    stats = {"links": int(sum(x is not None for x in links)), "missing": missing, "points": int(total),
             "mb": round(path.stat().st_size / 1e6, 2), "seconds": round(time.time() - t0)}
    (WORK / "road_shapes_stats.json").write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats))


if __name__ == "__main__":
    sys.exit(main())
