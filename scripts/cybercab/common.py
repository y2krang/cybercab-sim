"""Shared paths and helpers for the Cybercab data prep scripts.

Big downloads and in-between files go in CYBERCAB_DATA (default
scripts/cybercab/.data, not in git). Small outputs the web page loads go in
apps/cybercab/public/data/.
"""
import csv
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA_ROOT = Path(os.environ.get("CYBERCAB_DATA", Path(__file__).resolve().parent / ".data"))
DOWNLOADS = DATA_ROOT / "downloads"
WORK = DATA_ROOT / "work"
OUT = REPO / "apps" / "cybercab" / "public" / "data"

COUNTY_FIPS = "48453"  # Travis County, Texas
H3_RES = 8


def read_params(name):
    """Read a key,value,unit,label,source CSV from the output folder."""
    with open(OUT / name, newline="", encoding="utf-8") as f:
        return {r["key"]: r for r in csv.DictReader(f)}


def param(params, key):
    return float(params[key]["value"])


def ensure_dirs():
    for p in (WORK, OUT):
        p.mkdir(parents=True, exist_ok=True)
