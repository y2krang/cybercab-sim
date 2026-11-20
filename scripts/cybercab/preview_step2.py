"""Step 2 preview: drive time from downtown Austin to every hex, off-peak vs weekday rush,
plus one sample route drawn as its hex chain. Output: WORK/preview/step2_times.png"""
import csv
import gzip
import sys

import h3
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.collections import PolyCollection  # noqa: E402

from common import OUT, WORK, param, read_params  # noqa: E402

BG, FG = "#11151c", "#d8dee9"


def load(name, dtype, n, cols):
    with gzip.open(OUT / f"{name}.bin.gz", "rb") as f:
        return np.frombuffer(f.read(), dtype="<" + dtype).reshape(n, cols)


def main():
    with open(OUT / "hexes.csv", newline="") as f:
        hexes = list(csv.DictReader(f))
    ids = [h["h3"] for h in hexes]
    n = len(ids)
    pos = {h: i for i, h in enumerate(ids)}
    base = load("tt_base", "u2", n, n).astype(float)
    slow = load("tt_slow", "u2", n, n).astype(float)
    nxt = load("next_hop", "u1", n, n)
    neigh = load("hex_neighbours", "u2", n, 6)
    sd = read_params("slowdown.csv")
    kx = np.cos(np.radians(30.3))
    polys = [np.array([(lo * kx, la) for la, lo in h3.cell_to_boundary(h)]) for h in ids]

    src = pos[h3.latlng_to_cell(30.2682, -97.7429, 8)]          # Congress & 6th
    dst = pos[h3.latlng_to_cell(30.4394, -97.6200, 8)]          # Pflugerville
    chain = [src]
    while chain[-1] != dst and len(chain) < n and nxt[chain[-1], dst] != 255:
        chain.append(int(neigh[chain[-1], nxt[chain[-1], dst]]))
    cx = [float(hexes[i]["lng"]) * kx for i in chain]
    cy = [float(hexes[i]["lat"]) for i in chain]

    fig, axes = plt.subplots(1, 2, figsize=(18, 9), facecolor=BG)
    for ax, (key, title) in zip(axes, [("weekday_22_24", "Off-peak"), ("weekday_16_19", "Weekday 16:00-19:00")]):
        f = param(sd, key)
        t = base[src] + (f - 1) * slow[src]
        mins = np.where(base[src] < 65535, t / 60, np.nan)
        coll = PolyCollection(polys, array=np.ma.masked_invalid(mins), cmap="viridis_r", edgecolors="none")
        coll.set_clim(0, 60)
        coll.cmap.set_bad("#2a2f38")
        ax.add_collection(coll)
        ax.plot(cx, cy, color="#ff5a5a", lw=2.5)
        ax.plot(cx[0], cy[0], "o", color="white", ms=8)
        ax.autoscale()
        ax.set_aspect("equal")
        ax.axis("off")
        ax.set_title(f"{title} (x{f}): minutes from downtown", color=FG, fontsize=14)
    cb = fig.colorbar(coll, ax=axes, shrink=0.6)
    cb.ax.yaxis.set_tick_params(color=FG, labelcolor=FG)
    cb.set_label("minutes", color=FG)
    fig.suptitle("Step 2 travel times. Red line: sample route downtown to Pflugerville, as drawn by the sim",
                 color=FG, fontsize=15)
    out = WORK / "preview"
    out.mkdir(parents=True, exist_ok=True)
    fig.savefig(out / "step2_times.png", dpi=85, bbox_inches="tight", facecolor=BG)
    print(out / "step2_times.png")


if __name__ == "__main__":
    sys.exit(main())
