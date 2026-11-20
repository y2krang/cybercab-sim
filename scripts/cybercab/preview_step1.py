"""Step 1 preview pictures for the owner: roads, and hexes shaded by people, jobs and cars.

Output: WORK/preview/step1_roads.png, WORK/preview/step1_hexes.png
"""
import csv
import sys

import h3
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.collections import LineCollection, PolyCollection  # noqa: E402

from common import OUT, WORK  # noqa: E402

BG = "#11151c"
FG = "#d8dee9"


def main():
    out = WORK / "preview"
    out.mkdir(parents=True, exist_ok=True)
    kx = np.cos(np.radians(30.3))  # squash longitude so the map isn't stretched

    with np.load(WORK / "roads.npz") as z:
        r = {k: z[k] for k in z.files}  # load once; NpzFile re-reads on every access
    width = {0: 1.6, 1: 1.3, 2: 1.0, 3: 0.8, 4: 0.6}
    colour = {0: "#f2a65a", 1: "#f2c65a", 2: "#e8e0a0", 3: "#c0c8d0", 4: "#a0a8b0"}
    fig, ax = plt.subplots(figsize=(12, 12), facecolor=BG)
    ax.set_facecolor(BG)
    for cls in [8, 7, 6, 5, 4, 3, 2, 1, 0]:
        sel = (r["edge_class"] == cls) & (r["edge_shape_count"] > 0)
        segs = []
        for s0, n in zip(r["edge_shape_start"][sel], r["edge_shape_count"][sel]):
            segs.append(np.column_stack([r["shape_lon"][s0:s0 + n] * kx, r["shape_lat"][s0:s0 + n]]))
        ax.add_collection(LineCollection(segs, colors=colour.get(cls, "#5a6270"),
                                         linewidths=width.get(cls, 0.25)))
    ax.autoscale()
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title("Travis County drivable roads (OpenStreetMap)", color=FG, fontsize=16)
    fig.savefig(out / "step1_roads.png", dpi=110, bbox_inches="tight", facecolor=BG)
    plt.close(fig)

    with open(OUT / "hexes.csv", newline="") as f:
        hexes = list(csv.DictReader(f))
    polys = [np.array([(lo * kx, la) for la, lo in h3.cell_to_boundary(h["h3"])]) for h in hexes]
    fig, axes = plt.subplots(1, 3, figsize=(21, 8), facecolor=BG)
    for ax, (key, title) in zip(axes, [("people", "People (Census 2020)"), ("jobs", "Jobs (LODES 2022)"),
                                       ("cars", "Cars (ACS, scaled to 1.0 million)")]):
        vals = np.array([float(h[key]) for h in hexes])
        total = vals.sum()
        coll = PolyCollection(polys, array=np.log10(vals + 1), cmap="magma", edgecolors="none")
        ax.add_collection(coll)
        ax.autoscale()
        ax.set_aspect("equal")
        ax.axis("off")
        ax.set_facecolor(BG)
        ax.set_title(f"{title}\ntotal {total:,.0f}", color=FG, fontsize=14)
    fig.suptitle(f"Travis County: {len(hexes):,} hexagons (H3 level 8). Brighter = more", color=FG, fontsize=16)
    fig.savefig(out / "step1_hexes.png", dpi=90, bbox_inches="tight", facecolor=BG)
    plt.close(fig)
    print(out)


if __name__ == "__main__":
    sys.exit(main())
