"""Road graph helpers shared by prep_travel.py and prep_shapes.py, so both use
exactly the same edges, times and hex-to-road snapping."""
import numpy as np
from scipy.sparse import csr_matrix
from scipy.spatial import cKDTree

from common import param

MPH_TO_MS = 0.44704
SNAP_LIMIT_M = 1500       # hexes further than this from a usable road have no road
STREET_CLASSES = ("trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street")


def load_roads(path):
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def project(lon, lat):
    k = np.cos(np.radians(30.3))
    return np.column_stack([lon * 111320.0 * k, lat * 110540.0])


def build_graph(r, speeds, slow):
    """Directed graph of free-flow seconds (one edge per node pair: the quickest).
    Returns G (times), S (share of extra delay), sel (index into roads edges per kept edge)."""
    classes = [str(c) for c in r["classes"]]
    n_nodes = len(r["node_lon"])
    mph = np.minimum(r["edge_mph"], param(speeds, "max_speed")) * param(speeds, "junction_factor")
    t_edge = np.maximum(r["edge_length_m"] / (mph * MPH_TO_MS), 0.1)
    share_by_class = np.array([param(slow, f"share_{c}") for c in classes])
    share = share_by_class[r["edge_class"]]
    u, v = r["edge_u"].astype(np.int64), r["edge_v"].astype(np.int64)
    order = np.lexsort((t_edge, u * n_nodes + v))
    key = (u * n_nodes + v)[order]
    first = np.ones(len(key), bool)
    first[1:] = key[1:] != key[:-1]
    sel = order[first]
    G = csr_matrix((t_edge[sel], (u[sel], v[sel])), shape=(n_nodes, n_nodes))
    S = csr_matrix((share[sel], (u[sel], v[sel])), shape=(n_nodes, n_nodes))
    return G, S, sel


def snap_hexes(r, lng, lat):
    """Nearest junction on a street (not motorways or service roads) to each hex centre.
    Returns (node index per hex, distance in metres)."""
    classes = [str(c) for c in r["classes"]]
    street = [classes.index(c) for c in STREET_CLASSES]
    ok_edge = np.isin(r["edge_class"], street)
    street_nodes = np.unique(np.concatenate([r["edge_u"][ok_edge], r["edge_v"][ok_edge]]))
    tree = cKDTree(project(r["node_lon"][street_nodes], r["node_lat"][street_nodes]))
    snap_d, snap_i = tree.query(project(np.asarray(lng), np.asarray(lat)))
    return street_nodes[snap_i], snap_d
