"""Step 1b: Travis County drivable road network from the OpenStreetMap Texas extract.

Input:  DOWNLOADS/texas-latest.osm.pbf (Geofabrik), WORK/county.gpkg (from prep_area.py)
Output: WORK/roads.npz      graph: nodes, directed edges (length, speed, class), drawing shapes
        OUT/roads_summary.json   road miles by type, share with a speed limit tag
Speeds follow spec section 5: maxspeed tag, else road_speeds.csv by type.
The x 0.85 junction factor and time-of-day slowdowns are applied in step 2.
"""
import json
import math
import re
import sys
import time

import geopandas as gpd
import numpy as np
import osmium
import shapely
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from common import DOWNLOADS, OUT, WORK, param, read_params

CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service",
           "unclassified", "living_street"]
CLASS_CODE = {c: i for i, c in enumerate(CLASSES)}
BBOX = (-98.30, 29.92, -97.25, 30.72)  # Travis County plus a margin (lon/lat)
BUFFER_M = 5000
NO_ACCESS = {"no", "private"}


def road_class(hw):
    base = hw[:-5] if hw.endswith("_link") else hw
    return base if base in CLASS_CODE else None


def parse_maxspeed(tag, max_mph):
    """Return mph from an OSM maxspeed value, or None."""
    if not tag:
        return None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?", tag)
    if not m:
        return None
    v = float(m.group(1))
    if m.group(2) and m.group(2) != "mph":
        v = v / 1.609344
    # No unit: OSM's rule is km/h, but in Texas bare numbers are nearly always mph.
    return v if 3 <= v <= max_mph else None


def oneway_dir(tags, cls_raw):
    ow = tags.get("oneway", "")
    if ow in ("yes", "1", "true"):
        return 1
    if ow == "-1":
        return -1
    if ow == "no":
        return 0
    if cls_raw in ("motorway", "motorway_link") or tags.get("junction") in ("roundabout", "circular"):
        return 1
    return 0


def read_ways(pbf):
    ways = []  # (node_ids, lons, lats, class_code, maxspeed_mph or nan, oneway)
    seen = 0
    lo0, la0, lo1, la1 = BBOX
    fp = osmium.FileProcessor(str(pbf)).with_locations("sparse_mem_array").with_filter(
        osmium.filter.KeyFilter("highway"))
    for o in fp:
        if not o.is_way():
            continue
        seen += 1
        tags = o.tags
        hw = tags.get("highway", "")
        cls = road_class(hw)
        if cls is None or tags.get("area") == "yes":
            continue
        if tags.get("access") in NO_ACCESS or tags.get("motor_vehicle") in NO_ACCESS \
                or tags.get("motorcar") in NO_ACCESS:
            continue
        if cls == "service" and tags.get("service") in ("parking_aisle", "driveway", "drive-through"):
            continue
        nodes = o.nodes
        try:
            lons = [n.lon for n in nodes]
            lats = [n.lat for n in nodes]
        except osmium.InvalidLocationError:
            continue
        if max(lons) < lo0 or min(lons) > lo1 or max(lats) < la0 or min(lats) > la1:
            continue
        ways.append(([n.ref for n in nodes], lons, lats, CLASS_CODE[cls],
                     tags.get("maxspeed", ""), oneway_dir(tags, hw)))
    print(f"highway ways in Texas: {seen:,}; drivable near Travis County: {len(ways):,}")
    return ways


def haversine_m(lon1, lat1, lon2, lat2):
    r = 6371008.8
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def main():
    t0 = time.time()
    speeds = read_params("road_speeds.csv")
    max_mph = param(speeds, "max_speed")
    # Keep roads up to 5 km past the county line, so one-way lanes and roads that
    # leave and re-enter the county still join up. Hexes stay inside the county.
    county = gpd.read_file(WORK / "county.gpkg").to_crs(5070).buffer(BUFFER_M).to_crs(4326).iloc[0]

    ways = read_ways(DOWNLOADS / "texas-latest.osm.pbf")
    print(f"read in {time.time() - t0:.0f} s")

    # Keep the parts of each way inside the county.
    all_lon = np.concatenate([np.asarray(w[1]) for w in ways])
    all_lat = np.concatenate([np.asarray(w[2]) for w in ways])
    shapely.prepare(county)
    inside = shapely.contains_xy(county, all_lon, all_lat)

    # A node is a junction if it is used more than once (by any way) or ends a way.
    uses = {}
    for w in ways:
        for r in w[0]:
            uses[r] = uses.get(r, 0) + 1

    node_index = {}
    node_lon, node_lat = [], []

    def nid(ref, lon, lat):
        i = node_index.get(ref)
        if i is None:
            i = node_index[ref] = len(node_lon)
            node_lon.append(lon)
            node_lat.append(lat)
        return i

    e_u, e_v, e_len, e_mph, e_cls, e_tagged, e_shape0, e_shapen = [], [], [], [], [], [], [], []
    shape_lon, shape_lat = [], []
    pos = 0
    for refs, lons, lats, cls, maxspeed, ow in ways:
        n = len(refs)
        ins = inside[pos:pos + n]
        pos += n
        tagged = parse_maxspeed(maxspeed, max_mph)
        mph = tagged if tagged is not None else param(speeds, CLASSES[cls])
        lo = np.asarray(lons)
        la = np.asarray(lats)
        seg = haversine_m(lo[:-1], la[:-1], lo[1:], la[1:])
        start = None
        for i in range(n):
            if not ins[i]:
                start = None
                continue
            if start is None:
                start = i
                continue
            is_junction = uses[refs[i]] > 1 or i == n - 1 or (i + 1 < n and not ins[i + 1])
            if not is_junction:
                continue
            u = nid(refs[start], lons[start], lats[start])
            v = nid(refs[i], lons[i], lats[i])
            length = float(seg[start:i].sum())
            s0 = len(shape_lon)
            shape_lon.extend(lons[start:i + 1])
            shape_lat.extend(lats[start:i + 1])
            for a, b, rev in ((u, v, False), (v, u, True)):
                if (ow == 1 and rev) or (ow == -1 and not rev):
                    continue
                e_u.append(a); e_v.append(b); e_len.append(length); e_mph.append(mph)
                e_cls.append(cls); e_tagged.append(tagged is not None)
                e_shape0.append(s0); e_shapen.append(-(i - start + 1) if rev else (i - start + 1))
            start = i

    n_nodes = len(node_lon)
    e_u = np.array(e_u, dtype=np.int32)
    e_v = np.array(e_v, dtype=np.int32)
    print(f"graph: {n_nodes:,} junctions, {len(e_u):,} one-way edges")

    # Keep the biggest strongly connected part so every place can reach every other.
    g = csr_matrix((np.ones(len(e_u)), (e_u, e_v)), shape=(n_nodes, n_nodes))
    ncomp, labels = connected_components(g, directed=True, connection="strong")
    main_label = np.bincount(labels).argmax()
    keep_node = labels == main_label
    keep_edge = keep_node[e_u] & keep_node[e_v]
    new_id = np.full(n_nodes, -1, dtype=np.int32)
    new_id[keep_node] = np.arange(keep_node.sum(), dtype=np.int32)

    e_len = np.array(e_len, dtype=np.float32)
    e_mph = np.array(e_mph, dtype=np.float32)
    e_cls = np.array(e_cls, dtype=np.int8)
    e_tagged = np.array(e_tagged, dtype=bool)
    np.savez_compressed(
        WORK / "roads.npz",
        node_lon=np.array(node_lon, dtype=np.float64)[keep_node],
        node_lat=np.array(node_lat, dtype=np.float64)[keep_node],
        edge_u=new_id[e_u[keep_edge]], edge_v=new_id[e_v[keep_edge]],
        edge_length_m=e_len[keep_edge], edge_mph=e_mph[keep_edge], edge_class=e_cls[keep_edge],
        edge_speed_tagged=e_tagged[keep_edge],
        edge_shape_start=np.array(e_shape0, dtype=np.int64)[keep_edge],
        edge_shape_count=np.array(e_shapen, dtype=np.int32)[keep_edge],
        shape_lon=np.array(shape_lon, dtype=np.float64), shape_lat=np.array(shape_lat, dtype=np.float64),
        classes=np.array(CLASSES),
    )

    # Summary: road miles counted once per road (two-way roads appear twice as edges).
    fwd = keep_edge & (np.array(e_shapen) > 0)
    miles = {c: round(float(e_len[fwd & (e_cls == i)].sum() / 1609.344)) for i, c in enumerate(CLASSES)}
    dropped = ~keep_edge & (np.array(e_shapen) > 0)
    dropped_miles = {c: round(float(e_len[dropped & (e_cls == i)].sum() / 1609.344), 1)
                     for i, c in enumerate(CLASSES)}
    summary = {
        "junctions_total": n_nodes, "junctions_kept": int(keep_node.sum()),
        "edges_total": int(len(e_u)), "edges_kept": int(keep_edge.sum()),
        "connected_parts": int(ncomp),
        "road_miles": miles, "road_miles_total": int(sum(miles.values())),
        "dropped_unconnected_miles": dropped_miles,
        "share_with_speed_tag": round(float(e_tagged[keep_edge].mean()), 3),
        "seconds": round(time.time() - t0),
    }
    (OUT / "roads_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
